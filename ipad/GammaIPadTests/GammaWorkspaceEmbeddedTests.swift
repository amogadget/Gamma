#if GAMMA_EMBEDDED_BACKEND
import XCTest
@testable import GammaIPad

private final class EmbeddedCoordinatorSessionStore: GammaSessionPersistence {
    var loads = 0
    var saves = 0
    var clears = 0
    func load() throws -> GammaSavedSession? { loads += 1; return nil }
    func save(_ session: GammaSavedSession) throws { saves += 1 }
    func clear() throws { clears += 1 }
}

/// Coordinator unit tests only. These do not substitute for the embedded host's
/// real bootstrap/HTTP/WebKit integration tests on an iPad or simulator.
@MainActor
final class GammaWorkspaceEmbeddedTests: XCTestCase {
    func testEmbeddedUsesBackendSnapshotsNotStandaloneSnapshots() {
        let workspace = GammaWorkspace(sessionStore: EmbeddedCoordinatorSessionStore())
        workspace.isLocal = true
        XCTAssertTrue(workspace.usesLocalOnlySnapshots)
        workspace.isEmbeddedLocal = true
        XCTAssertFalse(workspace.usesLocalOnlySnapshots)
        workspace.isLocal = false; workspace.isEmbeddedLocal = false
        XCTAssertFalse(workspace.usesLocalOnlySnapshots)
    }

    func testEmbeddedFailureNeverDeletesCredentialsOrStartsRemoteMonitor() async throws {
        let store = EmbeddedCoordinatorSessionStore()
        let workspace = GammaWorkspace(sessionStore: store)
        workspace.isLocal = true; workspace.isEmbeddedLocal = true
        workspace.username = "device-account"; workspace.workspaceID = "device-workspace"
        XCTAssertTrue(workspace.handleSessionFailure(GammaAPI.APIError.unauthorized))
        XCTAssertTrue(workspace.isOffline)
        XCTAssertTrue(workspace.syncUnavailable)
        XCTAssertFalse(workspace.requiresLogin)
        XCTAssertEqual(workspace.username, "device-account")
        XCTAssertEqual(workspace.workspaceID, "device-workspace")
        workspace.sessionDidBecomeActive()
        await workspace.reconnectSession()
        XCTAssertNil(workspace.sessionLifecycle.monitor)
        XCTAssertNil(workspace.sessionLifecycle.retryTask)
        XCTAssertEqual(store.loads, 0); XCTAssertEqual(store.saves, 0); XCTAssertEqual(store.clears, 0)
    }

    func testEmbeddedPrimaryAndCacheRootsAreStableAndSeparate() throws {
        let primary = try GammaWorkspace.embeddedDataRoot()
        let cache = try GammaWorkspace.embeddedCacheRoot()
        XCTAssertEqual(primary, try GammaWorkspace.embeddedDataRoot())
        XCTAssertEqual(cache, try GammaWorkspace.embeddedCacheRoot())
        XCTAssertEqual(primary.lastPathComponent, "GammaEmbeddedServer")
        XCTAssertEqual(cache.lastPathComponent, "GammaEmbeddedCache")
        XCTAssertNotEqual(primary, cache)
        XCTAssertNotEqual(primary.lastPathComponent, "GammaLocalLibrary")
    }

    func testLeavingEmbeddedLibraryAcceptsBackendCacheWithoutRetagging() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try GammaCache(rootURL: root, server: URL(string: "gamma-local://device")!,
                                   username: "device-account", workspace: "device-workspace")
        let workspace = GammaWorkspace(cache: cache, sessionStore: EmbeddedCoordinatorSessionStore())
        workspace.isLocal = true; workspace.isEmbeddedLocal = true
        var snapshot = GammaPageCache(pageID: "device-page", docID: "device-doc")
        snapshot.workspace = "device-workspace"
        snapshot.outbox = [GammaMutation(kind: .content, blockID: "note", parentID: "device-page",
                                        content: "Keep this pending change", revision: 0)]
        try cache.savePage(snapshot)
        let before = try cache.pendingPages().flatMap(\.outbox).map(\.id)
        XCTAssertEqual(before.count, 1)
        XCTAssertNoThrow(try workspace.validateLocalLibraryBeforeLeaving())
        XCTAssertTrue(workspace.handleSessionFailure(URLError(.cannotConnectToHost)))
        XCTAssertEqual(try cache.pendingPages().flatMap(\.outbox).map(\.id), before)
        XCTAssertEqual(try cache.loadPage(pageID: "device-page", docID: "device-doc").workspace, "device-workspace")
        XCTAssertFalse(cache.isLocal)
        XCTAssertEqual(cache.workspace, "device-workspace")
    }
}
#endif
