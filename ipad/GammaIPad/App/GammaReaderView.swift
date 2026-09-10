import SwiftUI
import PDFKit
import PencilKit

struct GammaReaderView: View {
    @ObservedObject var workspace: GammaWorkspace
    let paper: GammaPaper
    let document: PDFDocument
    @State private var currentPage = 0
    @State private var requestedPage: Int?
    @State private var pencil = true
    @State private var notesVisible = true
    @State private var notesSheet = false
    @State private var localSaveError: String?
    @State private var confirmingLeave = false
    @State private var showStatus = false
    @State private var collapsed = Set<String>()
    @State private var resumeAfterScrub = false
    @ObservedObject private var recorder: GammaRecordingController
    init(workspace: GammaWorkspace, paper: GammaPaper, document: PDFDocument) {
        self.workspace = workspace; self.paper = paper; self.document = document
        self.recorder = workspace.recorder
    }
    private var replaying: Bool { recorder.playbackRecordingID != nil }

    var body: some View {
        GeometryReader { geometry in
            let wide = geometry.size.width >= 900
            VStack(spacing: 0) {
                header(wide: wide)
                if replaying { replayControls }
                Rectangle().fill(GammaTheme.line).frame(height: 1)
                HStack(spacing: 0) {
                    pdfSurface
                    if wide && notesVisible {
                        Rectangle().fill(GammaTheme.line).frame(width: 1)
                        notes.frame(width: min(360, geometry.size.width * 0.33))
                    }
                }
            }.background(GammaTheme.canvas)
            .sheet(isPresented: $notesSheet) {
                notes.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
            }
            .onChange(of: wide) { _, value in if value { notesSheet = false } }
        }
        .tint(GammaTheme.accent)
        .onChange(of: recorder.playbackTime) { _, _ in followReplayPage() }
        .onChange(of: recorder.playbackRecordingID) { _, _ in followReplayPage() }
        .confirmationDialog("Leave despite a local storage error?", isPresented: $confirmingLeave) {
            Button("Stay in Reader", role: .cancel) {}
            Button("Leave — unsaved strokes may be lost", role: .destructive) { workspace.closeReader() }
        }
    }

