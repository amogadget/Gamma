import Foundation

extension GammaCache {
    private var offlineManifestURL: URL { rootURL.appendingPathComponent("offline.json") }
    private var accountIdentityURL: URL { rootURL.appendingPathComponent("identity.json") }

    func loadOfflineEntries() throws -> [String: GammaOfflineEntry] {
        let entries = try readOffline([String: GammaOfflineEntry].self, from: offlineManifestURL) ?? [:]
        for (key, entry) in entries {
            guard key == entry.pageID, entry.pageID == entry.paper.id,
                  !(entry.paper.properties.docID ?? "").isEmpty else {
                throw GammaAPI.APIError.message("Offline manifest identity mismatch; data was preserved.")
            }
            let pageURL = pageURLForOffline(entry.pageID)
            if let data = try? Data(contentsOf: pageURL) {
                guard let page = try? JSONDecoder().decode(GammaPageCache.self, from: data),
                      page.pageID == entry.pageID, page.docID == entry.paper.properties.docID else {
                    throw GammaAPI.APIError.message("Offline manifest/page identity mismatch; data was preserved.")
                }
            }
        }
        return entries
    }
    func saveOfflineEntries(_ entries: [String: GammaOfflineEntry]) throws {
        _ = try validateOfflineEntries(entries)
        try writeOffline(entries, to: offlineManifestURL)
    }
    func loadOfflineEntry(pageID: String) throws -> GammaOfflineEntry? {
        try loadOfflineEntries()[pageID]
    }
    func saveOfflineEntry(_ entry: GammaOfflineEntry) throws {
        var entries = try loadOfflineEntries()
        entries[entry.pageID] = entry
        try saveOfflineEntries(entries)
    }
    func accountIdentity() throws -> GammaOfflineIdentity? {
        guard let identity = try readOffline(GammaOfflineIdentity.self, from: accountIdentityURL) else { return nil }
        return try validatedIdentity(identity)
    }
    func saveAccountIdentity(_ identity: GammaOfflineIdentity) throws {
        let normalized = try validatedIdentity(identity)
        try writeOffline(normalized, to: accountIdentityURL)
    }
    func ensureAccountIdentity(_ identity: GammaOfflineIdentity) throws {
        let normalized = try validatedIdentity(identity)
        if FileManager.default.fileExists(atPath: accountIdentityURL.path) {
            guard let existing = try readOffline(GammaOfflineIdentity.self, from: accountIdentityURL),
                  (try validatedIdentity(existing)) == normalized else {
                throw GammaAPI.APIError.message("Existing offline account identity mismatch; data was preserved.")
            }
            return
        }
        try writeOffline(normalized, to: accountIdentityURL)
    }
    private func validatedIdentity(_ identity: GammaOfflineIdentity) throws -> GammaOfflineIdentity {
        let server = Self.canonicalServer(identity.server)
        guard !server.isEmpty, !identity.username.isEmpty,
              Self.key(server + "\n" + identity.username) == rootURL.lastPathComponent else {
            throw GammaAPI.APIError.message("Offline account identity does not match its cache.")
        }
        return GammaOfflineIdentity(server: server, username: identity.username)
    }

