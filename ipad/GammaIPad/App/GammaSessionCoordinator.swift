import Foundation
import Network

@MainActor
final class GammaSessionLifecycle {
    var monitor: NWPathMonitor?
    var retryTask: Task<Void, Never>?
    var graceTask: Task<Void, Never>?
    var retryID = UUID()
    var validationID = UUID()
    var failureSince: Date?
    var foreground = true
    var probing = false
    var graceInterval: TimeInterval = 8
    func cancel() {
        retryTask?.cancel(); retryTask = nil; retryID = UUID()
        graceTask?.cancel(); graceTask = nil; validationID = UUID()
        monitor?.cancel(); monitor = nil
    }
    deinit { retryTask?.cancel(); graceTask?.cancel(); monitor?.cancel() }
}

extension GammaWorkspace {
    /// Root .task entry. Local identity is restored before the network probe, but
    /// it grants NO remote access. A probe can never choose a different workspace.
    func restoreSession() async {
        guard !didRestoreSession else { return }
        didRestoreSession = true
        guard username == nil, !busy else { return }
        restoringSession = true
        defer { restoringSession = false }
        let generation = accountGeneration
        do {
            guard let record = try sessionStore.load() else { return }
            _ = try record.cookies()
            let client = try sessionAPIFactory(record.server)
            client.close() // Validate HTTPS / credential-free canonical origin before opening cache.
            guard GammaCache.canonicalServer(record.server) == record.server else { throw CocoaError(.fileReadCorruptFile) }
            let storage = try GammaCache(rootURL: sessionCacheRoot ?? GammaCache.applicationSupportRoot(),
                server: URL(string: record.server)!, username: record.username, workspace: record.workspace)
            let library = try storage.library(), recent = try storage.recentPageIDs(), entries = try storage.loadOfflineEntries()
            guard generation == accountGeneration else { return }
            savedSession = record; cache = storage; username = record.username; accountServer = record.server
            workspaceID = record.workspace; workspaceName = record.workspaceName
            papers = library + entries.values.map(\.paper).filter { p in !library.contains { $0.id == p.id } }
            recentPageIDs = recent; offlineEntries = entries; isOffline = true; requiresLogin = false
            status = "Opening saved workspace · connecting to Gamma"
            await reconnectSession()
            if sessionLifecycle.foreground { sessionDidBecomeActive() }
        } catch {
            // A locked/unavailable Keychain is not an expired cookie. Don't erase it.
            errorMessage = "Saved session could not be opened securely. Unlock the iPad and try again."
            didRestoreSession = false
        }
    }

    /// Called before committing a newly authenticated workspace to visible state.
    func persistVerifiedSession(client: GammaAPI, user: String, option: GammaWorkspaceOption) throws {
        let record = try GammaSavedSession(server: client.baseURL, username: user, workspace: option, cookies: client.sessionCookies())
        try sessionStore.save(record)
        savedSession = record; requiresLogin = false; sessionLifecycle.failureSince = nil
        sessionLifecycle.graceTask?.cancel(); sessionLifecycle.graceTask = nil
    }

    func sessionDidBecomeActive() {
        sessionLifecycle.foreground = true
        guard savedSession != nil, !requiresLogin else { return }
        if sessionLifecycle.monitor == nil {
            let monitor = NWPathMonitor()
            let generation = accountGeneration
            monitor.pathUpdateHandler = { [weak self] path in
                let available = path.status == .satisfied
                Task { @MainActor [weak self] in
                    guard let self, self.sessionLifecycle.foreground,
                          self.accountGeneration == generation, self.savedSession != nil, !self.requiresLogin else { return }
                    if available { self.scheduleSessionRetry(immediate: true) }
                    else { self.handleSessionFailure(URLError(.notConnectedToInternet)) }
                }
            }
            sessionLifecycle.monitor = monitor
            monitor.start(queue: DispatchQueue(label: "Gamma.session.connectivity"))
        }
        scheduleSessionRetry(immediate: true)
    }
    func sessionDidEnterBackground() {
        sessionLifecycle.foreground = false
        sessionLifecycle.cancel()
    }

