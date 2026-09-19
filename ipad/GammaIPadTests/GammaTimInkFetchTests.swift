import XCTest
@testable import GammaIPad

private final class TimInkURLProtocol: URLProtocol {
    static let goodURL = "/api/uploads/0123456789abcdef01234567.ink"
    static let badURL = "/api/uploads/ffffffffffffffffffffffff.ink"
    static let bytes = Data(#"{"format":"gamma-ink","version":1,"space":{"kind":"pdf-page","page":1,"width":612,"height":792},"strokes":[]}"#.utf8)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        var status = 200
        var body = Self.bytes
        var type = "application/json"
        if path == "/api/session" {
            body = Data(#"{"user":"alice","default_workspace":"ws-a","workspaces":[{"id":"ws-a","name":"A","role":"owner"}]}"#.utf8)
        } else if request.value(forHTTPHeaderField: "X-Gamma-User") != "alice" || request.value(forHTTPHeaderField: "X-Gamma-Workspace") != "ws-a" {
            status = 403
        } else if path == Self.badURL {
            body = Data("<!DOCTYPE html><html>SPA</html>".utf8)
            type = "text/html"
        } else if path != Self.goodURL { status = 404 }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class GammaTimInkFetchTests: XCTestCase {
    private func api(workspace: String = "ws-a") throws -> GammaAPI {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [TimInkURLProtocol.self]
        return try GammaAPI(server: "https://gamma.example", workspace: workspace, configuration: config)
    }

    func testFetchCarriesAccountAndWorkspaceAndRejectsHTML() async throws {
        let client = try api()
        defer { client.close() }
        _ = try await client.session()
        let fetched = try await client.timInk(TimInkURLProtocol.goodURL)
        XCTAssertEqual(fetched, TimInkURLProtocol.bytes)
        do {
            _ = try await client.timInk(TimInkURLProtocol.badURL)
            XCTFail("SPA HTML must never be cached as handwriting")
        } catch { XCTAssertTrue(error.localizedDescription.contains("web page")) }
        let wrong = try api(workspace: "ws-b")
        defer { wrong.close() }
        _ = try await wrong.session()
        do {
            _ = try await wrong.timInk(TimInkURLProtocol.goodURL)
            XCTFail("Workspace denial must not fall back to another library")
        } catch GammaAPI.APIError.workspaceAccessDenied {} catch { XCTFail("Unexpected \(error)") }
    }

    @MainActor
    func testStaleTimMutationsAreRefusedWithoutChangingQueuedSource() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let client = try api()
        defer { client.close() }
        _ = try await client.session()
        let cache = try GammaCache(rootURL: root, server: client.baseURL, username: "alice", workspace: "ws-a")
        let workspace = GammaWorkspace(cache: cache, api: client)
        for kind in [GammaMutation.Kind.ink, .inkPreview, .content, .child] {
            var page = GammaPageCache(pageID: "page", docID: "doc", workspace: "ws-a")
            page.blocks = [GammaBlock(id: "mixed", content: "caption", properties:
                GammaProperties(type: "pdf_ink", pdfPage: 1, inkURL: TimInkURLProtocol.goodURL))]
            page.outbox = [GammaMutation(kind: kind, blockID: "mixed", parentID: "page",
                content: "pending caption", drawing: Data("untouched source".utf8), workspace: "ws-a")]
            try cache.savePage(page)
            workspace.page = page
            workspace.errorMessage = nil
            await workspace.sync()
            let retained = try cache.loadPage(pageID: "page", docID: "doc")
            XCTAssertEqual(retained.outbox, page.outbox)
            XCTAssertTrue(workspace.errorMessage?.contains("read-only") == true)
        }
    }

    @MainActor
    func testPartialHydrationCachesGoodGroupAndInvalidatesChangedURL() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let client = try api()
        defer { client.close() }
        _ = try await client.session()
        let cache = try GammaCache(rootURL: root, server: client.baseURL, username: "alice", workspace: "ws-a")
        let workspace = GammaWorkspace(cache: cache, api: client)
        var page = GammaPageCache(pageID: "page", docID: "doc", workspace: "ws-a")
        page.blocks = [
            GammaBlock(id: "good", content: "", properties: GammaProperties(pdfPage: 1, inkURL: TimInkURLProtocol.goodURL)),
            GammaBlock(id: "changed", content: "", properties: GammaProperties(pdfPage: 1, inkURL: TimInkURLProtocol.badURL))
        ]
        page.timInkSources = ["changed": GammaTimInkSource(inkURL: TimInkURLProtocol.goodURL, data: TimInkURLProtocol.bytes)]
        let result = try await workspace.hydrateTimInk(page, api: client, generation: workspace.accountGeneration)
        XCTAssertEqual(result.timInkSources?["good"]?.data, TimInkURLProtocol.bytes)
        XCTAssertNil(result.timInkSources?["changed"])
        XCTAssertNotNil(result.timInkErrors?["changed"])
        XCTAssertTrue(result.outbox.isEmpty)
        XCTAssertTrue(result.drawings.isEmpty)
        try cache.savePage(result)
        workspace.page = try cache.loadPage(pageID: "page", docID: "doc")
        workspace.reportTimInkErrors(result)
        XCTAssertEqual(workspace.timInk(pdfPage: 0).count, 1)
        XCTAssertNotNil(workspace.errorMessage)
        let offline = GammaWorkspace(cache: cache)
        offline.page = try cache.loadPage(pageID: "page", docID: "doc")
        offline.reportTimInkErrors(offline.page!)
        XCTAssertEqual(offline.timInk(pdfPage: 0).count, 1)
        XCTAssertNotNil(offline.errorMessage)
    }
}
