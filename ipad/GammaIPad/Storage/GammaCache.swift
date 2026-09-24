import Foundation
import CryptoKit
import PencilKit

struct GammaMutation: Codable, Identifiable, Equatable {
    enum Kind: String, Codable { case ink, content, child, audio, highlight, inkPreview }
    var id: String = UUID().uuidString
    var kind: Kind
    var blockID: String
    var parentID: String
    var content: String = ""
    var drawing: Data?
    var pdfPage: Int?
    var revision: Int = 0
    var conflict: Bool = false
    var audioSession: GammaRecordingSession?
    var highlight: GammaSelectedText?
    var highlightColor: String?
    var sourceAsset: String?
    /// The workspace this queued write belongs to, stamped when it is queued. A
    /// mutation is never sent to a different workspace: `sync()` refuses instead.
    /// Optional only so a snapshot written before workspaces existed still decodes.
    var workspace: String? = nil
}

struct GammaPageCache: Codable {
    var pageID: String
    var docID: String
    /// The workspace this snapshot was captured in. A snapshot whose recorded
    /// workspace disagrees with its directory is refused, never uploaded.
    /// Optional so a pre-workspace snapshot still decodes (and is stamped on save).
    var workspace: String? = nil
    var blocks: [GammaBlock] = []
    var drawings: [String: Data] = [:]
    var outbox: [GammaMutation] = []
    var recordings: [String: GammaRecordingSession]?
    var replayPreviewSkippedSources: [String: String]?
    /// Exact browser source bytes, never converted into PencilKit or queued for upload.
    /// Optional for backward-compatible reads of pre-gamma-ink snapshots.
    var timInkSources: [String: GammaTimInkSource]?
    var timInkErrors: [String: String]?
}

/// Atomic snapshots include both editable source and its pending operation. A
/// drawing is never acknowledged locally before both have reached the same file.
///
/// A cache directory is one (server, account, workspace) triple: `server +
/// username` alone would let two libraries of the same account share pending
/// handwriting, and a retry could then commit it into the wrong one. Deriving the
/// directory name from all three makes that mistake unrepresentable, and every
/// snapshot/manifest write re-asserts the triple it belongs to.
final class GammaCache {
    let rootURL: URL
    /// Canonical server, account and workspace this directory belongs to.
    let server: String
    let username: String
    let workspace: String
    /// Standalone device storage is not an account cache or an offline session.
    let isLocal: Bool
    let writeOverride: ((Data, URL) throws -> Void)?
    init(rootURL: URL, server: URL, username: String, workspace: String,
         writeOverride: ((Data, URL) throws -> Void)? = nil) throws {
        self.writeOverride = writeOverride
        self.isLocal = false
        let canonical = Self.canonicalServer(server.absoluteString)
        let workspace = workspace.trimmingCharacters(in: .whitespacesAndNewlines)
        guard GammaAPI.isValidWorkspace(workspace) else {
            throw GammaAPI.APIError.message("A Gamma workspace is required to open local files; nothing was read or changed.")
        }
        guard !username.isEmpty else {
            throw GammaAPI.APIError.message("Signed-in account identity is required to open local files.")
        }
        self.server = canonical
        self.username = username
        self.workspace = workspace
        self.rootURL = rootURL.appendingPathComponent(Self.directoryKey(server: canonical, username: username, workspace: workspace),
                                                     isDirectory: true)
        try FileManager.default.createDirectory(at: self.rootURL, withIntermediateDirectories: true)
        // This metadata is intentionally non-secret and permits safe offline identity discovery.
        try ensureAccountIdentity(GammaOfflineIdentity(server: canonical, username: username, workspace: workspace))
    }
    static let localWorkspaceID = "local-library"