    /// Read-only authentication probe, then resume the original outbox unchanged.
    /// Timeout/DNS/connection loss is NOT a failed login.
    func reconnectSession() async {
        guard !busy, !syncing, hydratingPages.isEmpty, !sessionLifecycle.probing, !requiresLogin, let record = savedSession,
              username == record.username, workspaceID == record.workspace,
              GammaCache.canonicalServer(accountServer) == record.server else { return }
        sessionLifecycle.probing = true
        defer { sessionLifecycle.probing = false }
        let generation = accountGeneration, validation = sessionLifecycle.validationID
        var candidate: GammaAPI?
        do {
            let client = try sessionAPIFactory(record.server); candidate = client
            client.installSessionCookies(try record.cookies())
            let info = try await client.session()
            try Task.checkCancellation()
            guard generation == accountGeneration, validation == sessionLifecycle.validationID else { client.close(); return }
            let option = try record.validate(info)
            try client.bind(workspace: option.id)
            // Persist renewal only after validation; no partial identity on failure.
            try persistVerifiedSession(client: client, user: record.username, option: option)
            workspaceOptions = info.workspaces; workspaceName = option.name
            let wasDisconnected = isOffline || api == nil
            if wasDisconnected {
                stopOfflineWorker(); api?.close(); api = client; candidate = nil
                isOffline = false; syncUnavailable = false; errorMessage = nil
                status = "Connected to Gamma · \(workspaceDisplayName)"
                restoreOfflineQueue()
                await refreshLibrary()
                guard generation == accountGeneration, !requiresLogin, !isOffline else { return }
                await sync()
                // Native pending edits must never be replaced by a stale Web tree.
                if webSession == nil, (try? pendingOutbox().filter { $0.kind != .inkPreview }.isEmpty) == true {
                    webSession = GammaWebSession(id: UUID(), serverURL: client.baseURL,
                        workspace: workspaceID, cookies: client.sessionCookies())
                }
            } else {
                client.close(); candidate = nil
                startOfflineWorker()
                await sync()
            }
        } catch {
            candidate?.close()
            guard generation == accountGeneration, validation == sessionLifecycle.validationID, !Task.isCancelled else { return }
            handleSessionFailure(error)
        }
    }

    func scheduleSessionRetry(immediate: Bool = false) {
        guard sessionLifecycle.foreground, savedSession != nil, !requiresLogin,
              sessionLifecycle.retryTask == nil else { return }
        let id = UUID(), generation = accountGeneration
        sessionLifecycle.retryID = id
        sessionLifecycle.retryTask = Task { [weak self] in
            var delay: UInt64 = immediate ? 0 : 2
            while !Task.isCancelled {
                if delay > 0 {
                    do { try await Task.sleep(nanoseconds: delay * 1_000_000_000) } catch { break }
                }
                guard let self, self.accountGeneration == generation, !self.requiresLogin,
                      self.sessionLifecycle.foreground else { break }
                self.applyOfflineGrace()
                await self.reconnectSession()
                if self.sessionLifecycle.failureSince == nil { delay = 30 }
                else { delay = min(30, max(2, delay * 2)) }
            }
            guard let self, self.sessionLifecycle.retryID == id else { return }
            self.sessionLifecycle.retryTask = nil
        }
    }

    @discardableResult
    func handleSessionFailure(_ error: Error) -> Bool {
        if error is CancellationError || (error as? URLError)?.code == .cancelled { return true }
        if let failure = error as? GammaAPI.APIError {
            switch failure {
            case .unauthorized, .accountChanged, .workspaceAccessDenied:
                sessionLifecycle.cancel(); stopOfflineWorker()
                accountGeneration = UUID()
                api?.clearSessionCookies(); api?.close(); api = nil; webSession = nil
                isOffline = cache != nil; syncUnavailable = true; requiresLogin = true
                // 403 retains the selected workspace and cookie for an explicit
                // same-workspace retry; never picks the server's default instead.
                if case .workspaceAccessDenied = failure {} else {
                    if savedSession != nil {
                        do { try sessionStore.clear() }
                        catch {
                            // Keep the deletion failure visible; the rejected record
                            // must never be used again in this running session.
                            savedSession = nil
                            status = failure.localizedDescription
                            errorMessage = "Secure session could not be removed. Unlock the iPad and sign out again. Local files are preserved."
                            return true
                        }
                    }
                    savedSession = nil
                }
                status = failure.localizedDescription
                errorMessage = failure.localizedDescription
                return true
            case .temporarilyUnavailable: break
            default: return false
            }
        } else {
            guard let network = error as? URLError,
                  [.timedOut, .cannotFindHost, .cannotConnectToHost, .networkConnectionLost,
                   .dnsLookupFailed, .notConnectedToInternet, .internationalRoamingOff,
                   .dataNotAllowed, .resourceUnavailable].contains(network.code) else { return false }
        }
        if sessionLifecycle.failureSince == nil {
            sessionLifecycle.failureSince = Date()
            let generation = accountGeneration
            let delay = UInt64(max(0, sessionLifecycle.graceInterval) * 1_000_000_000)
            sessionLifecycle.graceTask = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: delay) } catch { return }
                guard let self, self.accountGeneration == generation else { return }
                self.applyOfflineGrace()
                self.sessionLifecycle.graceTask = nil
            }
        }
        // No modal error, session deletion, or Web teardown for a brief interruption.
        applyOfflineGrace()
        scheduleSessionRetry()
        return true
    }
    func applyOfflineGrace(now: Date = Date()) {
        guard let since = sessionLifecycle.failureSince,
              now.timeIntervalSince(since) >= sessionLifecycle.graceInterval, !requiresLogin else { return }
        isOffline = cache != nil
        // Keep the authenticated client and Web identity alive; native reads use
        // only local cache while offline. The root can show its local library.
        stopOfflineWorker()
        status = "Offline · saved on this iPad · reconnecting automatically"
    }
}
