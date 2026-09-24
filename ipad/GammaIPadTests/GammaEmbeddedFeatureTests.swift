#if GAMMA_EMBEDDED_BACKEND
import XCTest
import PDFKit
import UIKit
import PencilKit
import WebKit
import AVFAudio
import CryptoKit
@testable import GammaIPad

/// Actual full-backend integration, not URLProtocol fixtures. Runtime validation
/// is pending execution on the parent's disposable iPad QA simulator.
/// Opt in with GAMMA_EMBEDDED_FEATURE_QA=1 ONLY in a disposable app container.
/// Uses the SAME Application Support root/runtime as EmbeddedLocalIntegration;
/// never resets the process-global Python host, migrates a different root, or
/// removes the app container. UUID fixtures remain available for failure triage.
@MainActor
final class GammaEmbeddedFeatureTests: XCTestCase {
    private func uuid() -> String { UUID().uuidString.lowercased() }

    private func local() async throws -> (GammaWorkspace, GammaAPI) {
        guard ProcessInfo.processInfo.environment["GAMMA_EMBEDDED_FEATURE_QA"] == "1" else {
            throw XCTSkip("Requires explicit disposable-container QA opt-in: GAMMA_EMBEDDED_FEATURE_QA=1")
        }
        let workspace = GammaWorkspace()
        await workspace.enterLocalLibrary()
        XCTAssertTrue(workspace.isEmbeddedLocal, "Full embedded runtime must start")
        let api = try XCTUnwrap(workspace.api)
        XCTAssertNotNil(api.localServerAccess)
        XCTAssertEqual(api.baseURL.host, "127.0.0.1")
        XCTAssertTrue(api.sessionCookies().isEmpty)
        let info = try await api.session()
        XCTAssertFalse(info.isGuest)
        return (workspace, api)
    }

