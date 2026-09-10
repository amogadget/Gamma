import Foundation

struct GammaAudioSegment: Codable, Equatable, Identifiable {
    var id: String
    var duration: Double
    var asset: String?
    var startTime: Double?
    enum CodingKeys: String, CodingKey { case id, duration, asset; case startTime = "start_time" }
}

struct GammaRecordingSession: Codable, Equatable, Identifiable {
    enum State: String, Codable { case recording, paused, interrupted, stopped, recoveryRequired }
    var id: String
    var pageID: String
    var state: State = .paused
    var segments: [GammaAudioSegment] = []
    var activeSegmentID: String?
    var revision: Int = 0
    var recoveryNote: String?
    var replayEvents: [GammaReplayEvent]?
    var duration: Double { segments.reduce(0) { $0 + $1.duration } }

    static func new(pageID: String) -> Self { Self(id: UUID().uuidString.lowercased(), pageID: pageID) }
    var serverState: String { state == .recoveryRequired ? "interrupted" : state.rawValue }
    func recovering() -> Self {
        var value = self
        if value.activeSegmentID != nil { value.state = .recoveryRequired }
        else if value.state == .recording { value.state = .interrupted }
        return value
    }
}

/// Recording files remain in the same account-isolated cache as Gamma blocks.
/// Only canonical UUIDs form path components; never use an asset URL as a path.
enum GammaRecordingFiles {
    static func url(root: URL, recordingID: String, segmentID: String) throws -> URL {
        guard UUID(uuidString: recordingID)?.uuidString.lowercased() == recordingID,
              UUID(uuidString: segmentID)?.uuidString.lowercased() == segmentID else {
            throw CocoaError(.fileReadInvalidFileName)
        }
        return root.appendingPathComponent("audio", isDirectory: true)
            .appendingPathComponent(recordingID, isDirectory: true)
            .appendingPathComponent(segmentID + ".m4a")
    }
}
