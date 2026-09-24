import XCTest
import AVFAudio
import AudioToolbox
import PDFKit
import PencilKit
import UIKit
@testable import GammaIPad

private final class LocalReplaySessionStore: GammaSessionPersistence {
    func load() throws -> GammaSavedSession? { nil }
    func save(_ session: GammaSavedSession) throws {}
    func clear() throws {}
}

/// Real AVFoundation AAC encode/decode and player preparation/seek, with synthetic
/// PencilKit events. Not a microphone, physical Pencil, speaker, or running-clock
/// synchronization test. Silent PCM also prevents audible output during the brief
/// playRecording -> pausePlayback interval; no recording permission is requested.
@MainActor
final class GammaLocalReplayTests: XCTestCase {
    @MainActor
    private final class Fixture {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = "GammaLocalReplayTests." + UUID().uuidString
        let defaults: UserDefaults
        var factoryCalls = 0

        init() { defaults = UserDefaults(suiteName: suite)! }
        func cleanUp() {
            try? FileManager.default.removeItem(at: root)
            defaults.removePersistentDomain(forName: suite)
        }
        func workspace() throws -> GammaWorkspace {
            let cache = try GammaCache.local(rootURL: root.appendingPathComponent("local"))
            return GammaWorkspace(cache: cache, sessionStore: LocalReplaySessionStore(),
                sessionCacheRoot: root.appendingPathComponent("server"),
                localLibraryRoot: root.appendingPathComponent("local"), libraryDefaults: defaults,
                sessionAPIFactory: { [self] _ in
                    factoryCalls += 1
                    throw URLError(.notConnectedToInternet)
                })
        }
    }

