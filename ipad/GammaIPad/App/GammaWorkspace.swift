import SwiftUI
import PDFKit
import PencilKit

@MainActor
final class GammaWorkspace: ObservableObject {
    @Published var username: String?
    @Published var papers: [GammaPaper] = []
    @Published var recentPageIDs: [String] = []
    @Published var paper: GammaPaper?
    @Published var document: PDFDocument?
    @Published var page: GammaPageCache?
    @Published var selectedID: String?
    @Published var contentRevision = 0
    @Published var status = "Sign in to Gamma"
    @Published var errorMessage: String?
    @Published var busy = false
    @Published var syncing = false
    @Published var syncUnavailable = false
    private var api: GammaAPI?
    private var cache: GammaCache?
    private var accountGeneration = UUID()
    let recorder = GammaRecordingController()
    private var currentPDFPage = 1
    private var strokeBegins: [String: GammaAudioStamp] = [:]
    private var replaySources: [String: (Data, PKDrawing)] = [:]
    private var pendingInkTiming: [String: (data: Data, recordingID: String, events: [GammaReplayEvent])] = [:]

    private let recordingClock: (() -> GammaAudioStamp?)?
    private var audioStamp: GammaAudioStamp? { recordingClock?() ?? recorder.recordingStamp }
    init(cache: GammaCache? = nil, api: GammaAPI? = nil, recordingClock: (() -> GammaAudioStamp?)? = nil) {
        self.recordingClock = recordingClock
        self.cache = cache
        self.api = api
        self.username = api?.authenticatedUsername
        recorder.canRollSegment = { [weak self] in self?.strokeBegins.isEmpty ?? true }
    }

    var selected: GammaBlock? { page?.blocks.first { $0.id == selectedID } }
    var selectedInkPage: Int? { selected?.isInk == true ? selected?.properties.pdfPage.map { $0 - 1 } : nil }
    var pendingCount: Int { page?.outbox.count ?? 0 }

