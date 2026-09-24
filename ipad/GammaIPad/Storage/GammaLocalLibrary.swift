import Foundation
import CryptoKit
import PDFKit

/// Standalone device-owned storage. No API, URLSession, credentials or synthetic
/// server identity participates in importing or opening a document.
/// Main-actor serialization also prevents two imports from losing index updates.
@MainActor
final class GammaLocalLibrary {
    struct Record: Codable, Equatable {
        var pageID: String
        var docID: String
        var originalFilename: String
        var title: String
        var pageCount: Int
        var importedAt: String
    }
    private struct Manifest: Codable {
        var version = 1
        var workspace = GammaCache.localWorkspaceID
        var records: [Record] = []
    }

    let cache: GammaCache

    init(cache: GammaCache) throws {
        guard cache.isLocal, cache.workspace == GammaCache.localWorkspaceID else {
            throw GammaAPI.APIError.message("Standalone storage requires a local library, not an account cache.")
        }
        self.cache = cache
    }

    convenience init(rootURL: URL? = nil,
                     writeOverride: ((Data, URL) throws -> Void)? = nil) throws {
        try self.init(cache: GammaCache.local(rootURL: rootURL, writeOverride: writeOverride))
    }

    func papers() throws -> [GammaPaper] { try cache.library() }

    /// Metadata is descriptive, not an additional library index. Interrupted
    /// imports can leave records/assets, but only library.json publishes a page.
    func records() throws -> [Record] {
        let ids = Set(try papers().map(\.id))
        return try manifest().records.filter { ids.contains($0.pageID) }
    }

    func pdfURL(for paper: GammaPaper) throws -> URL {
        guard let docID = paper.properties.docID,
              try papers().contains(where: { $0.id == paper.id && $0.properties.docID == docID }) else {
            throw GammaAPI.APIError.message("This PDF is not in the local library.")
        }
        let url = cache.sourceURL(docID: docID)
        let bytes = try Data(contentsOf: url)
        guard Self.documentID(bytes) == docID else {
            throw GammaAPI.APIError.message("The local PDF is damaged; its bytes were preserved.")
        }
        _ = try Self.validate(bytes)
        return url
    }

    /// Hold the Files provider grant through coordinated reading. The provider URL
    /// is never saved: cold reopen uses our immutable copy, not a stale bookmark.
    func importPDF(from url: URL) throws -> GammaPaper {
        guard url.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let coordinator = NSFileCoordinator(filePresenter: nil)
        var coordinationError: NSError?
        var result: Result<Data, Error>?
        coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { readableURL in
            result = Result { try Data(contentsOf: readableURL) }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw CocoaError(.fileReadUnknown) }
        let data = try result.get()
        let document = try Self.validate(data)
        let docID = Self.documentID(data)
        let pageID = UUID().uuidString.lowercased()
        let filename = Self.sanitizedFilename(url.lastPathComponent)
        let title = Self.sanitizedTitle((filename as NSString).deletingPathExtension)
        let timestamp = ISO8601DateFormatter().string(from: Date())
        let paper = GammaPaper(id: pageID, parentID: nil, content: title,
                               properties: GammaProperties(docID: docID), updatedAt: timestamp)
        let oldPapers = try papers()
        var metadata = try manifest()
        metadata.records.append(Record(pageID: pageID, docID: docID,
                                       originalFilename: filename, title: title,
                                       pageCount: document.pageCount, importedAt: timestamp))

        // Transaction order: durable source -> snapshot -> descriptive metadata ->
        // atomic index commit. Before the last rename the page is not visible.
        // Failure/process death leaves only reference-orphans, never deletes or
        // rewrites another page, and never advertises an incomplete new import.
        try cache.preserveLocalSource(data, docID: docID)
        try cache.savePage(GammaPageCache(pageID: pageID, docID: docID,
                                          workspace: GammaCache.localWorkspaceID,
                                          blocks: [paper]))
        try cache.writeLocalMetadata(metadata)
        try cache.saveLibrary(oldPapers + [paper])
        return paper
    }

    private func manifest() throws -> Manifest {
        let url = cache.rootURL.appendingPathComponent("local-records.json")
        let data: Data
        do { data = try Data(contentsOf: url) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return Manifest() }
        let value = try JSONDecoder().decode(Manifest.self, from: data)
        guard value.version == 1, value.workspace == GammaCache.localWorkspaceID else {
            throw GammaAPI.APIError.message("Unsupported local library metadata; files were preserved.")
        }
        return value
    }

    private static func validate(_ data: Data) throws -> PDFDocument {
        guard let document = PDFDocument(data: data), !document.isLocked,
              document.pageCount > 0,
              (0..<document.pageCount).allSatisfy({ document.page(at: $0) != nil }) else {
            throw GammaAPI.APIError.message("Choose a readable, nonempty PDF that does not require a password.")
        }
        // Encrypted PDFs already unlocked without a password are readable on cold
        // reopen as well. Never flatten/re-encode or strip original annotations.
        return document
    }

    private static func documentID(_ data: Data) -> String {
        // backend/gamma/storage.py content_digest: first 24 lowercase SHA256 hex.
        String(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined().prefix(24))
    }

    private static func sanitizedFilename(_ value: String) -> String {
        let leaf = value.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "/").last ?? ""
        let cleaned = leaf.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        let name = String(String.UnicodeScalarView(cleaned)).trimmingCharacters(in: .whitespacesAndNewlines)
        let stem = sanitizedTitle((name as NSString).deletingPathExtension)
        return stem + ".pdf"
    }

    private static func sanitizedTitle(_ value: String) -> String {
        let text = value.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
            .trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return text.isEmpty ? "Untitled PDF" : String(text.prefix(120))
    }
}
