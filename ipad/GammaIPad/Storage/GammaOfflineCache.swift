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
            try assertWorkspace(entry.workspace, what: "offline download")
            let pageURL = pageURLForOffline(entry.pageID)
            if let data = try? Data(contentsOf: pageURL) {
                guard let page = try? JSONDecoder().decode(GammaPageCache.self, from: data),
                      page.pageID == entry.pageID, page.docID == entry.paper.properties.docID else {
                    throw GammaAPI.APIError.message("Offline manifest/page identity mismatch; data was preserved.")
                }
                try assertWorkspace(page.workspace, what: "cached page")
            }
        }
        return entries
    }
    func saveOfflineEntries(_ entries: [String: GammaOfflineEntry]) throws {
        var entries = try validateOfflineEntries(entries)
        for key in entries.keys { entries[key]?.workspace = workspace }
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
    /// Writes `identity.json` only when the directory does not already have one, or
    /// when the stored one names the same server, account and workspace. The
    /// display label is deliberately not compared: the caller (`GammaCache.init`)
    /// cannot know it, so comparing it would reject every cache that had stored one.
    ///
    /// There is deliberately no unconditional "save identity" API. One existed and
    /// was the cause of a migration bug: it looked like the natural way to finish a
    /// rename, but the stored identity it replaced was still the pre-workspace one.
    /// Identity is written in two places only — here, and `updateWorkspaceName` for
    /// the label.
    func ensureAccountIdentity(_ identity: GammaOfflineIdentity) throws {
        let normalized = try validatedIdentity(identity)
        if FileManager.default.fileExists(atPath: accountIdentityURL.path) {
            guard let existing = try readOffline(GammaOfflineIdentity.self, from: accountIdentityURL) else {
                throw GammaAPI.APIError.message("Existing offline account identity could not be read; data was preserved.")
            }
            let validated = try validatedIdentity(existing)
            // Identity is the three coordinates. `workspaceName` is a display label
            // that this initializer cannot know (it is only learned at sign-in), so
            // comparing it would reject every cache whose label was already stored.
            guard validated.server == normalized.server,
                  validated.username == normalized.username,
                  validated.workspace == normalized.workspace else {
                throw GammaAPI.APIError.message("Existing offline account identity mismatch; data was preserved.")
            }
            return
        }
        try writeOffline(normalized, to: accountIdentityURL)
    }

    /// Records the workspace's display name in this cache's identity so the sign-in
    /// screen can name the library without a server. A label only: the coordinates
    /// are re-validated first, so this can never rebrand a cache into another
    /// server, account or workspace.
    func updateWorkspaceName(_ name: String) throws {
        let current = try accountIdentity()
            ?? GammaOfflineIdentity(server: server, username: username, workspace: workspace)
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard current.workspaceName != name else { return }
        let updated = try validatedIdentity(GammaOfflineIdentity(server: current.server, username: current.username,
                                                                workspace: current.workspace, workspaceName: name))
        try writeOffline(updated, to: accountIdentityURL)
    }
    /// The stored identity must name this exact directory under the scheme its
    /// workspace implies — a legacy (workspaceless) cache or a workspace cache.
    private func validatedIdentity(_ identity: GammaOfflineIdentity) throws -> GammaOfflineIdentity {
        let server = Self.canonicalServer(identity.server)
        let workspace = identity.workspace.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !server.isEmpty, !identity.username.isEmpty,
              workspace.isEmpty || GammaAPI.isValidWorkspace(workspace) else {
            throw GammaAPI.APIError.message("Offline identity is incomplete; data was preserved.")
        }
        let expected = workspace.isEmpty
            ? Self.legacyDirectoryKey(server: server, username: identity.username)
            : Self.directoryKey(server: server, username: identity.username, workspace: workspace)
        guard expected == rootURL.lastPathComponent else {
            throw GammaAPI.APIError.message("Offline account identity does not match its cache.")
        }
        return GammaOfflineIdentity(server: server, username: identity.username, workspace: workspace,
                                    workspaceName: identity.workspaceName)
    }

    /// Finds only self-consistent, non-secret identity metadata. Unknown/corrupt entries are ignored.
    /// Both directory schemes are recognised: a pre-workspace cache shows up with an
    /// empty workspace so it can be listed and migrated, never silently adopted.
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
                let workspace = value.workspace.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !server.isEmpty, !value.username.isEmpty,
                      workspace.isEmpty || GammaAPI.isValidWorkspace(workspace) else { return nil }
                let expected = workspace.isEmpty
                    ? legacyDirectoryKey(server: server, username: value.username)
                    : directoryKey(server: server, username: value.username, workspace: workspace)
                guard expected == directory.lastPathComponent else { return nil }
                return GammaOfflineIdentity(server: server, username: value.username, workspace: workspace,
                                            workspaceName: value.workspaceName)
            }
            .sorted { $0.id < $1.id }
    }

    /// What happened to a pre-workspace cache directory.
    enum MigrationOutcome: Equatable {
        /// No legacy directory exists for this account.
        case noLegacyCache
        /// The legacy directory was renamed to its workspace key and re-stamped.
        case migrated(to: URL)
        /// Already workspace-keyed; nothing to do.
        case alreadyWorkspaceScoped
        /// Nothing was touched. The reason is user-visible.
        case refused(String)
    }

    /// Attaches a pre-workspace cache to the account's **server-verified default**
    /// workspace — the only workspace a legacy cache may ever be claimed by.
    ///
    /// Safety properties, in order:
    /// 1. `verifiedDefaultWorkspace` must come from `/api/session` for the account
    ///    that owns the cache; this function cannot invent or guess one.
    /// 2. The legacy identity must validate against the legacy scheme, so the
    ///    directory provably belongs to this (server, account).
    /// 3. The destination must not already exist. An existing workspace cache is
    ///    never merged with or overwritten by legacy data.
    /// 4. The rename is a single filesystem operation, and the re-stamped
    ///    `identity.json` is written after it. If re-stamping fails the rename is
    ///    rolled back, with any rollback failure explicitly surfaced. After process
    ///    death, an unscoped destination is validated before completing the rename.
    @discardableResult
    static func migrateLegacyCache(rootURL: URL, server: String, username: String,
                                   verifiedDefaultWorkspace: String,
                                   workspaceName: String = "") throws -> MigrationOutcome {
        let canonical = canonicalServer(server)
        guard !canonical.isEmpty, !username.isEmpty else {
            return .refused("A server and account are required before local files can be attached to a workspace.")
        }
        guard GammaAPI.isValidWorkspace(verifiedDefaultWorkspace) else {
            return .refused("Sign in online first: this iPad cannot prove which workspace your existing local files belong to.")
        }
        let fm = FileManager.default
        let legacy = rootURL.appendingPathComponent(legacyDirectoryKey(server: canonical, username: username), isDirectory: true)
        let destination = rootURL.appendingPathComponent(directoryKey(server: canonical, username: username,
                                                                     workspace: verifiedDefaultWorkspace), isDirectory: true)
        let recovering = !fm.fileExists(atPath: legacy.path)
        if recovering && !fm.fileExists(atPath: destination.path) { return .noLegacyCache }
        if !recovering && fm.fileExists(atPath: destination.path) {
            return .refused("Local files for this account already exist in that workspace; the older cache was left untouched, not merged.")
        }
        let candidate = recovering ? destination : legacy
        let identityURL = candidate.appendingPathComponent("identity.json")
        guard let legacyIdentity = try? Data(contentsOf: identityURL),
              let stored = try? JSONDecoder().decode(GammaOfflineIdentity.self, from: legacyIdentity),
              canonicalServer(stored.server) == canonical, stored.username == username else {
            return .refused("The cache's identity is missing or inconsistent; local files were not changed.")
        }
        if recovering && stored.workspace == verifiedDefaultWorkspace {
            return .alreadyWorkspaceScoped
        }
        guard stored.workspace.isEmpty else {
            return .refused("The cache names another workspace; local files were not changed.")
        }
        // An interrupted rename from older builds has no journal. Recover only
        // the exact account/default destination with an unscoped identity and
        // self-consistent unscoped payloads. Never adopt foreign or corrupt data.
        do {
            let files = try fm.contentsOfDirectory(at: candidate, includingPropertiesForKeys: nil)
            for file in files where file.lastPathComponent.hasPrefix("page-") && file.pathExtension == "json" {
                let page = try JSONDecoder().decode(GammaPageCache.self, from: Data(contentsOf: file))
                guard (page.workspace ?? "").isEmpty, !page.pageID.isEmpty, !page.docID.isEmpty,
                      file.lastPathComponent == "page-\(key(page.pageID)).json",
                      page.outbox.allSatisfy({ ($0.workspace ?? "").isEmpty }) else {
                    return .refused("Legacy cache contains ambiguous workspace data; local files were not changed.")
                }
            }
            let manifest = candidate.appendingPathComponent("offline.json")
            if fm.fileExists(atPath: manifest.path) {
                let entries = try JSONDecoder().decode([String: GammaOfflineEntry].self, from: Data(contentsOf: manifest))
                guard entries.allSatisfy({ $0.key == $0.value.pageID && ($0.value.workspace ?? "").isEmpty }) else {
                    return .refused("Legacy downloads contain ambiguous workspace data; local files were not changed.")
                }
            }
        } catch {
            return .refused("Legacy cache could not be validated; local files were not changed: \(error.localizedDescription)")
        }
        guard let serverURL = URL(string: canonical) else {
            return .refused("The stored server address could not be read back, so the older cache was not moved.")
        }
        if !recovering { try fm.moveItem(at: legacy, to: destination) }
        do {
            // The directory still holds the pre-workspace identity, which names no
            // workspace and so would be rejected by `validatedIdentity` inside its
            // own new directory. It is replaced here and only here — the directory
            // has provably just been renamed into this workspace's key, and the
            // account and server were verified above.
            let identity = GammaOfflineIdentity(server: canonical, username: username,
                                                workspace: verifiedDefaultWorkspace,
                                                workspaceName: workspaceName)
            try JSONEncoder().encode(identity).write(to: destination.appendingPathComponent("identity.json"),
                                                     options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            // Prove the result is self-consistent before claiming success: a cache
            // instance only forms if the stored identity names its own directory.
            let storage = try GammaCache(rootURL: rootURL, server: serverURL, username: username,
                                         workspace: verifiedDefaultWorkspace)
            _ = try storage.accountIdentity()
            return .migrated(to: destination)
        } catch {
            let failure = error.localizedDescription
            do {
                // Avoid a needless rewrite when the failed atomic write retained
                // the original bytes (including on a read-only directory).
                let target = destination.appendingPathComponent("identity.json")
                if try Data(contentsOf: target) != legacyIdentity {
                    try legacyIdentity.write(to: target, options: .atomic)
                }
                try fm.moveItem(at: destination, to: legacy)
                return .refused("Local files could not be attached; the original cache was restored: \(failure)")
            } catch {
                return .refused("Migration failed and rollback failed. Local files remain at \(destination.path); do not delete this directory. Migration: \(failure). Rollback: \(error.localizedDescription)")
            }
        }
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
            guard let block = documentPages.flatMap({ $0.blocks.flatMap(\.flattened) }).first(where: { $0.id == recording.id }), block.isAudio else {
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
            // A snapshot naming another workspace must never drive a local deletion.
            try assertWorkspace(page.workspace, what: "cached page")
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
