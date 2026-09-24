#if GAMMA_EMBEDDED_BACKEND
import XCTest
import UIKit
import PencilKit
import AVFAudio
import AudioToolbox
@testable import GammaIPad

/// Exercises real routes and Apple's actual PencilKit/AAC encoders, no mock DB.
@MainActor
final class GammaLocalMigrationLiveTests: XCTestCase {
    func testConcurrentFailurePropagatesAndDoesNotPoisonRetry() async throws {
        let workspace = GammaWorkspace()
        await workspace.enterLocalLibrary()
        let api = try XCTUnwrap(workspace.api, workspace.errorMessage ?? "No embedded backend")
        let access = try XCTUnwrap(api.localServerAccess)
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let source = temporary.appendingPathComponent("old")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        let index = source.appendingPathComponent("library.json")
        let broken = Data("invalid retained library index".utf8)
        try broken.write(to: index)
        let cache = try GammaCache(rootURL: temporary.appendingPathComponent("new"),
            server: URL(string: access.cacheIdentity)!, username: access.account, workspace: access.workspace)
        let first = Task { @MainActor in
            try await GammaLocalLibraryMigration.run(sourceRoot: source, client: api, destination: cache)
        }
        let second = Task { @MainActor in
            try await GammaLocalLibraryMigration.run(sourceRoot: source, client: api, destination: cache)
        }
        var failures: [String] = []
        for task in [first, second] {
            do { _ = try await task.value; XCTFail("Malformed source must fail every waiter") }
            catch { failures.append(error.localizedDescription) }
        }
        XCTAssertEqual(failures.count, 2)
        XCTAssertEqual(failures.first, failures.last)
        XCTAssertEqual(try Data(contentsOf: index), broken)
        // Simulate explicit source repair; a failed task must not remain cached.
        try Data("[]".utf8).write(to: index)
        let retried = try await GammaLocalLibraryMigration.run(sourceRoot: source, client: api, destination: cache)
        XCTAssertEqual(retried, 0)
    }

