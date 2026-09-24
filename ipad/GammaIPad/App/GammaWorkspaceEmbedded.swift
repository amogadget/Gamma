#if GAMMA_EMBEDDED_BACKEND
import Foundation
import UIKit
import PDFKit

/// Only the embedded product can create this mode. The legacy library remains
/// untouched: its import/migration is separate from starting the full engine.
@MainActor
struct GammaPreparedEmbeddedLibrary {
    let client: GammaAPI
    let cache: GammaCache
    let info: GammaSessionInfo
    let option: GammaWorkspaceOption
    let papers: [GammaPaper]
    let recents: [String]
    let entries: [String: GammaOfflineEntry]
    let hasPendingNativeChanges: Bool
}

extension GammaWorkspace {
    static func embeddedDataRoot() throws -> URL {
        try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true)
            .appendingPathComponent("GammaEmbeddedServer", isDirectory: true)
    }
    static func embeddedCacheRoot() throws -> URL {
        try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true)
            .appendingPathComponent("GammaEmbeddedCache", isDirectory: true)
    }

    func prepareEmbeddedLibrary() async throws -> GammaPreparedEmbeddedLibrary {
        let host = GammaEmbeddedRuntimeController.shared
        let bootstrap: GammaEmbeddedBootstrap
        if host.state == .running, let running = host.bootstrap { bootstrap = running }
        else { bootstrap = try await host.start(dataRoot: Self.embeddedDataRoot()) }
        try Task.checkCancellation()
        let access = try GammaLocalServerAccess(trustedHostURL: bootstrap.url,
            account: bootstrap.account, workspace: bootstrap.workspace,
            sessionCookie: bootstrap.sessionCookie.httpCookie(origin: bootstrap.url),
            capabilityCookie: bootstrap.capabilityCookie.httpCookie(origin: bootstrap.url),
            capabilityHeader: bootstrap.capabilityHeader, cacheIdentity: "gamma-local://device")
        let client = GammaAPI(localServer: access)
        do {
            let info = try await client.session()
            guard info.user == bootstrap.account,
                  let option = info.option(bootstrap.workspace), option.canWrite else {
                throw GammaAPI.APIError.workspaceAccessDenied
            }
            let storage = try GammaCache(rootURL: Self.embeddedCacheRoot(),
                server: URL(string: access.cacheIdentity)!, username: bootstrap.account, workspace: bootstrap.workspace)
            try storage.updateWorkspaceName(option.name)
            try await GammaLocalLibraryMigration.run(sourceRoot: localLibraryRoot, client: client, destination: storage)
            let papers = try await client.papers()
            try Task.checkCancellation()
            try storage.saveLibrary(papers)
            return GammaPreparedEmbeddedLibrary(client: client, cache: storage, info: info, option: option,
                papers: papers, recents: try storage.recentPageIDs(), entries: try storage.loadOfflineEntries(),
                hasPendingNativeChanges: try storage.pendingPages().flatMap(\.outbox).contains { $0.kind != .inkPreview })
        } catch { client.close(); throw error }
    }

    /// All fallible work precedes this atomic MainActor mode transition.
    func commitEmbeddedLibrary(_ prepared: GammaPreparedEmbeddedLibrary) {
        sessionLifecycle.cancel(); sessionLifecycle.failureSince = nil
        accountGeneration = UUID(); restoringSession = false
        stopOfflineWorker(); closeReader(); api?.close()
        api = prepared.client; cache = prepared.cache; savedSession = nil
        username = prepared.info.user; accountServer = prepared.client.baseURL.absoluteString
        workspaceID = prepared.option.id; workspaceName = prepared.option.name
        workspaceOptions = prepared.info.workspaces
        isLocal = true; isEmbeddedLocal = true; isOffline = false
        requiresLogin = false; syncUnavailable = false
        papers = prepared.papers; recentPageIDs = prepared.recents; offlineEntries = prepared.entries
        webSession = prepared.hasPendingNativeChanges ? nil : embeddedWebSession(prepared.client)
        errorMessage = nil; status = "On this iPad · Full Gamma"
        libraryDefaults.set("local", forKey: "gamma.libraryMode")
        refreshOfflineStatus()
    }

    func embeddedWebSession(_ client: GammaAPI) -> GammaWebSession {
        GammaWebSession(id: UUID(), serverURL: client.baseURL, workspace: client.workspace,
                        cookies: [], localServerAccess: client.localServerAccess)
    }

    /// Scene backgrounding is NOT engine shutdown. iOS may suspend this process;
    /// neither Python nor the loopback server is promised execution while suspended.
    /// The root flushes PencilKit synchronously before calling this method. Keep
    /// WK, credentials and the interpreter intact even if a save needs recovery.
    func embeddedDidEnterBackground() {
        guard isEmbeddedLocal else { return }
        let application = UIApplication.shared
        let task = application.beginBackgroundTask(withName: "Save local Gamma")
        defer { if task != .invalid { application.endBackgroundTask(task) } }
        let recordingSaved = recorder.pauseBeforeLeaving()
        if hasFailedNativeSave { _ = retryNativeSave() }
        if !recordingSaved || nativeWriteInProgress || hasFailedNativeSave || hasPendingLocalInk {
            errorMessage = "Some native changes still need saving. Keep this reader open and retry the save."
        }
        // No asynchronous network flush here: native transactions/outbox are
        // synchronous disk writes; unsent operations resume in the SAME cache.
    }

    func embeddedDidBecomeActive() async {
        guard isEmbeddedLocal else { return }
        _ = await recoverEmbeddedRuntime()
    }

    /// An existing Web surface may hold drafts that cannot be recovered from a
    /// dead engine. Never replace it automatically. Root must preserve/export its
    /// recovery data or obtain explicit discard confirmation before passing true.
    /// Native outbox items NEVER authorize changing account/workspace/cache.
    @discardableResult
    func recoverEmbeddedRuntime(discardWebDraftsConfirmed: Bool = false,
                                restartRunning: Bool = false) async -> Bool {
        guard isEmbeddedLocal else { return false }
        // Explicit recovery may replace an invalidated WK even when the engine
        // appears healthy. Never let normal scene activation request that stop.
        guard !restartRunning || discardWebDraftsConfirmed else {
            errorMessage = "Confirm Web draft recovery before restarting local Gamma."
            return false
        }
        let host = GammaEmbeddedRuntimeController.shared
        if !restartRunning, host.state == .running, let bootstrap = host.bootstrap,
           let access = api?.localServerAccess,
           access.baseURL == bootstrap.url,
           access.capabilityCookie.value == bootstrap.capability {
            // Ordinary resume keeps the same WK identity and transport epoch.
            // A previous transient network error need not leave native sync frozen.
            guard !busy, !syncing, !nativeWriteInProgress, !hasFailedNativeSave else { return false }
            isOffline = false; syncUnavailable = false; requiresLogin = false
            await sync()
            return !isOffline && !syncUnavailable
        }
        guard webSession == nil || discardWebDraftsConfirmed else {
            errorMessage = "Local Gamma stopped. The Web editor was kept open to protect unsaved drafts. Recover or explicitly discard those drafts before restarting."
            return false
        }
        guard canChangeLibrary, recorder.pauseBeforeLeaving(), let storage = cache else {
            errorMessage = "Finish saving native changes before recovering local Gamma."
            return false
        }
        let generation = accountGeneration
        let oldClient = api
        let oldWebID = webSession?.id
        busy = true
        defer { busy = false }
        var candidate: GammaAPI?
        do {
            // Check the durable identity BEFORE requesting credentials, then check
            // the fresh bootstrap AND /api/session. Never select a default library.
            guard let identity = try storage.accountIdentity(),
                  identity.username == username, identity.workspace == workspaceID,
                  identity.server == "gamma-local://device", !storage.isLocal else {
                throw GammaAPI.APIError.accountChanged
            }
            if restartRunning {
                await host.stop()
                guard host.state == .stopped else {
                    throw GammaAPI.APIError.message("Local Gamma shutdown is still pending or failed. Keep this recovery open and retry; no second engine was started.")
                }
                try Task.checkCancellation()
                guard isEmbeddedLocal, generation == accountGeneration, cache === storage,
                      api === oldClient, webSession?.id == oldWebID,
                      !nativeWriteInProgress, !hasFailedNativeSave, !hasPendingLocalInk else {
                    throw CancellationError()
                }
            }
            let bootstrap = try await host.start(dataRoot: Self.embeddedDataRoot())
            guard bootstrap.account == identity.username else {
                throw GammaAPI.APIError.accountChanged
            }
            // Bootstrap names the account's default, not necessarily the local
            // workspace selected in Web. Retain the durable workspace and verify
            // its current write permission through the actual session below.
            let access = try GammaLocalServerAccess(trustedHostURL: bootstrap.url,
                account: bootstrap.account, workspace: identity.workspace,
                sessionCookie: bootstrap.sessionCookie.httpCookie(origin: bootstrap.url),
                capabilityCookie: bootstrap.capabilityCookie.httpCookie(origin: bootstrap.url),
                capabilityHeader: bootstrap.capabilityHeader, cacheIdentity: identity.server)
            let client = GammaAPI(localServer: access); candidate = client
            let info = try await client.session()
            guard info.user == identity.username, info.option(identity.workspace)?.canWrite == true else {
                throw GammaAPI.APIError.workspaceAccessDenied
            }
            try Task.checkCancellation()
            guard isEmbeddedLocal, generation == accountGeneration, cache === storage,
                  api === oldClient, webSession?.id == oldWebID,
                  !nativeWriteInProgress, !hasFailedNativeSave, !hasPendingLocalInk else {
                throw CancellationError()
            }
            // Keep the exact cache + reader, including durable pending edits. This
            // is not commitEmbeddedLibrary, which closes the reader on mode change.
            oldClient?.close(); api = client; candidate = nil
            accountServer = client.baseURL.absoluteString
            workspaceOptions = info.workspaces
            isOffline = false; syncUnavailable = false; requiresLogin = false
            webSession = nil // only reached with no Web surface or explicit consent
            errorMessage = nil; status = "On this iPad · Full Gamma"
            busy = false
            await sync()
            // Preserve native mode when it was selected. If Web was selected,
            // require successful durable outbox replay before reopening Full Gamma.
            guard isEmbeddedLocal, generation == accountGeneration, cache === storage, api === client else {
                return false
            }
            if oldWebID != nil, !isOffline, !syncUnavailable,
               (try storage.pendingPages().flatMap(\.outbox).filter { $0.kind != .inkPreview }).isEmpty {
                webSession = embeddedWebSession(client)
            }
            return !isOffline && !syncUnavailable
        } catch {
            candidate?.close()
            errorMessage = "Local Gamma recovery failed. Your current reader and saved changes were preserved. \(error.localizedDescription)"
            return false
        }
    }

    func openFromEmbeddedWeb(_ request: GammaWebOpenRequest, cookies: [HTTPCookie]) async -> Bool {
        guard isEmbeddedLocal, canChangeLibrary, recorder.pauseBeforeLeaving(),
              let client = api, let access = client.localServerAccess, let storage = cache,
              let session = webSession else { return false }
        let generation = accountGeneration
        busy = true
        defer { busy = false }
        var candidate: GammaAPI?
        do {
            try validateEmbeddedHandoffOrigin(client: client, storage: storage, session: session, generation: generation)
            // Refuse rather than discard even when Web already selected another library.
            guard try pendingOutbox().filter({ $0.kind != .inkPreview }).isEmpty else {
                throw GammaAPI.APIError.message("Sync pending native changes before reopening the native reader.")
            }
            // Local adopt probes actual /api/session; it never adopts message cookies.
            let info = try await client.adoptWebSession(cookies: cookies)
            let user = try GammaWebHandoffCheck.account(request.user, session: info).get()
            guard user == username, user == access.account else { throw GammaAPI.APIError.accountChanged }
            let option = try GammaWebHandoffCheck.workspace(request.workspace, session: info).get()
            try validateEmbeddedHandoffOrigin(client: client, storage: storage, session: session, generation: generation)
            let target: GammaAPI
            if option.id == access.workspace { target = client }
            else {
                // Copy only host-issued authority, with a NEW scope and epoch. Never
                // rebind the old API: outstanding requests remain in their old scope.
                let targetAccess = try GammaLocalServerAccess(trustedHostURL: access.baseURL,
                    account: access.account, workspace: option.id, sessionCookie: access.sessionCookie,
                    capabilityCookie: access.capabilityCookie, capabilityHeader: access.capabilityHeader,
                    cacheIdentity: access.cacheIdentity)
                target = GammaAPI(localServer: targetAccess); candidate = target
            }
            let remote = try GammaWebHandoffCheck.page(try await target.subtree(request.pageID),
                pageID: request.pageID, docID: request.docID).get()
            if target !== client {
                let prepared = try await prepareEmbeddedHandoff(client: target, info: info, option: option, paper: remote)
                try validateEmbeddedHandoffOrigin(client: client, storage: storage, session: session, generation: generation)
                guard try pendingOutbox().filter({ $0.kind != .inkPreview }).isEmpty else {
                    throw GammaAPI.APIError.message("Sync pending native changes before changing workspace.")
                }
                // Root observes the new webSession identity and retires the old WK;
                // returning from native subsequently restores only this target scope.
                commitEmbeddedLibrary(prepared); candidate = nil
            } else {
                try validateEmbeddedHandoffOrigin(client: client, storage: storage, session: session, generation: generation)
                isOffline = false; syncUnavailable = false
            }
            busy = false
            await open(remote)
            return paper?.id == request.pageID && document != nil
        } catch { candidate?.close(); errorMessage = error.localizedDescription; return false }
    }

    private func validateEmbeddedHandoffOrigin(client: GammaAPI, storage: GammaCache,
                                               session: GammaWebSession, generation: UUID) throws {
        try Task.checkCancellation()
        let host = GammaEmbeddedRuntimeController.shared
        guard isEmbeddedLocal, api === client, cache === storage, accountGeneration == generation,
              webSession?.id == session.id, let access = client.localServerAccess,
              session.localServerAccess?.epoch == access.epoch,
              webSession?.localServerAccess?.epoch == access.epoch,
              session.serverURL == access.baseURL, session.workspace == access.workspace,
              workspaceID == access.workspace, username == access.account,
              host.state == .running, let bootstrap = host.bootstrap,
              bootstrap.url == access.baseURL, bootstrap.account == access.account,
              bootstrap.capability == access.capabilityCookie.value,
              try bootstrap.sessionCookie.httpCookie(origin: bootstrap.url).value == access.sessionCookie.value,
              !nativeWriteInProgress, !hasFailedNativeSave, !hasPendingLocalInk,
              !syncing, !recorder.recording, !recorder.preparing else { throw CancellationError() }
    }

    private func prepareEmbeddedHandoff(client: GammaAPI, info: GammaSessionInfo,
                                        option: GammaWorkspaceOption, paper: GammaPaper) async throws -> GammaPreparedEmbeddedLibrary {
        guard let access = client.localServerAccess, let docID = paper.properties.docID else {
            throw GammaAPI.APIError.workspaceAccessDenied
        }
        let storage = try GammaCache(rootURL: Self.embeddedCacheRoot(),
            server: URL(string: access.cacheIdentity)!, username: access.account, workspace: option.id)
        // No legacy migration here: the original local library belongs only to
        // its initial default workspace, not every alternate Web-selected library.
        guard try storage.pendingPages().flatMap(\.outbox).filter({ $0.kind != .inkPreview }).isEmpty else {
            throw GammaAPI.APIError.message("This workspace has pending native changes. Sync them before Web handoff.")
        }
        _ = try storage.loadPage(pageID: paper.id, docID: docID)
        let source = storage.sourceURL(docID: docID)
        if !FileManager.default.fileExists(atPath: source.path) {
            let temporary = try await client.download(paper)
            defer { try? FileManager.default.removeItem(at: temporary) }
            guard let pdf = PDFDocument(url: temporary), !pdf.isLocked, pdf.pageCount > 0 else { throw NoteStoreError.invalidPDF }
            try storage.preserveSource(from: temporary, docID: docID)
        }
        guard let pdf = PDFDocument(url: source), !pdf.isLocked, pdf.pageCount > 0 else { throw NoteStoreError.invalidPDF }
        let papers = try await client.papers()
        try Task.checkCancellation()
        try storage.updateWorkspaceName(option.name)
        try storage.saveLibrary(papers)
        return GammaPreparedEmbeddedLibrary(client: client, cache: storage, info: info, option: option,
            papers: papers, recents: try storage.recentPageIDs(), entries: try storage.loadOfflineEntries(),
            hasPendingNativeChanges: false)
    }
}
#endif
