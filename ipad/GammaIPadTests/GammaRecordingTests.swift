import XCTest
import AVFAudio
import AudioToolbox
@testable import GammaIPad

final class GammaRecordingTests: XCTestCase {
    static func writeAudio(to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        var writer: AVAudioFile? = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000], commonFormat: .pcmFormatFloat32, interleaved: false)
        let format = try XCTUnwrap(writer?.processingFormat)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 12_000))
        buffer.frameLength = 12_000
        let samples = try XCTUnwrap(buffer.floatChannelData?[0])
        for i in 0..<12_000 { samples[i] = 0.2 * sin(Float(i) * 2 * .pi * 440 / 48_000) }
        try writer?.write(from: buffer); writer = nil
    }
    @MainActor
    func testFinalizedAudioQueuesOneGammaBlockAndSurvivesCacheReopen() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = try GammaCache(rootURL: root, server: URL(string: "https://gamma.example")!, username: "alice")
        let workspace = GammaWorkspace(cache: cache)
        workspace.page = GammaPageCache(pageID: "page", docID: "doc")
        var session = GammaRecordingSession.new(pageID: "page")
        let segmentID = UUID().uuidString.lowercased()
        let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: session.id, segmentID: segmentID)
        try Self.writeAudio(to: url)
        let duration = try GammaRecordingController.validatedDuration(url)
        XCTAssertGreaterThan(duration, 0)
        session.segments = [GammaAudioSegment(id: segmentID, duration: duration)]
        session.state = .paused
        try workspace.saveRecording(session, pageID: "page", docID: "doc")
        session.state = .stopped
        try workspace.saveRecording(session, pageID: "page", docID: "doc")
        let reopened = try cache.loadPage(pageID: "page", docID: "doc")
        XCTAssertEqual(reopened.blocks.count, 1)
        XCTAssertEqual(reopened.blocks.first?.id, session.id)
        XCTAssertEqual(reopened.blocks.first?.properties.type, "audio")
        XCTAssertEqual(reopened.outbox.count, 1)
        XCTAssertEqual(reopened.outbox.first?.kind, .audio)
        XCTAssertEqual(reopened.recordings?[session.id]?.state, .stopped)
        XCTAssertEqual(reopened.recordings?[session.id]?.segments.count, 1)
    }
    @MainActor
    func testInterruptedFileRecoveryFinalizesWithoutStartingMicrophone() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var value = GammaRecordingSession.new(pageID: "gamma-page")
        value.state = .recording; value.activeSegmentID = UUID().uuidString.lowercased()
        let url = try GammaRecordingFiles.url(root: root, recordingID: value.id, segmentID: value.activeSegmentID!)
        try Self.writeAudio(to: url)
        let controller = GammaRecordingController()
        var saved: GammaRecordingSession?
        controller.recover(value, root: root, discardIncomplete: false) { saved = $0 }
        XCTAssertFalse(controller.recording)
        XCTAssertEqual(saved?.state, .paused)
        XCTAssertNil(saved?.activeSegmentID)
        XCTAssertEqual(saved?.segments.count, 1)
        XCTAssertGreaterThan(saved?.duration ?? 0, 0)
    }
    @MainActor
    func testRecoveryWriteFailureRetainsRetryableManifestAndFile() throws {
        enum DiskFailure: Error { case full }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var value = GammaRecordingSession.new(pageID: "gamma-page")
        value.state = .recording; value.activeSegmentID = UUID().uuidString.lowercased()
        let url = try GammaRecordingFiles.url(root: root, recordingID: value.id, segmentID: value.activeSegmentID!)
        try Self.writeAudio(to: url)
        let controller = GammaRecordingController()
        var failing = true
        var saved: GammaRecordingSession?
        controller.recover(value, root: root, discardIncomplete: false) {
            if failing { throw DiskFailure.full }; saved = $0
        }
        XCTAssertTrue(controller.hasPendingSave)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        failing = false; controller.retrySave()
        XCTAssertFalse(controller.hasPendingSave)
        XCTAssertEqual(saved?.segments.count, 1)
    }
    func testRecordingFilePathsRejectTraversalAndSessionNeedsRecovery() throws {
        let root = FileManager.default.temporaryDirectory
        XCTAssertThrowsError(try GammaRecordingFiles.url(root: root, recordingID: "../private", segmentID: UUID().uuidString.lowercased()))
        var value = GammaRecordingSession.new(pageID: "page")
        value.activeSegmentID = UUID().uuidString.lowercased(); value.state = .recording
        XCTAssertEqual(value.recovering().state, .recoveryRequired)
        XCTAssertEqual(value.recovering().serverState, "interrupted")
    }
}
