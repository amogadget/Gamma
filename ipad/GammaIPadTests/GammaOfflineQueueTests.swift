import XCTest
import UIKit
import PDFKit
import AVFAudio
@testable import GammaIPad

/// End-to-end queue tests: the worker performs real cache writes, PDF/audio validation,
/// hydration, cancellation and restart transitions against an authenticated URLProtocol API.
@MainActor
final class GammaOfflineQueueTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        OfflineQueueURLProtocol.reset()
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root); OfflineQueueURLProtocol.reset() }

    private func makeAPI() async throws -> GammaAPI {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OfflineQueueURLProtocol.self]
        let api = try GammaAPI(server: "https://offline.test", configuration: configuration)
        _ = try await api.login(username: "alice", password: "fake")
        return api
    }

    private func paper(_ id: String = "page-1", doc: String = "doc-1") -> GammaPaper {
        GammaPaper(id: id, parentID: "root", content: "Paper", properties: GammaProperties(docID: doc))
    }
    private func validPDF(for cache: GammaCache, doc: String = "doc-1") throws {
        let url = root.appendingPathComponent("generated.pdf")
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 200))
        try renderer.writePDF(to: url) { context in
            context.beginPage(); UIColor.white.setFill(); UIRectFill(CGRect(x: 0, y: 0, width: 200, height: 200))
        }
        try cache.preserveSource(from: url, docID: doc)
    }
    private func seed(_ cache: GammaCache, _ p: GammaPaper, audio: [GammaAudioSegment] = [], audioRecordingID: String? = nil) throws {
        let recordingID = audioRecordingID ?? UUID().uuidString.lowercased()
        var page = GammaPageCache(pageID: p.id, docID: p.properties.docID!)
        page.blocks = [GammaBlock(id: p.id, parentID: "root", content: p.content,
                                  properties: GammaProperties(docID: p.properties.docID))]
        if !audio.isEmpty {
            page.blocks.append(GammaBlock(id: recordingID, parentID: p.id, content: "Audio",
                properties: GammaProperties(type: "audio", segments: audio)))
        }
        try cache.savePage(page)
        OfflineQueueURLProtocol.subtree = page.blocks.reduce(GammaBlock(id: p.id, parentID: "root", content: p.content,
            properties: GammaProperties(docID: p.properties.docID))) { root, block in
                var r = root; r.children = (r.children ?? []) + (block.id == p.id ? [] : [block]); return r
            }
    }
    private func waitFor(_ condition: @escaping () -> Bool) async {
        for _ in 0..<100 where !condition() { try? await Task.sleep(for: .milliseconds(20)) }
    }

    func testEnqueueDeduplicatesAndDoesNotSwitchReader() async throws {
        let api = try await makeAPI(); defer { api.close() }
        let cache = try GammaCache(rootURL: root, server: api.baseURL, username: "alice")
        let p = paper(); try validPDF(for: cache); try seed(cache, p)
        let workspace = GammaWorkspace(cache: cache, api: api)
        workspace.enqueueDownloads([p, p]); await waitFor { workspace.offlineEntries[p.id]?.state == .ready }
        XCTAssertEqual(workspace.offlineEntries[p.id]?.state, .ready)
        XCTAssertEqual(workspace.offlineEntries.count, 1)
        XCTAssertNil(workspace.page); XCTAssertNil(workspace.paper); XCTAssertNil(workspace.document)
        XCTAssertEqual(OfflineQueueURLProtocol.subtreeRequests, 1)
    }

    func testCancelActiveSubtreeSafelyLeavesCancelledAndNoReadyRecord() async throws {
        let api = try await makeAPI(); defer { api.close() }
        let cache = try GammaCache(rootURL: root, server: api.baseURL, username: "alice")
        let p = paper(); try validPDF(for: cache); try seed(cache, p)
        OfflineQueueURLProtocol.delaySubtree = true
        let workspace = GammaWorkspace(cache: cache, api: api); workspace.enqueueDownloads([p])
        await waitFor { workspace.activeDownloadID == p.id }
        workspace.cancelDownload(p.id); OfflineQueueURLProtocol.releaseSubtree = true
        await waitFor { workspace.offlineEntries[p.id]?.state == .cancelled }
        XCTAssertEqual(workspace.offlineEntries[p.id]?.state, .cancelled)
        XCTAssertNotEqual(workspace.offlineEntries[p.id]?.state, .ready)
        XCTAssertNil(workspace.page)
    }

    func testFailedDownloadCanBeRetriedAfterServerTreeIsFixed() async throws {
        let api = try await makeAPI(); defer { api.close() }
        let cache = try GammaCache(rootURL: root, server: api.baseURL, username: "alice")
        let p = paper(); try validPDF(for: cache); try seed(cache, p)
        OfflineQueueURLProtocol.badSubtree = true
        let workspace = GammaWorkspace(cache: cache, api: api); workspace.enqueueDownloads([p])
        await waitFor { workspace.offlineEntries[p.id]?.state == .failed }
        XCTAssertEqual(workspace.offlineEntries[p.id]?.state, .failed)
        OfflineQueueURLProtocol.badSubtree = false; workspace.retryDownload(p.id)
        await waitFor { workspace.offlineEntries[p.id]?.state == .ready }
        XCTAssertEqual(workspace.offlineEntries[p.id]?.state, .ready)
    }

    func testRestoreConvertsPersistedDownloadingToQueuedAndCompletes() async throws {
        let api = try await makeAPI(); defer { api.close() }
        let cache = try GammaCache(rootURL: root, server: api.baseURL, username: "alice")
        let p = paper(); try validPDF(for: cache); try seed(cache, p)
        try cache.saveOfflineEntries([p.id: GammaOfflineEntry(pageID: p.id, paper: p, state: .downloading)])
        let workspace = GammaWorkspace(cache: cache, api: api); workspace.restoreOfflineQueue()
        await waitFor { workspace.offlineEntries[p.id]?.state == .ready }
        XCTAssertEqual(workspace.offlineEntries[p.id]?.state, .ready)
    }

    func testCorruptPDFAndMissingLocalAudioNeverBecomeReady() async throws {
        let api = try await makeAPI(); defer { api.close() }
        let cache = try GammaCache(rootURL: root, server: api.baseURL, username: "alice")
        let p = paper(); try seed(cache, p); try Data("not pdf".utf8).write(to: cache.sourceURL(docID: "doc-1"))
        let workspace = GammaWorkspace(cache: cache, api: api); workspace.enqueueDownloads([p])
        await waitFor { workspace.offlineEntries[p.id]?.state == .failed }
        XCTAssertFalse(workspace.offlineEntries[p.id]?.pdfReady == true)
        let segment = GammaAudioSegment(id: UUID().uuidString.lowercased(), duration: 1, asset: nil)
        let audioPage = paper("page-audio", doc: "doc-audio"); try validPDF(for: cache, doc: "doc-audio"); try seed(cache, audioPage, audio: [segment])
        workspace.enqueueDownloads([audioPage]); await waitFor { workspace.offlineEntries[audioPage.id]?.state == .failed }
        XCTAssertTrue((workspace.offlineEntries[audioPage.id]?.error ?? "").contains("missing"))
    }

    func testLocalOnlyAudioIsReusedWithoutAssetRequest() async throws {
        let api = try await makeAPI(); defer { api.close() }
        let cache = try GammaCache(rootURL: root, server: api.baseURL, username: "alice")
        let segment = GammaAudioSegment(id: UUID().uuidString.lowercased(), duration: 0.25, asset: nil)
        let recordingID = UUID().uuidString.lowercased()
        let p = paper(); try validPDF(for: cache); try seed(cache, p, audio: [segment], audioRecordingID: recordingID)
        let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recordingID, segmentID: segment.id)
        try GammaRecordingTests.writeAudio(to: url)
        let workspace = GammaWorkspace(cache: cache, api: api); workspace.enqueueDownloads([p])
        await waitFor { workspace.offlineEntries[p.id]?.state == .ready }
        XCTAssertEqual(workspace.offlineEntries[p.id]?.state, .ready)
        XCTAssertEqual(OfflineQueueURLProtocol.assetRequests, 0)
    }

    func testMismatchedAuthenticatedAPIIsRejectedWithoutNetworkWork() async throws {
        let api = try await makeAPI(); defer { api.close() }
        let cache = try GammaCache(rootURL: root, server: api.baseURL, username: "bob")
        let workspace = GammaWorkspace(cache: cache, api: api)
        XCTAssertNil(workspace.api)
        XCTAssertTrue(workspace.isOffline)
        XCTAssertTrue((workspace.errorMessage ?? "").contains("does not match"))
        XCTAssertEqual(OfflineQueueURLProtocol.subtreeRequests, 0)
    }

    func testAccountGenerationStopsAwaitedOldRequestWithoutMutatingEntry() async throws {
        let api = try await makeAPI(); defer { api.close() }
        let cache = try GammaCache(rootURL: root, server: api.baseURL, username: "alice")
        let p = paper(); try validPDF(for: cache); try seed(cache, p); OfflineQueueURLProtocol.delaySubtree = true
        let workspace = GammaWorkspace(cache: cache, api: api); workspace.enqueueDownloads([p])
        await waitFor { workspace.activeDownloadID == p.id }
        workspace.accountGeneration = UUID(); workspace.stopOfflineWorker(); OfflineQueueURLProtocol.releaseSubtree = true
        await waitFor { workspace.offlineWorker == nil }
        XCTAssertNotEqual(workspace.offlineEntries[p.id]?.state, .ready)
    }
}

