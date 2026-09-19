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
    func testNondefaultWorkspaceNativeSaveIsolation() async throws {
#if GAMMA_LIVE_TEST
        func client() async throws -> (GammaAPI, GammaSessionInfo) {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [LoopbackGammaProtocol.self]
            let api = try GammaAPI(server: "https://gamma-integration.invalid", configuration: config)
            do {
                _ = try await api.login(username: "ipad-integration", password: "disposable-test-password")
                return (api, try await api.session())
            } catch { api.close(); throw error }
        }
        let (api, info) = try await client(); defer { api.close() }
        XCTAssertEqual(info.user, "ipad-integration")
        let matches = info.workspaces.filter { $0.name == "Native QA second library" }
        XCTAssertEqual(matches.count, 1, "Seed exactly one named second library before running")
        let second = try XCTUnwrap(matches.first)
        let defaultID = try XCTUnwrap(info.verifiedDefaultWorkspace)
        XCTAssertNotEqual(second.id, defaultID)
        XCTAssertFalse(second.isDefault)
        XCTAssertTrue(second.canWrite)
        try api.bind(workspace: second.id)
        let papers = try await api.papers()
        let paper = try XCTUnwrap(papers.first { $0.properties.docID != nil })
        let docID = try XCTUnwrap(paper.properties.docID)

        // Seed ONLY the immutable PDF locally: URLProtocol does not support the
        // download-task path. Ink upload and save use the actual native outbox.
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try GammaCache(rootURL: root, server: api.baseURL, username: "ipad-integration", workspace: second.id)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LoopbackGammaProtocol.self]
        let transport = URLSession(configuration: config)
        defer { transport.invalidateAndCancel() }
        let (pdfBytes, pdfResponse) = try await transport.data(for: api.makeRequest("api/uploads/\(docID).pdf"))
        XCTAssertEqual((pdfResponse as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertNotNil(PDFDocument(data: pdfBytes))
        let temporaryPDF = root.appendingPathComponent("fixture.pdf")
        try pdfBytes.write(to: temporaryPDF)
        try cache.preserveSource(from: temporaryPDF, docID: docID)
        var workspace: GammaWorkspace? = GammaWorkspace(cache: cache, api: api)
        await workspace!.open(paper)
        XCTAssertNil(workspace!.errorMessage)

        // UUID-derived geometry plus creation time makes this a real, unique
        // PKDrawing, not an empty archive deduplicated with a default-library asset.
        let nonce = UUID()
        let points = nonce.uuidString.utf8.enumerated().map { index, byte in
            PKStrokePoint(location: CGPoint(x: 40 + index * 4, y: 60 + Int(byte % 32)),
                timeOffset: Double(index) * 0.01, size: CGSize(width: 3, height: 3),
                opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        }
        let drawing = PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black),
            path: PKStrokePath(controlPoints: points, creationDate: Date()))])
        try workspace!.newInk(pdfPage: 1)
        let blockID = try XCTUnwrap(workspace!.selectedID)
        try workspace!.saveDrawing(blockID: blockID, pdfPage: 0, drawing: drawing)
        let savedBytes = try XCTUnwrap(workspace!.page?.drawings[blockID])
        let note = "Nondefault native isolation \(nonce.uuidString)"
        try workspace!.editContent(blockID: blockID, text: note)
        await workspace!.sync()
        XCTAssertEqual(workspace!.pendingCount, 0, workspace!.errorMessage ?? "outbox should drain")
        XCTAssertNil(workspace!.errorMessage)
        workspace!.closeReader(); workspace = nil
        api.close()

        // Fresh session, discovery and EMPTY cache: no saved drawing can mask a
        // missing scoped server write or a read accidentally aimed at default.
        let (reopened, freshInfo) = try await client(); defer { reopened.close() }
        let freshSecond = try XCTUnwrap(freshInfo.workspaces.first { $0.name == second.name })
        XCTAssertEqual(freshSecond.id, second.id)
        XCTAssertEqual(freshInfo.verifiedDefaultWorkspace, defaultID)
        try reopened.bind(workspace: freshSecond.id)
        let freshPapers = try await reopened.papers()
        let freshPaper = try XCTUnwrap(freshPapers.first { $0.id == paper.id })
        let freshCache = try GammaCache(rootURL: root.appendingPathComponent("reopened"),
            server: reopened.baseURL, username: "ipad-integration", workspace: freshSecond.id)
        try freshCache.preserveSource(from: temporaryPDF, docID: docID)
        let fresh = GammaWorkspace(cache: freshCache, api: reopened)
        defer { fresh.closeReader() }
        await fresh.open(freshPaper)
        XCTAssertNil(fresh.errorMessage)
        XCTAssertEqual(fresh.pendingCount, 0)
        XCTAssertEqual(fresh.page?.drawings[blockID], savedBytes)
        let restored = try fresh.drawing(blockID: blockID, pdfPage: 0)
        XCTAssertEqual(restored.strokes.map(GammaReplay.strokeID), drawing.strokes.map(GammaReplay.strokeID))
        let tree = try await reopened.subtree(paper.id)
        XCTAssertEqual(tree.flattened.filter { $0.id == blockID }.count, 1)
        let saved = try XCTUnwrap(tree.flattened.first { $0.id == blockID })
        XCTAssertEqual(saved.content, note)
        let source = try XCTUnwrap(saved.properties.inkAsset)
        let preview = try XCTUnwrap(saved.properties.previewAsset)
        let replay = try XCTUnwrap(saved.properties.replayAsset)
        let sourceBytes = try await reopened.asset(source)
        XCTAssertEqual(sourceBytes, savedBytes)
        XCTAssertEqual(try PKDrawing(data: sourceBytes).strokes.count, 1)

        // Positive default-library control, then exact 404s (not auth errors or
        // the SPA fallback) for the saved block and every uploaded native asset.
        let (defaultAPI, _) = try await client(); defer { defaultAPI.close() }
        try defaultAPI.bind(workspace: defaultID)
        let defaultPapers = try await defaultAPI.papers()
        XCTAssertTrue(defaultPapers.contains { $0.properties.docID != nil })
        XCTAssertFalse(defaultPapers.contains { $0.id == paper.id })
        for path in ["api/blocks/\(blockID)/subtree", "api/blocks/\(paper.id)/subtree"]
            + [source, preview, replay].map({ String($0.dropFirst()) }) {
            let (_, response) = try await transport.data(for: defaultAPI.makeRequest(path))
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 404, "Leaked into default: \(path)")
        }
