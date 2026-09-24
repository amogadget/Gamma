import Foundation
import CryptoKit
import PDFKit
import PencilKit
import UIKit

/// A retained-source import, NOT a cache relocation. Call while the embedded
/// library is still private to bootstrap, before opening editors/outbox workers.
/// No method writes to the old library. Errors intentionally escape to the
/// bootstrap banner; a partially imported page is never marked complete.
@MainActor
enum GammaLocalLibraryMigration {
    struct Progress: Codable {
        var version = 1
        var source: String
        var server: String
        var account: String
        var workspace: String
        var pages: [String: PageProgress] = [:]
    }
    struct PageProgress: Codable {
        var fingerprint: String
        var complete = false
        var blocks: [String: GammaBlock] = [:]
    }
    static func failure(_ detail: String) -> GammaAPI.APIError {
        .message("Local library migration needs attention: \(detail). Original PDFs, handwriting and recordings are retained; retry after resolving this problem.")
    }
    static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    static func canonicalID(_ id: String) -> Bool {
        UUID(uuidString: id)?.uuidString.lowercased() == id
    }

    /// Validates the whole graph before the first upload. Snapshot array order
    /// determines sibling order; parents always precede their descendants.
    static func orderedBlocks(_ snapshot: GammaPageCache) throws -> [GammaBlock] {
        guard snapshot.workspace == nil || snapshot.workspace == GammaCache.localWorkspaceID,
              snapshot.timInkSources?.isEmpty != false else { throw failure("snapshot is not a standalone native page") }
        let blocks = snapshot.blocks.flatMap(\.flattened)
        guard canonicalID(snapshot.pageID), Set(blocks.map(\.id)).count == blocks.count,
              blocks.allSatisfy({ canonicalID($0.id) }),
              let root = blocks.first(where: { $0.id == snapshot.pageID }),
              root.parentID == nil || root.parentID == "root",
              root.properties.docID == snapshot.docID else { throw failure("invalid page snapshot identity") }
        var remaining = blocks.filter { $0.id != snapshot.pageID }
        var result = [root], seen: Set<String> = [root.id]
        while !remaining.isEmpty {
            guard let index = remaining.firstIndex(where: { seen.contains($0.parentID ?? "") }) else {
                throw failure("missing parent or cyclic note relationship")
            }
            let block = remaining.remove(at: index)
            guard !block.isTimInk else { throw failure("unexpected browser ink in a standalone library; no conversion was attempted") }
            if block.isInk || block.isAudio || block.isHighlight {
                guard block.parentID == root.id else { throw failure("unsupported nested annotation") }
            } else if block.properties.nativeNote == true {
                guard let parent = result.first(where: { $0.id == block.parentID }),
                      parent.isInk || parent.properties.nativeNote == true else { throw failure("invalid native note parent") }
            } else { throw failure("unknown local block kind") }
            seen.insert(block.id); result.append(block)
        }
        guard Set(snapshot.drawings.keys).isSubset(of: Set(result.filter(\.isInk).map(\.id))),
              Set((snapshot.recordings ?? [:]).keys).isSubset(of: Set(result.filter(\.isAudio).map(\.id))) else {
            throw failure("unrepresented drawing or recording")
        }
        for change in snapshot.outbox {
            guard change.workspace == nil || change.workspace == GammaCache.localWorkspaceID,
                  let block = blocks.first(where: { $0.id == change.blockID }), block.parentID == change.parentID else {
                throw failure("outbox scope mismatch")
            }
            let covered: Bool
            switch change.kind {
            case .ink: covered = block.isInk && change.drawing != nil && snapshot.drawings[block.id] == change.drawing && block.pdfPage == change.pdfPage
            case .child: covered = block.properties.nativeNote == true && block.content == change.content
            case .content: covered = block.content == change.content
            case .audio: covered = change.audioSession != nil && snapshot.recordings?[block.id] == change.audioSession
            case .highlight: covered = change.highlight != nil && block.properties.highlightID == block.id && block.properties.pdfPosition == change.highlight?.position && block.properties.quote == change.highlight?.quote && block.properties.color == change.highlightColor
            case .inkPreview: covered = false
            }
            guard covered else { throw failure("incomplete local save") }
        }
        return result
    }

    private struct FlightKey: Equatable {
        let source: String
        let destination: String
        let server: String
        let account: String
        let workspace: String
        let epoch: UUID
    }
    private struct Flight {
        let key: FlightKey
        let token: UUID
        let task: Task<Int, Error>
    }
    // The destination is also a serialization lane: separately constructed host
    // access objects have distinct epochs even when they use the same backend.
    // Never let those flights race the same on-disk manifest.
    private static var flights: [String: Flight] = [:]