private final class OfflineQueueURLProtocol: URLProtocol {
    static var subtree: GammaBlock?; static var badSubtree = false; static var delaySubtree = false; static var releaseSubtree = false
    static var subtreeRequests = 0; static var assetRequests = 0
    private var pendingTask: Task<Void, Never>?
    static func reset() { subtree = nil; badSubtree = false; delaySubtree = false; releaseSubtree = false; subtreeRequests = 0; assetRequests = 0 }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "offline.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        if url.path == "/api/login" { respond(Data(#"{"username":"alice"}"#.utf8)); return }
        if url.path.contains("/subtree") {
            Self.subtreeRequests += 1
            pendingTask = Task { [weak self] in
                while Self.delaySubtree && !Self.releaseSubtree {
                    do { try await Task.sleep(for: .milliseconds(10)) }
                    catch { return }
                }
                guard !Task.isCancelled, let self else { return }
                if Self.badSubtree { self.respond(Data(#"{"block":{"id":"wrong","content":"bad","properties":{"doc_id":"wrong"}}}"#.utf8)) }
                else if let tree = Self.subtree, let data = try? JSONEncoder().encode(["block": tree]) { self.respond(data) }
            }; return
        }
        if url.path.contains("/assets/") { Self.assetRequests += 1; respond(Data("unexpected asset".utf8)); return }
        respond(Data("{}".utf8))
    }
    override func stopLoading() { pendingTask?.cancel(); pendingTask = nil }
    private func respond(_ data: Data) {
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type":"application/json"]) else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed); client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
    }
}