    /// An independent Application Support sibling, never scanned as an account.
    static func localApplicationSupportRoot() throws -> URL {
        try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true)
            .appendingPathComponent("GammaLocalLibrary", isDirectory: true)
    }

    static func local(rootURL: URL? = nil,
                      writeOverride: ((Data, URL) throws -> Void)? = nil) throws -> GammaCache {
        try GammaCache(localRootURL: rootURL ?? localApplicationSupportRoot(), writeOverride: writeOverride)
    }

    private init(localRootURL: URL, writeOverride: ((Data, URL) throws -> Void)?) throws {
        guard localRootURL.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
        self.rootURL = localRootURL
        self.server = ""
        self.username = ""
        self.workspace = Self.localWorkspaceID
        self.isLocal = true
        self.writeOverride = writeOverride
        try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
        // No account identity file: this directory cannot establish a server session.
        guard !FileManager.default.fileExists(atPath: rootURL.appendingPathComponent("identity.json").path) else {
            throw GammaAPI.APIError.message("An account cache cannot be opened as a standalone library.")
        }
    }

    static func canonicalServer(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    static func canonicalServer(_ value: URL) -> String { canonicalServer(value.absoluteString) }
    /// The one directory every workspace cache lives under. Migration and the
    /// offline list both need it without a cache in hand, so it is not private.
    static func applicationSupportRoot() throws -> URL {
        try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                    appropriateFor: nil, create: true)
            .appendingPathComponent("GammaCache", isDirectory: true)
    }
    static func application(server: URL, username: String, workspace: String) throws -> GammaCache {
        try GammaCache(rootURL: try applicationSupportRoot(), server: server,
                       username: username, workspace: workspace)
    }
    static func key(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    /// The workspace-explicit directory name.
    static func directoryKey(server: String, username: String, workspace: String) -> String {
        key(canonicalServer(server) + "\n" + username + "\n" + workspace)
    }
    /// The pre-workspace directory name (`server + username`). Still recognised so
    /// an existing cache is found, then migrated — never silently reinterpreted.
    static func legacyDirectoryKey(server: String, username: String) -> String {
        key(canonicalServer(server) + "\n" + username)
    }
    func saveLibrary(_ papers: [GammaPaper]) throws { try write(papers, to: rootURL.appendingPathComponent("library.json")) }
    func library() throws -> [GammaPaper] {
        try read([GammaPaper].self, from: rootURL.appendingPathComponent("library.json")) ?? []
    }
    func recentPageIDs() throws -> [String] {
        try read([String].self, from: rootURL.appendingPathComponent("recents.json")) ?? []
    }
    func recordRecent(_ pageID: String) throws -> [String] {
        let ids = Array(([pageID] + (try recentPageIDs()).filter { $0 != pageID }).prefix(12))
        try write(ids, to: rootURL.appendingPathComponent("recents.json"))
        return ids
    }
    func loadPage(pageID: String, docID: String) throws -> GammaPageCache {
        let snapshot = try read(GammaPageCache.self, from: pageURL(pageID))
        if let snapshot {
            guard snapshot.pageID == pageID, snapshot.docID == docID else {
                throw GammaAPI.APIError.message("Cached Gamma page/document identity mismatch; data preserved.")
            }
            try assertWorkspace(snapshot.workspace, what: "cached page")
            return snapshot
        }
        return GammaPageCache(pageID: pageID, docID: docID, workspace: workspace)
    }
    func savePage(_ page: GammaPageCache) throws {
        var page = page
        try assertWorkspace(page.workspace, what: "page snapshot")
        page.workspace = workspace
        page.invalidateTimInkSources()
        // A queued write without a stamp is only possible for data carried over from
        // before workspaces existed; it is stamped with this verified directory.
        for index in page.outbox.indices where page.outbox[index].workspace == nil { page.outbox[index].workspace = workspace }
        try write(page, to: pageURL(page.pageID))
    }
    /// A file naming a different workspace than the directory it lives in was
    /// moved, restored or copied incorrectly. Refusing keeps it from being
    /// uploaded into the wrong library; nothing is deleted.
    func assertWorkspace(_ recorded: String?, what: String) throws {
        guard let recorded, !recorded.isEmpty, recorded != workspace else { return }
        throw GammaAPI.APIError.message("This \(what) belongs to workspace “\(recorded)”, not “\(workspace)”. Nothing was uploaded or deleted; sign in to the matching workspace.")
    }
    func pendingPages() throws -> [GammaPageCache] {
        try FileManager.default.contentsOfDirectory(at: rootURL, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("page-") && $0.pathExtension == "json" }
            .compactMap { try read(GammaPageCache.self, from: $0) }
            .map { page in
                try assertWorkspace(page.workspace, what: "cached page")
                return page
            }
            .filter { !$0.outbox.isEmpty }
    }
    func sourceURL(docID: String) -> URL { rootURL.appendingPathComponent("source-\(Self.key(docID)).pdf") }
    func preserveSource(from temporaryURL: URL, docID: String) throws {
        let destination = sourceURL(docID: docID)
        // Immutable: do not flatten or overwrite an already-cached original.
        guard !FileManager.default.fileExists(atPath: destination.path) else { return }
        try Data(contentsOf: temporaryURL).write(to: destination, options: .atomic)
    }
    /// Local imports verify deduplicated bytes rather than trusting a truncated ID.
    /// A failed import may leave an unreferenced immutable source; never remove a
    /// source that a previous import (or an interrupted transaction) could reference.
    func preserveLocalSource(_ data: Data, docID: String) throws {
        guard isLocal else { throw CocoaError(.fileWriteNoPermission) }
        let destination = sourceURL(docID: docID)
        if FileManager.default.fileExists(atPath: destination.path) {
            guard try Data(contentsOf: destination) == data else {
                throw GammaAPI.APIError.message("The stored PDF does not match this import; existing bytes were preserved.")
            }
            return
        }
        try writeData(data, to: destination)
    }
    func writeLocalMetadata<T: Encodable>(_ value: T) throws {
        guard isLocal else { throw CocoaError(.fileWriteNoPermission) }
        try write(value, to: rootURL.appendingPathComponent("local-records.json"))
    }
    private func pageURL(_ id: String) -> URL { rootURL.appendingPathComponent("page-\(Self.key(id)).json") }
    private func read<T: Decodable>(_ type: T.Type, from url: URL) throws -> T? {
        do { return try JSONDecoder().decode(type, from: Data(contentsOf: url)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }
    private func write<T: Encodable>(_ value: T, to url: URL) throws {
        try writeData(JSONEncoder().encode(value), to: url)
    }
    private func writeData(_ data: Data, to url: URL) throws {
        if let writeOverride { try writeOverride(data, url) }
        else { try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    }
}
