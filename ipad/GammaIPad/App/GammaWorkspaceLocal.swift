import Foundation
import PDFKit
import PencilKit

extension GammaWorkspace {
    /// MainActor snapshot writes are synchronous. The reader additionally holds
    /// nativeWriteInProgress while PencilKit has a flush or failed save pending.
    var canChangeLibrary: Bool {
        !busy && !restoringSession && !syncing && !nativeWriteInProgress && !hasFailedNativeSave && !recorder.recording && !recorder.preparing
            && hydratingPages.isEmpty && !sessionLifecycle.probing && !hasPendingLocalInk
    }

    func restoreInitialLibrary() async {
        guard !didRestoreInitialLibrary, !busy else { return }
        didRestoreInitialLibrary = true
        if cache != nil { return }
        do {
            let selectedMode = libraryDefaults.string(forKey: "gamma.libraryMode")
            // Upgrade existing installations without changing their remembered
            // account. A fresh install checks persistence only: no API is built.
            var restoreServer = selectedMode == "server"
            if selectedMode == nil { restoreServer = try sessionStore.load() != nil }
            if restoreServer {
                await restoreSession()
                if let cache, !cache.isLocal, !isLocal { libraryDefaults.set("server", forKey: "gamma.libraryMode") }
            } else {
                await enterLocalLibrary()
            }
        } catch {
            errorMessage = "Saved session could not be read securely. Unlock the iPad and try again."
        }
        if cache == nil && errorMessage != nil { didRestoreInitialLibrary = false }
    }

    /// The native toolbar must not tear down a live Web editor whose pending
    /// operations it cannot inspect. This preference changes no active session.
    func preferLocalOnNextLaunch() {
        libraryDefaults.set("local", forKey: "gamma.libraryMode")
    }

    /// Disconnect does not upload or discard the durable native outbox. A network
    /// authentication probe is cancellable, unlike an in-flight write/sync.
    var canDisconnectServer: Bool {
        !isLocal && !busy && !syncing && (!restoringSession || sessionLifecycle.probing)
            && !nativeWriteInProgress && !hasFailedNativeSave && !hasPendingLocalInk
            && !recorder.preparing && hydratingPages.isEmpty
    }

    private func prepareLocalLibrary() throws -> (GammaCache, [GammaPaper], [String]) {
        let storage = try GammaCache.local(rootURL: localLibraryRoot)
        let library = try GammaLocalLibrary(cache: storage)
        let items = try library.papers(), recents = try storage.recentPageIDs()
        // Recover only complete local snapshots, never the server's outbox.
        for snapshot in try storage.pendingPages() {
            try storage.savePage(localSnapshot(snapshot))
        }
        return (storage, items, recents)
    }

    /// No suspension or fallible storage operations after the caller's preflight.
    private func commitLocalLibrary(_ prepared: (GammaCache, [GammaPaper], [String])) {
        let (storage, items, recents) = prepared
        sessionLifecycle.cancel(); sessionLifecycle.failureSince = nil
        accountGeneration = UUID(); restoringSession = false
        stopOfflineWorker(); closeReader(); api?.close(); api = nil
        cache = storage; savedSession = nil
        username = nil; accountServer = ""; webSession = nil
        workspaceID = storage.workspace; workspaceName = "On this iPad"; workspaceOptions = []
        isLocal = true; isOffline = false; requiresLogin = false; syncUnavailable = false
        papers = items; recentPageIDs = recents; offlineEntries = [:]
        errorMessage = nil; status = "On this iPad · saved locally"
        libraryDefaults.set("local", forKey: "gamma.libraryMode")
        refreshOfflineStatus()
    }

    func enterLocalLibrary() async {
        guard canChangeLibrary, recorder.pauseBeforeLeaving() else {
            errorMessage = "Finish writing and save the recording before changing libraries."; return
        }
        #if GAMMA_EMBEDDED_BACKEND
        busy = true
        defer { busy = false }
        do {
            commitEmbeddedLibrary(try await prepareEmbeddedLibrary())
            busy = false
            _ = await prepareWebWorkspace()
        }
        catch { errorMessage = "Full Gamma on this iPad could not start. \(error.localizedDescription)" }
        #else
        do { commitLocalLibrary(try prepareLocalLibrary()) }
        catch { errorMessage = error.localizedDescription }
        #endif
    }

