import XCTest
@testable import GammaIPad

private final class MemorySessionStore: GammaSessionPersistence {
    var value: GammaSavedSession?
    var writes = 0
    var clears = 0
    var refuseWrites = false
    init(_ value: GammaSavedSession? = nil) { self.value = value }
    func load() throws -> GammaSavedSession? { value }
    func save(_ session: GammaSavedSession) throws {
        if refuseWrites { throw CocoaError(.fileWriteNoPermission) }
        value = session; writes += 1
    }
    func clear() throws { value = nil; clears += 1 }
}

private final class SessionFixtureProtocol: URLProtocol {
    static var reply: (URLRequest) throws -> (Int, String) = { _ in (500, "") }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, body) = try Self.reply(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor
final class GammaSessionPersistenceTests: XCTestCase {
    private let server = URL(string: "https://session-fixture.invalid/gamma")!
    private let option = GammaWorkspaceOption(id: "ws-shared", name: "Shared", role: "editor")
    private let validInfo = #"{"user":"alice","default_workspace":"ws-other","workspaces":[{"id":"ws-shared","name":"Shared","role":"editor"},{"id":"ws-other","name":"Other","role":"owner"}]}"#
    private func cookie(value: String = "fixture-session-secret", domain: String = "session-fixture.invalid", expires: Date? = nil) -> HTTPCookie {
        var fields: [HTTPCookiePropertyKey: Any] = [.name: "session", .value: value, .domain: domain,
            .path: "/", .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE"]
        if let expires { fields[.expires] = expires }
        return HTTPCookie(properties: fields)!
    }
    private func record() throws -> GammaSavedSession {
        try GammaSavedSession(server: server, username: "alice", workspace: option, cookies: [cookie()])
    }
    private func client(_ server: String) throws -> GammaAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionFixtureProtocol.self]
        config.timeoutIntervalForRequest = 0.5
        return try GammaAPI(server: server, configuration: config)
    }
    private func temporaryRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("session-test-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    private func fixture(store: MemorySessionStore, root: URL) -> GammaWorkspace {
        let value = GammaWorkspace(sessionStore: store, sessionCacheRoot: root, sessionAPIFactory: { [self] in try client($0) })
        // Tests drive the retry/probe entry directly, never a real network monitor.
        value.sessionLifecycle.foreground = false
        return value
    }

    func testCookieRecordRoundTripsWithoutPasswordsOrUnrelatedCookies() throws {
        let unrelated = HTTPCookie(properties: [.name: "preferences", .value: "do-not-store", .domain: server.host!, .path: "/"])!
        let original = try GammaSavedSession(server: server, username: "alice", workspace: option,
                                            cookies: [cookie(), unrelated])
        let data = try JSONEncoder().encode(original)
        let restored = try JSONDecoder().decode(GammaSavedSession.self, from: data)
        XCTAssertEqual(restored.server, GammaCache.canonicalServer(server))
        XCTAssertEqual(restored.workspace, option.id)
        XCTAssertEqual(try restored.cookies().map(\.name), ["session"])
        XCTAssertEqual(try restored.cookies().first?.value, "fixture-session-secret")
        XCTAssertTrue(try XCTUnwrap(restored.cookies().first).isHTTPOnly)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("password"))
        XCTAssertThrowsError(try GammaSavedSession(server: server, username: "alice", workspace: option, cookies: [cookie(domain: "other.invalid")]))
        XCTAssertThrowsError(try GammaSavedSession(server: server, username: "alice", workspace: option, cookies: [cookie(expires: Date(timeIntervalSinceNow: -60))]))
    }

    func testRestoredCookiesStayUnboundUntilVerifiedAndDoNotLeakBetweenClients() async throws {
        let first = try client(server.absoluteString), second = try client(server.absoluteString)
        defer { first.close(); second.close() }
        first.installSessionCookies(try record().cookies())
        XCTAssertEqual(first.sessionCookies().count, 1)
        XCTAssertTrue(second.sessionCookies().isEmpty)
        XCTAssertThrowsError(try first.makeRequest("api/blocks/root/children"))
        SessionFixtureProtocol.reply = { [validInfo] _ in (200, validInfo) }
        let info = try await first.session()
        let chosen = try record().validate(info)
        try first.bind(workspace: chosen.id)
        let request = try first.makeRequest("api/blocks/root/children")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Gamma-User"), "alice")
        XCTAssertEqual(request.value(forHTTPHeaderField: "X-Gamma-Workspace"), "ws-shared")
    }

    func testLaunchRestoresExactWorkspaceWithoutLoginOrDefaultFallback() async throws {
        let root = try temporaryRoot(), store = MemorySessionStore(try record())
        var paths: [String] = []
        SessionFixtureProtocol.reply = { [validInfo] request in
            paths.append(request.url!.path)
            if request.url!.path.hasSuffix("/api/session") { return (200, validInfo) }
            return (200, #"{"children":[]}"#)
        }
        let value = fixture(store: store, root: root)
        await value.restoreSession(); value.sessionDidEnterBackground()
        XCTAssertEqual(value.username, "alice")
        XCTAssertEqual(value.workspaceID, "ws-shared")
        XCTAssertFalse(value.isOffline); XCTAssertFalse(value.requiresLogin)
        XCTAssertNotNil(value.webSession)
        XCTAssertFalse(paths.contains { $0.hasSuffix("/login") })
        let count = paths.count
        await value.restoreSession()
        XCTAssertEqual(paths.count, count)
        value.api?.close()
    }

    func testTimeoutKeepsSavedSessionAndCacheThenReconnectsSameWorkspace() async throws {
        let root = try temporaryRoot(), store = MemorySessionStore(try record())
        SessionFixtureProtocol.reply = { _ in throw URLError(.timedOut) }
        let value = fixture(store: store, root: root)
        await value.restoreSession(); value.sessionDidEnterBackground()
        XCTAssertEqual(value.username, "alice"); XCTAssertTrue(value.isOffline)
        XCTAssertFalse(value.requiresLogin); XCTAssertNotNil(store.value); XCTAssertEqual(store.clears, 0)
        XCTAssertNil(value.api)
        SessionFixtureProtocol.reply = { [validInfo] request in
            request.url!.path.hasSuffix("/session") ? (200, validInfo) : (200, #"{"children":[]}"#)
        }
        await value.reconnectSession()
        XCTAssertFalse(value.isOffline); XCTAssertEqual(value.api?.workspace, "ws-shared")
        value.api?.close()
    }

    func testExpiredSessionRequiresExplicitLoginWithoutErasingCachedOutbox() async throws {
        let root = try temporaryRoot(), store = MemorySessionStore(try record())
        let cache = try GammaCache(rootURL: root, server: server, username: "alice", workspace: "ws-shared")
        var snapshot = try cache.loadPage(pageID: "page", docID: "doc")
        snapshot.outbox = [GammaMutation(kind: .content, blockID: "note", parentID: "page", content: "local", workspace: "ws-shared")]
        try cache.savePage(snapshot)
        SessionFixtureProtocol.reply = { _ in (401, "{}") }
        let value = fixture(store: store, root: root)
        await value.restoreSession(); value.sessionDidEnterBackground()
        XCTAssertTrue(value.requiresLogin); XCTAssertTrue(value.isOffline)
        XCTAssertNil(value.api); XCTAssertNil(value.webSession); XCTAssertNil(store.value)
        XCTAssertEqual(value.username, "alice"); XCTAssertEqual(value.workspaceID, "ws-shared")
        XCTAssertEqual(try cache.loadPage(pageID: "page", docID: "doc").outbox.map(\.id), snapshot.outbox.map(\.id))
    }

    func testWrongAccountAndViewerNeverReadDataOrSwitchWorkspace() async throws {
        for body in [#"{"user":"bob","workspaces":[{"id":"ws-shared","role":"editor"}]}"#,
                     #"{"user":"alice","default_workspace":"ws-other","workspaces":[{"id":"ws-shared","role":"viewer"},{"id":"ws-other","role":"owner"}]}"#,
                     #"{"user":null}"#] {
            let root = try temporaryRoot(), store = MemorySessionStore(try record())
            var dataRequests = 0
            SessionFixtureProtocol.reply = { request in
                if !request.url!.path.hasSuffix("/session") { dataRequests += 1 }
                return (200, body)
            }
            let value = fixture(store: store, root: root)
            await value.restoreSession(); value.sessionDidEnterBackground()
            XCTAssertTrue(value.requiresLogin); XCTAssertNil(value.api)
            XCTAssertEqual(value.workspaceID, "ws-shared"); XCTAssertEqual(value.username, "alice")
            XCTAssertEqual(dataRequests, 0)
        }
    }

    func testGraceDoesNotLogoutOrDiscardWebSessionAndLogoutRetainsCacheFiles() async throws {
        let root = try temporaryRoot(), store = MemorySessionStore(try record())
        let cache = try GammaCache(rootURL: root, server: server, username: "alice", workspace: "ws-shared")
        let value = GammaWorkspace(cache: cache, sessionStore: store)
        value.savedSession = try record(); value.isOffline = false; value.sessionLifecycle.foreground = false
        let web = GammaWebSession(id: UUID(), serverURL: server, workspace: "ws-shared", cookies: [cookie()])
        value.webSession = web
        XCTAssertTrue(value.handleSessionFailure(URLError(.networkConnectionLost)))
        XCTAssertFalse(value.isOffline); XCTAssertFalse(value.requiresLogin)
        XCTAssertEqual(value.webSession?.id, web.id); XCTAssertNotNil(store.value)
        value.applyOfflineGrace(now: Date(timeIntervalSinceNow: 20))
        XCTAssertTrue(value.isOffline); XCTAssertEqual(value.webSession?.id, web.id)
        await value.signOut()
        XCTAssertNil(store.value); XCTAssertNil(value.savedSession); XCTAssertNil(value.username)
        XCTAssertTrue(FileManager.default.fileExists(atPath: cache.rootURL.path))
    }

    func testHTTP403PreservesSelectedWorkspaceAndStopsAutomaticRetries() async throws {
        let root = try temporaryRoot(), store = MemorySessionStore(try record())
        SessionFixtureProtocol.reply = { _ in (403, "{}") }
        let value = fixture(store: store, root: root)
        await value.restoreSession(); value.sessionDidEnterBackground()
        XCTAssertTrue(value.requiresLogin); XCTAssertTrue(value.syncUnavailable)
        XCTAssertEqual(value.workspaceID, "ws-shared"); XCTAssertNil(value.api)
        XCTAssertNotNil(store.value); XCTAssertNil(value.sessionLifecycle.retryTask)
    }

    func testSecureStorageFailureDoesNotReplaceSession() throws {
        let root = try temporaryRoot(), store = MemorySessionStore(try record())
        store.refuseWrites = true
        let value = fixture(store: store, root: root)
        let client = try client(server.absoluteString)
        defer { client.close() }
        client.installSessionCookies([cookie(value: "replacement")])
        XCTAssertThrowsError(try value.persistVerifiedSession(client: client, user: "alice", option: option))
        XCTAssertNil(value.savedSession)
        XCTAssertEqual(try store.value?.cookies().first?.value, "fixture-session-secret")
        XCTAssertEqual(store.writes, 0)
    }

    func testLateValidationCannotReviveAChangedAccountGeneration() async throws {
        let root = try temporaryRoot(), store = MemorySessionStore(try record())
        let value = fixture(store: store, root: root)
        value.savedSession = try record(); value.username = "alice"
        value.accountServer = GammaCache.canonicalServer(server); value.workspaceID = "ws-shared"
        let requested = expectation(description: "session probe started")
        let release = DispatchSemaphore(value: 0)
        SessionFixtureProtocol.reply = { [validInfo] _ in
            requested.fulfill()
            _ = release.wait(timeout: .now() + 3)
            return (200, validInfo)
        }
        let task = Task { await value.reconnectSession() }
        await fulfillment(of: [requested], timeout: 2)
        value.accountGeneration = UUID(); value.username = nil
        release.signal()
        await task.value
        XCTAssertNil(value.api); XCTAssertNil(value.username); XCTAssertNil(value.webSession)
        XCTAssertEqual(store.writes, 0)
    }

    func testFailedLoginDoesNotWritePartialSession() async throws {
        let root = try temporaryRoot(), previous = try record(), store = MemorySessionStore(previous)
        SessionFixtureProtocol.reply = { _ in (401, "{}") }
        let value = fixture(store: store, root: root)
        await value.login(server: server.absoluteString, username: "alice", password: "fixture-not-real")
        value.sessionDidEnterBackground()
        XCTAssertEqual(store.writes, 0); XCTAssertEqual(store.value?.workspace, previous.workspace)
        XCTAssertNil(value.username)
    }
}