#else
        throw XCTSkip("Opt-in live backend test: requires GAMMA_LIVE_TEST and the named second-library seed.")
#endif
    }

    @MainActor
    func testRealBackendInkNotesAndReopen() async throws {
#if GAMMA_LIVE_TEST
        // The workspace comes from the disposable server's own /api/session: a
        // hardcoded id would silently mean "whichever library the server calls
        // default", which is exactly what this migration removes.
        func client() async throws -> GammaAPI {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [LoopbackGammaProtocol.self]
            let client = try GammaAPI(server: "https://gamma-integration.invalid", configuration: config)
            _ = try await client.login(username: "ipad-integration", password: "disposable-test-password")
            let info = try await client.session()
            let workspace = try XCTUnwrap(info.verifiedDefaultWorkspace ?? info.workspaces.first(where: { $0.canWrite })?.id)
            try client.bind(workspace: workspace)
            return client
        }
        let api = try await client(); defer { api.close() }
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
        let reopened = try await client(); defer { reopened.close() }
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
        let cache = try GammaCache(rootURL: root, server: reopened.baseURL, username: "ipad-integration", workspace: reopened.workspace)
        // Fetch real immutable server PDF bytes through a data task; the custom
        // test URLProtocol does not claim coverage of URLSession download tasks.
        let pdfConfig = URLSessionConfiguration.ephemeral
        pdfConfig.protocolClasses = [LoopbackGammaProtocol.self]
        let pdfSession = URLSession(configuration: pdfConfig)
        defer { pdfSession.invalidateAndCancel() }
        let docID = try XCTUnwrap(paper.properties.docID)
        let (pdfBytes, pdfResponse) = try await pdfSession.data(for: try reopened.makeRequest("api/uploads/\(docID).pdf"))
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
        let savedSourceBytes = try XCTUnwrap(workspace!.page?.drawings[groupedID])
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
        let freshCache = try GammaCache(rootURL: root, server: reopened.baseURL, username: "ipad-integration", workspace: reopened.workspace)
        let fresh = GammaWorkspace(cache: freshCache, api: reopened)
        await fresh.open(paper)
        XCTAssertNil(fresh.errorMessage)
        XCTAssertEqual(fresh.pendingCount, 0)
        let freshDrawing = try fresh.drawing(blockID: groupedID, pdfPage: 0)
        XCTAssertEqual(freshDrawing.strokes.map(GammaReplay.strokeID), drawing.strokes.map(GammaReplay.strokeID))
        XCTAssertEqual(fresh.page?.drawings[groupedID], savedSourceBytes) // raw saved bytes, not a reserialized archive
        XCTAssertEqual(fresh.page?.blocks.first { $0.id == groupedID }?.content, "Workspace annotation")
        XCTAssertEqual(fresh.page?.blocks.first { $0.id == parentNote }?.content, "Parent edited after child")
        XCTAssertEqual(fresh.page?.blocks.first { $0.id == nestedNote }?.parentID, parentNote)
        let finalTree = try await reopened.subtree(paper.id)
        XCTAssertEqual(finalTree.flattened.filter { $0.id == groupedID }.count, 1)
        XCTAssertEqual(finalTree.flattened.filter { $0.id == nestedNote }.count, 1)
        let backfilled = try XCTUnwrap(finalTree.flattened.first { $0.id == id })
        XCTAssertNotNil(backfilled.properties.replayAsset)
        XCTAssertEqual(backfilled.properties.revision, 1)
        XCTAssertEqual(backfilled.content, "Annotation note")
        let exported = try XCTUnwrap(finalTree.flattened.first { $0.id == groupedID })
        let webAsset = try XCTUnwrap(exported.properties.replayAsset)
        let webData = try await reopened.asset(webAsset)
        let manifest = try XCTUnwrap(try JSONSerialization.jsonObject(with: webData) as? [String: Any])
        XCTAssertEqual(manifest["format"] as? String, "gamma-ink-replay-v1")
        XCTAssertEqual(manifest["source_sha256"] as? String, exported.properties.inkAsset?.split(separator: "/").last?.split(separator: ".").first.map(String.init))
        XCTAssertEqual((manifest["strokes"] as? [Any])?.count, 1)
#else
        throw XCTSkip("Opt-in live backend test: use GAMMA_LIVE_TEST and scripts/live-test-server.py through SSH forwarding.")
#endif
    }
}