    /// Explicit disconnect only: the root first prepares/flushes the Web editor.
    /// No PDF or current Web login is required. Failures leave the server identity
    /// connected; already-persisted recovery is deliberately never deleted.
    @discardableResult
    func disconnectServerToLocal(recovery: Data? = nil) async -> Bool {
        guard canDisconnectServer, recorder.pauseBeforeLeaving() else {
            errorMessage = "Finish writing and save the recording before disconnecting."; return false
        }
        busy = true
        defer { busy = false }
        do {
            #if GAMMA_EMBEDDED_BACKEND
            let prepared = try await prepareEmbeddedLibrary()
            var committed = false
            defer { if !committed { prepared.client.close() } }
            #else
            let prepared = try prepareLocalLibrary()
            #endif
            if let recovery { try persistWebDisconnectRecovery(recovery) }
            // No await between preflight, credential deletion and commit. The main
            // actor cannot interleave a login, a probe completion or a second switch.
            try sessionStore.clear()
            let server = cache?.server ?? accountServer
            let user = cache?.username ?? username ?? savedSession?.username
            for defaults in [libraryDefaults, UserDefaults.standard] {
                defaults.removeObject(forKey: "gamma.server")
                defaults.removeObject(forKey: "gamma.username")
                if let user, !server.isEmpty {
                    defaults.removeObject(forKey: Self.preferenceKey(server: server, username: user))
                }
            }
            #if GAMMA_EMBEDDED_BACKEND
            commitEmbeddedLibrary(prepared)
            committed = true
            #else
            commitLocalLibrary(prepared)
            #endif
            didRestoreSession = true; didRestoreInitialLibrary = true
            #if GAMMA_EMBEDDED_BACKEND
            busy = false
            _ = await prepareWebWorkspace()
            #endif
            return true
        } catch {
            errorMessage = "Could not disconnect; the server library is still selected. \(error.localizedDescription)"
            return false
        }
    }