    // Queries are added AFTER makeRequest: its path builder does not parse '?'.
    // The delegate refuses credential-bearing redirects outside the local origin.
    private func request(_ api: GammaAPI, _ path: String, method: String = "GET",
                         ws: String? = nil, query: [String: String] = [:],
                         json: [String: Any]? = nil, file: Data? = nil,
                         filename: String = "fixture.zip", mime: String = "application/zip",
                         status: Int = 200) async throws -> (Data, HTTPURLResponse) {
        var req = try api.makeRequest(path)
        var components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(req.url), resolvingAgainstBaseURL: false))
        var values = query
        if let ws { values["ws"] = ws }
        if !values.isEmpty { components.queryItems = values.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        req.url = try XCTUnwrap(components.url)
        req.httpMethod = method
        req.timeoutInterval = 30
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        if let file {
            let boundary = "GammaFeature-\(uuid())"
            req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8)
            body.append(file); body.append(Data("\r\n--\(boundary)--\r\n".utf8))
            req.httpBody = body
        }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil; config.urlCache = nil
        let transport = URLSession(configuration: config, delegate: api, delegateQueue: nil)
        defer { transport.invalidateAndCancel() }
        let (data, response) = try await transport.data(for: req)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        // Do not dump bodies/headers: session responses can contain private data.
        XCTAssertEqual(http.statusCode, status, "\(method) \(path)")
        guard http.statusCode == status else { throw FeatureFailure.contract }
        return (data, http)
    }
    private enum FeatureFailure: Error { case contract }
    private func object(_ data: Data) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private func json(_ api: GammaAPI, _ path: String, method: String = "GET", ws: String? = nil,
                      query: [String: String] = [:], body: [String: Any]? = nil) async throws -> [String: Any] {
        try object(await request(api, path, method: method, ws: ws, query: query, json: body).0)
    }
    private func newWorkspace(_ api: GammaAPI) async throws -> String {
        let name = "Embedded feature QA \(uuid())"
        let value = try await json(api, "api/workspaces", method: "POST", body: ["name": name])
        XCTAssertEqual(value["name"] as? String, name)
        XCTAssertEqual(value["kind"] as? String, "personal")
        XCTAssertEqual(value["role"] as? String, "owner")
        return try XCTUnwrap(value["id"] as? String)
    }
    private func page(_ api: GammaAPI, ws: String? = nil) async throws -> String {
        let id = uuid()
        let value = try await json(api, "api/pages", method: "POST", ws: ws,
                                   body: ["id": id, "title": "QA \(id)"])
        XCTAssertEqual(value["id"] as? String, id)
        return id
    }
    @discardableResult
    private func ops(_ api: GammaAPI, page: String, ws: String? = nil,
                     _ operations: [[String: Any]]) async throws -> Int {
        let result = try await json(api, "api/pages/\(page)/ops", method: "POST", ws: ws,
                                    body: ["client": "embedded-feature-qa", "ops": operations])
        XCTAssertEqual((result["ops"] as? [[String: Any]])?.count, operations.count)
        let seq = try XCTUnwrap(result["seq"] as? Int)
        XCTAssertGreaterThan(seq, 0)
        return seq
    }
    private func tree(_ api: GammaAPI, _ id: String, ws: String? = nil) async throws -> GammaBlock {
        struct Tree: Decodable { let block: GammaBlock }
        let data = try await request(api, "api/blocks/\(id)/subtree", ws: ws).0
        return try JSONDecoder().decode(Tree.self, from: data).block
    }
    private func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    private func pdf(_ api: GammaAPI, ws: String? = nil) async throws -> (GammaPaper, Data) {
        let marker = "Embedded PDF \(uuid())"
        let bytes = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 400, height: 500)).pdfData { context in
            context.beginPage()
            (marker as NSString).draw(at: CGPoint(x: 30, y: 40), withAttributes: [.font: UIFont.systemFont(ofSize: 12)])
        }
        let upload = try object(await request(api, "api/uploads", method: "POST", ws: ws,
            file: bytes, filename: "\(uuid()).pdf", mime: "application/pdf").0)
        let doc = try XCTUnwrap(upload["doc_id"] as? String)
        XCTAssertEqual(doc, String(digest(bytes).prefix(24))) // storage.DIGEST_CHARS
        XCTAssertEqual(upload["size"] as? Int, bytes.count)
        let source = try XCTUnwrap(upload["source_url"] as? String)
        XCTAssertEqual(source, "/api/uploads/\(doc).pdf")
        let data = try await request(api, "api/blocks/by-doc/\(doc)", method: "POST", ws: ws,
            json: ["default_title": marker, "source_url": source]).0
        let paper = try JSONDecoder().decode(GammaPaper.self, from: data)
        let readback = try await request(api, "api/uploads/\(doc).pdf", ws: ws).0
        XCTAssertEqual(readback, bytes)
        return (paper, bytes)
    }

    func testRealWorkspacesListAndIsolateNotesAndPreferences() async throws {
        let (_, api) = try await local()
        let a = try await newWorkspace(api), b = try await newWorkspace(api)
        XCTAssertNotEqual(a, b)
        let list = try await json(api, "api/workspaces/mine")
        let ids = try XCTUnwrap(list["workspaces"] as? [[String: Any]]).compactMap { $0["id"] as? String }
        XCTAssertTrue(ids.contains(a)); XCTAssertTrue(ids.contains(b))
        let pa = try await page(api, ws: a), pb = try await page(api, ws: b)
        let na = uuid(), nb = uuid()
        try await ops(api, page: pa, ws: a, [["op": "insert", "id": na, "parent": pa, "content": "Only A", "props": [:]]])
        try await ops(api, page: pb, ws: b, [["op": "insert", "id": nb, "parent": pb, "content": "Only B", "props": [:]]])
        let ta = try await tree(api, pa, ws: a), tb = try await tree(api, pb, ws: b)
        XCTAssertEqual(ta.flattened.first { $0.id == na }?.content, "Only A")
        XCTAssertEqual(tb.flattened.first { $0.id == nb }?.content, "Only B")
        _ = try await request(api, "api/blocks/\(pa)/subtree", ws: b, status: 404)
        _ = try await request(api, "api/blocks/\(pb)/subtree", ws: a, status: 404)
        for (ws, id) in [(a, pa), (b, pb)] {
            let written = try await json(api, "api/prefs/pinned-folders", method: "PUT", ws: ws, body: ["value": [id]])
            XCTAssertEqual(written["key"] as? String, "pinned-folders")
            XCTAssertNotNil(written["updated_at"] as? String)
        }
        let prefA = try await json(api, "api/prefs/pinned-folders", ws: a)
        let prefB = try await json(api, "api/prefs/pinned-folders", ws: b)
        XCTAssertEqual(prefA["value"] as? [String], [pa]); XCTAssertEqual(prefB["value"] as? [String], [pb])
    }

    func testNestedMarkdownOpsCRUDAndSearchFTS() async throws {
        let (_, api) = try await local()
        let p = try await page(api), parent = uuid(), child = uuid()
        let token = "qafeature" + uuid().replacingOccurrences(of: "-", with: "")
        let content = "**\(token)** 中文 $x^2 + y^2$"
        let seq = try await ops(api, page: p, [
            ["op": "insert", "id": parent, "parent": p, "content": "# Nested markdown", "props": [:]],
            ["op": "insert", "id": child, "parent": parent, "content": content, "props": [:]]])
        var snapshot = try await tree(api, p)
        XCTAssertEqual(snapshot.flattened.first { $0.id == parent }?.children?.first?.id, child)
        XCTAssertEqual(snapshot.flattened.first { $0.id == child }?.content, content)
        var found = false
        let deadline = Date().addingTimeInterval(20)
        repeat {
            let result = try await json(api, "api/search", query: ["q": token])
            let hits = try XCTUnwrap(result["results"] as? [[String: Any]])
            found = hits.contains { $0["source"] as? String == "notes" && $0["block_id"] as? String == child && $0["page_id"] as? String == p }
            if found { break }
            try await Task.sleep(for: .milliseconds(200))
        } while Date() < deadline
        XCTAssertTrue(found, "FTS must index the actual nested note within 20 seconds")
        let updated = content + " revised"
        let seq2 = try await ops(api, page: p, [["op": "set", "id": child, "content": updated],
                                               ["op": "move", "id": child, "parent": p]])
        XCTAssertGreaterThan(seq2, seq)
        snapshot = try await tree(api, p)
        XCTAssertEqual(snapshot.children?.first { $0.id == child }?.content, updated)
        let log = try await json(api, "api/pages/\(p)/ops", query: ["since": String(seq)])
        XCTAssertEqual(log["seq"] as? Int, seq2)
        XCTAssertEqual((log["batches"] as? [[String: Any]])?.count, 1)
        try await ops(api, page: p, [["op": "delete", "id": child]])
        snapshot = try await tree(api, p)
        XCTAssertFalse(snapshot.flattened.contains { $0.id == child })
        let after = try await json(api, "api/search", query: ["q": token])
        XCTAssertFalse(try XCTUnwrap(after["results"] as? [[String: Any]]).contains { $0["block_id"] as? String == child })
    }

    func testPDFUploadHighlightAndReadableCJKMathExportsPreserveOriginalBytes() async throws {
        let (_, api) = try await local()
        let (paper, original) = try await pdf(api)
        let doc = try XCTUnwrap(paper.properties.docID)
        let note = uuid(), highlight = uuid()
        let prose = "Readable export 中文数学 $x^2 + y^2 = z^2$"
        try await ops(api, page: paper.id, [["op": "insert", "id": note, "parent": paper.id, "content": prose, "props": [:]]])
        let position: [String: Any] = ["pageNumber": 1,
            "boundingRect": ["x1": 30, "y1": 40, "x2": 200, "y2": 60, "width": 400, "height": 500, "pageNumber": 1],
            "rects": [["x1": 30, "y1": 40, "x2": 200, "y2": 60, "width": 400, "height": 500, "pageNumber": 1]]]
        let payload: [String: Any] = ["parent_id": paper.id, "quote": "Embedded PDF", "color": "yellow", "pdf_position": position]
        let saved = try await json(api, "api/blocks/\(highlight)/highlight", method: "PUT", body: payload)
        XCTAssertEqual(saved["id"] as? String, highlight)
        let again = try await json(api, "api/blocks/\(highlight)/highlight", method: "PUT", body: payload)
        XCTAssertEqual(again["id"] as? String, highlight)
        let info = try await json(api, "api/pdf-info/\(doc)")
        XCTAssertEqual(info["pages"] as? Int, 1); XCTAssertEqual(info["bytes"] as? Int, original.count)
        let (annotated, headers) = try await request(api, "api/pages/\(paper.id)/export-pdf")
        XCTAssertGreaterThan(Int(headers.value(forHTTPHeaderField: "X-Annotations-Written") ?? "0") ?? 0, 0)
        let annotatedPDF = try XCTUnwrap(PDFDocument(data: annotated))
        XCTAssertEqual(annotatedPDF.pageCount, 1)
        XCTAssertTrue(try XCTUnwrap(annotatedPDF.page(at: 0)).annotations.contains { $0.type == "Highlight" })
        let (notes, notesHeaders) = try await request(api, "api/pages/\(paper.id)/export", query: ["mode": "notes-pdf"])
        XCTAssertTrue(notesHeaders.mimeType == "application/pdf")
        let notesPDF = try XCTUnwrap(PDFDocument(data: notes))
        XCTAssertGreaterThan(notesPDF.pageCount, 0)
        XCTAssertTrue((notesPDF.string ?? "").contains("Readable export"))
        // CJK and math are vector glyphs, not necessarily extractable text. Keep
        // a rendered evidence attachment for the parent's visual readability check.
        let preview = try XCTUnwrap(notesPDF.page(at: 0)).thumbnail(of: CGSize(width: 800, height: 1100), for: .mediaBox)
        let attachment = XCTAttachment(image: preview); attachment.name = "Embedded-notes-PDF-CJK-math-runtime-review"
        attachment.lifetime = .keepAlways; add(attachment)
        let stored = try await request(api, "api/uploads/\(doc).pdf").0
        XCTAssertEqual(stored, original); XCTAssertEqual(digest(stored), digest(original))
    }

    func testWorkspaceBackupZIPMergeRestoresTreeAndExactPDF() async throws {
        let (_, api) = try await local()
        let source = try await newWorkspace(api), target = try await newWorkspace(api)
        let (paper, original) = try await pdf(api, ws: source)
        let note = uuid(), content = "Backup nested QA \(uuid())"
        try await ops(api, page: paper.id, ws: source, [["op": "insert", "id": note, "parent": paper.id, "content": content, "props": [:]]])
        let sentinel = try await page(api, ws: target)
        let (zip, headers) = try await request(api, "api/export", ws: source)
        XCTAssertEqual(Array(zip.prefix(4)), [0x50, 0x4b, 0x03, 0x04])
        XCTAssertTrue(headers.value(forHTTPHeaderField: "Content-Disposition")?.contains(".zip") == true)
        let imported = try object(await request(api, "api/import-data", method: "POST", ws: target,
            query: ["mode": "merge"], file: zip).0)
        XCTAssertEqual(imported["ok"] as? Bool, true)
        let restored = try await tree(api, paper.id, ws: target)
        XCTAssertEqual(restored.flattened.first { $0.id == note }?.content, content)
        let preserved = try await tree(api, sentinel, ws: target)
        XCTAssertEqual(preserved.id, sentinel, "Merge must not replace preexisting target data")
        let doc = try XCTUnwrap(paper.properties.docID)
        let bytes = try await request(api, "api/uploads/\(doc).pdf", ws: target).0
        XCTAssertEqual(bytes, original); XCTAssertEqual(digest(bytes), digest(original))
        let sourceTree = try await tree(api, paper.id, ws: source)
        XCTAssertEqual(sourceTree.flattened.first { $0.id == note }?.content, content)
    }

    func testNativeNoteAndRealAACSynchronizeToEmbeddedAPIAndWebMedia() async throws {
        let (workspace, api) = try await local()
        let (paper, original) = try await pdf(api)
        await workspace.open(paper)
        XCTAssertEqual(workspace.document?.pageCount, 1)
        try workspace.newInk(pdfPage: 1)
        let inkID = try XCTUnwrap(workspace.selectedID)
        let points = [0.0, 0.1].map { t in PKStrokePoint(location: CGPoint(x: 30 + t * 100, y: 80),
            timeOffset: t, size: CGSize(width: 3, height: 3), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2) }
        let stroke = PKStroke(ink: PKInk(.pen, color: .black), path: PKStrokePath(controlPoints: points, creationDate: Date()))
        try workspace.saveDrawing(blockID: inkID, pdfPage: 0, drawing: PKDrawing(strokes: [stroke]))
        await workspace.sync()
        XCTAssertEqual(workspace.pendingCount, 0)
        let noteID = uuid(), text = "Native note \(uuid())"
        let note = try await api.putNote(id: noteID, parent: inkID, content: text, revision: 0)
        XCTAssertEqual(note.content, text)
        XCTAssertEqual(note.properties.nativeNote, true)
        XCTAssertEqual(note.properties.noteRevision, 1)
        let retry = try await api.putNote(id: noteID, parent: inkID, content: text, revision: 0)
        XCTAssertEqual(retry.properties.noteRevision, note.properties.noteRevision)
        var recording = GammaRecordingSession.new(pageID: paper.id)
        let segment = uuid(), cache = try XCTUnwrap(workspace.cache)
        let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id, segmentID: segment)
        try GammaRecordingTests.writeAudio(to: url) // Real AAC, never opens a microphone.
        let audio = try Data(contentsOf: url)
        let duration = try GammaRecordingController.validatedDuration(url)
        XCTAssertGreaterThan(duration, 0)
        recording.state = .stopped
        recording.segments = [GammaAudioSegment(id: segment, duration: duration)]
        recording.replayEvents = [GammaReplayEvent(kind: .page, segmentID: segment, start: 0, end: 0, pdfPage: 1),
            GammaReplayEvent(kind: .stroke, segmentID: segment, start: 0, end: 0.1, pdfPage: 1,
                             blockID: inkID, strokeID: GammaReplay.strokeID(stroke))]
        let doc = try XCTUnwrap(paper.properties.docID)
        try workspace.saveRecording(recording, pageID: paper.id, docID: doc)
        await workspace.sync()
        XCTAssertEqual(workspace.pendingCount, 0)
        let remote = try await api.subtree(paper.id)
        let block = try XCTUnwrap(remote.flattened.first { $0.id == recording.id })
        XCTAssertEqual(block.properties.type, "audio")
        XCTAssertEqual(block.properties.audioState, "stopped")
        XCTAssertEqual(block.properties.segments?.count, 1)
        XCTAssertEqual(block.properties.replayEvents, recording.replayEvents)
        XCTAssertEqual(try XCTUnwrap(block.properties.duration), duration, accuracy: 0.001)
        let remoteInk = try XCTUnwrap(remote.flattened.first { $0.id == inkID })
        let replaySource = try XCTUnwrap(remoteInk.properties.replayAsset, "Native sync must publish the actual replay derivative")
        let replayData = try await api.asset(replaySource)
        let replay = try object(replayData)
        XCTAssertFalse(replayData.isEmpty)
        XCTAssertEqual(replay["source_sha256"] as? String,
                       URL(string: try XCTUnwrap(remoteInk.properties.inkAsset))?.deletingPathExtension().lastPathComponent)
        let source = try XCTUnwrap(block.properties.segments?.first?.asset)
        let downloaded = try await api.asset(source)
        XCTAssertEqual(downloaded, audio)
        let storedPDF = try await request(api, "api/uploads/\(doc).pdf").0
        XCTAssertEqual(storedPDF, original)
        let access = try XCTUnwrap(api.localServerAccess)
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
        let controller = GammaWebViewController(configuration: config, serverURL: api.baseURL,
            workspace: api.workspace, cookies: [], reloadToken: nil, localServerAccess: access,
            onOpenPDF: { _, cookies in XCTAssertTrue(cookies.isEmpty) }, onError: { _ in XCTFail("Embedded Web failed") })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let oldKey = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1194, height: 834)
        window.rootViewController = controller; window.makeKeyAndVisible()
        defer { controller.invalidate(); window.isHidden = true; window.rootViewController = nil; oldKey?.makeKeyAndVisible() }
        var ready = false
        for _ in 0..<200 {
            ready = (try? await controller.webView.evaluateJavaScript("window.__GAMMA_NATIVE_CONTROL__?.version === 1")) as? Bool == true
            if ready { break }; try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertTrue(ready)
        let commands = GammaWebCommandController(); commands.attach(controller)
        let restored = await commands.restorePosition(request: GammaWebOpenRequest(pageID: paper.id, docID: doc,
            title: paper.content, user: access.account, workspace: api.workspace,
            viewport: GammaReadingPosition(pageIndex: 0, anchorX: 0, anchorY: 0)), serverURL: api.baseURL)
        XCTAssertTrue(restored)
        var mediaReady = false
        for _ in 0..<200 {
            mediaReady = (try? await controller.webView.evaluateJavaScript("""
                (() => { const a=document.querySelector('.nativeAudio audio');
                return !!a && a.readyState >= 1 && Number.isFinite(a.duration) && a.duration > 0 && !a.error; })()
                """)) as? Bool == true
            if mediaReady { break }; try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertTrue(mediaReady, "Bundled Web must decode real synchronized AAC metadata from the embedded server")
        let webSource = try await controller.webView.evaluateJavaScript("document.querySelector('.nativeAudio audio')?.currentSrc") as? String
        XCTAssertEqual(URL(string: webSource ?? "")?.path, URL(string: source)?.path)
        let mediaDuration = try await controller.webView.evaluateJavaScript("document.querySelector('.nativeAudio audio')?.duration") as? Double
        XCTAssertEqual(try XCTUnwrap(mediaDuration), duration, accuracy: 0.1)
        let hasReplay = try await controller.webView.evaluateJavaScript("[...document.querySelectorAll('.nativeAudio button')].some(b => b.textContent.includes('Open Note Replay'))") as? Bool
        XCTAssertEqual(hasReplay, true)
        _ = try await controller.webView.evaluateJavaScript("document.querySelector('.nativeAudio button')?.click()")
        var replayReady = false
        for _ in 0..<200 {
            replayReady = (try? await controller.webView.evaluateJavaScript("""
                (() => { const p=document.querySelector('button[aria-label="Play replay"]');
                return !!p && !p.disabled && !document.querySelector('.noteReplayMessage'); })()
                """)) as? Bool == true
            if replayReady { break }; try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertTrue(replayReady, "Real Web Note Replay must load synchronized stroke assets without static fallback")
    }
}
#endif
