import SwiftUI

struct GammaRecordingButton: View {
    @ObservedObject var workspace: GammaWorkspace
    @ObservedObject var recorder: GammaRecordingController
    @State private var showing = false
    var body: some View {
        Button { showing.toggle() } label: {
            HStack(spacing: 5) {
                Image(systemName: recorder.recording ? "record.circle.fill" : "mic")
                    .foregroundStyle(recorder.recording ? Color.red : Color.secondary)
                if recorder.recording { Text(audioTime(recorder.elapsed)).font(.system(size: 11, design: .monospaced)) }
            }.font(.system(size: 15)).frame(minWidth: 30, minHeight: 34)
        }.buttonStyle(.plain).accessibilityLabel(recorder.recording ? "Recording controls" : "Record audio")
            .accessibilityIdentifier("recording-controls")
            .popover(isPresented: $showing) {
                GammaRecordingPanel(workspace: workspace, recorder: recorder)
                    .frame(width: 360).presentationCompactAdaptation(.popover)
            }
            .onChange(of: recorder.playbackRecordingID) { _, id in if id != nil { showing = false } }
    }
}

struct GammaRecordingPanel: View {
    @ObservedObject var workspace: GammaWorkspace
    @ObservedObject var recorder: GammaRecordingController
    @State private var discardID: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Recordings").font(.headline)
                Spacer()
                if recorder.preparing || workspace.busy { ProgressView().controlSize(.small) }
            }
            if recorder.recording {
                HStack {
                    Circle().fill(.red).frame(width: 8, height: 8)
                    Text(audioTime(recorder.elapsed)).font(.system(.title2, design: .monospaced))
                    Spacer()
                    Button("Pause") { recorder.pause() }.buttonStyle(.bordered)
                    Button("Stop") { recorder.stop() }.buttonStyle(.borderedProminent)
                }
            } else {
                Button { Task { await workspace.startRecording() } } label: {
                    Label("Start recording", systemImage: "record.circle")
                        .frame(maxWidth: .infinity).padding(.vertical, 5)
                }.buttonStyle(.borderedProminent)
                    .disabled(workspace.busy || recorder.preparing || recorder.hasPendingSave)
            }
            if recorder.hasPendingSave {
                Text("Recording metadata is not saved. Keep this page open.").font(.caption).foregroundStyle(.red)
                Button("Retry local save") { recorder.retrySave() }
            }
            if let error = recorder.errorMessage { Text(error).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach((workspace.page?.blocks ?? []).filter(\.isAudio)) { block in
                        VStack(alignment: .leading, spacing: 7) {
                            HStack {
                                Image(systemName: "waveform").foregroundStyle(.secondary)
                                Text(block.content.isEmpty ? "Recording" : block.content).font(.subheadline).lineLimit(2)
                                Spacer()
                                Text(audioTime(block.properties.duration ?? 0)).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                            }
                            if let local = workspace.page?.recordings?[block.id], local.activeSegmentID != nil,
                               !(recorder.recording && recorder.session?.id == block.id) {
                                Text("Interrupted segment needs recovery").font(.caption).foregroundStyle(.orange)
                                HStack {
                                    Button("Recover") { workspace.recoverRecording(block.id, discardIncomplete: false) }
                                    Button("Keep finalized audio") { discardID = block.id }
                                }.font(.caption).disabled(recorder.recording || recorder.hasPendingSave)
                            } else if let local = workspace.page?.recordings?[block.id], local.state != .stopped,
                                      !(recorder.recording && recorder.session?.id == block.id) {
                                HStack {
                                    Button("Continue") { Task { await workspace.startRecording(resuming: block.id) } }
                                    Button("Finish") { workspace.finishPausedRecording(block.id) }
                                }.font(.caption).disabled(workspace.busy || recorder.recording || recorder.preparing || recorder.hasPendingSave)
                            }
                            HStack {
                                Text("\(block.properties.segments?.count ?? 0) segments").font(.caption2).foregroundStyle(.secondary)
                                Spacer()
                                Button("Show note") { workspace.select(block.id) }.font(.caption)
                                Button { Task { await workspace.playRecording(block.id) } } label: { Label("Replay", systemImage: "play.fill").font(.caption) }
                                    .disabled(workspace.busy || recorder.recording || (block.properties.segments ?? []).isEmpty)
                            }
                            if workspace.page?.outbox.contains(where: { $0.blockID == block.id && $0.conflict }) == true {
                                Text("Audio sync conflict").font(.caption).foregroundStyle(.orange)
                                HStack {
                                    Button("Keep local") { Task { await workspace.resolveConflict(blockID: block.id, keepLocal: true) } }
                                    Button("Use remote") { Task { await workspace.resolveConflict(blockID: block.id, keepLocal: false) } }
                                }.font(.caption).disabled(recorder.recording || workspace.busy)
                            }
                        }
                        Divider()
                    }
                }
            }.frame(maxHeight: 270)
            if recorder.playing {
                HStack {
                    Text("\(audioTime(recorder.playbackTime)) / \(audioTime(recorder.playbackDuration))")
                        .font(.system(.caption, design: .monospaced))
                    Spacer()
                    Button("Stop playback") { recorder.stopPlayback() }.font(.caption)
                }
            }
            Text("Audio is linked to this Gamma page. Pausing or leaving the app finalizes the current segment; resume is always explicit.")
                .font(.caption2).foregroundStyle(.secondary)
            Text(workspace.status).font(.caption2).foregroundStyle(.secondary)
        }.padding(18)
        .confirmationDialog("Exclude the incomplete segment?", isPresented: Binding(get: { discardID != nil }, set: { if !$0 { discardID = nil } })) {
            Button("Keep only finalized audio", role: .destructive) {
                if let id = discardID { workspace.recoverRecording(id, discardIncomplete: true) }
                discardID = nil
            }
            Button("Cancel", role: .cancel) { discardID = nil }
        } message: { Text("Earlier audio will stay intact. The incomplete file is retained locally but will not be played or uploaded.") }
    }
}

private func audioTime(_ seconds: Double) -> String {
    let value = Int(max(0, seconds.isFinite ? min(seconds, 86_400_000) : 0))
    return value >= 3600 ? String(format: "%d:%02d:%02d", value / 3600, value / 60 % 60, value % 60)
        : String(format: "%d:%02d", value / 60, value % 60)
}
