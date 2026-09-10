import XCTest
import PencilKit
import AVFAudio
@testable import GammaIPad

final class GammaReplayTests: XCTestCase {
    private func stroke(_ birth: Double, x: CGFloat = 0) -> PKStroke {
        let points = [0.0, 0.5, 1.0].map { t in
            PKStrokePoint(location: CGPoint(x: x + t * 100, y: 20), timeOffset: t,
                size: CGSize(width: 3, height: 3), opacity: 1, force: 1, azimuth: 0, altitude: .pi / 2)
        }
        return PKStroke(ink: PKInk(.pen, color: .black), path: PKStrokePath(controlPoints: points, creationDate: Date(timeIntervalSince1970: birth)))
    }
    func testPhase5AUsesFinalSurvivingInkNotHistoricalErasedStroke() throws {
        let a = stroke(1), b = stroke(2)
        let segment = GammaAudioSegment(id: "segment", duration: 700)
        let events = [
            GammaReplayEvent(kind: .stroke, segmentID: segment.id, start: 600, end: 601, pdfPage: 1, blockID: "ink", strokeID: GammaReplay.strokeID(a)),
            GammaReplayEvent(kind: .stroke, segmentID: segment.id, start: 607, end: 608, pdfPage: 1, blockID: "ink", strokeID: GammaReplay.strokeID(b))]
        let final = PKDrawing(strokes: [b])
        XCTAssertTrue(GammaReplay.visibleDrawing(final, blockID: "ink", at: 602, events: events, segments: [segment]).strokes.isEmpty)
        XCTAssertEqual(GammaReplay.visibleDrawing(final, blockID: "ink", at: 608, events: events, segments: [segment]).strokes.count, 1)
    }
    func testProgressiveStrokeAndUntimedBaselinePreserveFinalSource() throws {
        let timed = stroke(1), baseline = stroke(2, x: 200)
        let final = PKDrawing(strokes: [timed, baseline])
        let original = final.dataRepresentation()
        let event = GammaReplayEvent(kind: .stroke, segmentID: "segment", start: 10, end: 11, pdfPage: 1,
                                     blockID: "ink", strokeID: GammaReplay.strokeID(timed))
        let segments = [GammaAudioSegment(id: "segment", duration: 20)]
        XCTAssertEqual(GammaReplay.visibleDrawing(final, blockID: "ink", at: 9, events: [event], segments: segments).strokes.count, 1)
        let frame = GammaReplay.visibleDrawing(final, blockID: "ink", at: 10.25, events: [event], segments: segments)
        XCTAssertEqual(frame.strokes.count, 2)
        XCTAssertEqual(try XCTUnwrap(frame.strokes.first?.path.last).location.x, 25, accuracy: 0.01)
        XCTAssertEqual(final.dataRepresentation(), original)
    }
    func testSegmentOffsetsExcludePauseAndNavigationRestoresPage() {
        let segments = [GammaAudioSegment(id: "a", duration: 60), GammaAudioSegment(id: "b", duration: 30)]
        let events = [GammaReplayEvent(kind: .page, segmentID: "a", start: 0, end: 0, pdfPage: 1),
                      GammaReplayEvent(kind: .page, segmentID: "b", start: 2, end: 2, pdfPage: 4)]
        XCTAssertEqual(GammaReplay.page(at: 61, events: events, segments: segments), 1)
        XCTAssertEqual(GammaReplay.page(at: 63, events: events, segments: segments), 4)
        XCTAssertEqual(GammaReplay.time(events[1], segments: segments), 62)
    }
    func testCaptureUsesAudioClockAndDoesNotRetimeOldInk() throws {
        let old = stroke(1), new = stroke(1_900_000_000)
        let begin = GammaAudioStamp(recordingID: "recording", segmentID: "seg", seconds: 42)
        let end = GammaAudioStamp(recordingID: "recording", segmentID: "seg", seconds: 43)
        let events = GammaReplay.capture(previous: PKDrawing(strokes: [old]), final: PKDrawing(strokes: [old, new]),
            blockID: "ink", page: 3, begin: begin, now: end, existing: [])
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.start, 42)
        XCTAssertEqual(events.first?.end, 43)
        let later = GammaReplay.capture(previous: PKDrawing(strokes: [old, new]), final: PKDrawing(strokes: [old, new]),
            blockID: "ink", page: 3, begin: nil, now: GammaAudioStamp(recordingID: "recording", segmentID: "seg", seconds: 90), existing: events)
        XCTAssertEqual(later, events)
    }
    func testTimingSurvivesPencilKitSerializationAndEncoderClamping() throws {
        let original = stroke(1234.567)
        let restored = try PKDrawing(data: PKDrawing(strokes: [original]).dataRepresentation())
        XCTAssertEqual(GammaReplay.strokeID(original), GammaReplay.strokeID(try XCTUnwrap(restored.strokes.first)))
        let event = GammaReplayEvent(kind: .stroke, segmentID: "seg", start: 9.99, end: 10.04,
                                     pdfPage: 1, blockID: "ink", strokeID: GammaReplay.strokeID(original))
        XCTAssertEqual(GammaReplay.time(event, segments: [GammaAudioSegment(id: "seg", duration: 10)], end: true), 10)
    }
    func testTimedInkWithUnavailableSegmentIsNotInventedAsBaseline() {
        let ink = stroke(1)
        let event = GammaReplayEvent(kind: .stroke, segmentID: "missing", start: 0, end: 1,
            pdfPage: 1, blockID: "ink", strokeID: GammaReplay.strokeID(ink))
        XCTAssertTrue(GammaReplay.visibleDrawing(PKDrawing(strokes: [ink]), blockID: "ink", at: 10,
            events: [event], segments: []).strokes.isEmpty)
    }
    @MainActor
    func testFailedSaveRetryKeepsOriginalStrokeTimeAndOtherEvents() throws {
        enum DiskError: Error { case full }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        var fail = false
        let cache = try GammaCache(rootURL: root, server: URL(string: "https://gamma.example")!, username: "test", writeOverride: { data, url in
            if fail { throw DiskError.full }; try data.write(to: url, options: .atomic)
        })
        let recordingID = UUID().uuidString.lowercased(), segmentID = UUID().uuidString.lowercased()
        var seconds = 10.0
        let workspace = GammaWorkspace(cache: cache, recordingClock: {
            GammaAudioStamp(recordingID: recordingID, segmentID: segmentID, seconds: seconds)
        })
        var snapshot = GammaPageCache(pageID: "page", docID: "doc")
        snapshot.blocks = [GammaBlock(id: "ink", parentID: "page", content: "", properties: GammaProperties(type: "pdf_ink", pdfPage: 1))]
        snapshot.drawings["ink"] = PKDrawing().dataRepresentation()
        try cache.savePage(snapshot); workspace.page = snapshot
        let session = GammaRecordingSession(id: recordingID, pageID: "page", state: .recording, activeSegmentID: segmentID)
        try workspace.saveRecording(session, pageID: "page", docID: "doc")
        workspace.inkBegan(blockID: "ink"); seconds = 11
        let drawing = PKDrawing(strokes: [stroke(123)])
        fail = true
        XCTAssertThrowsError(try workspace.saveDrawing(blockID: "ink", pdfPage: 0, drawing: drawing, pageID: "page", docID: "doc"))
        workspace.inkEnded(blockID: "ink"); fail = false; seconds = 100
        var latest = try cache.loadPage(pageID: "page", docID: "doc")
        latest.recordings?[recordingID]?.replayEvents?.append(GammaReplayEvent(kind: .page, segmentID: segmentID, start: 12, end: 12, pdfPage: 2))
        try cache.savePage(latest)
        try workspace.saveDrawing(blockID: "ink", pdfPage: 0, drawing: drawing, pageID: "page", docID: "doc")
        let restored = try cache.loadPage(pageID: "page", docID: "doc")
        let events = restored.recordings?[recordingID]?.replayEvents ?? []
        XCTAssertEqual(events.first(where: { $0.kind == .stroke })?.start, 10)
        XCTAssertEqual(events.first(where: { $0.kind == .stroke })?.end, 11)
        XCTAssertTrue(events.contains(where: { $0.kind == .page && $0.pdfPage == 2 }))
    }
    @MainActor
    func testPlayerSeekCrossesRealAACSegmentsWhilePaused() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let files = (0..<2).map { root.appendingPathComponent("\($0).m4a") }
        for file in files { try GammaRecordingTests.writeAudio(to: file) }
        let firstDuration = try GammaRecordingController.validatedDuration(files[0])
        let controller = GammaRecordingController()
        defer { controller.stopPlayback() }
        controller.play(urls: files, recordingID: "recording", startPlaying: false)
        XCTAssertNil(controller.errorMessage)
        XCTAssertEqual(controller.playbackRecordingID, "recording")
        controller.seek(to: firstDuration + 0.1)
        XCTAssertFalse(controller.playing)
        XCTAssertEqual(controller.currentPlaybackTime, firstDuration + 0.1, accuracy: 0.01)
        controller.seek(to: 0.05)
        XCTAssertEqual(controller.currentPlaybackTime, 0.05, accuracy: 0.01)
        controller.seek(to: 999)
        XCTAssertEqual(controller.currentPlaybackTime, controller.playbackDuration, accuracy: 0.01)
    }
}
