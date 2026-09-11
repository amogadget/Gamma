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
}

struct GammaPageCache: Codable {
    var pageID: String
    var docID: String
    var blocks: [GammaBlock] = []
    var drawings: [String: Data] = [:]
    var outbox: [GammaMutation] = []
    var recordings: [String: GammaRecordingSession]?
    var replayPreviewSkippedSources: [String: String]?
}

/// Atomic snapshots include both editable source and its pending operation. A
/// drawing is never acknowledged locally before both have reached the same file.
/// Account directories use a hash of the canonical server and authenticated user;
/// page/document/block identities inside the cache remain Gamma identities.
final class GammaCache {
    let rootURL: URL
    let writeOverride: ((Data, URL) throws -> Void)?
    init(rootURL: URL, server: URL, username: String, writeOverride: ((Data, URL) throws -> Void)? = nil) throws {
        self.writeOverride = writeOverride
        let canonical = Self.canonicalServer(server.absoluteString)
        let key = Self.key(canonical + "\n" + username)
        self.rootURL = rootURL.appendingPathComponent(key, isDirectory: true)
        try FileManager.default.createDirectory(at: self.rootURL, withIntermediateDirectories: true)
        // This metadata is intentionally non-secret and permits safe offline identity discovery.
        try ensureAccountIdentity(GammaOfflineIdentity(server: canonical, username: username))
    }
    static func canonicalServer(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    static func canonicalServer(_ value: URL) -> String { canonicalServer(value.absoluteString) }
    static func application(server: URL, username: String) throws -> GammaCache {
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                               appropriateFor: nil, create: true)
        return try GammaCache(rootURL: root.appendingPathComponent("GammaCache", isDirectory: true),
                              server: server, username: username)
    }
    static func key(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
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
            return snapshot
        }
        return GammaPageCache(pageID: pageID, docID: docID)
    }
    func savePage(_ page: GammaPageCache) throws { try write(page, to: pageURL(page.pageID)) }
    func pendingPages() throws -> [GammaPageCache] {
        try FileManager.default.contentsOfDirectory(at: rootURL, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("page-") && $0.pathExtension == "json" }
            .compactMap { try read(GammaPageCache.self, from: $0) }
            .filter { !$0.outbox.isEmpty }
    }
    func sourceURL(docID: String) -> URL { rootURL.appendingPathComponent("source-\(Self.key(docID)).pdf") }
    func preserveSource(from temporaryURL: URL, docID: String) throws {
        let destination = sourceURL(docID: docID)
        // Immutable: do not flatten or overwrite an already-cached original.
        guard !FileManager.default.fileExists(atPath: destination.path) else { return }
        try Data(contentsOf: temporaryURL).write(to: destination, options: .atomic)
    }
    private func pageURL(_ id: String) -> URL { rootURL.appendingPathComponent("page-\(Self.key(id)).json") }
    private func read<T: Decodable>(_ type: T.Type, from url: URL) throws -> T? {
        do { return try JSONDecoder().decode(type, from: Data(contentsOf: url)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }
    private func write<T: Encodable>(_ value: T, to url: URL) throws {
        let data = try JSONEncoder().encode(value)
        if let writeOverride { try writeOverride(data, url) }
        else { try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]) }
    }
}