    @discardableResult
    static func run(sourceRoot: URL? = nil, client: GammaAPI, destination: GammaCache) async throws -> Int {
        try Task.checkCancellation()
        guard let access = client.localServerAccess, access.cacheIdentity == "gamma-local://device",
              client.workspace == access.workspace, destination.workspace == access.workspace,
              destination.username == access.account, destination.server == client.cacheServerIdentity,
              !destination.isLocal else { throw failure("target is not the verified embedded workspace") }
        let source = try (sourceRoot ?? GammaCache.localApplicationSupportRoot())
            .standardizedFileURL.resolvingSymlinksInPath()
        let target = destination.rootURL.standardizedFileURL.resolvingSymlinksInPath().path
        let key = FlightKey(source: source.path, destination: target, server: destination.server,
                            account: access.account, workspace: access.workspace, epoch: access.epoch)
        if let running = flights[target], running.key == key {
            // Cancelling one waiter must not cancel a migration another caller
            // still needs. Every waiter observes the same thrown failure.
            return try await running.task.value
        }
        let predecessor = flights[target]?.task
        let token = UUID()
        let task = Task { @MainActor in
            defer {
                // Only this flight's completion may remove its registry entry;
                // an older flight must not erase a newer queued epoch.
                if flights[target]?.token == token { flights.removeValue(forKey: target) }
            }
            if let predecessor { _ = try await predecessor.value }
            return try await runOnce(sourceRoot: source, client: client, destination: destination)
        }
        flights[target] = Flight(key: key, token: token, task: task)
        return try await task.value
    }

