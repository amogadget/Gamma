#if GAMMA_EMBEDDED_BACKEND
import XCTest
import PDFKit
import PencilKit
@testable import GammaIPad

private final class LifecycleSessionStore: GammaSessionPersistence {
    var touches = 0
    func load() throws -> GammaSavedSession? { touches += 1; return nil }
    func save(_ session: GammaSavedSession) throws { touches += 1 }
    func clear() throws { touches += 1 }
}

/// Real bundled runtime/HTTP tests. No mock engine, login or transport. Run in
/// the embedded app host; a desktop source-contract test is not equivalent.
@MainActor
final class GammaEmbeddedLifecycleTests: XCTestCase {
    func testSuspendRetainsEngineAndRestartReplaysOnlySameWorkspace() async throws {
        let store = LifecycleSessionStore()
        let workspace = GammaWorkspace(sessionStore: store)
        await workspace.enterLocalLibrary()
        XCTAssertTrue(workspace.isEmbeddedLocal, workspace.errorMessage ?? "No embedded engine")
        let host = GammaEmbeddedRuntimeController.shared
        let first = try XCTUnwrap(host.bootstrap)
        let oldAPI = try XCTUnwrap(workspace.api)
        let oldAccess = try XCTUnwrap(oldAPI.localServerAccess)
        let storage = try XCTUnwrap(workspace.cache)
        let identity = try XCTUnwrap(storage.accountIdentity())
        let webID = try XCTUnwrap(workspace.webSession?.id)

        workspace.embeddedDidEnterBackground()
        await workspace.embeddedDidBecomeActive()
        XCTAssertEqual(host.state, .running)
        XCTAssertTrue(host.bootstrap?.capability == first.capability)
        XCTAssertTrue(workspace.api === oldAPI)
        XCTAssertEqual(workspace.webSession?.id, webID)
        XCTAssertEqual(workspace.api?.localServerAccess?.epoch, oldAccess.epoch)
        XCTAssertEqual(store.touches, 0)

        // Persist actual native edits before a deliberate engine outage. The
        // test's stop is NOT scene backgrounding and does not kill CPython.
        var request = try oldAPI.makeRequest("api/blank-pdfs/\(UUID().uuidString.lowercased())")
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["title": "Lifecycle pending ink", "page_count": 1])
        let transport = URLSession(configuration: .ephemeral)
        defer { transport.invalidateAndCancel() }
        let (data, response) = try await transport.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let paper = try JSONDecoder().decode(GammaPaper.self, from: data)
        await workspace.open(paper)
        XCTAssertEqual(workspace.document?.pageCount, 1)
        try workspace.newInk(pdfPage: 1)
        let inkID = try XCTUnwrap(workspace.selectedID)
        let point = PKStrokePoint(location: CGPoint(x: 44, y: 55), timeOffset: 0,
            size: CGSize(width: 3, height: 3), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        let drawing = PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black),
            path: PKStrokePath(controlPoints: [point], creationDate: Date()))])
        try workspace.saveDrawing(blockID: inkID, pdfPage: 0, drawing: drawing)
        let pending = try storage.pendingPages().flatMap(\.outbox).map(\.id)
        XCTAssertFalse(pending.isEmpty)
        let document = workspace.document
        await host.stop()
        XCTAssertEqual(host.state, .stopped)

        // A dead engine cannot tell us whether this existing WK has dirty drafts.
        // Foreground must leave it and its credentials alone, not show sign-in or
        // silently replace it with a fresh local library.
        await workspace.embeddedDidBecomeActive()
        XCTAssertEqual(host.state, .stopped)
        XCTAssertEqual(workspace.webSession?.id, webID)
        XCTAssertTrue(workspace.api === oldAPI)
        XCTAssertFalse(workspace.requiresLogin)
        XCTAssertNotNil(workspace.errorMessage)
        XCTAssertEqual(try storage.pendingPages().flatMap(\.outbox).map(\.id), pending)

        workspace.nativeWriteInProgress = true
        let refusedDuringWrite = await workspace.recoverEmbeddedRuntime(discardWebDraftsConfirmed: true)
        XCTAssertFalse(refusedDuringWrite)
        XCTAssertEqual(host.state, .stopped)
        workspace.nativeWriteInProgress = false
        workspace.username = "not-the-durable-account"
        let refusedWrongAccount = await workspace.recoverEmbeddedRuntime(discardWebDraftsConfirmed: true)
        XCTAssertFalse(refusedWrongAccount)
        XCTAssertEqual(host.state, .stopped)
        XCTAssertEqual(try storage.pendingPages().flatMap(\.outbox).map(\.id), pending)
        workspace.username = identity.username

        // Explicit confirmation permits new Web credentials, never retargeting
        // native transactions. A real /api/session authorizes replay to same ws.
        let recovered = await workspace.recoverEmbeddedRuntime(discardWebDraftsConfirmed: true)
        XCTAssertTrue(recovered, workspace.errorMessage ?? "Recovery failed")
        let second = try XCTUnwrap(host.bootstrap)
        let api = try XCTUnwrap(workspace.api)
        XCTAssertTrue(second.capability != first.capability)
        XCTAssertTrue(second.sessionCookie.value != first.sessionCookie.value)
        XCTAssertEqual(second.account, first.account)
        XCTAssertEqual(second.workspace, first.workspace)
        XCTAssertNotEqual(api.localServerAccess?.epoch, oldAccess.epoch)
        XCTAssertTrue(workspace.cache === storage)
        XCTAssertTrue(workspace.document === document)
        XCTAssertEqual(try XCTUnwrap(storage.accountIdentity()).server, identity.server)
        XCTAssertEqual(api.cacheServerIdentity, "gamma-local://device")
        XCTAssertEqual(api.workspace, identity.workspace)
        XCTAssertEqual(workspace.pendingCount, 0, workspace.errorMessage ?? "Pending replay")
        XCTAssertTrue(try storage.pendingPages().flatMap(\.outbox).isEmpty)
        let remote = try await api.subtree(paper.id)
        let block = try XCTUnwrap(remote.flattened.first { $0.id == inkID })
        let source = try XCTUnwrap(block.properties.inkAsset)
        let bytes = try await api.asset(source)
        XCTAssertEqual(try PKDrawing(data: bytes).strokes.count, 1)
        XCTAssertNotEqual(workspace.webSession?.id, webID)
        XCTAssertEqual(workspace.webSession?.localServerAccess?.epoch, api.localServerAccess?.epoch)
        XCTAssertFalse(workspace.requiresLogin)
        XCTAssertTrue(workspace.isEmbeddedLocal)
        XCTAssertEqual(store.touches, 0, "Embedded lifecycle must never access remote Keychain")

        // Root's explicit recovery detaches an invalidated WK even if the host
        // still reports running. Consent must rotate BOTH host and Web epochs.
        let healthyWebID = try XCTUnwrap(workspace.webSession?.id)
        let healthyEpoch = try XCTUnwrap(api.localServerAccess?.epoch)
        let unconfirmed = await workspace.recoverEmbeddedRuntime(restartRunning: true)
        XCTAssertFalse(unconfirmed)
        XCTAssertTrue(host.bootstrap?.capability == second.capability)
        XCTAssertEqual(workspace.webSession?.id, healthyWebID)
        workspace.nativeWriteInProgress = true
        let blocked = await workspace.recoverEmbeddedRuntime(discardWebDraftsConfirmed: true, restartRunning: true)
        XCTAssertFalse(blocked)
        XCTAssertTrue(host.bootstrap?.capability == second.capability)
        workspace.nativeWriteInProgress = false
        let restarted = await workspace.recoverEmbeddedRuntime(discardWebDraftsConfirmed: true, restartRunning: true)
        XCTAssertTrue(restarted, workspace.errorMessage ?? "Explicit running recovery failed")
        XCTAssertEqual(host.state, .running)
        let third = try XCTUnwrap(host.bootstrap)
        let recoveredAPI = try XCTUnwrap(workspace.api)
        XCTAssertTrue(third.capability != second.capability)
        XCTAssertTrue(third.sessionCookie.value != second.sessionCookie.value)
        XCTAssertEqual(third.account, second.account)
        XCTAssertEqual(third.workspace, second.workspace)
        XCTAssertNotEqual(recoveredAPI.localServerAccess?.epoch, healthyEpoch)
        XCTAssertNotEqual(workspace.webSession?.id, healthyWebID)
        XCTAssertEqual(workspace.webSession?.localServerAccess?.epoch, recoveredAPI.localServerAccess?.epoch)
        XCTAssertTrue(workspace.cache === storage)
        XCTAssertTrue(workspace.document === document)
        let stillSaved = try await recoveredAPI.subtree(paper.id)
        XCTAssertNotNil(stillSaved.flattened.first { $0.id == inkID })
        let stillSavedBytes = try await recoveredAPI.asset(source)
        XCTAssertEqual(stillSavedBytes, bytes)
        XCTAssertEqual(store.touches, 0)
    }

    func testConcurrentSamePathStartsJoinOneRuntimeEpoch() async throws {
        let host = GammaEmbeddedRuntimeController.shared
        let root = try GammaWorkspace.embeddedDataRoot()
        let original = try await host.start(dataRoot: root)
        await host.stop()
        XCTAssertEqual(host.state, .stopped)
        async let first = host.start(dataRoot: root)
        async let second = host.start(dataRoot: root.appendingPathComponent(".", isDirectory: true))
        let (a, b) = try await (first, second)
        XCTAssertEqual(host.state, .running)
        XCTAssertEqual(a.url, b.url)
        XCTAssertTrue(a.capability == b.capability)
        XCTAssertTrue(a.sessionCookie.value == b.sessionCookie.value)
        XCTAssertTrue(a.capability != original.capability)
        XCTAssertEqual(a.account, original.account)
        XCTAssertEqual(a.workspace, original.workspace)
    }

    func testFailedEmbeddedNativeSaveBlocksRecoveryUntilDurableRetry() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var fail = false
        let cache = try GammaCache(rootURL: root, server: URL(string: "gamma-local://device")!,
            username: "device-account", workspace: "device-workspace", writeOverride: { data, url in
                if fail { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: url, options: .atomic)
            })
        let store = LifecycleSessionStore()
        let workspace = GammaWorkspace(cache: cache, sessionStore: store)
        workspace.isLocal = true; workspace.isEmbeddedLocal = true
        let pdf = PDFDocument(); pdf.insert(PDFPage(), at: 0)
        workspace.document = pdf
        workspace.page = GammaPageCache(pageID: "page", docID: "doc", workspace: cache.workspace)
        fail = true
        XCTAssertThrowsError(try workspace.newInk(pdfPage: 1))
        XCTAssertTrue(workspace.hasFailedNativeSave)
        XCTAssertFalse(workspace.canChangeLibrary)
        workspace.embeddedDidEnterBackground()
        XCTAssertTrue(workspace.hasFailedNativeSave)
        let recovered = await workspace.recoverEmbeddedRuntime(discardWebDraftsConfirmed: true)
        XCTAssertFalse(recovered)
        XCTAssertTrue(workspace.document === pdf)
        fail = false
        workspace.embeddedDidEnterBackground()
        XCTAssertFalse(workspace.hasFailedNativeSave)
        let pending = try cache.pendingPages().flatMap(\.outbox)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending.first?.workspace, cache.workspace)
        XCTAssertEqual(store.touches, 0)
    }

    func testNonEmbeddedLifecycleIsNoOp() async {
        let store = LifecycleSessionStore()
        let workspace = GammaWorkspace(sessionStore: store)
        workspace.errorMessage = "Unrelated remote error"
        workspace.embeddedDidEnterBackground()
        await workspace.embeddedDidBecomeActive()
        let recovered = await workspace.recoverEmbeddedRuntime(discardWebDraftsConfirmed: true)
        XCTAssertFalse(recovered)
        XCTAssertEqual(workspace.errorMessage, "Unrelated remote error")
        XCTAssertEqual(store.touches, 0)
    }
}
#endif