    func testRetainedSourcesMigrateOnceIntoTheRealWorkspace() async throws {
        let workspace = GammaWorkspace()
        await workspace.enterLocalLibrary()
        let api = try XCTUnwrap(workspace.api, workspace.errorMessage ?? "No embedded backend")
        let access = try XCTUnwrap(api.localServerAccess)
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let source = temporary.appendingPathComponent("old")
        let library = try GammaLocalLibrary(rootURL: source)
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 300)).pdfData { $0.beginPage() }
        let pdfURL = temporary.appendingPathComponent("retained.pdf")
        try pdf.write(to: pdfURL)
        let paper = try library.importPDF(from: pdfURL)
        let ink = UUID().uuidString.lowercased(), note = UUID().uuidString.lowercased()
        let audio = UUID().uuidString.lowercased(), segment = UUID().uuidString.lowercased()
        let point = PKStrokePoint(location: CGPoint(x: 30, y: 40), timeOffset: 0,
            size: CGSize(width: 4, height: 4), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        let stroke = PKStroke(ink: PKInk(.pen, color: .black), path: PKStrokePath(controlPoints: [point], creationDate: Date()))
        let drawing = PKDrawing(strokes: [stroke]).dataRepresentation()
        let event = GammaReplayEvent(kind: .stroke, segmentID: segment, start: 0, end: 0.2,
                                    pdfPage: 1, blockID: ink, strokeID: GammaReplay.strokeID(stroke))
        let recording = GammaRecordingSession(id: audio, pageID: paper.id, state: .stopped,
            segments: [GammaAudioSegment(id: segment, duration: 0.25)], replayEvents: [event])
        let audioURL = try GammaRecordingFiles.url(root: source, recordingID: audio, segmentID: segment)
        try FileManager.default.createDirectory(at: audioURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        var writer: AVAudioFile? = try AVAudioFile(forWriting: audioURL, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000
        ], commonFormat: .pcmFormatFloat32, interleaved: false)
        let format = try XCTUnwrap(writer?.processingFormat)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 12_000))
        buffer.frameLength = 12_000
        let samples = try XCTUnwrap(buffer.floatChannelData?[0])
        for i in 0..<12_000 { samples[i] = 0.2 * sin(Float(i) * 2 * .pi * 440 / 48_000) }
        try writer?.write(from: buffer); writer = nil
        let audioBytes = try Data(contentsOf: audioURL)
        var snapshot = try library.cache.loadPage(pageID: paper.id, docID: paper.properties.docID!)
        snapshot.blocks += [
            GammaBlock(id: ink, parentID: paper.id, content: "ink caption", properties: GammaProperties(type: "pdf_ink", pdfPage: 1)),
            GammaBlock(id: note, parentID: ink, content: "Retained nested note", properties: GammaProperties(nativeNote: true)),
            GammaBlock(id: audio, parentID: paper.id, content: "recording", properties: GammaProperties(type: "audio", audioState: "stopped", segments: recording.segments, duration: 0.25, replayEvents: [event]))
        ]
        snapshot.drawings[ink] = drawing; snapshot.recordings = [audio: recording]
        try library.cache.savePage(snapshot)
        let before = try JSONEncoder().encode(library.cache.loadPage(pageID: paper.id, docID: paper.properties.docID!))
        let cache = try GammaCache(rootURL: temporary.appendingPathComponent("new"),
            server: URL(string: access.cacheIdentity)!, username: access.account, workspace: access.workspace)
        // Root bootstrap and a second native caller may both request migration
        // while the first HTTP call is suspended. Both must join one flight,
        // not independently load and overwrite an old progress manifest.
        let secondClient = GammaAPI(localServer: access)
        defer { secondClient.close() }
        let first = Task { @MainActor in
            try await GammaLocalLibraryMigration.run(sourceRoot: source, client: api, destination: cache)
        }
        let second = Task { @MainActor in
            try await GammaLocalLibraryMigration.run(sourceRoot: source.appendingPathComponent("."),
                                                    client: secondClient, destination: cache)
        }
        let migrated = try await first.value
        let joined = try await second.value
        XCTAssertEqual(migrated, 1)
        XCTAssertEqual(joined, 1, "Both callers must observe the same flight result")
        let tree = try await api.subtree(paper.id)
        XCTAssertEqual(Set(tree.flattened.map(\.id)), Set(snapshot.blocks.map(\.id)))
        let nativeInk = try XCTUnwrap(tree.flattened.first { $0.id == ink })
        let inkBytes = try await api.asset(XCTUnwrap(nativeInk.properties.inkAsset))
        XCTAssertEqual(inkBytes, drawing)
        XCTAssertNotNil(nativeInk.properties.replayAsset)
        let nativeAudio = try XCTUnwrap(tree.flattened.first { $0.id == audio })
        XCTAssertEqual(nativeAudio.properties.replayEvents, [event])
        let remoteAudioBytes = try await api.asset(XCTUnwrap(nativeAudio.properties.segments?.first?.asset))
        XCTAssertEqual(remoteAudioBytes, audioBytes)
        XCTAssertEqual(tree.flattened.first { $0.id == note }?.parentID, ink)
        // A completed receipt must NOT replace later full-Gamma edits.
        try await api.updateContent(id: note, content: "Edited in full Gamma")
        let repeated = try await GammaLocalLibraryMigration.run(sourceRoot: source, client: api, destination: cache)
        XCTAssertEqual(repeated, 0)
        let edited = try await api.subtree(note)
        XCTAssertEqual(edited.content, "Edited in full Gamma")
        let after = try JSONEncoder().encode(library.cache.loadPage(pageID: paper.id, docID: paper.properties.docID!))
        XCTAssertEqual(try JSONSerialization.jsonObject(with: before) as? NSDictionary,
                       try JSONSerialization.jsonObject(with: after) as? NSDictionary)
        XCTAssertEqual(try Data(contentsOf: library.pdfURL(for: paper)), pdf)
        XCTAssertEqual(try Data(contentsOf: audioURL), audioBytes)
    }
}
#endif