    private static func runOnce(sourceRoot: URL, client: GammaAPI, destination: GammaCache) async throws -> Int {
        guard let access = client.localServerAccess, access.cacheIdentity == "gamma-local://device",
              client.workspace == access.workspace, destination.workspace == access.workspace,
              destination.username == access.account, destination.server == client.cacheServerIdentity,
              !destination.isLocal else { throw failure("target is not the verified embedded workspace") }
        let info = try await client.session()
        guard info.user == access.account, info.option(access.workspace)?.role == "owner" else {
            throw failure("embedded owner identity changed")
        }
        let source = sourceRoot
        guard FileManager.default.fileExists(atPath: source.appendingPathComponent("library.json").path) else { return 0 }
        let sourcePath = source.standardizedFileURL.resolvingSymlinksInPath().path
        let targetPath = destination.rootURL.standardizedFileURL.resolvingSymlinksInPath().path
        guard sourcePath != targetPath, !sourcePath.hasPrefix(targetPath + "/"), !targetPath.hasPrefix(sourcePath + "/") else {
            throw failure("source and destination overlap")
        }
        guard try destination.pendingPages().allSatisfy({ $0.outbox.isEmpty }) else {
            throw failure("finish pending embedded native changes before migrating")
        }
        func contained(_ url: URL) throws {
            guard url.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(sourcePath + "/") else {
                throw failure("a source reference escapes the old library")
            }
        }
        try contained(source.appendingPathComponent("library.json"))
        try contained(source.appendingPathComponent("local-records.json"))
        let library = try GammaLocalLibrary(rootURL: source)
        let papers = try library.papers()
        let records = try library.records()
        guard Set(papers.map(\.id)).count == papers.count else { throw failure("duplicate published page IDs") }
        let manifestURL = destination.rootURL.appendingPathComponent("local-library-migration-v1.json")
        let sourceIdentity = source.standardizedFileURL.resolvingSymlinksInPath().path
        var progress = Progress(source: sourceIdentity, server: destination.server,
                                account: destination.username, workspace: destination.workspace)
        if FileManager.default.fileExists(atPath: manifestURL.path) {
            progress = try JSONDecoder().decode(Progress.self, from: Data(contentsOf: manifestURL))
            guard progress.version == 1, progress.source == sourceIdentity, progress.server == destination.server,
                  progress.account == destination.username, progress.workspace == destination.workspace else {
                throw failure("migration receipt belongs to another source or workspace")
            }
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        func save() throws {
            try encoder.encode(progress).write(to: manifestURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        var count = 0
        for paper in papers {
            try Task.checkCancellation()
            guard let docID = paper.properties.docID else { throw failure("published page lacks PDF identity") }
            try contained(source.appendingPathComponent("page-\(GammaCache.key(paper.id)).json"))
            try contained(library.cache.sourceURL(docID: docID))
            let snapshot = try library.cache.loadPage(pageID: paper.id, docID: docID)
            let ordered = try orderedBlocks(snapshot)
            let pdfURL = try library.pdfURL(for: paper)
            let pdfBytes = try Data(contentsOf: pdfURL)
            guard let pdf = PDFDocument(data: pdfBytes) else { throw failure("unreadable PDF") }
            var fingerprintData = try encoder.encode(snapshot)
            fingerprintData.append(pdfBytes)
            var audioFiles: [String: Data] = [:]
            for block in ordered where block.isAudio {
                guard let recording = snapshot.recordings?[block.id], recording.id == block.id,
                      recording.pageID == paper.id, recording.activeSegmentID == nil,
                      recording.state != .recording, recording.state != .recoveryRequired,
                      block.properties.segments == recording.segments,
                      block.properties.duration == recording.duration,
                      block.properties.audioState == recording.serverState,
                      block.properties.replayEvents == recording.replayEvents else { throw failure("recording requires recovery") }
                for segment in recording.segments {
                    let url = try GammaRecordingFiles.url(root: source, recordingID: block.id, segmentID: segment.id)
                    try contained(url)
                    let bytes = try Data(contentsOf: url)
                    guard bytes.count >= 16, bytes.subdata(in: 4..<8) == Data("ftyp".utf8) else { throw failure("invalid audio source") }
                    guard audioFiles[segment.id] == nil else { throw failure("duplicate recording segment identity") }
                    audioFiles[segment.id] = bytes; fingerprintData.append(bytes)
                }
            }
            for block in ordered where block.isInk {
                guard let bytes = snapshot.drawings[block.id], let number = block.pdfPage,
                      number > 0, pdf.page(at: number - 1) != nil else { throw failure("missing drawing source or PDF page") }
                _ = try PKDrawing(data: bytes)
            }
            let fingerprint = digest(fingerprintData)
            if let prior = progress.pages[paper.id] {
                guard prior.fingerprint == fingerprint else { throw failure("old page changed since migration began") }
                // Once complete, the backend is authoritative. Never undo edits or
                // resurrect a page the user subsequently deleted there.
                if prior.complete { continue }
            } else {
                guard try await client.localMigrationPage(paper.id) == nil else { throw failure("target page ID already exists without a migration receipt") }
                progress.pages[paper.id] = PageProgress(fingerprint: fingerprint)
                try save() // intent is durable BEFORE any remote write
            }
            let uploaded = try await client.localMigrationRequest("api/uploads", method: "POST", pdf: pdfBytes)
            guard let upload = try JSONSerialization.jsonObject(with: uploaded) as? [String: Any],
                  upload["doc_id"] as? String == docID,
                  let sourceURL = upload["source_url"] as? String else { throw failure("uploaded PDF identity mismatch") }
            if let existing = try await client.localMigrationPage(paper.id) {
                guard existing.properties.docID == docID, existing.content == ordered[0].content else { throw failure("target root changed") }
            } else {
                guard progress.pages[paper.id]?.blocks.isEmpty == true else { throw failure("partially migrated page was deleted") }
                var properties = try JSONSerialization.jsonObject(with: encoder.encode(ordered[0].properties)) as! [String: Any]
                properties["source_url"] = sourceURL
                if let record = records.first(where: { $0.pageID == paper.id && $0.docID == docID }) {
                    properties["original_filename"] = record.originalFilename
                }
                _ = try await client.localMigrationRequest("api/pages", method: "POST", json: ["id": paper.id, "title": ordered[0].content, "properties": properties])
            }
            for block in ordered.dropFirst() {
                try Task.checkCancellation()
                if let receipt = progress.pages[paper.id]?.blocks[block.id] {
                    guard let current = try await client.localMigrationPage(block.id), equivalent(current, receipt) else { throw failure("migrated block changed before completion") }
                    continue
                }
                let existing = try await client.localMigrationPage(block.id)
                if let existing {
                    guard existing.parentID == block.parentID,
                          existing.content == block.content else { throw failure("target annotation content differs; automatic overwrite refused") }
                }
                var returned: GammaBlock
                if block.isInk {
                    let bytes = snapshot.drawings[block.id]!
                    let drawing = try PKDrawing(data: bytes)
                    let crop = pdf.page(at: block.pdfPage! - 1)!.bounds(for: .cropBox).standardized
                    let visible = drawing.bounds.intersection(CGRect(origin: .zero, size: crop.size))
                    let rect = visible.isNull || visible.isEmpty ? CGRect(x: 0, y: 0, width: min(1, crop.width), height: min(1, crop.height)) : visible
                    guard let preview = drawing.image(from: rect, scale: min(1, 2048 / max(rect.width, rect.height))).pngData() else { throw failure("cannot render ink preview") }
                    let ink = try await client.localMigrationUpload(data: bytes, fileExtension: "pkdrawing", mime: "application/octet-stream")
                    let png = try await client.localMigrationUpload(data: preview, fileExtension: "png", mime: "image/png")
                    let replay = try GammaWebInkExport.encode(drawing: drawing, sourceData: bytes, pageSize: crop.size)
                    let replayAsset = try await client.localMigrationUpload(data: replay, fileExtension: "inkjson", mime: "application/json")
                    returned = try await client.putInk(id: block.id, body: ["parent_id": paper.id, "pdf_page": block.pdfPage!, "expected_revision": 0,
                        "ink_asset": ink, "preview_asset": png, "replay_asset": replayAsset,
                        "bounds": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height],
                        "crop_box": ["width": crop.width, "height": crop.height], "coordinate_space": "pdf-crop-top-left-v1"])
                } else if block.isAudio {
                    let recording = snapshot.recordings![block.id]!
                    var segments = recording.segments
                    for index in segments.indices {
                        segments[index].asset = try await client.localMigrationUpload(data: audioFiles[segments[index].id]!, fileExtension: "m4a", mime: "audio/mp4")
                    }
                    returned = try await client.putAudio(id: block.id, parent: paper.id, revision: 0, state: recording.serverState,
                                                         segments: segments, replayEvents: recording.replayEvents ?? [])
                } else if block.isHighlight {
                    guard let position = block.properties.pdfPosition, let number = block.pdfPage,
                          let quote = block.properties.quote, let color = block.properties.color,
                          block.properties.highlightID == block.id else { throw failure("invalid highlight") }
                    var normalizedPosition = position
                    normalizedPosition.area = position.area ?? false
                    returned = try await client.createHighlight(id: block.id, parent: paper.id,
                        selection: GammaSelectedText(page: number, quote: quote, position: normalizedPosition), color: color)
                    guard returned.properties.highlightID == block.id, returned.properties.quote == quote,
                          returned.properties.color == color, returned.properties.pdfPosition == normalizedPosition else {
                        throw failure("target highlight differs from the retained source")
                    }
                } else {
                    returned = try await client.putNote(id: block.id, parent: block.parentID!, content: block.content, revision: 0)
                }
                if returned.content != block.content {
                    guard returned.content.isEmpty else { throw failure("target content conflict") }
                    try await client.updateContent(id: block.id, content: block.content)
                    returned = try await client.subtree(block.id)
                }
                guard returned.parentID == block.parentID, returned.content == block.content else { throw failure("annotation readback mismatch") }
                returned.children = nil
                progress.pages[paper.id]?.blocks[block.id] = returned
                try save()
            }
            let final = try await client.subtree(paper.id)
            guard Set(final.flattened.map(\.id)) == Set(ordered.map(\.id)) else { throw failure("final page graph differs") }
            for block in final.flattened where block.id != paper.id {
                guard let receipt = progress.pages[paper.id]?.blocks[block.id], equivalent(block, receipt) else { throw failure("final annotation readback mismatch") }
                if block.isInk {
                    guard let asset = block.properties.inkAsset,
                          try await client.asset(asset) == snapshot.drawings[block.id] else { throw failure("drawing readback differs") }
                }
                if block.isAudio {
                    for segment in block.properties.segments ?? [] {
                        guard let asset = segment.asset, try await client.asset(asset) == audioFiles[segment.id] else {
                            throw failure("recording readback differs")
                        }
                    }
                }
            }
            // Verify immutable source bytes through the same workspace API.
            let downloaded = try await client.localMigrationRequest("api/uploads/\(docID).pdf")
            guard downloaded == pdfBytes else { throw failure("PDF readback differs from original") }
            progress.pages[paper.id]?.complete = true
            try save(); count += 1
        }
        return count
    }

    static func equivalent(_ lhs: GammaBlock, _ rhs: GammaBlock) -> Bool {
        lhs.id == rhs.id && lhs.parentID == rhs.parentID && lhs.content == rhs.content && lhs.properties == rhs.properties
    }
}
