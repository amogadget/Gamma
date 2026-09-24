import XCTest
import PDFKit
import PencilKit
import UIKit
@testable import GammaIPad

private final class EmptyLocalTestSessionStore: GammaSessionPersistence {
    var value: GammaSavedSession?
    func load() throws -> GammaSavedSession? { value }
    func save(_ session: GammaSavedSession) throws { value = session }
    func clear() throws { value = nil }
}

private final class LocalResumeProtocol: URLProtocol {
    static var requestedPaths: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        Self.requestedPaths.append(path)
        let body: String
        if path == "/api/session" {
            body = #"{"user":"alice","default_workspace":"ws-alpha","workspaces":[{"id":"ws-alpha","name":"Server library","role":"owner"}]}"#
        } else if path == "/api/blocks/root/children" {
            body = #"{"children":[]}"#
        } else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class GammaWorkspaceLocalTests: XCTestCase {
    private func pdf(at root: URL) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 100)).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 100, height: 100))
        }
        let document = PDFDocument(); document.insert(PDFPage(image: image)!, at: 0)
        let url = root.appendingPathComponent("source.pdf")
        try XCTUnwrap(document.dataRepresentation()).write(to: url)
        return url
    }

    func testLocalColdRestartPersistsInkNotesAndRecordingWithoutNetwork() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { try? FileManager.default.removeItem(at: root); defaults.removePersistentDomain(forName: suite) }
        var factoryCalls = 0
        func workspace() -> GammaWorkspace {
            GammaWorkspace(sessionStore: EmptyLocalTestSessionStore(), localLibraryRoot: root.appendingPathComponent("local"), libraryDefaults: defaults,
                sessionAPIFactory: { _ in factoryCalls += 1; throw URLError(.notConnectedToInternet) })
        }
        let first = workspace()
        await first.restoreInitialLibrary()
        XCTAssertTrue(first.isLocal); XCTAssertNil(first.username); XCTAssertNil(first.api)
        await first.importLocalPDF(url: try pdf(at: root))
        let paper = try XCTUnwrap(first.paper), cache = try XCTUnwrap(first.cache)
        try first.newInk(pdfPage: 1)
        let ink = try XCTUnwrap(first.selectedID)
        let point = PKStrokePoint(location: CGPoint(x: 10, y: 20), timeOffset: 0,
            size: CGSize(width: 2, height: 2), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        let drawing = PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black),
            path: PKStrokePath(controlPoints: [point], creationDate: Date()))])
        try first.saveDrawing(blockID: ink, pdfPage: 0, drawing: drawing)
        try first.editContent(blockID: ink, text: "Local note")
        var recording = GammaRecordingSession.new(pageID: paper.id)
        recording.state = .stopped
        recording.segments = [GammaAudioSegment(id: UUID().uuidString.lowercased(), duration: 2)]
        recording.replayEvents = [GammaReplayEvent(kind: .page, segmentID: recording.segments[0].id,
            start: 0, end: 0, pdfPage: 1)]
        // File preservation is tested separately from AVFoundation playback validity.
        let audio = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id, segmentID: recording.segments[0].id)
        try FileManager.default.createDirectory(at: audio.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: audio)
        try first.saveRecording(recording, pageID: paper.id, docID: try XCTUnwrap(paper.properties.docID))
        XCTAssertEqual(first.pendingCount, 0)
        let second = workspace()
        await second.restoreInitialLibrary(); await second.open(paper)
        XCTAssertEqual(try second.drawing(blockID: ink, pdfPage: 0).strokes.count, 1)
        XCTAssertEqual(second.page?.blocks.first(where: { $0.id == ink })?.content, "Local note")
        XCTAssertEqual(second.page?.recordings?[recording.id], recording)
        XCTAssertEqual(try Data(contentsOf: audio), Data([1, 2, 3]))
        await second.sync(); await second.reconnectSession(); second.sessionDidBecomeActive()
        XCTAssertNil(second.sessionLifecycle.monitor); XCTAssertEqual(factoryCalls, 0)
        XCTAssertTrue(try cache.pendingPages().isEmpty)
    }

    func testExplicitResumeUsesSavedCookieWithoutLoginAndKeepsLibrariesSeparate() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { try? FileManager.default.removeItem(at: root); defaults.removePersistentDomain(forName: suite) }
        let store = EmptyLocalTestSessionStore()
        let server = URL(string: "https://resume-local.invalid")!
        let cookie = try XCTUnwrap(HTTPCookie(properties: [.name: "session", .value: "saved-cookie",
            .domain: server.host!, .path: "/", .secure: "TRUE", HTTPCookiePropertyKey("HttpOnly"): "TRUE"]))
        store.value = try GammaSavedSession(server: server, username: "alice",
            workspace: GammaWorkspaceOption(id: "ws-alpha", name: "Server library", role: "owner"), cookies: [cookie])
        LocalResumeProtocol.requestedPaths = []
        let workspace = GammaWorkspace(sessionStore: store, sessionCacheRoot: root.appendingPathComponent("server"),
            localLibraryRoot: root.appendingPathComponent("local"), libraryDefaults: defaults,
            sessionAPIFactory: { address in
                let config = URLSessionConfiguration.ephemeral
                config.protocolClasses = [LocalResumeProtocol.self]
                return try GammaAPI(server: address, configuration: config)
            })
        workspace.sessionLifecycle.foreground = false
        // Upgrade: no mode preference, but an existing session keeps server mode.
        await workspace.restoreInitialLibrary()
        XCTAssertFalse(workspace.isLocal); XCTAssertEqual(workspace.username, "alice")
        LocalResumeProtocol.requestedPaths = []
        await workspace.enterLocalLibrary()
        let local = try XCTUnwrap(workspace.cache)
        XCTAssertTrue(LocalResumeProtocol.requestedPaths.isEmpty)
        XCTAssertNotNil(store.value)
        let resumed = await workspace.resumeServerLibrary()
        XCTAssertTrue(resumed); XCTAssertFalse(workspace.isLocal)
        XCTAssertEqual(workspace.username, "alice"); XCTAssertEqual(workspace.workspaceID, "ws-alpha")
        XCTAssertNotEqual(workspace.cache?.rootURL, local.rootURL)
        XCTAssertTrue(LocalResumeProtocol.requestedPaths.contains("/api/session"))
        XCTAssertFalse(LocalResumeProtocol.requestedPaths.contains("/api/login"))
        XCTAssertEqual(defaults.string(forKey: "gamma.libraryMode"), "server")
        await workspace.enterLocalLibrary()
        XCTAssertTrue(workspace.isLocal); XCTAssertEqual(workspace.cache?.rootURL, local.rootURL)
        XCTAssertNotNil(store.value)
        workspace.sessionDidEnterBackground()
    }

    func testMissingLocalPrimarySnapshotRefusesOpenWithoutReplacingReader() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try GammaCache.local(rootURL: root.appendingPathComponent("local"))
        let library = try GammaLocalLibrary(cache: cache)
        let source = try pdf(at: root)
        let intact = try library.importPDF(from: source)
        let damaged = try library.importPDF(from: source)
        var apiCalls = 0
        let workspace = GammaWorkspace(cache: cache, sessionStore: EmptyLocalTestSessionStore(),
            sessionAPIFactory: { _ in apiCalls += 1; throw URLError(.notConnectedToInternet) })
        await workspace.open(intact)
        let previousDocument = try XCTUnwrap(workspace.document)
        let snapshotURL = cache.rootURL.appendingPathComponent("page-\(GammaCache.key(damaged.id)).json")
        try FileManager.default.removeItem(at: snapshotURL)
        XCTAssertTrue(FileManager.default.fileExists(atPath: try library.pdfURL(for: damaged).path))
        XCTAssertTrue(try library.papers().contains(where: { $0.id == damaged.id }))
        await workspace.open(damaged)
        XCTAssertEqual(workspace.paper?.id, intact.id)
        XCTAssertEqual(workspace.page?.pageID, intact.id)
        XCTAssertTrue(workspace.document === previousDocument)
        XCTAssertTrue(workspace.errorMessage?.contains("primary notes") == true)
        XCTAssertFalse(workspace.errorMessage?.contains("Sign in") == true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: snapshotURL.path))
        XCTAssertEqual(apiCalls, 0)
    }

    func testFailedLoginAndAbsentSavedSessionKeepLocalReader() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try GammaCache.local(rootURL: root)
        let workspace = GammaWorkspace(cache: cache, sessionStore: EmptyLocalTestSessionStore(),
            sessionAPIFactory: { _ in throw URLError(.notConnectedToInternet) })
        let paper = GammaPaper(id: "local-page", parentID: nil, content: "Local", properties: GammaProperties(docID: "local-doc"))
        workspace.paper = paper
        workspace.page = GammaPageCache(pageID: paper.id, docID: "local-doc")
        let resumed = await workspace.resumeServerLibrary()
        XCTAssertFalse(resumed)
        await workspace.login(server: "https://gamma.example", username: "alice", password: "secret")
        XCTAssertTrue(workspace.isLocal); XCTAssertTrue(workspace.cache === cache)
        XCTAssertNil(workspace.username); XCTAssertNil(workspace.api)
        XCTAssertEqual(workspace.paper?.id, paper.id)
        XCTAssertEqual(workspace.page?.pageID, paper.id)
    }

    func testFailedPrimarySaveDoesNotAcknowledgeDrawing() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var fail = false
        let cache = try GammaCache.local(rootURL: root, writeOverride: { data, url in
            if fail { throw CocoaError(.fileWriteOutOfSpace) }
            try data.write(to: url, options: .atomic)
        })
        let workspace = GammaWorkspace(cache: cache)
        workspace.document = PDFDocument(url: try pdf(at: root))
        workspace.page = GammaPageCache(pageID: "page", docID: "doc", workspace: "local-library")
        try workspace.newInk(pdfPage: 1)
        let id = try XCTUnwrap(workspace.selectedID)
        fail = true
        XCTAssertThrowsError(try workspace.editContent(blockID: id, text: "Unsaved"))
        XCTAssertEqual(workspace.page?.blocks.first?.content, "")
        XCTAssertEqual(try cache.loadPage(pageID: "page", docID: "doc").blocks.first?.content, "")
        XCTAssertTrue(try cache.pendingPages().isEmpty)
        XCTAssertTrue(workspace.hasFailedNativeSave); XCTAssertFalse(workspace.canChangeLibrary)
        workspace.closeReader()
        XCTAssertNotNil(workspace.page)
        fail = false
        XCTAssertThrowsError(try workspace.editContent(blockID: id, text: "Unrelated replacement"))
        XCTAssertTrue(workspace.hasFailedNativeSave)
        XCTAssertTrue(workspace.retryNativeSave())
        XCTAssertEqual(try cache.loadPage(pageID: "page", docID: "doc").blocks.first?.content, "Unsaved")
        XCTAssertFalse(workspace.hasFailedNativeSave); XCTAssertTrue(workspace.canChangeLibrary)
        workspace.closeReader()
        XCTAssertNil(workspace.page)
    }

    func testFailedNewInkCanRetryItsRetainedSnapshotAndClose() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var fail = false
        let cache = try GammaCache.local(rootURL: root, writeOverride: { data, url in
            if fail { throw CocoaError(.fileWriteOutOfSpace) }
            try data.write(to: url, options: .atomic)
        })
        let workspace = GammaWorkspace(cache: cache)
        workspace.document = PDFDocument(url: try pdf(at: root))
        workspace.page = GammaPageCache(pageID: "page", docID: "doc", workspace: "local-library")
        fail = true
        XCTAssertThrowsError(try workspace.newInk(pdfPage: 1))
        XCTAssertTrue(workspace.hasFailedNativeSave)
        XCTAssertTrue(try cache.loadPage(pageID: "page", docID: "doc").blocks.isEmpty)
        XCTAssertFalse(workspace.retryNativeSave())
        workspace.closeReader(); XCTAssertNotNil(workspace.page)
        fail = false
        XCTAssertTrue(workspace.retryNativeSave())
        let saved = try cache.loadPage(pageID: "page", docID: "doc")
        XCTAssertEqual(saved.blocks.count, 1)
        XCTAssertTrue(saved.blocks[0].isInk)
        XCTAssertNotNil(saved.drawings[saved.blocks[0].id])
        XCTAssertTrue(saved.outbox.isEmpty)
        XCTAssertFalse(workspace.hasFailedNativeSave)
        workspace.closeReader(); XCTAssertNil(workspace.page)
    }

    func testFailedNoteCannotBeErasedByUnrelatedDrawing() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var fail = false
        let cache = try GammaCache.local(rootURL: root, writeOverride: { data, url in
            if fail { throw CocoaError(.fileWriteOutOfSpace) }
            try data.write(to: url, options: .atomic)
        })
        let workspace = GammaWorkspace(cache: cache)
        workspace.document = PDFDocument(url: try pdf(at: root))
        workspace.page = GammaPageCache(pageID: "page", docID: "doc", workspace: "local-library")
        try workspace.newInk(pdfPage: 1)
        let ink = try XCTUnwrap(workspace.selectedID)
        fail = true
        XCTAssertThrowsError(try workspace.editContent(blockID: ink, text: "Retain this note"))
        fail = false
        let point = PKStrokePoint(location: CGPoint(x: 10, y: 20), timeOffset: 0,
            size: CGSize(width: 2, height: 2), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        let drawing = PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black),
            path: PKStrokePath(controlPoints: [point], creationDate: Date()))])
        XCTAssertThrowsError(try workspace.saveDrawing(blockID: ink, pdfPage: 0, drawing: drawing))
        XCTAssertTrue(workspace.hasFailedNativeSave)
        XCTAssertTrue(workspace.retryNativeSave())
        XCTAssertEqual(workspace.page?.blocks.first?.content, "Retain this note")
        try workspace.saveDrawing(blockID: ink, pdfPage: 0, drawing: drawing)
        let saved = try cache.loadPage(pageID: "page", docID: "doc")
        XCTAssertEqual(saved.blocks.first?.content, "Retain this note")
        XCTAssertEqual(try PKDrawing(data: XCTUnwrap(saved.drawings[ink])).strokes.count, 1)
    }

    func testChoosingLocalNextLaunchKeepsLiveServerWorkspaceIntact() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { try? FileManager.default.removeItem(at: root); defaults.removePersistentDomain(forName: suite) }
        let server = URL(string: "https://gamma.example")!
        let cache = try GammaCache(rootURL: root.appendingPathComponent("server"), server: server,
            username: "alice", workspace: "ws-alpha")
        let workspace = GammaWorkspace(cache: cache, sessionStore: EmptyLocalTestSessionStore(), libraryDefaults: defaults)
        let sessionID = UUID()
        workspace.webSession = GammaWebSession(id: sessionID, serverURL: server, workspace: "ws-alpha", cookies: [])
        workspace.preferLocalOnNextLaunch()
        XCTAssertFalse(workspace.isLocal)
        XCTAssertEqual(workspace.webSession?.id, sessionID)
        XCTAssertTrue(workspace.cache === cache)
        XCTAssertEqual(workspace.username, "alice")
        var factoryCalls = 0
        let restarted = GammaWorkspace(sessionStore: EmptyLocalTestSessionStore(),
            localLibraryRoot: root.appendingPathComponent("local"), libraryDefaults: defaults,
            sessionAPIFactory: { _ in factoryCalls += 1; throw URLError(.notConnectedToInternet) })
        await restarted.restoreInitialLibrary()
        XCTAssertTrue(restarted.isLocal)
        XCTAssertNil(restarted.api)
        XCTAssertEqual(factoryCalls, 0)
    }

    func testServerCanvasCanAutomaticallyRetryIdenticalFailedSave() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var fail = false
        let cache = try GammaCache(rootURL: root.appendingPathComponent("server"),
            server: URL(string: "https://gamma.example")!, username: "alice", workspace: "ws-alpha",
            writeOverride: { data, url in
                if fail { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: url, options: .atomic)
            })
        let workspace = GammaWorkspace(cache: cache, sessionStore: EmptyLocalTestSessionStore())
        workspace.document = PDFDocument(url: try pdf(at: root))
        workspace.page = GammaPageCache(pageID: "page", docID: "doc", workspace: "ws-alpha")
        XCTAssertFalse(workspace.isLocal)
        try workspace.newInk(pdfPage: 1)
        let ink = try XCTUnwrap(workspace.selectedID)
        let point = PKStrokePoint(location: CGPoint(x: 10, y: 20), timeOffset: 0,
            size: CGSize(width: 2, height: 2), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        let drawing = PKDrawing(strokes: [PKStroke(ink: PKInk(.pen, color: .black),
            path: PKStrokePath(controlPoints: [point], creationDate: Date()))])
        fail = true
        XCTAssertThrowsError(try workspace.saveDrawing(blockID: ink, pdfPage: 0, drawing: drawing))
        XCTAssertFalse(workspace.hasFailedNativeSave, "Server retries use their existing merge path, not a frozen local transaction")
        fail = false
        // PDFInkView retries this same callback without an explicit Retry Save tap.
        try workspace.saveDrawing(blockID: ink, pdfPage: 0, drawing: drawing)
        XCTAssertFalse(workspace.hasFailedNativeSave)
        let saved = try cache.loadPage(pageID: "page", docID: "doc")
        XCTAssertEqual(try PKDrawing(data: XCTUnwrap(saved.drawings[ink])).strokes.count, 1)
        XCTAssertFalse(saved.outbox.isEmpty, "Server edits still need their durable upload queue")
        XCTAssertTrue(saved.outbox.allSatisfy { $0.workspace == "ws-alpha" })
    }

    func testIncompleteMutationIsNotDiscardedAndServerCacheIsSeparate() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let local = try GammaCache.local(rootURL: root.appendingPathComponent("local"))
        let server = try GammaCache(rootURL: root.appendingPathComponent("server"), server: URL(string: "https://gamma.example")!,
            username: "alice", workspace: "ws-alpha")
        var pending = GammaPageCache(pageID: "page", docID: "doc")
        pending.outbox = [GammaMutation(kind: .content, blockID: "missing", parentID: "page", content: "kept")]
        try server.savePage(pending)
        let workspace = GammaWorkspace(cache: local)
        XCTAssertThrowsError(try workspace.localSnapshot(pending))
        XCTAssertEqual(try server.pendingPages().first?.outbox.first?.content, "kept")
        XCTAssertNotEqual(local.rootURL, server.rootURL)
        XCTAssertNil(workspace.username); XCTAssertEqual(workspace.accountServer, "")
        workspace.nativeWriteInProgress = true
        XCTAssertFalse(workspace.canChangeLibrary)
        await workspace.enterLocalLibrary()
        XCTAssertTrue(workspace.cache === local)
    }
}
