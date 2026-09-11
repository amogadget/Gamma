import SwiftUI

/// Explicit local-file management. There is no quota or automatic eviction.
struct GammaDownloadsView: View {
    @ObservedObject var workspace: GammaWorkspace
    @Environment(\.dismiss) private var dismiss
    @State private var removal: GammaPaper?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(workspace.username ?? "Gamma").font(.headline)
                    Text(workspace.accountServer).font(.caption).textSelection(.enabled)
                    Text("Local files: \(ByteCountFormatter.string(fromByteCount: workspace.localUsageBytes, countStyle: .file))")
                    Text("Downloads stay on this iPad until you remove them. PDF, notes, handwriting and recordings are prepared together. Existing local recordings are reused.")
                        .font(.caption).foregroundStyle(.secondary)
                    if workspace.isOffline {
                        Label("Local workspace · sign in to download or sync", systemImage: "wifi.slash")
                    }
                }
                if let error = workspace.errorMessage {
                    Section { Text(error).font(.caption).foregroundStyle(.red) }
                }
                Section("Documents") {
                    ForEach(workspace.papers) { paper in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(paper.content.isEmpty ? "Untitled PDF" : paper.content).font(.headline)
                            Text(ByteCountFormatter.string(fromByteCount: workspace.localDocumentBytes[paper.id] ?? 0, countStyle: .file))
                                .font(.caption).foregroundStyle(.secondary)
                            if let entry = workspace.offlineEntries[paper.id] {
                                Text(entry.state.rawValue.capitalized).font(.subheadline)
                                HStack {
                                    readiness("PDF", entry.pdfReady)
                                    readiness("Notes / ink", entry.snapshotReady)
                                    readiness("Recordings", entry.audioReady)
                                }.font(.caption)
                                if let error = entry.error { Text(error).font(.caption).foregroundStyle(.orange) }
                                if entry.state == .queued || entry.state == .downloading {
                                    Button("Cancel download") { workspace.cancelDownload(paper.id) }
                                } else {
                                    Button(entry.state == .ready ? "Update offline copy" : "Retry download") {
                                        workspace.enqueueDownloads([paper])
                                    }.disabled(workspace.isOffline)
                                }
                            } else {
                                Text("Not prepared for offline use").font(.caption).foregroundStyle(.secondary)
                                Button("Download PDF, notes and recordings") { workspace.enqueueDownloads([paper]) }
                                    .disabled(workspace.isOffline)
                            }
                            Button("Remove downloaded files…", role: .destructive) { removal = paper }
                                .font(.caption).disabled(workspace.busy || workspace.syncing || workspace.paper?.id == paper.id)
                        }.padding(.vertical, 5)
                    }
                }
                Section {
                    Text("Removing local files does not delete the Gamma document or server assets. Notes, handwriting, pending edits and recording recovery data are protected. Files that cannot safely be downloaded again are kept.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.borderless)
            .navigationTitle("On this iPad")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onAppear { workspace.refreshOfflineStatus() }
            .confirmationDialog("Remove downloaded files from this iPad?", isPresented: Binding(
                get: { removal != nil }, set: { if !$0 { removal = nil } }
            ), titleVisibility: .visible) {
                Button("Remove local downloaded files", role: .destructive) {
                    if let paper = removal { workspace.removeDownloadedFiles(paper) }
                    removal = nil
                }
                Button("Cancel", role: .cancel) { removal = nil }
            } message: {
                Text("Server documents are not deleted. Pending edits and local recording recovery files are never removed.")
            }
        }
    }
    private func readiness(_ label: String, _ ready: Bool) -> some View {
        Label(label, systemImage: ready ? "checkmark.circle.fill" : "circle")
            .foregroundStyle(ready ? Color.green : Color.secondary)
    }
}
