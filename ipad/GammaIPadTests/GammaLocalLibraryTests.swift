import XCTest
import Foundation
import PDFKit
import UIKit
import PencilKit
import CryptoKit
@testable import GammaIPad

@MainActor
final class GammaLocalLibraryTests: XCTestCase {
    private func temporaryRoot() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }

    private func pdf(at root: URL, name: String = "Paper.pdf") throws -> URL {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 300))
        let data = renderer.pdfData { context in
            context.beginPage()
            ("Local original" as NSString).draw(at: CGPoint(x: 20, y: 20), withAttributes: nil)
        }
        let url = root.appendingPathComponent(name)
        try data.write(to: url, options: .atomic)
        return url
    }

    func testLocalRootIsIndependentAndCreatesNoAccountIdentity() throws {
        let root = try temporaryRoot()
        let localRoot = root.appendingPathComponent("GammaLocalLibrary")
        let local = try GammaCache.local(rootURL: localRoot)
        let account = try GammaCache(rootURL: root.appendingPathComponent("GammaCache"),
                                     server: URL(string: "https://example.invalid")!,
                                     username: "alice", workspace: "ws-one")
        XCTAssertTrue(local.isLocal)
        XCTAssertFalse(account.isLocal)
        XCTAssertEqual(local.rootURL, localRoot)
        XCTAssertEqual(local.server, "")
        XCTAssertEqual(local.username, "")
        XCTAssertEqual(local.workspace, "local-library")
        XCTAssertFalse(FileManager.default.fileExists(atPath: localRoot.appendingPathComponent("identity.json").path))
        XCTAssertNotEqual(local.rootURL, account.rootURL)
        XCTAssertNil(try local.accountIdentity())
        XCTAssertTrue(try GammaCache.discoverOfflineIdentities(rootURL: localRoot).isEmpty)
        XCTAssertEqual(try GammaCache.discoverOfflineIdentities(rootURL: root.appendingPathComponent("GammaCache")).map(\.username), ["alice"])
        XCTAssertThrowsError(try GammaLocalLibrary(cache: account))
        XCTAssertThrowsError(try GammaCache.local(rootURL: account.rootURL))
        XCTAssertEqual(try GammaCache.localApplicationSupportRoot().lastPathComponent, "GammaLocalLibrary")
        XCTAssertEqual(try GammaCache.applicationSupportRoot().lastPathComponent, "GammaCache")
    }

    func testImportColdReopenAndDuplicateImportRetainExactSource() throws {
        let root = try temporaryRoot()
        let source = try pdf(at: root, name: "  A   paper.PDF")
        let original = try Data(contentsOf: source)
        let libraryRoot = root.appendingPathComponent("local")
        let library = try GammaLocalLibrary(rootURL: libraryRoot)
        let first = try library.importPDF(from: source)
        let second = try library.importPDF(from: source)
        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(UUID(uuidString: first.id)?.uuidString.lowercased(), first.id)
        XCTAssertEqual(first.properties.docID, second.properties.docID)
        XCTAssertEqual(first.content, "A paper")
        let hash = SHA256.hash(data: original).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(first.properties.docID, String(hash.prefix(24)))
        try FileManager.default.removeItem(at: source)
        let reopened = try GammaLocalLibrary(rootURL: libraryRoot)
        XCTAssertEqual(try reopened.papers(), [first, second])
        XCTAssertEqual(try Data(contentsOf: reopened.pdfURL(for: first)), original)
        XCTAssertEqual(try reopened.records().map(\.originalFilename), ["A paper.pdf", "A paper.pdf"])
        XCTAssertEqual(try reopened.records().map(\.pageCount), [1, 1])
        let snapshot = try reopened.cache.loadPage(pageID: first.id, docID: first.properties.docID!)
        XCTAssertEqual(snapshot.workspace, "local-library")
        XCTAssertEqual(snapshot.blocks, [first])
        XCTAssertEqual(snapshot.blocks.first?.id, snapshot.pageID)
        XCTAssertEqual(snapshot.blocks.first?.properties.docID, snapshot.docID)
        XCTAssertNil(snapshot.blocks.first?.parentID)
        let duplicateSnapshot = try reopened.cache.loadPage(pageID: second.id, docID: second.properties.docID!)
        XCTAssertEqual(duplicateSnapshot.blocks, [second])
        XCTAssertTrue(snapshot.outbox.isEmpty)
    }

    func testRejectsUnreadableEmptyAndLockedPDFWithoutPublishing() throws {
        let root = try temporaryRoot()
        let library = try GammaLocalLibrary(rootURL: root.appendingPathComponent("local"))
        let bad = root.appendingPathComponent("bad.pdf")
        try Data("not a pdf".utf8).write(to: bad)
        XCTAssertThrowsError(try library.importPDF(from: bad))
        try Data().write(to: bad)
        XCTAssertThrowsError(try library.importPDF(from: bad))
        let source = try pdf(at: root)
        let document = try XCTUnwrap(PDFDocument(url: source))
        let locked = root.appendingPathComponent("locked.pdf")
        XCTAssertTrue(document.write(to: locked, withOptions: [
            PDFDocumentWriteOption.userPasswordOption: "secret",
            PDFDocumentWriteOption.ownerPasswordOption: "owner"
        ]))
        XCTAssertTrue(try XCTUnwrap(PDFDocument(url: locked)).isLocked)
        XCTAssertThrowsError(try library.importPDF(from: locked))
        XCTAssertTrue(try library.papers().isEmpty)
        XCTAssertTrue(try library.records().isEmpty)
    }

    func testEveryFailedWriteKeepsPreviouslyPublishedLibraryAndSource() throws {
        for failure in ["source-", "page-", "local-records.json", "library.json"] {
            let root = try temporaryRoot()
            let source = try pdf(at: root)
            let libraryRoot = root.appendingPathComponent("local")
            let initial = try GammaLocalLibrary(rootURL: libraryRoot)
            let existing = try initial.importPDF(from: source)
            let original = try Data(contentsOf: initial.pdfURL(for: existing))
            // Distinct bytes force the source-write stage; do not mutate the old source.
            let another = root.appendingPathComponent("another.pdf")
            var next = original
            next.append(Data("\n% another import\n".utf8))
            try next.write(to: another)
            let failing = try GammaLocalLibrary(rootURL: libraryRoot) { data, url in
                if url.lastPathComponent.hasPrefix(failure) { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: url, options: .atomic)
            }
            XCTAssertThrowsError(try failing.importPDF(from: another), failure)
            let reopened = try GammaLocalLibrary(rootURL: libraryRoot)
            XCTAssertEqual(try reopened.papers(), [existing], failure)
            XCTAssertEqual(try reopened.records().map(\.pageID), [existing.id], failure)
            XCTAssertEqual(try Data(contentsOf: reopened.pdfURL(for: existing)), original, failure)
            // A retry may reuse reference-orphans safely and publishes only one new page.
            _ = try reopened.importPDF(from: another)
            XCTAssertEqual(try reopened.papers().count, 2, failure)
        }
    }

    func testCorruptDeduplicatedSourceIsNeverOverwritten() throws {
        let root = try temporaryRoot()
        let source = try pdf(at: root)
        let library = try GammaLocalLibrary(rootURL: root.appendingPathComponent("local"))
        let paper = try library.importPDF(from: source)
        let destination = library.cache.sourceURL(docID: paper.properties.docID!)
        let corrupt = Data("damaged original".utf8)
        try corrupt.write(to: destination)
        XCTAssertThrowsError(try library.importPDF(from: source))
        XCTAssertThrowsError(try library.pdfURL(for: paper))
        XCTAssertEqual(try Data(contentsOf: destination), corrupt)
        XCTAssertEqual(try library.papers(), [paper])
    }

    func testSnapshotsPreservePencilAudioReplayAndOutboxAcrossColdStart() throws {
        let root = try temporaryRoot()
        let source = try pdf(at: root)
        let libraryRoot = root.appendingPathComponent("local")
        let library = try GammaLocalLibrary(rootURL: libraryRoot)
        let paper = try library.importPDF(from: source)
        var snapshot = try library.cache.loadPage(pageID: paper.id, docID: paper.properties.docID!)
        let drawing = PKDrawing().dataRepresentation()
        snapshot.drawings["drawing"] = drawing
        var recording = GammaRecordingSession.new(pageID: paper.id)
        let segmentID = UUID().uuidString.lowercased()
        recording.state = .stopped
        recording.segments = [GammaAudioSegment(id: segmentID, duration: 1)]
        recording.replayEvents = [GammaReplayEvent(kind: .page, segmentID: segmentID,
                                                   start: 0, end: 0.5, pdfPage: 1)]
        snapshot.recordings = [recording.id: recording]
        // Storage never silently discards pending writes; the adapter owns local commits.
        snapshot.outbox = [GammaMutation(kind: .content, blockID: "note", parentID: paper.id, content: "saved")]
        let audio = try GammaRecordingFiles.url(root: library.cache.rootURL, recordingID: recording.id, segmentID: segmentID)
        try FileManager.default.createDirectory(at: audio.deletingLastPathComponent(), withIntermediateDirectories: true)
        let audioBytes = Data([1, 2, 3]) // Persistence fixture, not a playable AAC claim.
        try audioBytes.write(to: audio, options: .atomic)
        try library.cache.savePage(snapshot)
        let reopened = try GammaLocalLibrary(rootURL: libraryRoot)
        let loaded = try reopened.cache.loadPage(pageID: paper.id, docID: paper.properties.docID!)
        XCTAssertEqual(loaded.drawings["drawing"], drawing)
        XCTAssertEqual(loaded.recordings?[recording.id], recording)
        XCTAssertEqual(loaded.outbox.count, 1)
        XCTAssertEqual(loaded.outbox.first?.workspace, "local-library")
        XCTAssertEqual(try Data(contentsOf: audio), audioBytes)
    }
}
