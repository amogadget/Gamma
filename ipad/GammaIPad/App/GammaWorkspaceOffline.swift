import Foundation
import PDFKit
import PencilKit

extension GammaWorkspace {
    func reloadOfflineAccounts() {
        do {
            let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                  appropriateFor: nil, create: true).appendingPathComponent("GammaCache")
            // Migrate the identity remembered by older versions only if its cache already exists.
            if let server = UserDefaults.standard.string(forKey: "gamma.server"),
               let user = UserDefaults.standard.string(forKey: "gamma.username"), let url = URL(string: server) {
                let directory = root.appendingPathComponent(GammaCache.key(GammaCache.canonicalServer(server) + "\n" + user))
                if FileManager.default.fileExists(atPath: directory.path) {
                    _ = try GammaCache(rootURL: root, server: url, username: user)
                }
            }
            offlineAccounts = try GammaCache.discoverOfflineIdentities(rootURL: root)
        } catch { errorMessage = error.localizedDescription }
    }
    func enterOffline(_ account: GammaOfflineIdentity) {
        guard !busy, !syncing, recorder.pauseBeforeLeaving(), let server = URL(string: account.server) else { return }
        do {
            let storage = try GammaCache.application(server: server, username: account.username)
            let library = try storage.library(), recents = try storage.recentPageIDs()
            let entries = try storage.loadOfflineEntries()
            stopOfflineWorker(); api?.close(); api = nil; webSession = nil; closeReader()
            accountGeneration = UUID(); cache = storage; accountServer = account.server
            username = account.username; isOffline = true
            papers = library + entries.values.map(\.paper).filter { p in !library.contains { $0.id == p.id } }
            recentPageIDs = recents; offlineEntries = entries
            restoreOfflineQueue(); refreshOfflineStatus(); status = "On this iPad · sign in to the same account to sync"
        } catch { errorMessage = error.localizedDescription }
    }

    /// A single persisted manifest is both queue and readiness record.
    func enqueueDownloads(_ selected: [GammaPaper]) {
        guard !isOffline, let cache, api != nil else {
            errorMessage = "Sign in to the same Gamma account to download missing files."; return
        }
        do {
            var entries = try cache.loadOfflineEntries()
            for paper in selected {
                guard let doc = paper.properties.docID, !doc.isEmpty else { continue }
                if let previous = entries[paper.id] {
                    guard previous.paper.properties.docID == doc else {
                        throw GammaAPI.APIError.message("Document identity changed; cached files were preserved.")
                    }
                    if previous.state == .queued || previous.state == .downloading { continue }
                }
                var entry = entries[paper.id] ?? GammaOfflineEntry(pageID: paper.id, paper: paper)
                entry.paper = paper; entry.state = .queued; entry.error = nil; entries[paper.id] = entry
            }
            try cache.saveOfflineEntries(entries); offlineEntries = entries; startOfflineWorker()
        } catch { errorMessage = error.localizedDescription }
    }
    func cancelDownload(_ id: String) {
        guard let cache else { return }
        do {
            var entries = try cache.loadOfflineEntries()
            guard var entry = entries[id], entry.state == .queued || entry.state == .downloading else { return }
            entry.state = .cancelled; entry.error = "Download cancelled. Completed files are kept."
            entries[id] = entry; try cache.saveOfflineEntries(entries); offlineEntries = entries
            if activeDownloadID == id { offlineWorker?.cancel() }
        } catch { errorMessage = error.localizedDescription }
    }
    func retryDownload(_ id: String) {
        guard let entry = offlineEntries[id] else { return }; enqueueDownloads([entry.paper])
    }
    func stopOfflineWorker() {
        offlineWorker?.cancel(); offlineWorker = nil; activeDownloadID = nil; offlineWorkerID = UUID()
    }
    func restoreOfflineQueue() {
        guard let cache else { return }
        do {
            var entries = try cache.loadOfflineEntries()
            for id in entries.keys where entries[id]?.state == .downloading { entries[id]?.state = .queued }
            try cache.saveOfflineEntries(entries); offlineEntries = entries; startOfflineWorker()
        } catch { errorMessage = error.localizedDescription }
    }
    func startOfflineWorker() {
        guard offlineWorker == nil, !isOffline, let api, let cache else { return }
        let generation = accountGeneration, workerID = UUID(); offlineWorkerID = workerID
        // One document at a time bounds network work; MainActor serializes all file commits with edits.
        offlineWorker = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled, self.accountGeneration == generation {
                    let entries = try cache.loadOfflineEntries()
                    guard let entry = entries.values.sorted(by: { $0.pageID < $1.pageID }).first(where: { $0.state == .queued }) else { break }
                    self.activeDownloadID = entry.pageID
                    await self.prepareOffline(entry, api: api, cache: cache, generation: generation, workerID: workerID)
                }
            } catch { if self.accountGeneration == generation { self.errorMessage = error.localizedDescription } }
            guard self.offlineWorkerID == workerID else { return }
            self.offlineWorker = nil; self.activeDownloadID = nil
            if self.accountGeneration == generation {
                self.refreshOfflineStatus()
                if let entries = try? cache.loadOfflineEntries(), entries.values.contains(where: { $0.state == .queued }) {
                    self.startOfflineWorker()
                }
            }
        }
    }
    private func checkDownload(_ id: String, cache: GammaCache, generation: UUID, workerID: UUID) throws {
        try Task.checkCancellation()
        guard accountGeneration == generation, offlineWorkerID == workerID,
              let entry = try cache.loadOfflineEntry(pageID: id), entry.state == .downloading else { throw CancellationError() }
    }
    private func prepareOffline(_ original: GammaOfflineEntry, api: GammaAPI, cache: GammaCache, generation: UUID, workerID: UUID) async {
        let id = original.pageID
        do {
            var entry = original; entry.state = .downloading; entry.error = nil
            try cache.saveOfflineEntry(entry); offlineEntries[id] = entry
            guard let doc = entry.paper.properties.docID else { throw NoteStoreError.missingSource }
            let source = cache.sourceURL(docID: doc)
            if !FileManager.default.fileExists(atPath: source.path) {
                let temporary = try await api.download(entry.paper)
                defer { try? FileManager.default.removeItem(at: temporary) }
                try checkDownload(id, cache: cache, generation: generation, workerID: workerID); try validatePDF(temporary)
                try cache.preserveSource(from: temporary, docID: doc)
            }
            try validatePDF(source)
            entry.pdfReady = true; try cache.saveOfflineEntry(entry); offlineEntries[id] = entry
            let local = try cache.loadPage(pageID: id, docID: doc)
            let snapshot = try await hydrated(local, api: api)
            try checkDownload(id, cache: cache, generation: generation, workerID: workerID)
            try cache.savePage(snapshot)
            if self.page?.pageID == id { self.page = snapshot; contentRevision += 1 }
            entry.snapshotReady = true; try cache.saveOfflineEntry(entry); offlineEntries[id] = entry
            for (recordingID, segment) in try audioSegments(snapshot) {
                try checkDownload(id, cache: cache, generation: generation, workerID: workerID)
                let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recordingID, segmentID: segment.id)
                if FileManager.default.fileExists(atPath: url.path) {
                    _ = try GammaRecordingController.validatedDuration(url); continue
                }
                guard let asset = segment.asset else {
                    throw GammaAPI.APIError.message("A local recording segment is missing and has no uploaded copy. Recovery data was preserved.")
                }
                let data = try await api.asset(asset)
                try checkDownload(id, cache: cache, generation: generation, workerID: workerID)
                try installAudio(data, at: url)
            }
            try checkDownload(id, cache: cache, generation: generation, workerID: workerID)
            let latest = try cache.loadPage(pageID: id, docID: doc)
            try validateSnapshot(latest); try validateAudio(latest, cache: cache)
            entry.audioReady = true; entry.state = .ready; entry.error = nil
            try cache.saveOfflineEntry(entry); offlineEntries[id] = entry
        } catch {
            // Old account's in-flight record is retained for its next authenticated restart.
            guard accountGeneration == generation, offlineWorkerID == workerID else { return }
            do {
                guard var entry = try cache.loadOfflineEntry(pageID: id) else { return }
                if entry.state == .downloading {
                    entry.state = error is CancellationError ? .cancelled : .failed; entry.error = error.localizedDescription
                }
                try cache.saveOfflineEntry(entry); offlineEntries[id] = entry
            } catch { errorMessage = error.localizedDescription }
        }
    }
    func installAudio(_ data: Data, at url: URL) throws {
        let fm = FileManager.default
        if fm.fileExists(atPath: url.path) { _ = try GammaRecordingController.validatedDuration(url); return }
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".download-\(UUID().uuidString).m4a")
        defer { try? fm.removeItem(at: temporary) }
        try data.write(to: temporary, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        _ = try GammaRecordingController.validatedDuration(temporary)
        try fm.moveItem(at: temporary, to: url)
    }
    private func validatePDF(_ url: URL) throws {
        guard let pdf = PDFDocument(url: url), !pdf.isLocked, pdf.pageCount > 0 else { throw NoteStoreError.invalidPDF }
    }
    private func validateSnapshot(_ snapshot: GammaPageCache) throws {
        guard snapshot.blocks.contains(where: { $0.id == snapshot.pageID && $0.properties.docID == snapshot.docID }) else {
            throw GammaAPI.APIError.message("Notes have not been prepared for offline use.")
        }
        for block in snapshot.blocks where block.isInk {
            guard let data = snapshot.drawings[block.id] else { throw GammaAPI.APIError.message("Editable handwriting is missing from this iPad.") }
            _ = try PKDrawing(data: data)
        }
    }
    /// Union local sessions and server blocks. No asset URL is needed for valid local audio.
    private func audioSegments(_ snapshot: GammaPageCache) throws -> [(String, GammaAudioSegment)] {
        var segments: [String: (String, GammaAudioSegment)] = [:]
        for block in snapshot.blocks where block.isAudio {
            for segment in block.properties.segments ?? [] { segments[block.id + "/" + segment.id] = (block.id, segment) }
        }
        for recording in Array(snapshot.recordings?.values ?? Dictionary<String, GammaRecordingSession>().values) {
            guard recording.pageID == snapshot.pageID else { throw GammaAPI.APIError.message("Recording identity mismatch; data preserved.") }
            guard recording.activeSegmentID == nil, recording.state != .recording, recording.state != .recoveryRequired else {
                throw GammaAPI.APIError.message("Finish or recover the local recording before completing offline preparation.")
            }
            for segment in recording.segments {
                let key = recording.id + "/" + segment.id
                var value = segment; if value.asset == nil { value.asset = segments[key]?.1.asset }
                segments[key] = (recording.id, value)
            }
        }
        return segments.values.sorted { $0.0 + $0.1.id < $1.0 + $1.1.id }
    }
    private func validateAudio(_ snapshot: GammaPageCache, cache: GammaCache) throws {
        for (recording, segment) in try audioSegments(snapshot) {
            let url = try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording, segmentID: segment.id)
            _ = try GammaRecordingController.validatedDuration(url)
        }
    }
    func removeDownloadedFiles(_ paper: GammaPaper) {
        guard let cache, !busy, !syncing, !recorder.recording, !recorder.preparing,
              self.paper?.properties.docID != paper.properties.docID,
              !offlineEntries.values.contains(where: { $0.paper.properties.docID == paper.properties.docID && ($0.state == .downloading || $0.state == .queued) }),
              let doc = paper.properties.docID else {
            errorMessage = "Close this document and finish its download or recording before removing local files."; return
        }
        do {
            let result = try cache.removeRedownloadable(pageID: paper.id, docID: doc)
            status = result.reason ?? "Removed downloadable files from this iPad. Gamma server content was not changed."
            errorMessage = result.protected ? result.reason : nil; refreshOfflineStatus()
        } catch { errorMessage = error.localizedDescription }
    }
    func refreshOfflineStatus() {
        guard let cache else { return }
        do {
            var entries = try cache.loadOfflineEntries()
            for id in entries.keys {
                guard var entry = entries[id], let doc = entry.paper.properties.docID else { continue }
                let snapshot = try cache.loadPage(pageID: id, docID: doc)
                entry.pdfReady = (try? validatePDF(cache.sourceURL(docID: doc))) != nil
                entry.snapshotReady = (try? validateSnapshot(snapshot)) != nil
                entry.audioReady = entry.snapshotReady && (try? validateAudio(snapshot, cache: cache)) != nil
                if entry.state == .ready && !(entry.pdfReady && entry.snapshotReady && entry.audioReady) {
                    entry.state = .failed; entry.error = "Some files are missing, not finalized, or unreadable. Retry after checking local recordings."
                }
                entries[id] = entry
            }
            try cache.saveOfflineEntries(entries); offlineEntries = entries; localUsageBytes = try cache.diskUsage().bytes
            var sizes: [String: Int64] = [:]
            for paper in papers {
                guard let doc = paper.properties.docID else { continue }
                let snapshot = try cache.loadPage(pageID: paper.id, docID: doc)
                var urls = Set([cache.sourceURL(docID: doc), cache.rootURL.appendingPathComponent("page-\(GammaCache.key(paper.id)).json")])
                for recording in Array(snapshot.recordings?.values ?? [:].values) {
                    var ids = recording.segments.map(\.id)
                    if let active = recording.activeSegmentID { ids.append(active) }
                    for id in ids { urls.insert(try GammaRecordingFiles.url(root: cache.rootURL, recordingID: recording.id, segmentID: id)) }
                }
                sizes[paper.id] = try urls.reduce(Int64(0)) { total, url in
                    guard FileManager.default.fileExists(atPath: url.path) else { return total }
                    return total + Int64(try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0)
                }
            }
            localDocumentBytes = sizes
        } catch {
            for id in offlineEntries.keys {
                offlineEntries[id]?.state = .failed; offlineEntries[id]?.pdfReady = false
                offlineEntries[id]?.snapshotReady = false; offlineEntries[id]?.audioReady = false
                offlineEntries[id]?.error = "Cache could not be verified. Files were preserved."
            }
            errorMessage = "Local cache error — files preserved. \(error.localizedDescription)"
        }
    }
}
