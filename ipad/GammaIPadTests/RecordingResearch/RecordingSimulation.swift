import Foundation

/// Research-only model compiled into XCTest, never into the application.
/// Inputs are observations from an AUDIO clock, never wall-clock timestamps.
struct RecordingSimulation {
    enum Phase: String, Codable { case idle, recording, paused, interrupted, recoveryRequired, stopped }
    enum SegmentState: String, Codable { case writing, finalized, incomplete, unrecoverable }
    struct Segment: Codable, Equatable {
        var id = UUID()
        var duration: Double = 0
        var state: SegmentState = .writing
    }
    struct Snapshot: Codable, Equatable {
        var schemaVersion = 1
        let pageID: String
        let recordingID: UUID
        var phase: Phase = .idle
        var segments: [Segment] = []
        var durableDuration: Double { segments.filter { $0.state == .finalized }.reduce(0) { $0 + $1.duration } }
        var visibleDuration: Double {
            segments.filter { $0.state == .finalized || $0.state == .writing }.reduce(0) { $0 + $1.duration }
        }
    }
    enum Failure: Error { case permissionDenied, invalidTransition, invalidDuration, unsupportedSnapshot }
    private(set) var snapshot: Snapshot
    init(pageID: String) { snapshot = Snapshot(pageID: pageID, recordingID: UUID()) }
    init(recovering saved: Snapshot) throws {
        guard saved.schemaVersion == 1, !saved.pageID.isEmpty,
              saved.segments.allSatisfy({ $0.duration.isFinite && $0.duration >= 0 }),
              saved.segments.filter({ $0.state == .writing || $0.state == .incomplete }).count <= 1 else {
            throw Failure.unsupportedSnapshot
        }
        let pending = saved.segments.filter { $0.state == .writing || $0.state == .incomplete }
        guard Set(saved.segments.map(\.id)).count == saved.segments.count,
              saved.phase != .idle || saved.segments.isEmpty else { throw Failure.unsupportedSnapshot }
        switch saved.phase {
        case .recording:
            guard pending.count == 1, saved.segments.last?.state == .writing else { throw Failure.unsupportedSnapshot }
        case .recoveryRequired:
            guard pending.count == 1, saved.segments.last?.state == .incomplete else { throw Failure.unsupportedSnapshot }
        default:
            guard pending.isEmpty else { throw Failure.unsupportedSnapshot }
        }
        snapshot = saved
        if snapshot.phase == .recording {
            snapshot.phase = .recoveryRequired
            for index in snapshot.segments.indices where snapshot.segments[index].state == .writing {
                snapshot.segments[index].state = .incomplete
            }
        }
    }
    mutating func begin(permissionGranted: Bool, persist: (Snapshot) throws -> Void) throws {
        guard permissionGranted else { throw Failure.permissionDenied }
        guard [.idle, .paused, .interrupted].contains(snapshot.phase) else { throw Failure.invalidTransition }
        var next = snapshot
        next.segments.append(Segment()); next.phase = .recording
        try commit(next, persist)
    }
    mutating func observe(audioSeconds: Double, persist: (Snapshot) throws -> Void) throws {
        guard snapshot.phase == .recording, let index = snapshot.segments.indices.last else { throw Failure.invalidTransition }
        try validateDuration(audioSeconds, minimum: snapshot.segments[index].duration)
        var next = snapshot; next.segments[index].duration = audioSeconds
        try commit(next, persist)
    }
    /// Call only AFTER the driver confirms a valid finalized audio file.
    /// This simulation assumes final audio duration has been reconciled against
    /// live clock observations; encoder priming/padding is an adapter concern.
    mutating func finishSegment(audioSeconds: Double, nextPhase: Phase, persist: (Snapshot) throws -> Void) throws {
        guard snapshot.phase == .recording, [.paused, .interrupted, .stopped].contains(nextPhase),
              let index = snapshot.segments.indices.last else { throw Failure.invalidTransition }
        try validateDuration(audioSeconds, minimum: snapshot.segments[index].duration)
        var next = snapshot
        next.segments[index].duration = audioSeconds
        next.segments[index].state = .finalized
        next.phase = nextPhase
        try commit(next, persist)
    }
    mutating func stopWhilePaused(persist: (Snapshot) throws -> Void) throws {
        guard [.paused, .interrupted].contains(snapshot.phase) else { throw Failure.invalidTransition }
        var next = snapshot; next.phase = .stopped
        try commit(next, persist)
    }
    /// Explicit user-authorized recovery; never automatically starts a microphone.
    /// Invalid partial files stay represented as unrecoverable, not silently
    /// counted as intact audio. Earlier finalized segments remain available.
    mutating func recoverIncomplete(validatedDuration: Double?, persist: (Snapshot) throws -> Void) throws {
        guard snapshot.phase == .recoveryRequired,
              let index = snapshot.segments.firstIndex(where: { $0.state == .incomplete }) else { throw Failure.invalidTransition }
        var next = snapshot
        if let duration = validatedDuration {
            try validateDuration(duration, minimum: 0)
            next.segments[index].duration = duration
            next.segments[index].state = .finalized
        } else {
            next.segments[index].state = .unrecoverable
        }
        next.phase = .paused
        try commit(next, persist)
    }
    private func validateDuration(_ value: Double, minimum: Double) throws {
        guard value.isFinite, value >= minimum else { throw Failure.invalidDuration }
    }
    private mutating func commit(_ next: Snapshot, _ persist: (Snapshot) throws -> Void) throws {
        try persist(next)
        snapshot = next
    }
}
