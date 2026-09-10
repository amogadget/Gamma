import XCTest
import PDFKit
import PencilKit
import UIKit
@testable import GammaIPad

#if GAMMA_LIVE_TEST
/// Test-only bridge into a disposable backend through SSH loopback forwarding.
/// Production HTTPS validation stays unchanged. This validates actual API traffic,
/// not TLS deployment, physical Pencil input or the full application UI.
final class LoopbackGammaProtocol: URLProtocol {
    static var sessionCookie: String?
    private var forwardingTask: URLSessionDataTask?
    private var transport: URLSession?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "gamma-integration.invalid" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var forwarded = request
        var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        url.scheme = "http"; url.host = "127.0.0.1"; url.port = 19091
        forwarded.url = url.url
        if let cookie = Self.sessionCookie { forwarded.setValue(cookie, forHTTPHeaderField: "Cookie") }
        // URLProtocol receives streams for some request bodies. Materialize only
        // test data before passing it to the real loopback network transport.
        if forwarded.httpBody == nil, let stream = forwarded.httpBodyStream {
            stream.open(); defer { stream.close() }
            var body = Data(); var buffer = [UInt8](repeating: 0, count: 8192)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            forwarded.httpBodyStream = nil; forwarded.httpBody = body
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        let session = URLSession(configuration: config)
        transport = session
        forwardingTask = session.dataTask(with: forwarded) { [weak self] data, response, error in
            guard let self else { return }
            defer { session.finishTasksAndInvalidate() }
            if let error { self.client?.urlProtocol(self, didFailWithError: error); return }
            guard let http = response as? HTTPURLResponse,
                  let translated = HTTPURLResponse(url: self.request.url!, statusCode: http.statusCode,
                    httpVersion: nil, headerFields: http.allHeaderFields as? [String: String]) else { return }
            if let fields = http.allHeaderFields as? [String: String], let realURL = http.url {
                let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: realURL)
                if let cookie = cookies.first(where: { $0.name == "session" }) {
                    Self.sessionCookie = "session=\(cookie.value)"
                }
            }
            self.client?.urlProtocol(self, didReceive: translated, cacheStoragePolicy: .notAllowed)
            if let data { self.client?.urlProtocol(self, didLoad: data) }
            self.client?.urlProtocolDidFinishLoading(self)
        }
        forwardingTask?.resume()
    }
    override func stopLoading() { forwardingTask?.cancel(); transport?.invalidateAndCancel() }
}
#endif

