import Foundation
import PDFKit
import PencilKit

struct Note: Codable, Identifiable, Equatable {
    let id: UUID
    let title: String
    let createdAt: Date
    let pageCount: Int
    let schemaVersion: Int
}

struct LibrarySnapshot {
    let notes: [Note]
    let issues: [String]
}

enum NoteStoreError: LocalizedError {
    case invalidPDF
    case invalidMetadata(String)
    case invalidPage(Int)
    case corruptDrawing(Int)
    case missingSource

    var errorDescription: String? {
        switch self {
        case .invalidPDF: return "The file is not a readable, unlocked PDF with at least one page."
        case .invalidMetadata(let detail): return "The note metadata is damaged or unsupported: \(detail)"
        case .invalidPage(let page): return "Page index \(page) is outside this document (indexes start at zero)."
        case .corruptDrawing(let page):
            return "The handwriting for page \(page + 1) is damaged. It has been preserved and will not be overwritten."
        case .missingSource: return "This note's original PDF is missing. Its handwriting has been preserved."
        }
    }
}

/// Synchronous, local-only storage. The UI calls this on the main thread; callers must
/// serialize operations. A published bundle is never rewritten during import.
final class NoteStore {
    let rootURL: URL
    private let files: FileManager

    init(rootURL: URL, files: FileManager = .default) throws {
        self.rootURL = rootURL
        self.files = files
        try files.createDirectory(at: rootURL, withIntermediateDirectories: true)
    }

    static func applicationStore() throws -> NoteStore {
        let support = try FileManager.default.url(for: .applicationSupportDirectory,
                                                 in: .userDomainMask,
                                                 appropriateFor: nil, create: true)
        return try NoteStore(rootURL: support.appendingPathComponent("Notes", isDirectory: true))
    }

    func bundleURL(for id: UUID) -> URL {
        rootURL.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    /// Only completely imported UUID bundles are visible. Hidden staging folders left
    /// by an interrupted import are ignored, not interpreted as notes.
    func library() throws -> LibrarySnapshot {
        let entries = try files.contentsOfDirectory(at: rootURL,
                                                    includingPropertiesForKeys: [.isDirectoryKey],
                                                    options: [.skipsHiddenFiles])
        var notes: [Note] = []
        var issues: [String] = []
        for entry in entries {
            guard let id = UUID(uuidString: entry.lastPathComponent) else {
                issues.append("Unrecognized item preserved: \(entry.lastPathComponent)")
                continue
            }
            do {
                let note = try readNote(id: id)
                _ = try document(for: note)
                notes.append(note)
            } catch {
                issues.append("\(entry.lastPathComponent): \(error.localizedDescription)")
            }
        }
        return LibrarySnapshot(notes: notes.sorted { $0.createdAt > $1.createdAt }, issues: issues)
    }

    /// The caller must hold a security-scoped resource grant while this runs for a
    /// URL returned by Files. Copy first, validate the private copy, then publish.
    @discardableResult
    func importPDF(from url: URL, title: String? = nil) throws -> Note {
        let id = UUID()
        let staging = rootURL.appendingPathComponent(".import-\(id.uuidString)", isDirectory: true)
        try files.createDirectory(at: staging, withIntermediateDirectories: false)
        defer { try? files.removeItem(at: staging) }
        let source = staging.appendingPathComponent("source.pdf")
        try files.copyItem(at: url, to: source)
        guard let pdf = PDFDocument(url: source), !pdf.isLocked, pdf.pageCount > 0 else {
            throw NoteStoreError.invalidPDF
        }
        let proposedTitle = (title ?? url.deletingPathExtension().lastPathComponent)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let note = Note(id: id, title: proposedTitle.isEmpty ? "Untitled PDF" : proposedTitle,
                        createdAt: Date(), pageCount: pdf.pageCount, schemaVersion: 1)
        try files.createDirectory(at: staging.appendingPathComponent("drawings", isDirectory: true),
                                  withIntermediateDirectories: false)
        try JSONEncoder().encode(note).write(to: staging.appendingPathComponent("note.json"), options: .atomic)
        try files.moveItem(at: staging, to: bundleURL(for: id))
        return note
    }

    func readNote(id: UUID) throws -> Note {
        let data = try Data(contentsOf: bundleURL(for: id).appendingPathComponent("note.json"))
        let note: Note
        do { note = try JSONDecoder().decode(Note.self, from: data) }
        catch { throw NoteStoreError.invalidMetadata(error.localizedDescription) }
        guard note.id == id, note.schemaVersion == 1, note.pageCount > 0 else {
            throw NoteStoreError.invalidMetadata("identity, version, or page count mismatch")
        }
        return note
    }

    func document(for note: Note) throws -> PDFDocument {
        let persisted = try readNote(id: note.id)
        guard persisted == note else { throw NoteStoreError.invalidMetadata("note changed") }
        let source = bundleURL(for: note.id).appendingPathComponent("source.pdf")
        guard files.fileExists(atPath: source.path) else { throw NoteStoreError.missingSource }
        guard let document = PDFDocument(url: source), !document.isLocked,
              document.pageCount == note.pageCount else { throw NoteStoreError.invalidPDF }
        return document
    }

    /// Page indices are zero-based. Only a genuinely absent drawing means blank.
    /// Decode/read failures are thrown, never substituted with an empty drawing.
    func loadDrawing(noteID: UUID, page: Int) throws -> PKDrawing {
        let url = try drawingURL(noteID: noteID, page: page)
        let data: Data
        do { data = try Data(contentsOf: url) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            // A missing bundle/drawings directory is damage, not a blank page.
            let parent = url.deletingLastPathComponent()
            let values = try parent.resourceValues(forKeys: [.isDirectoryKey])
            guard values.isDirectory == true else {
                throw NoteStoreError.invalidMetadata("drawings directory missing")
            }
            return PKDrawing()
        }
        guard !data.isEmpty else { throw NoteStoreError.corruptDrawing(page) }
        do { return try PKDrawing(data: data) }
        catch { throw NoteStoreError.corruptDrawing(page) }
    }

    /// Check the existing page before writing, so even an erroneous caller cannot
    /// replace an unreadable drawing with a blank canvas. Atomic rename keeps the
    /// old complete drawing intact if writing the replacement fails.
    func saveDrawing(noteID: UUID, page: Int, drawing: PKDrawing) throws {
        let url = try drawingURL(noteID: noteID, page: page)
        _ = try loadDrawing(noteID: noteID, page: page)
        try drawing.dataRepresentation().write(to: url, options: .atomic)
    }

    private func drawingURL(noteID: UUID, page: Int) throws -> URL {
        let note = try readNote(id: noteID)
        guard (0..<note.pageCount).contains(page) else { throw NoteStoreError.invalidPage(page) }
        return bundleURL(for: noteID).appendingPathComponent("drawings", isDirectory: true)
            .appendingPathComponent("page-\(page).drawing")
    }
}
