import XCTest
@testable import GammaIPad

final class RecordingSimulationTests: XCTestCase {
    private let discard: (RecordingSimulation.Snapshot) throws -> Void = { _ in }

    func testPauseResumeUsesAudioDurationNotTimeBetweenActions() throws {
        var session = RecordingSimulation(pageID: "gamma-page")
        try session.begin(permissionGranted: true, persist: discard)
        try session.observe(audioSeconds: 60, persist: discard)
        try session.finishSegment(audioSeconds: 60, nextPhase: .paused, persist: discard)
        // No wall-clock input exists; an arbitrarily long pause cannot advance
        // the audio timeline. Resume starts another file at local audio time 0.
        XCTAssertEqual(session.snapshot.visibleDuration, 60)
        try session.begin(permissionGranted: true, persist: discard)
        try session.observe(audioSeconds: 30, persist: discard)
        try session.finishSegment(audioSeconds: 30, nextPhase: .stopped, persist: discard)
        XCTAssertEqual(session.snapshot.durableDuration, 90)
        XCTAssertEqual(session.snapshot.segments.count, 2)
    }
    func testPermissionDeniedDoesNotPublishRecording() {
        var session = RecordingSimulation(pageID: "gamma-page")
        XCTAssertThrowsError(try session.begin(permissionGranted: false, persist: discard))
        XCTAssertEqual(session.snapshot.phase, .idle)
        XCTAssertTrue(session.snapshot.segments.isEmpty)
    }
    func testInterruptionRequiresExplicitResumeAndCreatesNewSegment() throws {
        var session = RecordingSimulation(pageID: "gamma-page")
        try session.begin(permissionGranted: true, persist: discard)
        try session.finishSegment(audioSeconds: 15, nextPhase: .interrupted, persist: discard)
        XCTAssertThrowsError(try session.observe(audioSeconds: 20, persist: discard))
        XCTAssertEqual(session.snapshot.phase, .interrupted)
        try session.begin(permissionGranted: true, persist: discard)
        XCTAssertEqual(session.snapshot.segments.last?.duration, 0)
        XCTAssertEqual(session.snapshot.durableDuration, 15)
    }
    func testFailedManifestWriteKeepsLastCommittedState() throws {
        enum DiskError: Error { case full }
        var session = RecordingSimulation(pageID: "gamma-page")
        try session.begin(permissionGranted: true, persist: discard)
        try session.observe(audioSeconds: 12, persist: discard)
        let previous = session.snapshot
        XCTAssertThrowsError(try session.finishSegment(audioSeconds: 15, nextPhase: .paused, persist: { _ in throw DiskError.full }))
        XCTAssertEqual(session.snapshot, previous)
        try session.finishSegment(audioSeconds: 15, nextPhase: .paused, persist: discard)
        XCTAssertEqual(session.snapshot.durableDuration, 15)
    }
    func testCrashRecoveryDoesNotPretendPartialFileIsFinalized() throws {
        var session = RecordingSimulation(pageID: "gamma-page")
        try session.begin(permissionGranted: true, persist: discard)
        try session.finishSegment(audioSeconds: 120, nextPhase: .paused, persist: discard)
        try session.begin(permissionGranted: true, persist: discard)
        try session.observe(audioSeconds: 17, persist: discard)
        var restored = try RecordingSimulation(recovering: session.snapshot)
        XCTAssertEqual(restored.snapshot.phase, .recoveryRequired)
        XCTAssertEqual(restored.snapshot.durableDuration, 120)
        XCTAssertThrowsError(try restored.begin(permissionGranted: true, persist: discard))
        try restored.recoverIncomplete(validatedDuration: nil, persist: discard)
        XCTAssertEqual(restored.snapshot.segments.last?.state, .unrecoverable)
        XCTAssertEqual(restored.snapshot.durableDuration, 120)
        XCTAssertEqual(restored.snapshot.phase, .paused)
    }
    func testValidatedPartialFileCanRecoverShorterPlayableDuration() throws {
        var session = RecordingSimulation(pageID: "gamma-page")
        try session.begin(permissionGranted: true, persist: discard)
        try session.observe(audioSeconds: 17, persist: discard)
        var restored = try RecordingSimulation(recovering: session.snapshot)
        try restored.recoverIncomplete(validatedDuration: 12, persist: discard)
        XCTAssertEqual(restored.snapshot.durableDuration, 12)
        XCTAssertEqual(restored.snapshot.phase, .paused)
    }
    func testNonfiniteAndBackwardsAudioClocksAreRejected() throws {
        var session = RecordingSimulation(pageID: "gamma-page")
        try session.begin(permissionGranted: true, persist: discard)
        try session.observe(audioSeconds: 20, persist: discard)
        for value in [Double.nan, .infinity, -1, 19] {
            XCTAssertThrowsError(try session.observe(audioSeconds: value, persist: discard))
        }
        XCTAssertEqual(session.snapshot.visibleDuration, 20)
    }
    func testManifestReopensWithSameGammaIdentityAndSegments() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("recording.json")
        let save: (RecordingSimulation.Snapshot) throws -> Void = { try JSONEncoder().encode($0).write(to: url, options: .atomic) }
        var session = RecordingSimulation(pageID: "original-gamma-page")
        try session.begin(permissionGranted: true, persist: save)
        try session.finishSegment(audioSeconds: 10, nextPhase: .paused, persist: save)
        try session.stopWhilePaused(persist: save)
        let data = try Data(contentsOf: url)
        let restored = try RecordingSimulation(recovering: JSONDecoder().decode(RecordingSimulation.Snapshot.self, from: data))
        XCTAssertEqual(restored.snapshot, session.snapshot)
        XCTAssertEqual(restored.snapshot.pageID, "original-gamma-page")
        XCTAssertThrowsError(try JSONDecoder().decode(RecordingSimulation.Snapshot.self, from: Data("corrupt".utf8)))
    }
    func testInvalidSnapshotStructureAndVersionAreRejected() {
        var snapshot = RecordingSimulation(pageID: "gamma-page").snapshot
        snapshot.phase = .recording
        XCTAssertThrowsError(try RecordingSimulation(recovering: snapshot))
        snapshot.phase = .idle; snapshot.schemaVersion = 99
        XCTAssertThrowsError(try RecordingSimulation(recovering: snapshot))
    }
}
