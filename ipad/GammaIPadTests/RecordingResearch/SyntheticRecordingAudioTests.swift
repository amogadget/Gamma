import XCTest
import AVFAudio
import AudioToolbox

/// Actual Apple codec/file tests with generated PCM. No microphone is opened,
/// no recording permission is requested, and no speaker output is performed.
final class SyntheticRecordingAudioTests: XCTestCase {
    private func writeTone(to url: URL, seconds: Double) throws {
        var writer: AVAudioFile? = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
        ], commonFormat: .pcmFormatFloat32, interleaved: false)
        let format = try XCTUnwrap(writer?.processingFormat)
        let frames = AVAudioFrameCount(seconds * format.sampleRate)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try XCTUnwrap(buffer.floatChannelData?[0])
        for i in 0..<Int(frames) { samples[i] = 0.2 * sin(Float(i) * 2 * .pi * 440 / Float(format.sampleRate)) }
        try writer?.write(from: buffer)
        writer = nil // Explicit file finalization before reopen.
    }
    func testSyntheticAACSegmentsFinalizeDecodeAndKeepContinuousOffsets() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var offset: Double = 0
        var starts: [Double] = []
        for (index, duration) in [0.25, 0.5].enumerated() {
            let url = root.appendingPathComponent("segment-\(index).m4a")
            try writeTone(to: url, seconds: duration)
            let file = try AVAudioFile(forReading: url)
            let actual = Double(file.length) / file.processingFormat.sampleRate
            XCTAssertEqual(actual, duration, accuracy: 0.1, "Allow AAC priming/padding; do not assume sample-perfect segment duration")
            let decoded = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
            try file.read(into: decoded)
            XCTAssertGreaterThan(decoded.frameLength, 0)
            let samples = try XCTUnwrap(decoded.floatChannelData?[0])
            let energy = (0..<Int(decoded.frameLength)).reduce(Float(0)) { $0 + samples[$1] * samples[$1] }
            XCTAssertGreaterThan(energy, 0, "Reopened file should contain the synthetic tone, not silence")
            starts.append(offset); offset += actual
        }
        XCTAssertEqual(starts.first, 0)
        XCTAssertGreaterThan(starts[1], 0.15)
        XCTAssertEqual(offset, 0.75, accuracy: 0.2)
    }
    func testTruncatedAudioCannotBeDeclaredRecoveredWithoutDecode() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("partial invalid m4a".utf8).write(to: url)
        XCTAssertThrowsError(try AVAudioFile(forReading: url))
    }
}