final class GammaLiveTests: XCTestCase {
    @MainActor
    func testRealBackendInkNotesAndReopen() async throws {
#if GAMMA_LIVE_TEST
        func client() throws -> GammaAPI {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [LoopbackGammaProtocol.self]
            return try GammaAPI(server: "https://gamma-integration.invalid", configuration: config)
        }
        let api = try client(); defer { api.close() }
        _ = try await api.login(username: "ipad-integration", password: "disposable-test-password")
        let papers = try await api.papers()
        let paper = try XCTUnwrap(papers.first)
        let points = (0..<3).map { index in
            PKStrokePoint(location: CGPoint(x: 40 + index * 12, y: 60), timeOffset: Double(index) * 0.1,
                size: CGSize(width: 3, height: 3), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        }
        let drawing = PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black),
            path: PKStrokePath(controlPoints: points, creationDate: Date()))])
        let bytes = drawing.dataRepresentation()
        let source = try await api.upload(data: bytes, fileExtension: "pkdrawing", mime: "application/octet-stream")
        let preview = try XCTUnwrap(drawing.image(from: CGRect(x: 30, y: 50, width: 50, height: 30), scale: 1).pngData())
        let png = try await api.upload(data: preview, fileExtension: "png", mime: "image/png")
        let id = UUID().uuidString.lowercased()
        let payload: [String: Any] = ["parent_id": paper.id, "pdf_page": 1,
            "ink_asset": source, "preview_asset": png, "expected_revision": 0,
            "bounds": ["x": 30, "y": 50, "width": 50, "height": 30],
            "crop_box": ["width": 612, "height": 792], "coordinate_space": "pdf-crop-top-left-v1"]
        let block = try await api.putInk(id: id, body: payload)
        XCTAssertEqual(block.properties.revision, 1)
        let retried = try await api.putInk(id: id, body: payload)
        XCTAssertEqual(retried.properties.revision, 1)
        try await api.updateContent(id: id, content: "Annotation note")
        let childID = UUID().uuidString.lowercased()
        _ = try await api.putNote(id: childID, parent: id, content: "Child note", revision: 0)
        _ = try await api.putNote(id: childID, parent: id, content: "Child note", revision: 0)
        let nestedID = UUID().uuidString.lowercased()
        _ = try await api.putNote(id: nestedID, parent: childID, content: "Nested note", revision: 0)
        api.close()
        let reopened = try client(); defer { reopened.close() }
        _ = try await reopened.login(username: "ipad-integration", password: "disposable-test-password")
        let tree = try await reopened.subtree(paper.id)
        XCTAssertEqual(tree.flattened.filter { $0.id == id }.count, 1)
        XCTAssertEqual(tree.flattened.filter { $0.id == childID }.count, 1)
        XCTAssertEqual(tree.flattened.first { $0.id == id }?.content, "Annotation note")
        XCTAssertEqual(tree.flattened.first { $0.id == nestedID }?.parentID, childID)
        let restored = try await reopened.asset(source)
        XCTAssertEqual(restored, bytes)
        XCTAssertEqual(try PKDrawing(data: restored).strokes.count, 1)
        let restoredPreview = try await reopened.asset(png)
        XCTAssertEqual(restoredPreview, preview)

        // Drive the actual workspace/outbox, discard its in-memory state, and
        // recover from the atomic account-scoped cache plus the real backend.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try GammaCache(rootURL: root, server: reopened.baseURL, username: "ipad-integration")
        // Fetch real immutable server PDF bytes through a data task; the custom
        // test URLProtocol does not claim coverage of URLSession download tasks.
        let pdfConfig = URLSessionConfiguration.ephemeral
        pdfConfig.protocolClasses = [LoopbackGammaProtocol.self]
        let pdfSession = URLSession(configuration: pdfConfig)
        defer { pdfSession.invalidateAndCancel() }
        let docID = try XCTUnwrap(paper.properties.docID)
        let (pdfBytes, pdfResponse) = try await pdfSession.data(for: reopened.makeRequest("api/uploads/\(docID).pdf"))
        XCTAssertEqual((pdfResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertNotNil(PDFDocument(data: pdfBytes))
        let temporaryPDF = root.appendingPathComponent("fixture.pdf")
        try pdfBytes.write(to: temporaryPDF)
        try cache.preserveSource(from: temporaryPDF, docID: try XCTUnwrap(paper.properties.docID))
        var workspace: GammaWorkspace? = GammaWorkspace(cache: cache, api: reopened)
        await workspace!.open(paper)
        XCTAssertNil(workspace!.errorMessage)
        try workspace!.newInk(pdfPage: 1)
        let groupedID = try XCTUnwrap(workspace!.selectedID)
        try workspace!.saveDrawing(blockID: groupedID, pdfPage: 0, drawing: drawing)
        try workspace!.editContent(blockID: groupedID, text: "Workspace annotation")
        try workspace!.addChild(parentID: groupedID)
        let parentNote = try XCTUnwrap(workspace!.selectedID)
        try workspace!.addChild(parentID: parentNote)
        let nestedNote = try XCTUnwrap(workspace!.selectedID)
        try workspace!.editContent(blockID: nestedNote, text: "Nested workspace note")
        try workspace!.editContent(blockID: parentNote, text: "Parent edited after child")
        await workspace!.sync()
        XCTAssertEqual(workspace!.pendingCount, 0, workspace!.errorMessage ?? "outbox should drain")
        XCTAssertNil(workspace!.errorMessage)
        workspace!.closeReader(); workspace = nil
        let freshCache = try GammaCache(rootURL: root, server: reopened.baseURL, username: "ipad-integration")
        let fresh = GammaWorkspace(cache: freshCache, api: reopened)
        await fresh.open(paper)
        XCTAssertNil(fresh.errorMessage)
        XCTAssertEqual(fresh.pendingCount, 0)
        XCTAssertEqual(try fresh.drawing(blockID: groupedID, pdfPage: 0).dataRepresentation(), bytes)
        XCTAssertEqual(fresh.page?.blocks.first { $0.id == groupedID }?.content, "Workspace annotation")
        XCTAssertEqual(fresh.page?.blocks.first { $0.id == parentNote }?.content, "Parent edited after child")
        XCTAssertEqual(fresh.page?.blocks.first { $0.id == nestedNote }?.parentID, parentNote)
        let finalTree = try await reopened.subtree(paper.id)
        XCTAssertEqual(finalTree.flattened.filter { $0.id == groupedID }.count, 1)
        XCTAssertEqual(finalTree.flattened.filter { $0.id == nestedNote }.count, 1)
#else
        throw XCTSkip("Opt-in live backend test: use GAMMA_LIVE_TEST and scripts/live-test-server.py through SSH forwarding.")
#endif
    }
}