    private func followReplayPage() {
        if let page = workspace.replayPage() { requestedPage = page - 1 }
    }
    private var replayControls: some View {
        VStack(spacing: 3) {
            HStack(spacing: 12) {
                Text("NOTE REPLAY").font(.system(size: 10, weight: .semibold)).tracking(1).foregroundStyle(.secondary)
                Button { recorder.seek(to: recorder.currentPlaybackTime - 10); followReplayPage() } label: { Image(systemName: "gobackward.10") }
                Button { if recorder.playing { recorder.pausePlayback() } else { recorder.resumePlayback() } }
                    label: { Image(systemName: recorder.playing ? "pause.fill" : "play.fill") }
                Button { recorder.seek(to: recorder.currentPlaybackTime + 10); followReplayPage() } label: { Image(systemName: "goforward.10") }
                Slider(value: Binding(get: { recorder.playbackTime }, set: { recorder.seek(to: $0); followReplayPage() }),
                       in: 0...max(0.01, recorder.playbackDuration), onEditingChanged: { editing in
                    if editing { resumeAfterScrub = recorder.playing; recorder.pausePlayback() }
                    else if resumeAfterScrub { recorder.resumePlayback() }
                }).accessibilityIdentifier("note-replay-timeline")
                Text("\(replayTime(recorder.playbackTime)) / \(replayTime(recorder.playbackDuration))")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                Button("Done") { recorder.stopPlayback() }.font(.caption)
            }
            if (workspace.replaySession?.replayEvents ?? []).isEmpty {
                Text("This older recording has no note timing; audio plays with static notes.")
                    .font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.padding(.horizontal, 14).padding(.vertical, 8).background(GammaTheme.surface)
    }
    private func replayTime(_ seconds: Double) -> String {
        let value = Int(max(0, seconds.isFinite ? seconds : 0))
        return String(format: "%d:%02d", value / 60, value % 60)
    }

    private func header(wide: Bool) -> some View {
        HStack(spacing: 12) {
            iconButton("Library", symbol: "house") {
                if localSaveError != nil { confirmingLeave = true } else { workspace.closeReader() }
            }.disabled(workspace.busy)
            Rectangle().fill(GammaTheme.line).frame(width: 1, height: 20)
            Text(paper.content.isEmpty ? "Untitled PDF" : paper.content)
                .font(.system(size: 14, weight: .medium)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            Text("\(currentPage + 1) / \(document.pageCount)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
            Button { showStatus.toggle() } label: {
                Image(systemName: workspace.syncing ? "arrow.triangle.2.circlepath" : workspace.syncUnavailable || workspace.errorMessage != nil || localSaveError != nil ? "exclamationmark.circle" : workspace.pendingCount > 0 ? "icloud.and.arrow.up" : "checkmark.icloud")
                    .foregroundStyle(workspace.syncUnavailable || localSaveError != nil ? Color.orange : Color.secondary)
                    .frame(width: 32, height: 34)
            }.buttonStyle(.plain).accessibilityLabel("Sync status")
                .popover(isPresented: $showStatus) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Synchronization").font(.headline)
                        Text(localSaveError ?? workspace.errorMessage ?? workspace.status).font(.subheadline)
                        Button("Retry sync") { Task { await workspace.retrySync() } }.disabled(workspace.syncing)
                    }.padding(20).frame(width: 320).presentationCompactAdaptation(.popover)
                }
            GammaRecordingButton(workspace: workspace, recorder: workspace.recorder)
            Button { perform { try workspace.newInk(pdfPage: currentPage + 1) }; pencil = true } label: {
                Label("New ink", systemImage: "pencil.tip.crop.circle.badge.plus").font(.system(size: 12, weight: .medium))
                    .padding(.horizontal, 10).frame(height: 32)
                    .background(GammaTheme.accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 6))
            }.buttonStyle(.plain).disabled(workspace.busy || localSaveError != nil || replaying).accessibilityIdentifier("new-ink")
            iconButton("Pencil mode", symbol: "pencil.tip", active: pencil && workspace.selected?.isInk == true) { pencil.toggle() }
                .disabled(workspace.selected?.isInk != true || replaying)
            iconButton("Notes", symbol: "sidebar.right", active: wide ? notesVisible : notesSheet) {
                if wide { notesVisible.toggle() } else { notesSheet.toggle() }
            }
        }.padding(.horizontal, 14).frame(height: 52).background(GammaTheme.surface)
    }

    private var pdfSurface: some View {
        let inkID = workspace.selected?.isInk == true ? workspace.selectedID : nil
        return PDFInkView(document: document,
            loadDrawing: { try workspace.drawing(blockID: inkID, pdfPage: $0) },
            saveDrawing: { page, drawing in
                do {
                    try workspace.saveDrawing(blockID: inkID, pdfPage: page, drawing: drawing,
                                              pageID: paper.id, docID: paper.properties.docID)
                    localSaveError = nil
                } catch { localSaveError = error.localizedDescription; throw error }
            }, onError: { localSaveError = $0 },
            isDrawing: pencil && inkID != nil && !workspace.busy && !replaying,
            backgroundDrawing: { try workspace.background(excluding: inkID, pdfPage: $0) },
            editablePage: workspace.selectedInkPage, contentRevision: workspace.contentRevision,
            onPageChanged: { currentPage = $0; workspace.pageNavigated($0 + 1) }, requestedPage: requestedPage,
            highlights: { index in
                (workspace.page?.blocks ?? []).compactMap { block in
                    guard block.isHighlight, let position = block.properties.pdfPosition,
                          block.pdfPage == index + 1 || position.rects?.contains(where: { $0.pageNumber == index + 1 }) == true else { return nil }
                    return GammaPDFHighlight(id: block.id, position: position, color: block.properties.color,
                                             selected: workspace.selectedID == block.id)
                }
            }, inkHitTest: { index, point, tolerance in
                guard !workspace.busy, localSaveError == nil, let page = workspace.page else { return nil }
                let drawings: [(id: String, drawing: PKDrawing)] = page.blocks.compactMap { block in
                    guard block.isInk, block.properties.pdfPage == index + 1,
                          let data = page.drawings[block.id], let drawing = try? PKDrawing(data: data) else { return nil }
                    return (block.id, drawing)
                }
                return InkSelection.target(at: point, drawings: drawings, selectedID: pencil ? inkID : nil, tolerance: tolerance)
            }, onSelectInk: { id in
                workspace.select(id)
                pencil = true
                notesVisible = true
            }, onInkBegan: { _ in workspace.inkBegan(blockID: inkID) },
            onInkEnded: { _ in workspace.inkEnded(blockID: inkID) },
            replayActive: replaying,
            replayDrawing: { workspace.replayDrawing(pdfPage: $0) },
            replayHitTest: { workspace.replaySeek(at: $1, pdfPage: $0, tolerance: $2) },
            onReplaySeek: { time in recorder.seek(to: time); recorder.resumePlayback(); followReplayPage() })
    }

    private var notes: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "list.bullet").font(.system(size: 11))
                Text("NOTES").font(.system(size: 11, weight: .medium)).tracking(1.2)
                Text("\(orderedBlocks.count)").font(.caption2).foregroundStyle(.tertiary)
                Spacer()
                iconButton("Reload notes", symbol: "arrow.clockwise") { Task { await workspace.refreshPage() } }
                    .disabled(workspace.busy || workspace.syncing || localSaveError != nil)
            }.foregroundStyle(.secondary).padding(.horizontal, 14).frame(height: 38).background(GammaTheme.surface)
            Rectangle().fill(GammaTheme.line).frame(height: 1)
            ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(paper.content.isEmpty ? "Untitled PDF" : paper.content)
                        .font(.system(size: 16, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 16).padding(.horizontal, 14)
                    LazyVStack(alignment: .leading, spacing: 4) {
                        ForEach(orderedBlocks, id: \.block.id) { row in
                            noteRow(row).id(row.block.id).opacity(workspace.replayNoteVisible(row.block) ? 1 : 0.25)
                        }
                    }.padding(.horizontal, 8)
                    if orderedBlocks.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("No notes yet").font(.subheadline)
                            Text("Use New ink to add a handwritten annotation.").font(.caption).foregroundStyle(.secondary)
                        }.padding(20)
                    }
                }.padding(.bottom, 16)
            }.onChange(of: workspace.selectedID) { _, id in
                if let id { withAnimation { proxy.scrollTo(id, anchor: .center) } }
            }
            }
            if let selected = workspace.selected { editor(selected) }
        }.background(GammaTheme.notes)
    }

    private func noteRow(_ row: NoteRow) -> some View {
        let block = row.block
        let selected = workspace.selectedID == block.id
        let hasChildren = workspace.page?.blocks.contains(where: { $0.parentID == block.id }) == true
        return HStack(alignment: .top, spacing: 5) {
            Button {
                if collapsed.contains(block.id) { collapsed.remove(block.id) } else { collapsed.insert(block.id) }
            } label: {
                Image(systemName: hasChildren ? (collapsed.contains(block.id) ? "chevron.right" : "chevron.down") : "circle.fill")
                    .font(.system(size: hasChildren ? 9 : 4)).foregroundStyle(.tertiary).frame(width: 16, height: 26)
            }.buttonStyle(.plain).disabled(!hasChildren)
            Button {
                workspace.select(block.id)
                if let page = block.pdfPage { requestedPage = page - 1 }
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        if block.isHighlight {
                            Circle().fill(Color(uiColor: GammaPDFHighlight.uiColor(block.properties.color).withAlphaComponent(0.7))).frame(width: 8, height: 8)
                        } else if block.isInk { Image(systemName: "pencil.tip").font(.system(size: 10)).foregroundStyle(.secondary) }
                        else if block.isAudio { Image(systemName: "waveform").font(.system(size: 10)).foregroundStyle(.secondary) }
                        if let page = block.pdfPage { Text("p.\(page)").font(.system(size: 10)).foregroundStyle(.secondary) }
                        Spacer(minLength: 0)
                    }
                    if !block.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(block.content).font(.system(size: 14)).foregroundStyle(.primary).multilineTextAlignment(.leading)
                    } else if block.isAudio {
                        Text("Recording").font(.system(size: 13)).foregroundStyle(.secondary)
                    } else if block.isInk {
                        Text("Handwriting").font(.system(size: 13)).foregroundStyle(.secondary)
                    } else if !block.isHighlight {
                        Text("Empty note").font(.system(size: 13)).foregroundStyle(.tertiary)
                    }
                    if let quote = block.properties.quote, !quote.isEmpty {
                        HStack(spacing: 8) {
                            Rectangle().fill(Color.secondary.opacity(0.22)).frame(width: 2)
                            Text(quote).font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 7)
                        }.fixedSize(horizontal: false, vertical: true).background(GammaTheme.surface.opacity(0.55))
                    }
                }.padding(9).frame(maxWidth: .infinity, alignment: .leading)
                    .background(selected ? GammaTheme.surface : .clear, in: RoundedRectangle(cornerRadius: 7))
                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(selected ? GammaTheme.line : .clear))
            }.buttonStyle(.plain).disabled(workspace.busy || localSaveError != nil)
        }.padding(.leading, CGFloat(min(row.depth, 6)) * 14)
    }

    private func editor(_ selected: GammaBlock) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Rectangle().fill(GammaTheme.line).frame(height: 1)
            HStack {
                Text(selected.isHighlight ? "HIGHLIGHT NOTE" : "NOTE").font(.system(size: 10, weight: .medium)).tracking(1).foregroundStyle(.secondary)
                Spacer()
                if selected.isInk || selected.properties.nativeNote == true {
                    Button { perform { try workspace.addChild(parentID: selected.id) } }
                    label: { Label("Child note", systemImage: "plus").font(.caption) }
                        .disabled(workspace.busy || workspace.syncing)
                }
            }.padding(.horizontal, 14)
            TextEditor(text: Binding(get: {
                workspace.page?.blocks.first(where: { $0.id == selected.id })?.content ?? ""
            }, set: { text in perform { try workspace.editContent(blockID: selected.id, text: text) } }))
                .font(.system(size: 14)).scrollContentBackground(.hidden)
                .frame(height: 110).padding(.horizontal, 10).disabled(workspace.busy || replaying)
                .accessibilityIdentifier("block-content-editor")
            if workspace.page?.outbox.contains(where: { $0.blockID == selected.id && $0.conflict }) == true {
                HStack {
                    Text("Conflict").foregroundStyle(.orange)
                    Button("Keep local") { Task { await workspace.resolveConflict(blockID: selected.id, keepLocal: true) } }
                    Button("Use remote") { Task { await workspace.resolveConflict(blockID: selected.id, keepLocal: false) } }
                }.font(.caption).padding(.horizontal, 14)
            }
        }.padding(.bottom, 8).background(GammaTheme.surface)
    }
    private func iconButton(_ label: String, symbol: String, active: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 15))
                .foregroundStyle(active ? GammaTheme.accent : Color.secondary)
                .frame(width: 34, height: 34)
                .background(active ? GammaTheme.accent.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain).accessibilityLabel(label).help(label)
    }
    private struct NoteRow { let block: GammaBlock; let depth: Int }
    private var orderedBlocks: [NoteRow] {
        let blocks = workspace.page?.blocks ?? []
        var visited = Set<String>()
        func walk(_ parent: String, depth: Int) -> [NoteRow] {
            var rows: [NoteRow] = []
            for block in blocks where block.parentID == parent && visited.insert(block.id).inserted {
                rows.append(NoteRow(block: block, depth: depth))
                if !collapsed.contains(block.id) { rows += walk(block.id, depth: depth + 1) }
            }
            return rows
        }
        return walk(paper.id, depth: 0)
    }
    private func perform(_ operation: () throws -> Void) {
        do { try operation() } catch { localSaveError = error.localizedDescription; showStatus = true }
    }
}