    func login(server: String, username: String, password: String) async {
        busy = true
        defer { busy = false }
        var candidate: GammaAPI?
        do {
            let client = try GammaAPI(server: server); candidate = client
            let authenticatedUser = try await client.login(username: username, password: password)
            let storage = try GammaCache.application(server: client.baseURL, username: authenticatedUser)
            let library = try storage.library()
            recentPageIDs = try storage.recentPageIDs()
            api = client; cache = storage; self.username = authenticatedUser
            accountGeneration = UUID(); papers = library; errorMessage = nil; syncUnavailable = false
            UserDefaults.standard.set(client.baseURL.absoluteString, forKey: "gamma.server")
            UserDefaults.standard.set(authenticatedUser, forKey: "gamma.username")
            await refreshLibrary()
            busy = false
            await sync()
        } catch { candidate?.close(); errorMessage = error.localizedDescription }
    }
    func signOut() async {
        guard !syncing, !busy, recorder.pauseBeforeLeaving() else { return }
        accountGeneration = UUID()
        await api?.logout(); api?.close(); api = nil; cache = nil
        username = nil; papers = []; recentPageIDs = []; closeReader(); status = "Signed out. Cached data and pending changes are preserved for this account."
    }
    func startRecording(resuming id: String? = nil) async {
        guard !busy, let cache, let original = page, !recorder.recording else { return }
        busy = true; defer { busy = false }
        let value = id.flatMap { original.recordings?[$0] } ?? GammaRecordingSession.new(pageID: original.pageID)
        let generation = accountGeneration
        await recorder.begin(value.recovering(), root: cache.rootURL) { [weak self] value in
            guard let self, self.accountGeneration == generation else { throw CocoaError(.fileWriteNoPermission) }
            try self.saveRecording(value, pageID: original.pageID, docID: original.docID)
        }
        if let id = recorder.session?.id { selectedID = id }
    }
    func saveRecording(_ value: GammaRecordingSession, pageID: String, docID: String) throws {
        guard let cache, value.pageID == pageID else { throw CocoaError(.fileWriteNoPermission) }
        var snapshot = try cache.loadPage(pageID: pageID, docID: docID)
        var next = value
        // Recorder callbacks carry audio file state, while Pencil/page callbacks
        // update the latest timeline in the cache. Never overwrite those events
        // with an older copy held by AVAudioRecorder's controller.
        next.replayEvents = snapshot.recordings?[value.id]?.replayEvents ?? value.replayEvents
        if let active = next.activeSegmentID,
           !(next.replayEvents ?? []).contains(where: { $0.kind == .page && $0.segmentID == active }) {
            if next.replayEvents == nil { next.replayEvents = [] }
            next.replayEvents?.append(GammaReplayEvent(kind: .page, segmentID: active, start: 0, end: 0, pdfPage: currentPDFPage))
        }
        if let block = snapshot.blocks.first(where: { $0.id == value.id }) {
            guard block.isAudio else { throw CocoaError(.fileWriteFileExists) }
            next.revision = block.properties.audioRevision ?? value.revision
            // Keep uploaded immutable asset references when local recorder state
            // predates a completed upload; do not discard newly recorded files.
            for i in next.segments.indices {
                if let remote = block.properties.segments?.first(where: { $0.id == next.segments[i].id }) {
                    next.segments[i].asset = remote.asset
                }
            }
        }
        if snapshot.recordings == nil { snapshot.recordings = [:] }
        snapshot.recordings?[next.id] = next
        if let i = snapshot.blocks.firstIndex(where: { $0.id == next.id }) {
            snapshot.blocks[i].properties.audioState = next.serverState
            snapshot.blocks[i].properties.segments = next.segments
            snapshot.blocks[i].properties.duration = next.duration
            snapshot.blocks[i].properties.replayEvents = next.replayEvents
        } else {
            snapshot.blocks.append(GammaBlock(id: next.id, parentID: pageID, content: "Recording",
                properties: GammaProperties(type: "audio", audioRevision: 0, audioState: next.serverState,
                                            segments: next.segments, duration: next.duration, replayEvents: next.replayEvents)))
        }
        enqueue(GammaMutation(kind: .audio, blockID: next.id, parentID: pageID,
                              revision: next.revision, audioSession: next), in: &snapshot)
        try persist(snapshot)
    }
    func recoverRecording(_ id: String, discardIncomplete: Bool) {
        guard let original = page, let value = original.recordings?[id], let cache else { return }
        let generation = accountGeneration
        recorder.recover(value, root: cache.rootURL, discardIncomplete: discardIncomplete) { [weak self] value in
            guard let self, self.accountGeneration == generation else { throw CocoaError(.fileWriteNoPermission) }
            try self.saveRecording(value, pageID: original.pageID, docID: original.docID)
        }
    }
    func finishPausedRecording(_ id: String) {
        guard let original = page, var value = original.recordings?[id], value.activeSegmentID == nil else { return }
        value.state = .stopped
        do { try saveRecording(value, pageID: original.pageID, docID: original.docID) }
        catch { recorder.errorMessage = error.localizedDescription }
    }
    func playRecording(_ id: String) async {
        guard !busy, !recorder.recording, let cache, let api,
              let block = page?.blocks.first(where: { $0.id == id && $0.isAudio }) else { return }
        busy = true; defer { busy = false }
        do {
            var urls: [URL] = []
            for segment in block.properties.segments ?? [] {
                let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: id, segmentID: segment.id)
                if !FileManager.default.fileExists(atPath: url.path) {
                    guard let asset = segment.asset else { throw CocoaError(.fileNoSuchFile) }
                    let data = try await api.asset(asset)
                    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                }
                _ = try GammaRecordingController.validatedDuration(url)
                urls.append(url)
            }
            replaySources = [:]
            recorder.play(urls: urls, recordingID: id)
        } catch { recorder.errorMessage = error.localizedDescription }
    }

    var replaySession: GammaRecordingSession? {
        guard let id = recorder.playbackRecordingID, let page else { return nil }
        if let local = page.recordings?[id] { return local }
        guard let block = page.blocks.first(where: { $0.id == id && $0.isAudio }) else { return nil }
        return GammaRecordingSession(id: id, pageID: page.pageID, state: .stopped,
            segments: block.properties.segments ?? [], revision: block.properties.audioRevision ?? 0,
            replayEvents: block.properties.replayEvents)
    }
    func replayPage() -> Int? {
        guard let session = replaySession else { return nil }
        return GammaReplay.page(at: recorder.currentPlaybackTime, events: session.replayEvents ?? [], segments: session.segments)
    }
    func replayDrawing(pdfPage: Int) -> PKDrawing? {
        guard let session = replaySession, let page else { return nil }
        var strokes: [PKStroke] = []
        for block in page.blocks where block.isInk && block.properties.pdfPage == pdfPage + 1 {
            guard let data = page.drawings[block.id] else { continue }
            if replaySources[block.id]?.0 != data {
                guard let drawing = try? PKDrawing(data: data) else { continue }
                replaySources[block.id] = (data, drawing)
            }
            if let drawing = replaySources[block.id]?.1 {
                strokes += GammaReplay.visibleDrawing(drawing, blockID: block.id, at: recorder.currentPlaybackTime,
                    events: session.replayEvents ?? [], segments: session.segments).strokes
            }
        }
        return PKDrawing(strokes: strokes)
    }
    func replaySeek(at point: CGPoint, pdfPage: Int, tolerance: CGFloat) -> Double? {
        guard let session = replaySession, let page else { return nil }
        for block in page.blocks.reversed() where block.isInk && block.properties.pdfPage == pdfPage + 1 {
            guard let data = page.drawings[block.id], let drawing = try? PKDrawing(data: data) else { continue }
            for stroke in drawing.strokes.reversed() where stroke.renderBounds.insetBy(dx: -tolerance, dy: -tolerance).contains(point) {
                if let event = GammaReplay.event(for: stroke, blockID: block.id, events: session.replayEvents ?? []),
                   let time = GammaReplay.time(event, segments: session.segments), time <= recorder.currentPlaybackTime { return max(0, time - 2) }
            }
        }
        return nil
    }
    func replayNoteVisible(_ block: GammaBlock) -> Bool {
        guard let session = replaySession,
              let event = session.replayEvents?.first(where: { $0.kind == .note && $0.blockID == block.id }),
              let time = GammaReplay.time(event, segments: session.segments) else { return true }
        return time <= recorder.currentPlaybackTime
    }
    func inkBegan(blockID: String?) {
        guard let id = blockID else { return }
        strokeBegins[id] = audioStamp
    }
    func inkEnded(blockID: String?) { if let id = blockID { strokeBegins.removeValue(forKey: id) } }
    func pageNavigated(_ number: Int) {
        currentPDFPage = max(1, number)
        guard let stamp = recorder.recordingStamp, var snapshot = page,
              recorder.session?.pageID == snapshot.pageID else { return }
        let event = GammaReplayEvent(kind: .page, segmentID: stamp.segmentID, start: stamp.seconds, end: stamp.seconds, pdfPage: currentPDFPage)
        if let last = snapshot.recordings?[stamp.recordingID]?.replayEvents?.last,
           last.kind == .page && last.pdfPage == currentPDFPage && last.segmentID == stamp.segmentID { return }
        appendReplayEvents([event], recordingID: stamp.recordingID, snapshot: &snapshot)
        do { try persist(snapshot) } catch { errorMessage = error.localizedDescription }
    }
    private func appendReplayEvents(_ events: [GammaReplayEvent], recordingID: String, snapshot: inout GammaPageCache) {
        guard var session = snapshot.recordings?[recordingID] else { return }
        if session.replayEvents == nil { session.replayEvents = [] }
        session.replayEvents?.append(contentsOf: events)
        snapshot.recordings?[recordingID] = session
        if let index = snapshot.blocks.firstIndex(where: { $0.id == recordingID }) { snapshot.blocks[index].properties.replayEvents = session.replayEvents }
        enqueue(GammaMutation(kind: .audio, blockID: recordingID, parentID: snapshot.pageID,
                              revision: session.revision, audioSession: session), in: &snapshot)
    }

    func refreshLibrary() async {
        guard let api, let cache else { return }
        do { let library = try await api.papers(); try cache.saveLibrary(library); papers = library }
        catch { errorMessage = error.localizedDescription; status = "Offline / session unavailable — showing cached Gamma library" }
    }
    func open(_ paper: GammaPaper) async {
        guard let cache, let api, let docID = paper.properties.docID else { return }
        busy = true; defer { busy = false }
        do {
            var snapshot = try cache.loadPage(pageID: paper.id, docID: docID)
            let source = cache.sourceURL(docID: docID)
            if !FileManager.default.fileExists(atPath: source.path) {
                let temporary = try await api.download(paper)
                defer { try? FileManager.default.removeItem(at: temporary) }
                guard let original = PDFDocument(url: temporary), !original.isLocked, original.pageCount > 0 else {
                    throw NoteStoreError.invalidPDF
                }
                try cache.preserveSource(from: temporary, docID: docID)
            }
            guard let pdf = PDFDocument(url: source), !pdf.isLocked, pdf.pageCount > 0 else { throw NoteStoreError.invalidPDF }
            recentPageIDs = try cache.recordRecent(paper.id)
            self.paper = paper; document = pdf; page = snapshot; selectedID = nil; contentRevision += 1
            do {
                snapshot = try await hydrated(snapshot, api: api)
                try cache.savePage(snapshot); page = snapshot; contentRevision += 1
                errorMessage = nil
            } catch { errorMessage = error.localizedDescription; status = "Cached Gamma page — remote hydration incomplete; retry available" }
            busy = false
            await sync()
        } catch { errorMessage = error.localizedDescription }
    }
    func closeReader() {
        guard recorder.pauseBeforeLeaving() else { errorMessage = "Save the current recording before leaving."; return }
        paper = nil; document = nil; page = nil; selectedID = nil; contentRevision += 1
        strokeBegins = [:]; replaySources = [:]; currentPDFPage = 1
    }
    func select(_ id: String?) { selectedID = id; contentRevision += 1 }

    /// These closures are created with an immutable block identity by the View.
    /// A delayed canvas flush can never be redirected into the newly selected block.
    func drawing(blockID: String?, pdfPage: Int) throws -> PKDrawing {
        guard let blockID, let page,
              let block = page.blocks.first(where: { $0.id == blockID }),
              block.properties.pdfPage == pdfPage + 1 else { return PKDrawing() }
        guard let data = page.drawings[blockID] else {
            throw GammaAPI.APIError.message("Editable ink source is not downloaded. Retry hydration; drawing is disabled until available.")
        }
        return try PKDrawing(data: data)
    }
    func background(excluding blockID: String?, pdfPage: Int) throws -> PKDrawing {
        guard let page else { return PKDrawing() }
        var strokes: [PKStroke] = []
        for block in page.blocks where block.isInk && block.id != blockID && block.properties.pdfPage == pdfPage + 1 {
            guard let data = page.drawings[block.id] else {
                throw GammaAPI.APIError.message("Some ink sources are not cached. Retry to load all annotations.")
            }
            strokes += try PKDrawing(data: data).strokes
        }
        return PKDrawing(strokes: strokes)
    }
    func saveDrawing(blockID: String?, pdfPage: Int, drawing: PKDrawing, pageID: String? = nil, docID: String? = nil) throws {
        var target = page
        if let pageID, let docID, let cache {
            target = try cache.loadPage(pageID: pageID, docID: docID)
        }
        guard let blockID, var snapshot = target,
              let block = snapshot.blocks.first(where: { $0.id == blockID }), block.isInk,
              block.properties.pdfPage == pdfPage + 1 else { return }
        // Missing/corrupt source is an error, never permission to overwrite remotely.
        guard let old = snapshot.drawings[blockID] else { throw GammaAPI.APIError.message("Ink source unavailable; nothing overwritten.") }
        let previous = try PKDrawing(data: old)
        let data = drawing.dataRepresentation()
        guard old != data else { return }
        snapshot.drawings[blockID] = data
        let begin = strokeBegins[blockID]
        let fallback = begin.map { start in
            GammaAudioStamp(recordingID: start.recordingID, segmentID: start.segmentID,
                seconds: start.seconds + (drawing.strokes.last?.path.last?.timeOffset ?? 0))
        }
        let pending = pendingInkTiming[blockID]
        let now = audioStamp ?? fallback
        if let recordingID = pending?.recordingID ?? now?.recordingID,
           var session = snapshot.recordings?[recordingID] {
            let latestEvents = session.replayEvents ?? []
            let mergedEvents = pending == nil ? latestEvents :
                latestEvents.filter { !($0.kind == .stroke && $0.blockID == blockID) } +
                (pending?.events.filter { $0.kind == .stroke && $0.blockID == blockID } ?? [])
            if pending?.data == data {
                session.replayEvents = mergedEvents
            } else if let now {
                let prior = try pending.map { try PKDrawing(data: $0.data) } ?? previous
                session.replayEvents = GammaReplay.capture(previous: prior, final: drawing, blockID: blockID,
                    page: pdfPage + 1, begin: begin, now: now, existing: mergedEvents)
            }
            pendingInkTiming[blockID] = (data, recordingID, session.replayEvents ?? [])
            snapshot.recordings?[recordingID] = session
            if let i = snapshot.blocks.firstIndex(where: { $0.id == recordingID }) { snapshot.blocks[i].properties.replayEvents = session.replayEvents }
            enqueue(GammaMutation(kind: .audio, blockID: recordingID, parentID: snapshot.pageID,
                                  revision: session.revision, audioSession: session), in: &snapshot)
        }
        enqueue(GammaMutation(kind: .ink, blockID: blockID, parentID: snapshot.pageID,
                              drawing: data, pdfPage: pdfPage + 1, revision: block.properties.revision ?? 0), in: &snapshot)
        try persist(snapshot)
        pendingInkTiming.removeValue(forKey: blockID)
    }
    func newInk(pdfPage: Int) throws {
        guard var snapshot = page, let document, (1...document.pageCount).contains(pdfPage) else { return }
        let id = UUID().uuidString.lowercased() // The server's permanent unified-block ID, NOT a new document/library.
        let data = PKDrawing().dataRepresentation()
        let block = GammaBlock(id: id, parentID: snapshot.pageID, content: "",
                               properties: GammaProperties(type: "pdf_ink", pdfPage: pdfPage, revision: 0))
        snapshot.blocks.append(block); snapshot.drawings[id] = data
        snapshot.outbox.append(GammaMutation(kind: .ink, blockID: id, parentID: snapshot.pageID,
                                             drawing: data, pdfPage: pdfPage))
        try persist(snapshot); select(id)
    }
    func editContent(blockID: String, text: String) throws {
        guard var snapshot = page, let index = snapshot.blocks.firstIndex(where: { $0.id == blockID }) else { return }
        guard snapshot.blocks[index].content != text else { return }
        let wasEmpty = snapshot.blocks[index].content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        snapshot.blocks[index].content = text
        if wasEmpty, !text.isEmpty, let stamp = recorder.recordingStamp,
           !(snapshot.recordings?[stamp.recordingID]?.replayEvents ?? []).contains(where: { $0.kind == .note && $0.blockID == blockID }) {
            appendReplayEvents([GammaReplayEvent(kind: .note, segmentID: stamp.segmentID, start: stamp.seconds,
                end: stamp.seconds, pdfPage: currentPDFPage, blockID: blockID)], recordingID: stamp.recordingID, snapshot: &snapshot)
        }
        if snapshot.blocks[index].properties.nativeNote == true {
            enqueue(GammaMutation(kind: .child, blockID: blockID,
                                  parentID: snapshot.blocks[index].parentID ?? snapshot.pageID,
                                  content: text, revision: snapshot.blocks[index].properties.noteRevision ?? 0), in: &snapshot)
        } else {
            enqueue(GammaMutation(kind: .content, blockID: blockID,
                                  parentID: snapshot.blocks[index].parentID ?? snapshot.pageID, content: text), in: &snapshot)
        }
        try persist(snapshot)
    }
    func addChild(parentID: String) throws {
        guard var snapshot = page else { return }
        guard let parent = snapshot.blocks.first(where: { $0.id == parentID }),
              parent.isInk || parent.properties.nativeNote == true else {
            throw GammaAPI.APIError.message("Select an ink annotation or its child note before adding a note.")
        }
        let mutation = GammaMutation(kind: .child, blockID: UUID().uuidString.lowercased(), parentID: parentID)
        snapshot.blocks.append(GammaBlock(id: mutation.blockID, parentID: parentID, content: "",
                                          properties: GammaProperties(nativeNote: true, noteRevision: 0)))
        snapshot.outbox.append(mutation); try persist(snapshot); select(mutation.blockID)
    }
    private func enqueue(_ mutation: GammaMutation, in snapshot: inout GammaPageCache) {
        let previous = snapshot.outbox.first { $0.kind == mutation.kind && $0.blockID == mutation.blockID }
        var next = mutation; next.conflict = previous?.conflict ?? false
        snapshot.outbox.removeAll { $0.kind == mutation.kind && $0.blockID == mutation.blockID }
        snapshot.outbox.append(next)
    }
    private func persist(_ snapshot: GammaPageCache) throws {
        guard let cache else { throw GammaAPI.APIError.message("Sign in before editing.") }
        try cache.savePage(snapshot)
        if page?.pageID == snapshot.pageID { page = snapshot }
        status = snapshot.outbox.isEmpty ? "Synced with Gamma" : "Saved on iPad · \(snapshot.outbox.count) pending for Gamma"
    }
    private func latest(_ original: GammaPageCache, cache: GammaCache) throws -> GammaPageCache {
        try cache.loadPage(pageID: original.pageID, docID: original.docID)
    }
    private func hydrated(_ original: GammaPageCache, api: GammaAPI) async throws -> GammaPageCache {
        let remote = try await api.subtree(original.pageID)
        var downloaded: [String: Data] = [:]
        for block in remote.flattened where block.isInk && !original.outbox.contains(where: { $0.blockID == block.id && $0.kind == .ink }) {
            guard let asset = block.properties.inkAsset else { throw GammaAPI.APIError.message("Gamma ink block has no editable source.") }
            let data = try await api.asset(asset); _ = try PKDrawing(data: data)
            downloaded[block.id] = data
        }
        // Re-read after every await: disabling Pencil or leaving a page may have
        // synchronously flushed a canvas while remote hydration was in flight.
        let local = try cache?.loadPage(pageID: original.pageID, docID: original.docID) ?? original
        var result = local
        let dirty = Set(local.outbox.map(\.blockID))
        result.blocks = remote.flattened.map { block in
            if dirty.contains(block.id), let edited = local.blocks.first(where: { $0.id == block.id }) { return edited }
            return block
        }
        for block in local.blocks where dirty.contains(block.id) && !result.blocks.contains(where: { $0.id == block.id }) {
            result.blocks.append(block)
        }
        for (id, data) in downloaded where !local.outbox.contains(where: { $0.blockID == id && $0.kind == .ink }) {
            result.drawings[id] = data
        }
        for block in remote.flattened where block.isAudio && !dirty.contains(block.id) {
            guard result.recordings?[block.id]?.activeSegmentID == nil else { continue }
            if result.recordings == nil { result.recordings = [:] }
            let state = GammaRecordingSession.State(rawValue: block.properties.audioState ?? "stopped") ?? .stopped
            result.recordings?[block.id] = GammaRecordingSession(id: block.id, pageID: original.pageID,
                state: state == .recording ? .interrupted : state,
                segments: block.properties.segments ?? [], revision: block.properties.audioRevision ?? 0,
                replayEvents: block.properties.replayEvents)
        }
        return result
    }

    /// Parents must reach Gamma before descendants, even when a later parent edit
    /// moved its coalesced mutation to the end of the local queue.
    static func orderedOperations(_ snapshot: GammaPageCache) -> [GammaMutation] {
        let parents = Dictionary(snapshot.blocks.map { ($0.id, $0.parentID ?? snapshot.pageID) },
                                 uniquingKeysWith: { first, _ in first })
        func depth(_ id: String) -> Int {
            var current = id; var seen = Set<String>()
            while current != snapshot.pageID, seen.insert(current).inserted, let parent = parents[current] {
                current = parent
            }
            return seen.count
        }
        func priority(_ kind: GammaMutation.Kind) -> Int {
            switch kind { case .ink, .audio: return 0; case .child: return 1; case .content: return 2 }
        }
        return snapshot.outbox.enumerated().sorted { a, b in
            let left = (priority(a.element.kind), depth(a.element.blockID), a.offset)
            let right = (priority(b.element.kind), depth(b.element.blockID), b.offset)
            return left < right
        }.map(\.element)
    }

    /// Serialized, retryable outbox. The immutable operation sent over the network
    /// is acknowledged only by its own id; edits made during await remain pending.
    func retrySync() async {
        syncUnavailable = false
        await sync()
    }

    func sync() async {
        guard !syncing, !busy, !syncUnavailable, let api, let cache else { return }
        syncing = true; defer { syncing = false }
        let generation = accountGeneration
        do {
            let pages = try cache.pendingPages()
            for original in pages {
                var snapshot = try latest(original, cache: cache)
                // Bound this pass; newly written operations are sent next pass.
                let operations = Self.orderedOperations(snapshot)
                for queued in operations {
                    guard generation == accountGeneration else { return }
                    snapshot = try latest(original, cache: cache)
                    guard let operation = snapshot.outbox.first(where: { $0.id == queued.id }), !operation.conflict else { continue }
                    do {
                        var returnedBlock: GammaBlock?
                        switch operation.kind {
                        case .audio:
                            guard let recording = operation.audioSession else { throw CocoaError(.fileReadCorruptFile) }
                            var segments = recording.segments
                            for i in segments.indices where segments[i].asset == nil {
                                let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id, segmentID: segments[i].id)
                                _ = try GammaRecordingController.validatedDuration(url)
                                let data = try Data(contentsOf: url)
                                segments[i].asset = try await api.upload(data: data, fileExtension: "m4a", mime: "audio/mp4")
                            }
                            returnedBlock = try await api.putAudio(id: operation.blockID, parent: operation.parentID,
                                revision: operation.revision, state: recording.serverState, segments: segments,
                                replayEvents: recording.replayEvents.map { events in
                                    let finalized = Set(segments.map(\.id))
                                    return events.filter { finalized.contains($0.segmentID) }
                                })
                        case .ink:
                            guard let source = operation.drawing, let pdfPage = operation.pdfPage else { continue }
                            let drawing = try PKDrawing(data: source)
                            guard let pdf = PDFDocument(url: cache.sourceURL(docID: original.docID)),
                                  let pdfKitPage = pdf.page(at: pdfPage - 1) else { throw NoteStoreError.missingSource }
                            let crop = pdfKitPage.bounds(for: .cropBox).standardized
                            let pageRect = CGRect(origin: .zero, size: crop.size)
                            let visible = drawing.bounds.intersection(pageRect)
                            let rect = visible.isNull || visible.isEmpty ? CGRect(x: 0, y: 0, width: min(1, crop.width), height: min(1, crop.height)) : visible
                            guard let preview = drawing.image(from: rect, scale: min(1, 2048 / max(rect.width, rect.height))).pngData() else { throw GammaAPI.APIError.message("Unable to encode ink preview.") }
                            let ink = try await api.upload(data: source, fileExtension: "pkdrawing", mime: "application/octet-stream")
                            let png = try await api.upload(data: preview, fileExtension: "png", mime: "image/png")
                            returnedBlock = try await api.putInk(id: operation.blockID, body: [
                                "parent_id": operation.parentID, "pdf_page": pdfPage,
                                "ink_asset": ink, "preview_asset": png, "expected_revision": operation.revision,
                                "bounds": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height],
                                "crop_box": ["width": crop.width, "height": crop.height],
                                "coordinate_space": "pdf-crop-top-left-v1"
                            ])
                        case .content:
                            try await api.updateContent(id: operation.blockID, content: operation.content)
                        case .child:
                            returnedBlock = try await api.putNote(id: operation.blockID, parent: operation.parentID,
                                                                  content: operation.content, revision: operation.revision)
                        }
                        snapshot = try latest(original, cache: cache)
                        if let remote = returnedBlock {
                            if operation.kind == .audio {
                                let revision = remote.properties.audioRevision ?? operation.revision + 1
                                if let i = snapshot.blocks.firstIndex(where: { $0.id == remote.id }) {
                                    snapshot.blocks[i].properties.audioRevision = revision
                                }
                                if var local = snapshot.recordings?[remote.id] {
                                    local.revision = revision
                                    for i in local.segments.indices {
                                        if let uploaded = remote.properties.segments?.first(where: { $0.id == local.segments[i].id }) {
                                            local.segments[i].asset = uploaded.asset
                                            local.segments[i].startTime = uploaded.startTime
                                        }
                                    }
                                    snapshot.recordings?[remote.id] = local
                                    if let i = snapshot.blocks.firstIndex(where: { $0.id == remote.id }) {
                                        snapshot.blocks[i].properties.segments = local.segments
                                    }
                                    for j in snapshot.outbox.indices where snapshot.outbox[j].blockID == remote.id && snapshot.outbox[j].kind == .audio {
                                        snapshot.outbox[j].revision = revision
                                        if snapshot.outbox[j].id != operation.id { snapshot.outbox[j].audioSession = local }
                                    }
                                }
                            } else if operation.kind == .child {
                                if let i = snapshot.blocks.firstIndex(where: { $0.id == remote.id }) {
                                    snapshot.blocks[i].properties = remote.properties
                                }
                                for j in snapshot.outbox.indices where snapshot.outbox[j].blockID == remote.id && snapshot.outbox[j].kind == .child {
                                    snapshot.outbox[j].revision = remote.properties.noteRevision ?? operation.revision + 1
                                }
                            } else if let i = snapshot.blocks.firstIndex(where: { $0.id == remote.id }) {
                                snapshot.blocks[i].properties = remote.properties
                                for j in snapshot.outbox.indices where snapshot.outbox[j].blockID == remote.id && snapshot.outbox[j].kind == .ink {
                                    snapshot.outbox[j].revision = remote.properties.revision ?? operation.revision + 1
                                }
                            }
                        }
                        snapshot.outbox.removeAll { $0.id == operation.id }
                        try persist(snapshot)
                    } catch GammaAPI.APIError.serverUpgradeRequired(let path) {
                        syncUnavailable = true
                        errorMessage = GammaAPI.APIError.serverUpgradeRequired(path).localizedDescription
                        status = "Server update required · saved on iPad"
                        return
                    } catch GammaAPI.APIError.conflict {
                        snapshot = try latest(original, cache: cache)
                        for i in snapshot.outbox.indices where snapshot.outbox[i].blockID == operation.blockID && snapshot.outbox[i].kind == operation.kind {
                            snapshot.outbox[i].conflict = true
                        }
                        try persist(snapshot)
                        errorMessage = "Revision conflict: \(operation.blockID). Local changes are preserved; select the block to resolve."
                    } catch {
                        errorMessage = error.localizedDescription
                        status = "Not synced — pending changes preserved; retrying automatically"
                        return
                    }
                }
            }
            let pending = try cache.pendingPages().flatMap(\.outbox)
            status = pending.isEmpty ? "Synced with Gamma" : "\(pending.count) pending · \(pending.filter(\.conflict).count) conflicts"
        } catch { errorMessage = error.localizedDescription; status = "Local cache error — files preserved" }
    }

    /// Explicit conflict choices. Keeping local rebases only after fetching current
    /// revision; using remote archives the local source before replacing it.
    func resolveConflict(blockID: String, keepLocal: Bool) async {
        guard let api, let cache, let original = page, !syncing else { return }
        busy = true; defer { busy = false }
        do {
            let tree = try await api.subtree(original.pageID)
            guard let remote = tree.flattened.first(where: { $0.id == blockID }) else {
                throw GammaAPI.APIError.message("Remote block no longer exists. Local changes are preserved.")
            }
            var snapshot = try latest(original, cache: cache)
            if remote.isAudio {
                guard !recorder.recording, !recorder.preparing else {
                    throw GammaAPI.APIError.message("Pause recording before resolving an audio conflict.")
                }
                if keepLocal {
                    for i in snapshot.outbox.indices where snapshot.outbox[i].blockID == blockID && snapshot.outbox[i].kind == .audio {
                        snapshot.outbox[i].revision = remote.properties.audioRevision ?? 0
                        snapshot.outbox[i].conflict = false
                    }
                    snapshot.recordings?[blockID]?.revision = remote.properties.audioRevision ?? 0
                } else {
                    if let local = snapshot.recordings?[blockID] {
                        snapshot.drawings["audio-conflict-backup-\(blockID)-\(UUID().uuidString)"] = try JSONEncoder().encode(local)
                    }
                    snapshot.outbox.removeAll { $0.blockID == blockID && $0.kind == .audio }
                    snapshot.recordings?[blockID] = GammaRecordingSession(id: blockID, pageID: original.pageID,
                        state: .stopped, segments: remote.properties.segments ?? [], revision: remote.properties.audioRevision ?? 0,
                        replayEvents: remote.properties.replayEvents)
                }
                if let i = snapshot.blocks.firstIndex(where: { $0.id == blockID }) {
                    if keepLocal { snapshot.blocks[i].properties.audioRevision = remote.properties.audioRevision }
                    else { snapshot.blocks[i].properties = remote.properties }
                }
                try persist(snapshot); errorMessage = nil; busy = false
                await sync()
                return
            }
            if remote.properties.nativeNote == true {
                if keepLocal {
                    for i in snapshot.outbox.indices where snapshot.outbox[i].blockID == blockID && snapshot.outbox[i].kind == .child {
                        snapshot.outbox[i].revision = remote.properties.noteRevision ?? 0
                        snapshot.outbox[i].conflict = false
                    }
                } else {
                    if let old = snapshot.blocks.first(where: { $0.id == blockID }) {
                        snapshot.drawings["note-conflict-backup-\(blockID)-\(UUID().uuidString)"] = Data(old.content.utf8)
                    }
                    snapshot.outbox.removeAll { $0.blockID == blockID && $0.kind == .child }
                }
                if let i = snapshot.blocks.firstIndex(where: { $0.id == blockID }) {
                    snapshot.blocks[i].properties = remote.properties
                    if !keepLocal { snapshot.blocks[i].content = remote.content }
                }
                try persist(snapshot); errorMessage = nil; busy = false
                await sync()
                return
            }
            guard let asset = remote.properties.inkAsset else {
                throw GammaAPI.APIError.message("Remote block has no editable ink source.")
            }
            if keepLocal {
                for i in snapshot.outbox.indices where snapshot.outbox[i].blockID == blockID && snapshot.outbox[i].kind == .ink {
                    snapshot.outbox[i].revision = remote.properties.revision ?? 0; snapshot.outbox[i].conflict = false
                }
            } else {
                let data = try await api.asset(asset); _ = try PKDrawing(data: data)
                snapshot = try latest(original, cache: cache)
                if let local = snapshot.drawings[blockID] {
                    // Recovery copy is intentionally not a second knowledge block.
                    snapshot.drawings["conflict-backup-\(blockID)-\(UUID().uuidString)"] = local
                }
                snapshot.drawings[blockID] = data
                snapshot.outbox.removeAll { $0.blockID == blockID && $0.kind == .ink }
            }
            if let i = snapshot.blocks.firstIndex(where: { $0.id == blockID }) { snapshot.blocks[i].properties = remote.properties }
            try persist(snapshot); contentRevision += 1; errorMessage = nil; busy = false
            await sync()
        } catch { errorMessage = error.localizedDescription }
    }
    func refreshPage() async {
        guard let original = page, let cache, let api, !syncing, !busy else { return }
        busy = true; defer { busy = false }
        do {
            // UI disables editing while hydration is in flight.
            let snapshot = try await hydrated(original, api: api)
            try cache.savePage(snapshot); page = snapshot; contentRevision += 1; errorMessage = nil
        } catch { errorMessage = error.localizedDescription }
    }
}
