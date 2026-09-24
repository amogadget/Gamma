#if GAMMA_EMBEDDED_BACKEND
import XCTest
import PDFKit
@testable import GammaIPad

/// Real host/bootstrap and backend permissions, never a policy HTTP stub.
@MainActor
final class GammaEmbeddedWorkspaceHandoffTests: XCTestCase {
    private func json(_ api: GammaAPI, _ path: String, _ body: [String: Any], method: String = "POST") async throws -> Data {
        var request = try api.makeRequest(path)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(data: data, encoding: .utf8) ?? "")
        return data
    }

    func testAlternateOwnedWorkspaceHandoffUsesNewScopeAndRejectsUnavailableWorkspace() async throws {
        let workspace = GammaWorkspace()
        await workspace.enterLocalLibrary()
        XCTAssertTrue(workspace.isEmbeddedLocal, workspace.errorMessage ?? "No runtime")
        let original = try XCTUnwrap(workspace.api)
        let originalCache = try XCTUnwrap(workspace.cache)
        let access = try XCTUnwrap(original.localServerAccess)
        let originalWeb = try XCTUnwrap(workspace.webSession)
        let created = try await json(original, "api/workspaces", ["name": "Native handoff \(UUID().uuidString)"])
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: created) as? [String: Any])
        let targetID = try XCTUnwrap(object["id"] as? String)
        let targetAccess = try GammaLocalServerAccess(trustedHostURL: access.baseURL,
            account: access.account, workspace: targetID, sessionCookie: access.sessionCookie,
            capabilityCookie: access.capabilityCookie, capabilityHeader: access.capabilityHeader,
            cacheIdentity: access.cacheIdentity)
        let seed = GammaAPI(localServer: targetAccess)
        defer { seed.close() }
        let data = try await json(seed, "api/blank-pdfs/\(UUID().uuidString.lowercased())",
            ["title": "Alternate workspace PDF", "page_count": 2], method: "PUT")
        let paper = try JSONDecoder().decode(GammaPaper.self, from: data)
        let docID = try XCTUnwrap(paper.properties.docID)
        func request(workspace id: String, doc: String? = nil, user: String? = nil) -> GammaWebOpenRequest {
            GammaWebOpenRequest(pageID: paper.id, docID: doc ?? docID, title: paper.content,
                                user: user ?? access.account, workspace: id)
        }
        // Actual session authorizes the alternate workspace, but not a nonexistent one.
        let info = try await original.session()
        XCTAssertEqual(info.option(targetID)?.canWrite, true)
        let unavailable = await workspace.openFromEmbeddedWeb(request(workspace: "missing-\(UUID().uuidString)"), cookies: [])
        XCTAssertFalse(unavailable)
        XCTAssertTrue(workspace.api === original); XCTAssertTrue(workspace.cache === originalCache)
        XCTAssertEqual(workspace.webSession?.id, originalWeb.id)
        let wrongDoc = await workspace.openFromEmbeddedWeb(request(workspace: targetID, doc: "wrong-document"), cookies: [])
        XCTAssertFalse(wrongDoc)
        let wrongAccount = await workspace.openFromEmbeddedWeb(request(workspace: targetID, user: "not-the-device-account"), cookies: [])
        XCTAssertFalse(wrongAccount)
        XCTAssertTrue(workspace.api === original); XCTAssertTrue(workspace.cache === originalCache)

        // A stale Web epoch is not origin proof, even on the same host/account.
        workspace.webSession = GammaWebSession(id: UUID(), serverURL: original.baseURL,
            workspace: access.workspace, cookies: [], localServerAccess: targetAccess)
        let stale = await workspace.openFromEmbeddedWeb(request(workspace: targetID), cookies: [])
        XCTAssertFalse(stale)
        workspace.webSession = originalWeb
        // Native outbox is durable and must block the transition, not be dropped.
        var pending = GammaPageCache(pageID: "pending-\(UUID().uuidString)", docID: "pending-doc")
        pending.workspace = access.workspace
        pending.outbox = [GammaMutation(kind: .content, blockID: "pending-note", parentID: pending.pageID,
                                       content: "Keep me", revision: 0)]
        try originalCache.savePage(pending)
        let refused = await workspace.openFromEmbeddedWeb(request(workspace: targetID), cookies: [])
        XCTAssertFalse(refused)
        XCTAssertEqual(try originalCache.loadPage(pageID: pending.pageID, docID: pending.docID).outbox.map(\.id), pending.outbox.map(\.id))
        XCTAssertTrue(workspace.api === original)
        // Clear only this test-created synthetic mutation; production never does so.
        pending.outbox = []; try originalCache.savePage(pending)

        let accepted = await workspace.openFromEmbeddedWeb(request(workspace: targetID), cookies: [])
        XCTAssertTrue(accepted, workspace.errorMessage ?? "Handoff failed")
        let target = try XCTUnwrap(workspace.api)
        let targetCache = try XCTUnwrap(workspace.cache)
        XCTAssertFalse(target === original)
        XCTAssertEqual(original.workspace, access.workspace, "Old client must never be rebound")
        XCTAssertEqual(target.workspace, targetID); XCTAssertEqual(workspace.workspaceID, targetID)
        XCTAssertEqual(workspace.username, access.account)
        XCTAssertNotEqual(target.localServerAccess?.epoch, access.epoch)
        XCTAssertEqual(target.localServerAccess?.cacheIdentity, access.cacheIdentity)
        XCTAssertTrue(target.localServerAccess?.capabilityCookie.value == access.capabilityCookie.value)
        XCTAssertTrue(target.localServerAccess?.sessionCookie.value == access.sessionCookie.value)
        XCTAssertNotEqual(targetCache.rootURL, originalCache.rootURL)
        XCTAssertEqual(try XCTUnwrap(targetCache.accountIdentity()).workspace, targetID)
        XCTAssertEqual(targetCache.workspace, targetID)
        XCTAssertEqual(workspace.document?.pageCount, 2)
        XCTAssertEqual(workspace.page?.workspace, targetID)
        XCTAssertEqual(workspace.paper?.id, paper.id)
        XCTAssertTrue(FileManager.default.fileExists(atPath: targetCache.sourceURL(docID: docID).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: originalCache.sourceURL(docID: docID).path))
        XCTAssertNotEqual(workspace.webSession?.id, originalWeb.id)
        XCTAssertEqual(workspace.webSession?.workspace, targetID)
        XCTAssertEqual(workspace.webSession?.localServerAccess?.epoch, target.localServerAccess?.epoch)
        let verified = try await target.subtree(paper.id)
        XCTAssertEqual(verified.properties.docID, docID)
        // Ordinary same-workspace handoff keeps its API/cache/epoch and WK identity.
        let targetWebID = workspace.webSession?.id
        let same = await workspace.openFromEmbeddedWeb(request(workspace: targetID), cookies: [])
        XCTAssertTrue(same, workspace.errorMessage ?? "Same workspace handoff failed")
        XCTAssertTrue(workspace.api === target); XCTAssertTrue(workspace.cache === targetCache)
        XCTAssertEqual(workspace.webSession?.id, targetWebID)
    }
}
#endif
