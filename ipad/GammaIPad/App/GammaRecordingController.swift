import AVFAudio
import AudioToolbox
import UIKit
import Combine

@MainActor
final class GammaRecordingController: NSObject, ObservableObject, AVAudioRecorderDelegate, AVAudioPlayerDelegate {
    @Published private(set) var session: GammaRecordingSession?
    @Published private(set) var preparing = false
    @Published private(set) var recording = false
    @Published private(set) var elapsed: Double = 0
    @Published var errorMessage: String?
    @Published private(set) var playing = false
    @Published private(set) var playbackTime: Double = 0
    @Published private(set) var playbackDuration: Double = 0
    @Published private(set) var playbackRecordingID: String?
    var canRollSegment: () -> Bool = { true }
    var recordingStamp: GammaAudioStamp? {
        guard recording, let recorder, recorder.isRecording, let session, let id = session.activeSegmentID else { return nil }
        return GammaAudioStamp(recordingID: session.id, segmentID: id, seconds: recorder.currentTime)
    }
    var currentPlaybackTime: Double {
        guard playing, let player else { return playbackTime }
        return durations.prefix(playingIndex).reduce(0, +) + player.currentTime
    }
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var root: URL?
    private var save: ((GammaRecordingSession) throws -> Void)?
    private var player: AVAudioPlayer?
    private var playlist: [URL] = []
    private var durations: [Double] = []
    private var playingIndex = 0
    private var pendingCommit: GammaRecordingSession?
    var hasPendingSave: Bool { pendingCommit != nil }
    private let segmentLimit: Double = 300