    func persistWebDisconnectRecovery(_ data: Data) throws {
        guard data.count <= 32 * 1024 * 1024,
              let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let storage = cache, !storage.isLocal,
              storage.workspace == workspaceID,
              (api?.cacheServerIdentity ?? GammaCache.canonicalServer(accountServer)) == storage.server,
              username == nil || username == storage.username else {
            throw GammaAPI.APIError.message("Web recovery is invalid or does not match this server library.")
        }
        if let webSession {
            guard (webSession.localServerAccess?.cacheIdentity ?? GammaCache.canonicalServer(webSession.serverURL)) == storage.server,
                  webSession.workspace == storage.workspace else {
                throw GammaAPI.APIError.message("Web recovery belongs to a different server library.")
            }
        }
        // Treat the object as opaque recovery, not a file manifest or operations.
        // Trusted outer context survives a Web logout (payload.user may be null).
        let envelope: [String: Any] = ["version": 1, "server": storage.server,
            "username": storage.username, "workspace": storage.workspace,
            "createdAt": ISO8601DateFormatter().string(from: Date()), "payload": payload]
        let encoded = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
        let target = storage.rootURL.appendingPathComponent("web-recovery-\(UUID().uuidString).json")
        try encoded.write(to: target, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// Explicit opt-in only. A saved server session remains independent of all
    /// local files. If there is no saved session, retain local mode for login UI.
    @discardableResult
    func resumeServerLibrary() async -> Bool {
        guard canChangeLibrary, recorder.pauseBeforeLeaving() else { return false }
        if !isLocal, cache != nil { return true }
        do {
            if isLocal { try validateLocalLibraryBeforeLeaving() }
            guard try sessionStore.load() != nil else { return false }
            let previousCache = cache, previousLocal = isLocal
            let previousEmbedded = isEmbeddedLocal, previousAPI = api, previousWeb = webSession
            let previousUser = username, previousServer = accountServer
            let previousWorkspace = workspaceID, previousName = workspaceName, previousOptions = workspaceOptions
            let previousPaper = paper, previousDocument = document, previousPage = page, previousSelection = selectedID
            closeReader(); isLocal = false; isEmbeddedLocal = false; cache = nil; username = nil
            api = nil; webSession = nil
            didRestoreSession = false
            await restoreSession()
            guard let restored = cache, !restored.isLocal else {
                sessionLifecycle.cancel()
                api?.close(); api = previousAPI; webSession = previousWeb
                cache = previousCache; isLocal = previousLocal; isEmbeddedLocal = previousEmbedded
                username = previousUser; accountServer = previousServer
                workspaceID = previousWorkspace; workspaceName = previousName; workspaceOptions = previousOptions
                isOffline = false; requiresLogin = false
                paper = previousPaper; document = previousDocument; page = previousPage; selectedID = previousSelection
                contentRevision += 1
                return false
            }
            previousAPI?.close()
            libraryDefaults.set("server", forKey: "gamma.libraryMode")
            return true
        } catch { errorMessage = error.localizedDescription; return false }
    }

    func importLocalPDF(url: URL) async {
        guard isLocal, canChangeLibrary, let cache, cache.isLocal else { return }
        busy = true
        do {
            let library = try GammaLocalLibrary(cache: cache)
            let imported = try library.importPDF(from: url)
            papers = try library.papers(); errorMessage = nil
            busy = false
            await open(imported)
            refreshOfflineStatus()
        } catch { busy = false; errorMessage = error.localizedDescription }
    }

    func validateLocalLibraryBeforeLeaving() throws {
        if isEmbeddedLocal {
            // Read/validate durable recovery; never collapse the backend outbox
            // into a standalone snapshot or delete it on a mode transition.
            guard let cache, !cache.isLocal else { throw CocoaError(.fileWriteNoPermission) }
            _ = try cache.pendingPages()
            return
        }
        guard let cache, cache.isLocal else { throw CocoaError(.fileWriteNoPermission) }
        for snapshot in try cache.pendingPages() {
            try cache.savePage(localSnapshot(snapshot))
        }
    }

    /// Never drop an operation just because it is local. Each operation must be
    /// represented completely by the atomically saved primary page snapshot.
    func localSnapshot(_ original: GammaPageCache) throws -> GammaPageCache {
        var snapshot = original
        guard snapshot.workspace == nil || snapshot.workspace == "local-library" else {
            throw CocoaError(.fileWriteNoPermission)
        }
        for mutation in snapshot.outbox {
            guard mutation.workspace == nil || mutation.workspace == "local-library",
                  let block = snapshot.blocks.first(where: { $0.id == mutation.blockID }),
                  block.parentID == mutation.parentID else { throw CocoaError(.fileWriteUnknown) }
            var covered = false
            switch mutation.kind {
            case .ink:
                covered = block.isInk && block.properties.pdfPage == mutation.pdfPage
                    && mutation.drawing != nil && snapshot.drawings[block.id] == mutation.drawing
                if let data = mutation.drawing { _ = try PKDrawing(data: data) }
            case .content, .child:
                covered = block.content == mutation.content
                    && (mutation.kind != .child || block.properties.nativeNote == true)
            case .audio:
                if let recording = mutation.audioSession {
                    covered = recording.pageID == snapshot.pageID && block.isAudio
                        && snapshot.recordings?[block.id] == recording
                        && block.properties.segments == recording.segments
                        && block.properties.replayEvents == recording.replayEvents
                        && block.properties.audioState == recording.serverState
                        && block.properties.duration == recording.duration
                }
            case .highlight:
                if let highlight = mutation.highlight {
                    covered = block.properties.highlightID == block.id
                        && block.properties.pdfPage == highlight.page
                        && block.properties.quote == highlight.quote
                        && block.properties.pdfPosition == highlight.position
                        && block.properties.color == mutation.highlightColor
                }
            case .inkPreview:
                // This is a server-only derivative, never a primary local write.
                covered = false
            }
            guard covered else {
                throw GammaAPI.APIError.message("Local save contains an incomplete change. Nothing was discarded; finish saving before changing libraries.")
            }
        }
        snapshot.workspace = "local-library"
        snapshot.outbox = []
        return snapshot
    }
}
