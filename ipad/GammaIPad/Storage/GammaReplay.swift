import Foundation
import PencilKit
import CryptoKit

struct GammaAudioStamp: Equatable {
    let recordingID: String
    let segmentID: String
    let seconds: Double
}

struct GammaReplayEvent: Codable, Equatable, Identifiable {
    enum Kind: String, Codable { case stroke, page, note }
    var id: String = UUID().uuidString.lowercased()
    var kind: Kind
    var segmentID: String
    var start: Double
    var end: Double
    var pdfPage: Int
    var blockID: String?
    var strokeID: String?
    enum CodingKeys: String, CodingKey {
        case id, kind, start, end
        case segmentID = "segment_id", pdfPage = "pdf_page", blockID = "block_id", strokeID = "stroke_id"
    }
}

/// Phase5A uses only final surviving strokes. CreationDate below is an identity
/// component, NEVER an audio clock. Audio timestamps come from recorder/player.
enum GammaReplay {
    static func strokeID(_ stroke: PKStroke) -> String {
        func hash(_ string: String) -> String {
            SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined()
        }
        let lineage = hash(String(format: "%.6f", stroke.path.creationDate.timeIntervalSince1970) + stroke.ink.inkType.rawValue)
        let first = stroke.path.first
        let signature = hash(String(format: "%.6f,%.6f,%.6f", first?.location.x ?? 0, first?.location.y ?? 0, first?.timeOffset ?? 0))
        return lineage + "." + signature
    }
    static func event(for stroke: PKStroke, blockID: String, events: [GammaReplayEvent]) -> GammaReplayEvent? {
        let id = strokeID(stroke)
        let candidates = events.filter { $0.kind == .stroke && $0.blockID == blockID }
        if let exact = candidates.first(where: { $0.strokeID == id }) { return exact }
        // Vector erasing may fragment a stroke but preserve its creation lineage.
        let prefix = id.split(separator: ".").first.map(String.init) ?? id
        return candidates.first { $0.strokeID?.hasPrefix(prefix + ".") == true }
    }
    static func time(_ event: GammaReplayEvent, segments: [GammaAudioSegment], end: Bool = false) -> Double? {
        var offset = 0.0
        for segment in segments {
            if segment.id == event.segmentID {
                let local = end ? event.end : event.start
                return offset + min(max(0, local), segment.duration)
            }
            offset += segment.duration
        }
        return nil
    }
    static func page(at position: Double, events: [GammaReplayEvent], segments: [GammaAudioSegment]) -> Int? {
        events.compactMap { event -> (Double, Int)? in
            guard event.kind == .page, let time = time(event, segments: segments), time <= position else { return nil }
            return (time, event.pdfPage)
        }.sorted { $0.0 < $1.0 }.last?.1
    }
    static func visibleDrawing(_ final: PKDrawing, blockID: String, at position: Double,
                               events: [GammaReplayEvent], segments: [GammaAudioSegment]) -> PKDrawing {
        var result: [PKStroke] = []
        let candidates = events.filter { $0.kind == .stroke && $0.blockID == blockID }
        let exact = Dictionary(candidates.compactMap { event in event.strokeID.map { ($0, event) } }, uniquingKeysWith: { first, _ in first })
        let lineage = Dictionary(candidates.compactMap { event in event.strokeID?.split(separator: ".").first.map { (String($0), event) } }, uniquingKeysWith: { first, _ in first })
        for stroke in final.strokes {
            let id = strokeID(stroke)
            guard let event = exact[id] ?? lineage[String(id.split(separator: ".")[0])] else {
                // Untimed/pre-existing ink stays as static context; no invented timing.
                result.append(stroke); continue
            }
            guard let start = time(event, segments: segments), let end = time(event, segments: segments, end: true),
                  position >= start else { continue }
            if position >= end || end <= start { result.append(stroke); continue }
            let points = Array(stroke.path)
            guard let first = points.first, let last = points.last else { continue }
            let fraction = min(1, max(0, (position - start) / (end - start)))
            let cutoff = first.timeOffset + fraction * max(0, last.timeOffset - first.timeOffset)
            var prefix = points.filter { $0.timeOffset <= cutoff }
            if prefix.isEmpty { prefix = [first] }
            if let rightIndex = points.firstIndex(where: { $0.timeOffset > cutoff }), rightIndex > 0 {
                let left = points[rightIndex - 1], right = points[rightIndex]
                let span = right.timeOffset - left.timeOffset
                if span > 0 {
                    let f = CGFloat((cutoff - left.timeOffset) / span)
                    func mix(_ a: CGFloat, _ b: CGFloat) -> CGFloat { a + (b - a) * f }
                    prefix.append(PKStrokePoint(location: CGPoint(x: mix(left.location.x, right.location.x), y: mix(left.location.y, right.location.y)),
                        timeOffset: cutoff, size: CGSize(width: mix(left.size.width, right.size.width), height: mix(left.size.height, right.size.height)),
                        opacity: mix(left.opacity, right.opacity), force: mix(left.force, right.force),
                        azimuth: mix(left.azimuth, right.azimuth), altitude: mix(left.altitude, right.altitude)))
                }
            }
            result.append(PKStroke(ink: stroke.ink,
                path: PKStrokePath(controlPoints: prefix, creationDate: stroke.path.creationDate),
                transform: stroke.transform, mask: stroke.mask))
        }
        return PKDrawing(strokes: result)
    }
    static func capture(previous: PKDrawing, final: PKDrawing, blockID: String, page: Int,
                        begin: GammaAudioStamp?, now: GammaAudioStamp,
                        existing: [GammaReplayEvent]) -> [GammaReplayEvent] {
        var events = existing
        let oldIDs = Set(previous.strokes.map(strokeID))
        for stroke in final.strokes {
            let id = strokeID(stroke)
            let known = event(for: stroke, blockID: blockID, events: events)
            guard !oldIDs.contains(id) || (begin != nil && known?.segmentID == now.segmentID) else { continue }
            // Erasing/repositioning surviving old ink is not a new timed stroke.
            if known != nil && !oldIDs.contains(id) { continue }
            let length = max(0, (stroke.path.last?.timeOffset ?? 0) - (stroke.path.first?.timeOffset ?? 0))
            let stamp = begin?.recordingID == now.recordingID ? begin! : GammaAudioStamp(recordingID: now.recordingID,
                segmentID: now.segmentID, seconds: max(0, now.seconds - length))
            if let index = events.firstIndex(where: { $0.kind == .stroke && $0.blockID == blockID && $0.strokeID == id }) {
                // Extend only the active gesture, never retime an older stroke.
                if begin != nil && abs(events[index].start - stamp.seconds) < 0.1 {
                    events[index].end = max(events[index].end, now.segmentID == stamp.segmentID ? now.seconds : stamp.seconds + length)
                }
            } else if !oldIDs.contains(id) {
                events.append(GammaReplayEvent(kind: .stroke, segmentID: stamp.segmentID,
                    start: stamp.seconds, end: max(stamp.seconds, now.segmentID == stamp.segmentID ? now.seconds : stamp.seconds + length),
                    pdfPage: page, blockID: blockID, strokeID: id))
            }
        }
        return events
    }
}