    /// Finds only self-consistent, non-secret identity metadata. Unknown/corrupt entries are ignored.
    static func discoverOfflineIdentities(rootURL: URL) throws -> [GammaOfflineIdentity] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: rootURL.path) else { return [] }
        return try fm.contentsOfDirectory(at: rootURL, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles])
            .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            .compactMap { directory in
                let url = directory.appendingPathComponent("identity.json")
                guard let data = try? Data(contentsOf: url),
                      let value = try? JSONDecoder().decode(GammaOfflineIdentity.self, from: data) else { return nil }
                let server = canonicalServer(value.server)
                guard !server.isEmpty, !value.username.isEmpty,
                      key(server + "\n" + value.username) == directory.lastPathComponent else { return nil }
                return GammaOfflineIdentity(server: server, username: value.username)
            }
            .sorted { $0.id < $1.id }
    }

    func diskUsage() throws -> GammaOfflineDiskUsage {
        var bytes: Int64 = 0; var count = 0
        try walk(rootURL) { url, isDirectory in
            if !isDirectory { bytes += Int64((try url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0); count += 1 }
        }
        return GammaOfflineDiskUsage(bytes: bytes, fileCount: count)
    }

    /// Removes only a document's re-downloadable original and completed uploaded audio.
    /// Snapshot/outbox and unsafe recording files are never touched. Main-actor
    /// isolation serializes this operation with workspace snapshot edits.
    @MainActor
    func removeRedownloadable(pageID: String, docID: String) throws -> GammaOfflineRemoval {
        let pages = try pageSnapshotsForRemoval()
        guard !pages.isEmpty else {
            return GammaOfflineRemoval(pdfRemoved: false, audioFilesRemoved: 0, protected: true, reason: "No valid snapshots found.")
        }
        guard pages.contains(where: { $0.pageID == pageID && $0.docID == docID }) else {
            return GammaOfflineRemoval(pdfRemoved: false, audioFilesRemoved: 0, protected: true, reason: "Snapshot is missing or corrupt.")
        }
        // A document can have multiple pages. Pending data on any of them keeps
        // the shared original; this also protects inkPreview and conflict backups.
        let documentPages = pages.filter { $0.docID == docID }
        if documentPages.contains(where: { !$0.outbox.isEmpty || $0.drawings.keys.contains(where: { $0.localizedCaseInsensitiveContains("backup") }) }) {
            return GammaOfflineRemoval(pdfRemoved: false, audioFilesRemoved: 0, protected: true, reason: "Pending or backup data requires retained local files.")
        }
        guard isSafeDocument(pages, docID: docID) else {
            return GammaOfflineRemoval(pdfRemoved: false, audioFilesRemoved: 0, protected: true, reason: "Recording metadata is incomplete or protected; files retained.")
        }
        let recordings = documentPages.compactMap { $0.recordings }.flatMap { $0.values }
        for recording in recordings {
            if recording.state != .stopped || recording.activeSegmentID != nil || recording.segments.contains(where: { !validUploadedAsset($0.asset) }) {
                return GammaOfflineRemoval(pdfRemoved: false, audioFilesRemoved: 0, protected: true, reason: "Recording data is not safely re-downloadable.")
            }
            guard let block = documentPages.flatMap { $0.blocks.flatMap(\.flattened) }.first(where: { $0.id == recording.id }), block.isAudio else {
                return GammaOfflineRemoval(pdfRemoved: false, audioFilesRemoved: 0, protected: true, reason: "Audio block identity is unavailable.")
            }
            for segment in recording.segments {
                guard let remote = block.properties.segments?.first(where: { $0.id == segment.id }), validUploadedAsset(remote.asset), remote.asset == segment.asset else {
                    return GammaOfflineRemoval(pdfRemoved: false, audioFilesRemoved: 0, protected: true, reason: "Audio asset identity cannot be verified.")
                }
            }
        }
        // Recheck immediately before each synchronous removal: no stale preflight decision is used.
        let fm = FileManager.default
        var removedPDF = false
        let source = sourceURL(docID: docID)
        // Re-read the snapshot directly before removing the original as well.
        if fm.fileExists(atPath: source.path), isSafeDocument(try pageSnapshotsForRemoval(), docID: docID) {
            try fm.removeItem(at: source); removedPDF = true
        }
        var audioRemoved = 0
        for recording in recordings {
            for segment in recording.segments {
                guard let audio = try? GammaRecordingFiles.url(root: rootURL, recordingID: recording.id, segmentID: segment.id), fm.fileExists(atPath: audio.path) else { continue }
                // Synchronous state, identity, and asset recheck immediately before removal.
                let latestPages = try pageSnapshotsForRemoval()
                guard isSafeDocument(latestPages, docID: docID),
                      let currentPage = latestPages.first(where: { $0.docID == docID && $0.recordings?[recording.id]?.segments.contains(where: { $0.id == segment.id }) == true }),
                      let current = currentPage.recordings?[recording.id], current.state == .stopped, current.activeSegmentID == nil,
                      let currentSegment = current.segments.first(where: { $0.id == segment.id }), validUploadedAsset(currentSegment.asset),
                      let block = currentPage.blocks.flatMap(\.flattened).first(where: { $0.id == recording.id }), block.isAudio,
                      block.properties.segments?.contains(where: { $0.id == segment.id && $0.asset == currentSegment.asset && validUploadedAsset($0.asset) }) == true else { continue }
                try fm.removeItem(at: audio); audioRemoved += 1
            }
        }
        return GammaOfflineRemoval(pdfRemoved: removedPDF, audioFilesRemoved: audioRemoved, protected: false, reason: nil)
    }

    private func validateOfflineEntries(_ entries: [String: GammaOfflineEntry]) throws -> [String: GammaOfflineEntry] {
        for (key, entry) in entries {
            guard key == entry.pageID, entry.pageID == entry.paper.id,
                  !(entry.paper.properties.docID ?? "").isEmpty else {
                throw GammaAPI.APIError.message("Offline manifest identity mismatch; data was preserved.")
            }
        }
        return entries
    }

    private func pageSnapshotsForRemoval() throws -> [GammaPageCache] {
        let files = try FileManager.default.contentsOfDirectory(at: rootURL, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("page-") && $0.pathExtension == "json" }
        var result: [GammaPageCache] = []
        for file in files {
            guard let data = try? Data(contentsOf: file), let page = try? JSONDecoder().decode(GammaPageCache.self, from: data),
                  page.pageID.isEmpty == false, page.docID.isEmpty == false,
                  file.lastPathComponent == "page-\(Self.key(page.pageID)).json" else {
                throw GammaAPI.APIError.message("A cached page is corrupt; local files were retained.")
            }
            result.append(page)
        }
        return result
    }

    private func validUploadedAsset(_ asset: String?) -> Bool {
        guard let asset, asset.hasPrefix("/api/assets/"), asset.count > "/api/assets/".count else { return false }
        let name = String(asset.dropFirst("/api/assets/".count))
        return !name.contains("/") && !name.contains("\\") && name != "." && name != ".."
    }

    private func isSafeDocument(_ pages: [GammaPageCache], docID: String) -> Bool {
        let documentPages = pages.filter { $0.docID == docID }
        guard !documentPages.isEmpty else { return false }
        if documentPages.contains(where: { !$0.outbox.isEmpty || $0.drawings.keys.contains(where: { $0.localizedCaseInsensitiveContains("backup") }) }) { return false }
        for page in documentPages {
            for block in page.blocks where block.isAudio {
                guard let session = page.recordings?[block.id], session.id == block.id, session.pageID == page.pageID else { return false }
            }
            for recording in Array(page.recordings?.values ?? [:].values) {
                guard recording.state == .stopped, recording.activeSegmentID == nil,
                      recording.segments.allSatisfy({ validUploadedAsset($0.asset) }),
                      let block = page.blocks.flatMap(\.flattened).first(where: { $0.id == recording.id }), block.isAudio else { return false }
                for segment in recording.segments {
                    guard let remote = block.properties.segments?.first(where: { $0.id == segment.id }), remote.asset == segment.asset, validUploadedAsset(remote.asset) else { return false }
                }
            }
        }
        return true
    }

    private func pageURLForOffline(_ id: String) -> URL { rootURL.appendingPathComponent("page-\(Self.key(id)).json") }
    private func readOffline<T: Decodable>(_ type: T.Type, from url: URL) throws -> T? {
        do { return try JSONDecoder().decode(type, from: Data(contentsOf: url)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }
    private func writeOffline<T: Encodable>(_ value: T, to url: URL) throws {
        let data = try JSONEncoder().encode(value)
        if let override = writeOverride { try override(data, url) }
        else { try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    }
    private func walk(_ url: URL, _ body: (URL, Bool) throws -> Void) throws {
        let values = try url.resourceValues(forKeys: [.isDirectoryKey])
        let directory = values.isDirectory ?? false
        try body(url, directory)
        if directory { for child in try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey], options: []) { try walk(child, body) } }
    }
}