    override init() {
        super.init()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(interruption(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        center.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        center.addObserver(self, selector: #selector(mediaReset), name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
        center.addObserver(self, selector: #selector(backgrounded), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    func begin(_ value: GammaRecordingSession, root: URL,
               save: @escaping (GammaRecordingSession) throws -> Void) async {
        guard !recording, !preparing, !hasPendingSave else { return }
        guard value.state != .stopped, value.activeSegmentID == nil else {
            errorMessage = "Recover the interrupted segment before resuming."; return
        }
        preparing = true; errorMessage = nil
        defer { preparing = false }
        let allowed = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
        }
        guard allowed else { errorMessage = "Microphone access is disabled. Allow Gamma in Settings → Privacy & Security → Microphone."; return }
        guard UIApplication.shared.applicationState == .active else {
            errorMessage = "Return to Gamma and tap Record to start the microphone."; return
        }
        stopPlayback()
        self.root = root; self.save = save; session = value
        do { try startSegment() }
        catch {
            recorder?.stop(); recorder = nil; recording = false; timer?.invalidate(); timer = nil
            var failed = session ?? value
            failed.state = failed.activeSegmentID == nil ? .interrupted : .recoveryRequired
            try? commit(failed)
            errorMessage = "Recording could not start: \(error.localizedDescription)"
            deactivateAudio()
        }
    }

    private func startSegment() throws {
        guard var next = session, let root else { throw CocoaError(.fileNoSuchFile) }
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.record, mode: .default)
        try audio.setActive(true)
        next.activeSegmentID = UUID().uuidString.lowercased(); next.state = .recording
        let url = try GammaRecordingFiles.url(root: root, recordingID: next.id, segmentID: next.activeSegmentID!)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Publish recovery identity before capture begins. A start failure leaves
        // explicit recoverable state, never an untracked live microphone.
        try commit(next)
        let input = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000])
        input.delegate = self
        guard input.prepareToRecord(), input.record() else {
            input.stop(); throw CocoaError(.fileWriteUnknown)
        }
        recorder = input; recording = true; elapsed = next.duration
        startTimer()
    }
    private func startTimer() {
        timer?.invalidate()
        timer = Timer(timeInterval: playing ? (1.0 / 30.0) : 0.5, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        RunLoop.main.add(timer!, forMode: .common)
    }
    @objc private func tick() {
        if let recorder, recording {
            elapsed = (session?.duration ?? 0) + recorder.currentTime
            if recorder.currentTime >= segmentLimit && canRollSegment() {
                do { try finalize(nextState: .paused); try startSegment() }
                catch { errorMessage = "Recording paused: \(error.localizedDescription)"; recording = false; deactivateAudio() }
            }
        } else if let player, playing {
            playbackTime = durations.prefix(playingIndex).reduce(0, +) + player.currentTime
        }
    }
    func pause() {
        guard recording else { return }
        do { try finalize(nextState: .paused) }
        catch { errorMessage = "Could not save the recording: \(error.localizedDescription)" }
        deactivateAudio()
    }
    func stop() {
        if recording {
            do { try finalize(nextState: .stopped) }
            catch { errorMessage = "Could not finish the recording: \(error.localizedDescription)" }
        } else if var next = session, next.activeSegmentID == nil, !hasPendingSave {
            next.state = .stopped
            do { try commit(next) } catch { errorMessage = error.localizedDescription }
        }
        deactivateAudio()
    }
    private func finalize(nextState: GammaRecordingSession.State) throws {
        guard var next = session, let root, let id = next.activeSegmentID else { return }
        let hadAudio = (recorder?.currentTime ?? 0) > 0
        recorder?.delegate = nil; recorder?.stop(); recorder = nil
        recording = false; timer?.invalidate(); timer = nil
        let url = try GammaRecordingFiles.url(root: root, recordingID: next.id, segmentID: id)
        do {
            let duration = try Self.validatedDuration(url)
            if duration > 0 { next.segments.append(GammaAudioSegment(id: id, duration: duration)) }
            next.activeSegmentID = nil; next.state = nextState
        } catch {
            // Never assume that a stopped/partial M4A is playable. Keep the file
            // and its identity for explicit recovery; preserve earlier segments.
            if !hadAudio && !FileManager.default.fileExists(atPath: url.path) {
                next.activeSegmentID = nil; next.state = nextState
            } else { next.state = .recoveryRequired }
            try? commit(next)
            throw error
        }
        // A disk failure here leaves the finalized snapshot pending verbatim;
        // do not reclassify successfully decoded audio as a damaged segment.
        try commit(next); elapsed = next.duration
    }
    static func validatedDuration(_ url: URL, fullyDecode: Bool = false) throws -> Double {
        let file = try AVAudioFile(forReading: url)
        let duration = Double(file.length) / file.processingFormat.sampleRate
        guard duration.isFinite, duration >= 0 else { throw CocoaError(.fileReadCorruptFile) }
        if fullyDecode, file.length > 0 {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 16_384) else { throw CocoaError(.fileReadCorruptFile) }
            var frames: AVAudioFramePosition = 0
            while frames < file.length {
                let count = AVAudioFrameCount(min(AVAudioFramePosition(buffer.frameCapacity), file.length - frames))
                try file.read(into: buffer, frameCount: count)
                guard buffer.frameLength > 0 else { throw CocoaError(.fileReadCorruptFile) }
                frames += AVAudioFramePosition(buffer.frameLength)
            }
            guard frames > 0 else { throw CocoaError(.fileReadCorruptFile) }
            return Double(frames) / file.processingFormat.sampleRate
        }
        // Normal finalized files get a decode check without rescanning a long
        // recording on every upload/play; crash recovery uses full decoding.
        if file.length > 0 {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                               frameCapacity: AVAudioFrameCount(min(file.length, 4096))) else { throw CocoaError(.fileReadCorruptFile) }
            try file.read(into: buffer)
            guard buffer.frameLength > 0 else { throw CocoaError(.fileReadCorruptFile) }
        }
        return duration
    }
    private func commit(_ value: GammaRecordingSession) throws {
        guard let save else { throw CocoaError(.fileWriteUnknown) }
        pendingCommit = value
        try save(value)
        session = value; pendingCommit = nil
    }
    func retrySave() {
        guard let pendingCommit else { return }
        do { try commit(pendingCommit); errorMessage = nil }
        catch { errorMessage = "Recording is still not saved: \(error.localizedDescription)" }
    }
    func recover(_ value: GammaRecordingSession, root: URL, discardIncomplete: Bool,
                 save: @escaping (GammaRecordingSession) throws -> Void) {
        guard !recording, !preparing, !hasPendingSave else { return }
        self.root = root; self.save = save
        var next = value.recovering()
        guard let active = next.activeSegmentID else { session = next; return }
        do {
            if discardIncomplete {
                next.recoveryNote = "An incomplete segment was excluded; the original local file was retained."
            } else {
                let url = try GammaRecordingFiles.url(root: root, recordingID: next.id, segmentID: active)
                let duration = try Self.validatedDuration(url, fullyDecode: true)
                if duration > 0 { next.segments.append(GammaAudioSegment(id: active, duration: duration)) }
            }
            next.activeSegmentID = nil; next.state = .paused
            try commit(next); elapsed = next.duration; errorMessage = nil
        } catch { errorMessage = "The partial segment could not be recovered. Earlier audio is preserved. \(error.localizedDescription)" }
    }
    func pauseBeforeLeaving() -> Bool {
        if preparing { return false }
        pause(); stopPlayback()
        return !hasPendingSave
    }
    private func deactivateAudio() { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    @objc private func backgrounded() { interruptRecording("App moved to the background. Resume explicitly when ready.") }
    @objc private func interruption(_ note: Notification) {
        guard (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt) == AVAudioSession.InterruptionType.began.rawValue else { return }
        interruptRecording("Audio was interrupted. Resume explicitly when ready.")
    }
    @objc private func routeChanged(_ note: Notification) {
        let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        if raw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue || raw == AVAudioSession.RouteChangeReason.newDeviceAvailable.rawValue {
            interruptRecording("Audio input changed. Check the microphone, then resume.")
        }
    }
    @objc private func mediaReset() { interruptRecording("Audio services restarted. Resume explicitly when ready.") }
    private func interruptRecording(_ message: String) {
        stopPlayback()
        guard recording else { return }
        do { try finalize(nextState: .interrupted); errorMessage = message }
        catch { errorMessage = "Interrupted audio needs recovery: \(error.localizedDescription)" }
        deactivateAudio()
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        let identity = ObjectIdentifier(recorder)
        Task { @MainActor [weak self] in
            guard let self, let current = self.recorder, ObjectIdentifier(current) == identity else { return }
            self.interruptRecording(flag ? "Recording was stopped by the system. Resume explicitly when ready." : "Audio recording stopped unexpectedly; check recovery status.")
        }
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        let identity = ObjectIdentifier(recorder)
        let message = error?.localizedDescription ?? "Audio encoder failed."
        Task { @MainActor [weak self] in
            guard let self, let current = self.recorder, ObjectIdentifier(current) == identity else { return }
            self.interruptRecording(message)
        }
    }
    func play(urls: [URL], recordingID: String? = nil, startPlaying: Bool = true) {
        guard !recording, !preparing else { return }
        stopPlayback()
        do {
            durations = try urls.map { try Self.validatedDuration($0) }
            guard !urls.isEmpty else { return }
            playlist = urls; playingIndex = 0; playbackDuration = durations.reduce(0, +); playbackTime = 0
            playbackRecordingID = recordingID
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
            try AVAudioSession.sharedInstance().setActive(true)
            if startPlaying { try playSegment(); startTimer() }
            else { player = try AVAudioPlayer(contentsOf: urls[0]); player?.delegate = self; player?.prepareToPlay() }
            errorMessage = nil
        } catch { stopPlayback(); errorMessage = "Cannot play recording: \(error.localizedDescription)" }
    }
    private func playSegment() throws {
        let next = try AVAudioPlayer(contentsOf: playlist[playingIndex]); next.delegate = self
        guard next.play() else { throw CocoaError(.fileReadUnknown) }
        player = next; playing = true
    }
    func pausePlayback() {
        player?.pause(); playbackTime = currentPlaybackTime; playing = false
        timer?.invalidate(); timer = nil
    }
    func resumePlayback() {
        guard let player, !recording else { return }
        if playbackTime >= playbackDuration { seek(to: 0) }
        if (self.player ?? player).play() { playing = true; startTimer() }
    }
    func seek(to seconds: Double) {
        guard seconds.isFinite, !playlist.isEmpty else { return }
        let target = min(max(0, seconds), playbackDuration)
        let wasPlaying = playing && target < playbackDuration
        var index = 0; var offset = 0.0
        while index < durations.count - 1 && offset + durations[index] <= target {
            offset += durations[index]; index += 1
        }
        do {
            if playingIndex != index || player == nil {
                player?.delegate = nil; player?.stop()
                let next = try AVAudioPlayer(contentsOf: playlist[index]); next.delegate = self
                player = next; playingIndex = index
            }
            player?.currentTime = min(max(0, target - offset), durations[index])
            playbackTime = target
            if wasPlaying { player?.play(); playing = true; startTimer() }
            else { player?.pause(); playing = false }
        } catch { errorMessage = "Cannot seek audio: \(error.localizedDescription)" }
    }
    func stopPlayback() {
        player?.delegate = nil; player?.stop(); player = nil; playing = false
        playlist = []; durations = []; playbackTime = 0; playbackRecordingID = nil
        if !recording { timer?.invalidate(); timer = nil; deactivateAudio() }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let identity = ObjectIdentifier(player)
        Task { @MainActor [weak self] in
            guard let self, let current = self.player, ObjectIdentifier(current) == identity else { return }
            guard flag else { self.stopPlayback(); self.errorMessage = "Audio playback failed."; return }
            self.playingIndex += 1
            if self.playingIndex >= self.playlist.count {
                self.playingIndex = max(0, self.playlist.count - 1)
                self.playing = false; self.playbackTime = self.playbackDuration
                self.timer?.invalidate(); self.timer = nil
                return
            }
            do { try self.playSegment() } catch { self.stopPlayback(); self.errorMessage = error.localizedDescription }
        }
    }
}
