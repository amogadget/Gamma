import XCTest
import PDFKit
@testable import GammaIPad

private final class DisconnectSessionStore: GammaSessionPersistence {
    var value: GammaSavedSession?
    var clears = 0
    var refuseClear = false
    func load() throws -> GammaSavedSession? { value }
    func save(_ session: GammaSavedSession) throws { value = session }
    func clear() throws {
        if refuseClear { throw CocoaError(.fileWriteNoPermission) }
        clears += 1; value = nil
    }
}

private final class DisconnectProbeProtocol: URLProtocol {
    static var started: (() -> Void)?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() { Self.started?() } // Suspended until client cancellation.
    override func stopLoading() {}
}

@MainActor
final class GammaServerDisconnectTests: XCTestCase {
    private func fixture(blockLocal: Bool = false) throws -> (GammaWorkspace, GammaCache, DisconnectSessionStore, UserDefaults) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "GammaServerDisconnectTests.\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock {
            try? FileManager.default.removeItem(at: root)
            defaults.removePersistentDomain(forName: suite)
        }
        let server = URL(string: "https://disconnect.invalid")!
        let cache = try GammaCache(rootURL: root.appendingPathComponent("server"), server: server,
                                   username: "alice", workspace: "ws-alpha")
        let store = DisconnectSessionStore()
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.name: "session", .value: "fixture",
            .domain: server.host!, .path: "/", .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE"]))
        store.value = try GammaSavedSession(server: server, username: "alice",
            workspace: GammaWorkspaceOption(id: "ws-alpha", name: "Server", role: "owner"), cookies: [cookie])
        let local = root.appendingPathComponent("local")
        if blockLocal { try Data("not a directory".utf8).write(to: local) }
        let workspace = GammaWorkspace(cache: cache, sessionStore: store, localLibraryRoot: local,
            libraryDefaults: defaults, sessionAPIFactory: { address in
                let configuration = URLSessionConfiguration.ephemeral
                configuration.protocolClasses = [DisconnectProbeProtocol.self]
                return try GammaAPI(server: address, configuration: configuration)
            })
        workspace.savedSession = store.value
        workspace.sessionLifecycle.foreground = false
        workspace.webSession = GammaWebSession(id: UUID(), serverURL: server, workspace: "ws-alpha", cookies: [cookie])
        defaults.set("server", forKey: "gamma.libraryMode")
        defaults.set(server.absoluteString, forKey: "gamma.server")
        defaults.set("alice", forKey: "gamma.username")
        defaults.set("ws-alpha", forKey: GammaWorkspace.preferenceKey(server: server.absoluteString, username: "alice"))
        return (workspace, cache, store, defaults)
    }

    func testSignedOutWebWithoutPDFDisconnectsAndClearsOnlyCredentials() async throws {
        let (workspace, cache, store, defaults) = try fixture()
        workspace.username = nil // Web logout must not strand the server view.
        XCTAssertNil(workspace.paper); XCTAssertNil(workspace.document)
        XCTAssertTrue(workspace.canDisconnectServer)
        let disconnected = await workspace.disconnectServerToLocal()
        XCTAssertTrue(disconnected); XCTAssertTrue(workspace.isLocal)
        XCTAssertNil(workspace.api); XCTAssertNil(workspace.webSession)
        XCTAssertNil(workspace.username); XCTAssertEqual(workspace.accountServer, "")
        XCTAssertNil(store.value); XCTAssertEqual(store.clears, 1)
        XCTAssertNil(defaults.string(forKey: "gamma.server"))
        XCTAssertNil(defaults.string(forKey: "gamma.username"))
        XCTAssertNil(defaults.string(forKey: GammaWorkspace.preferenceKey(server: cache.server, username: cache.username)))
        XCTAssertEqual(defaults.string(forKey: "gamma.libraryMode"), "local")
        XCTAssertTrue(FileManager.default.fileExists(atPath: cache.rootURL.path))
        let resumed = await workspace.resumeServerLibrary()
        XCTAssertFalse(resumed); XCTAssertTrue(workspace.isLocal)
        await workspace.restoreSession()
        XCTAssertTrue(workspace.isLocal); XCTAssertNil(workspace.api)
    }

    func testLocalStorageFailureRetainsServerSessionAndPreferences() async throws {
        let (workspace, cache, store, defaults) = try fixture(blockLocal: true)
        let web = workspace.webSession?.id
        let disconnected = await workspace.disconnectServerToLocal()
        XCTAssertFalse(disconnected); XCTAssertFalse(workspace.isLocal)
        XCTAssertTrue(workspace.cache === cache); XCTAssertEqual(workspace.webSession?.id, web)
        XCTAssertEqual(workspace.username, "alice"); XCTAssertNotNil(store.value)
        XCTAssertEqual(store.clears, 0); XCTAssertEqual(defaults.string(forKey: "gamma.libraryMode"), "server")
        XCTAssertNotNil(workspace.errorMessage)
    }

    func testPendingNativeOutboxStaysByteForByteInOriginalCache() async throws {
        let (workspace, cache, _, _) = try fixture()
        var snapshot = GammaPageCache(pageID: "page", docID: "doc", workspace: "ws-alpha")
        snapshot.outbox = [GammaMutation(kind: .content, blockID: "note", parentID: "page", content: "unsent", workspace: "ws-alpha")]
        try cache.savePage(snapshot)
        workspace.page = snapshot
        let path = cache.rootURL.appendingPathComponent("page-\(GammaCache.key("page")).json")
        let before = try Data(contentsOf: path)
        XCTAssertTrue(workspace.canDisconnectServer)
        let disconnected = await workspace.disconnectServerToLocal()
        XCTAssertTrue(disconnected)
        XCTAssertEqual(try Data(contentsOf: path), before)
        XCTAssertEqual(try cache.pendingPages().first?.outbox.map(\.id), snapshot.outbox.map(\.id))
        XCTAssertTrue(try XCTUnwrap(workspace.cache).pendingPages().isEmpty)
        XCTAssertNil(workspace.page)
    }

    func testRecoveryIsOpaqueProtectedAndBoundToRetainedCacheIdentity() async throws {
        let (workspace, cache, _, _) = try fixture()
        workspace.username = nil
        let recovery = Data(#"{"user":null,"path":"../../must-not-write","pending":[{"text":"unsent"}]}"#.utf8)
        let disconnected = await workspace.disconnectServerToLocal(recovery: recovery)
        XCTAssertTrue(disconnected)
        let files = try FileManager.default.contentsOfDirectory(at: cache.rootURL, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("web-recovery-") }
        let file = try XCTUnwrap(files.first)
        XCTAssertEqual(files.count, 1)
        let envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        XCTAssertEqual(envelope["server"] as? String, cache.server)
        XCTAssertEqual(envelope["username"] as? String, "alice")
        XCTAssertEqual(envelope["workspace"] as? String, "ws-alpha")
        let payload = try XCTUnwrap(envelope["payload"] as? [String: Any])
        XCTAssertTrue(payload["user"] is NSNull)
        XCTAssertEqual(payload["path"] as? String, "../../must-not-write")
        #if !targetEnvironment(simulator)
        // The simulator filesystem does not expose iOS data-protection classes.
        // Keep this assertion on real iOS while testing bytes/scope on both.
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        XCTAssertEqual(attributes[.protectionKey] as? FileProtectionType, .completeUntilFirstUserAuthentication)
        #endif
    }

    func testCorruptArrayAndOversizedRecoveryRefuseWithoutDeletingAnything() async throws {
        let (workspace, cache, store, _) = try fixture()
        let before = try FileManager.default.contentsOfDirectory(atPath: cache.rootURL.path).sorted()
        for data in [Data("broken".utf8), Data("[]".utf8), Data(repeating: 32, count: 32 * 1024 * 1024 + 1)] {
            let disconnected = await workspace.disconnectServerToLocal(recovery: data)
            XCTAssertFalse(disconnected); XCTAssertTrue(workspace.cache === cache)
            XCTAssertNotNil(workspace.webSession); XCTAssertEqual(store.clears, 0)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.rootURL.path).sorted(), before)
        }
    }

    func testRecoveryFromMismatchedWebWorkspaceIsRejected() async throws {
        let (workspace, cache, store, _) = try fixture()
        workspace.webSession = GammaWebSession(id: UUID(), serverURL: URL(string: cache.server)!,
            workspace: "ws-other", cookies: [])
        let disconnected = await workspace.disconnectServerToLocal(recovery: Data("{}".utf8))
        XCTAssertFalse(disconnected); XCTAssertTrue(workspace.cache === cache)
        XCTAssertEqual(store.clears, 0)
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: cache.rootURL.path)
            .contains { $0.hasPrefix("web-recovery-") })
    }

    func testCredentialDeletionFailureKeepsConnectedIdentityAndRecovery() async throws {
        let (workspace, cache, store, defaults) = try fixture()
        store.refuseClear = true
        let disconnected = await workspace.disconnectServerToLocal(recovery: Data("{}".utf8))
        XCTAssertFalse(disconnected); XCTAssertFalse(workspace.isLocal)
        XCTAssertTrue(workspace.cache === cache); XCTAssertNotNil(workspace.webSession)
        XCTAssertNotNil(store.value); XCTAssertEqual(workspace.username, "alice")
        XCTAssertEqual(defaults.string(forKey: "gamma.libraryMode"), "server")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: cache.rootURL.path)
            .filter { $0.hasPrefix("web-recovery-") }.count, 1)
    }

    func testActiveWriterAndSyncRefuseDisconnect() async throws {
        let (workspace, cache, store, _) = try fixture()
        workspace.nativeWriteInProgress = true
        XCTAssertFalse(workspace.canDisconnectServer)
        let writing = await workspace.disconnectServerToLocal()
        XCTAssertFalse(writing); XCTAssertTrue(workspace.cache === cache)
        workspace.nativeWriteInProgress = false; workspace.syncing = true
        XCTAssertFalse(workspace.canDisconnectServer)
        let syncing = await workspace.disconnectServerToLocal()
        XCTAssertFalse(syncing); XCTAssertEqual(store.clears, 0)
    }

    func testFailedNativeSaveRefusesDisconnect() async throws {
        let (workspace, originalCache, store, _) = try fixture()
        let failingLocal = try GammaCache.local(rootURL: originalCache.rootURL.deletingLastPathComponent().appendingPathComponent("failed-local"),
            writeOverride: { _, _ in throw CocoaError(.fileWriteOutOfSpace) })
        // The retained failed-save transaction is private; produce it via the
        // public native write path, then verify the server switch guard honors it.
        workspace.cache = failingLocal; workspace.isLocal = true
        let document = PDFDocument(); document.insert(PDFPage(), at: 0)
        workspace.document = document
        workspace.page = GammaPageCache(pageID: "page", docID: "doc", workspace: "local-library")
        XCTAssertThrowsError(try workspace.newInk(pdfPage: 1))
        XCTAssertTrue(workspace.hasFailedNativeSave)
        workspace.cache = originalCache; workspace.isLocal = false
        XCTAssertFalse(workspace.canDisconnectServer)
        let disconnected = await workspace.disconnectServerToLocal()
        XCTAssertFalse(disconnected); XCTAssertEqual(store.clears, 0)
    }

    func testDisconnectDuringLaunchProbeCannotRestoreServerPreference() async throws {
        let (initialWorkspace, cache, store, defaults) = try fixture()
        let workspace = GammaWorkspace(sessionStore: store,
            sessionCacheRoot: cache.rootURL.deletingLastPathComponent(),
            localLibraryRoot: initialWorkspace.localLibraryRoot, libraryDefaults: defaults,
            sessionAPIFactory: initialWorkspace.sessionAPIFactory)
        workspace.sessionLifecycle.foreground = false
        let started = expectation(description: "launch probe started")
        DisconnectProbeProtocol.started = { started.fulfill() }
        defer { DisconnectProbeProtocol.started = nil }
        let launch = Task { await workspace.restoreInitialLibrary() }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(workspace.restoringSession)
        let disconnected = await workspace.disconnectServerToLocal()
        XCTAssertTrue(disconnected)
        await launch.value
        XCTAssertTrue(workspace.isLocal); XCTAssertTrue(workspace.canChangeLibrary)
        XCTAssertEqual(defaults.string(forKey: "gamma.libraryMode"), "local")
        XCTAssertNil(store.value); XCTAssertNil(workspace.webSession)
    }

    func testDisconnectCancelsOngoingProbeWithoutLeavingLocalSwitchDisabled() async throws {
        let (workspace, _, store, _) = try fixture()
        let started = expectation(description: "read-only probe started")
        DisconnectProbeProtocol.started = { started.fulfill() }
        defer { DisconnectProbeProtocol.started = nil }
        let probe = Task { await workspace.reconnectSession() }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertTrue(workspace.sessionLifecycle.probing)
        workspace.restoringSession = true // Same probe can be driven by launch restore.
        XCTAssertTrue(workspace.canDisconnectServer)
        let disconnected = await workspace.disconnectServerToLocal()
        XCTAssertTrue(disconnected); XCTAssertFalse(workspace.sessionLifecycle.probing)
        XCTAssertTrue(workspace.canChangeLibrary)
        await probe.value
        XCTAssertTrue(workspace.isLocal); XCTAssertTrue(workspace.canChangeLibrary)
        XCTAssertNil(workspace.webSession); XCTAssertNil(workspace.api); XCTAssertNil(store.value)
    }
}