    private func importPDF(_ fixture: Fixture, cache: GammaCache) throws -> GammaPaper {
        try FileManager.default.createDirectory(at: fixture.root, withIntermediateDirectories: true)
        let image = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 200)).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 200, height: 200))
        }
        let document = PDFDocument()
        for index in 0..<2 { document.insert(try XCTUnwrap(PDFPage(image: image)), at: index) }
        let url = fixture.root.appendingPathComponent("source.pdf")
        try XCTUnwrap(document.dataRepresentation()).write(to: url)
        let paper = try GammaLocalLibrary(cache: cache).importPDF(from: url)
        try FileManager.default.removeItem(at: url) // Reopen must use the local primary copy.
        return paper
    }

    private func writeAAC(to url: URL, seconds: Double) throws -> Double {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var writer: AVAudioFile? = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000
        ], commonFormat: .pcmFormatFloat32, interleaved: false)
        let format = try XCTUnwrap(writer?.processingFormat)
        let frames = AVAudioFrameCount(seconds * format.sampleRate)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try XCTUnwrap(buffer.floatChannelData?[0])
        for index in 0..<Int(frames) { samples[index] = 0 }
        try writer?.write(from: buffer)
        writer = nil // Finalize the real M4A container before any reader opens it.
        let reader = try AVAudioFile(forReading: url)
        XCTAssertEqual(reader.fileFormat.streamDescription.pointee.mFormatID, kAudioFormatMPEG4AAC)
        let decoded = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: reader.processingFormat,
            frameCapacity: AVAudioFrameCount(reader.length)))
        try reader.read(into: decoded)
        XCTAssertGreaterThan(decoded.frameLength, 0)
        let duration = try GammaRecordingController.validatedDuration(url)
        XCTAssertEqual(duration, seconds, accuracy: 0.1) // AAC priming/padding is allowed.
        return duration
    }

    private func stroke(birth: Double) -> PKStroke {
        let points = [0.0, 0.5, 1.0].map { time in
            PKStrokePoint(location: CGPoint(x: 20 + time * 100, y: 30), timeOffset: time,
                size: CGSize(width: 3, height: 3), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        }
        return PKStroke(ink: PKInk(.pen, color: .black),
            path: PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: birth)))
    }

    func testColdLocalReplaySeeksRealAACAcrossSegmentsAndRevealsPersistedInk() async throws {
        let fixture = Fixture()
        defer { fixture.cleanUp() }
        let first = try fixture.workspace()
        let cache = try XCTUnwrap(first.cache)
        let paper = try importPDF(fixture, cache: cache)
        let docID = try XCTUnwrap(paper.properties.docID)
        await first.open(paper)
        XCTAssertEqual(first.document?.pageCount, 2)
        var recording = GammaRecordingSession.new(pageID: paper.id)
        recording.state = .stopped
        var audioURLs: [URL] = []
        var inkIDs: [String] = []
        var events: [GammaReplayEvent] = []
        for index in 0..<2 {
            let segmentID = UUID().uuidString.lowercased()
            let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id, segmentID: segmentID)
            let duration = try writeAAC(to: url, seconds: Double(index + 2))
            recording.segments.append(GammaAudioSegment(id: segmentID, duration: duration))
            audioURLs.append(url)
            try first.newInk(pdfPage: index + 1)
            let inkID = try XCTUnwrap(first.selectedID)
            inkIDs.append(inkID)
            let ink = stroke(birth: 1_700_000_000 + Double(index))
            try first.saveDrawing(blockID: inkID, pdfPage: index, drawing: PKDrawing(strokes: [ink]))
            events.append(GammaReplayEvent(kind: .page, segmentID: segmentID, start: 0, end: 0, pdfPage: index + 1))
            events.append(GammaReplayEvent(kind: .stroke, segmentID: segmentID, start: 0.5, end: 1.5,
                pdfPage: index + 1, blockID: inkID, strokeID: GammaReplay.strokeID(ink)))
        }
        recording.replayEvents = events
        try first.saveRecording(recording, pageID: paper.id, docID: docID)
        let saved = try cache.loadPage(pageID: paper.id, docID: docID)
        let originalAudio = try audioURLs.map { try Data(contentsOf: $0) }
        let pdfURL = try GammaLocalLibrary(cache: cache).pdfURL(for: paper)
        let originalPDF = try Data(contentsOf: pdfURL)
        first.closeReader()

        let cold = try fixture.workspace()
        defer { cold.recorder.stopPlayback() }
        await cold.open(paper)
        XCTAssertTrue(cold.isLocal)
        XCTAssertNil(cold.api)
        XCTAssertNil(cold.username)
        XCTAssertEqual(cold.page?.recordings?[recording.id], recording)
        XCTAssertEqual(cold.page?.drawings, saved.drawings)
        await cold.playRecording(recording.id)
        cold.recorder.pausePlayback() // No wait or active-clock test; all following seeks remain paused.
        XCTAssertNil(cold.recorder.errorMessage)
        XCTAssertEqual(cold.recorder.playbackRecordingID, recording.id)
        XCTAssertEqual(cold.recorder.playbackDuration, recording.duration, accuracy: 0.01)

        cold.recorder.seek(to: 0.2)
        XCTAssertEqual(cold.replayPage(), 1)
        XCTAssertEqual(cold.replayDrawing(pdfPage: 0)?.strokes.count, 0)
        XCTAssertEqual(cold.replayDrawing(pdfPage: 1)?.strokes.count, 0)
        cold.recorder.seek(to: 1)
        let partial = try XCTUnwrap(cold.replayDrawing(pdfPage: 0))
        XCTAssertEqual(partial.strokes.count, 1)
        XCTAssertEqual(try XCTUnwrap(partial.strokes.first?.path.last).location.x, 70, accuracy: 0.1)

        let secondOffset = recording.segments[0].duration
        cold.recorder.seek(to: secondOffset + 0.2)
        XCTAssertFalse(cold.recorder.playing)
        XCTAssertEqual(cold.recorder.currentPlaybackTime, secondOffset + 0.2, accuracy: 0.01)
        XCTAssertEqual(cold.replayPage(), 2)
        XCTAssertEqual(cold.replayDrawing(pdfPage: 0)?.strokes.count, 1)
        XCTAssertEqual(cold.replayDrawing(pdfPage: 1)?.strokes.count, 0)
        cold.recorder.seek(to: secondOffset + 1.7)
        XCTAssertEqual(cold.replayDrawing(pdfPage: 1)?.strokes.count, 1)
        cold.recorder.seek(to: 0.2) // Backward cross-segment seek must hide later ink again.
        XCTAssertEqual(cold.replayPage(), 1)
        XCTAssertEqual(cold.replayDrawing(pdfPage: 0)?.strokes.count, 0)
        XCTAssertEqual(cold.replayDrawing(pdfPage: 1)?.strokes.count, 0)
        XCTAssertFalse(cold.recorder.playing)
        XCTAssertNil(cold.recorder.errorMessage)
        cold.recorder.stopPlayback()
        for (index, inkID) in inkIDs.enumerated() {
            XCTAssertEqual(try cold.drawing(blockID: inkID, pdfPage: index).strokes.count, 1)
        }
        XCTAssertEqual(try cache.loadPage(pageID: paper.id, docID: docID).drawings, saved.drawings)
        XCTAssertEqual(try audioURLs.map { try Data(contentsOf: $0) }, originalAudio)
        XCTAssertEqual(try Data(contentsOf: pdfURL), originalPDF)
        XCTAssertTrue(try cache.pendingPages().isEmpty)
        XCTAssertEqual(fixture.factoryCalls, 0)
    }

    func testMissingLocalAACFailsWithoutNetworkFallback() async throws {
        try await assertDamagedAudioFails(missing: true)
    }

    func testMalformedLocalAACFailsWithoutNetworkFallbackOrRewritingMedia() async throws {
        try await assertDamagedAudioFails(missing: false)
    }

    private func assertDamagedAudioFails(missing: Bool) async throws {
        let fixture = Fixture()
        defer { fixture.cleanUp() }
        let first = try fixture.workspace()
        let cache = try XCTUnwrap(first.cache)
        let paper = try importPDF(fixture, cache: cache)
        let docID = try XCTUnwrap(paper.properties.docID)
        await first.open(paper)
        var recording = GammaRecordingSession.new(pageID: paper.id)
        recording.state = .stopped
        let segmentID = UUID().uuidString.lowercased()
        let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id, segmentID: segmentID)
        let duration = try writeAAC(to: url, seconds: 2)
        // Even an asset reference must not permit local mode to fetch a replacement.
        recording.segments = [GammaAudioSegment(id: segmentID, duration: duration,
            asset: "/api/uploads/" + String(repeating: "a", count: 64) + ".m4a")]
        try first.saveRecording(recording, pageID: paper.id, docID: docID)
        let malformed = Data("not an AAC container".utf8)
        if missing { try FileManager.default.removeItem(at: url) }
        else { try malformed.write(to: url) }
        first.closeReader()
        let cold = try fixture.workspace()
        defer { cold.recorder.stopPlayback() }
        await cold.open(paper)
        await cold.playRecording(recording.id)
        XCTAssertNotNil(cold.recorder.errorMessage)
        XCTAssertFalse(cold.recorder.playing)
        XCTAssertNil(cold.recorder.playbackRecordingID)
        XCTAssertNil(cold.replaySession)
        XCTAssertFalse(cold.busy)
        XCTAssertTrue(cold.isLocal)
        XCTAssertNil(cold.api)
        XCTAssertEqual(cold.page?.recordings?[recording.id], recording)
        XCTAssertEqual(try cache.loadPage(pageID: paper.id, docID: docID).recordings?[recording.id], recording)
        if missing { XCTAssertFalse(FileManager.default.fileExists(atPath: url.path)) }
        else { XCTAssertEqual(try Data(contentsOf: url), malformed) }
        XCTAssertTrue(try cache.pendingPages().isEmpty)
        XCTAssertEqual(fixture.factoryCalls, 0)
    }
}
