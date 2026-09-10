import Foundation

struct GammaProperties: Codable, Equatable {
    var type: String?
    var docID: String?
    var pdfPage: Int?
    var inkAsset: String?
    var previewAsset: String?
    var revision: Int?
    var clientMutationID: String?
    var nativeNote: Bool?
    var noteRevision: Int?
    var highlightID: String?
    var quote: String?
    var color: String?
    var pdfPosition: GammaHighlightPosition?
    var folder: String?
    var category: String?
    var audioRevision: Int?
    var audioState: String?
    var segments: [GammaAudioSegment]?
    var duration: Double?
    var replayEvents: [GammaReplayEvent]?
    enum CodingKeys: String, CodingKey {
        case type, quote, color, folder, category, segments, duration
        case audioRevision = "audio_revision", audioState = "audio_state", replayEvents = "replay_events"
        case highlightID = "highlight_id", pdfPosition = "pdf_position"
        case nativeNote = "native_note", noteRevision = "note_revision"
        case revision = "ink_revision"
        case docID = "doc_id", pdfPage = "pdf_page", inkAsset = "ink_asset"
        case previewAsset = "preview_asset", clientMutationID = "client_mutation_id"
    }
}

struct GammaBlock: Codable, Identifiable, Equatable {
    var id: String
    var parentID: String?
    var content: String
    var properties: GammaProperties
    var children: [GammaBlock]?
    var updatedAt: String?
    enum CodingKeys: String, CodingKey {
        case id, content, properties, children
        case parentID = "parent_id", updatedAt = "updated_at"
    }
    var folders: [String] { (properties.folder ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    var flattened: [GammaBlock] { [self] + (children ?? []).flatMap(\.flattened) }
    var isInk: Bool { properties.type == "pdf_ink" }
    var isAudio: Bool { properties.type == "audio" }
    var isHighlight: Bool { properties.highlightID != nil && properties.pdfPosition != nil }
    var pdfPage: Int? { properties.pdfPage ?? properties.pdfPosition?.pageNumber ?? properties.pdfPosition?.boundingRect?.pageNumber }
}
typealias GammaPaper = GammaBlock

/// One authenticated session spans the library and all readers. Secrets are never
/// written to disk; relaunch requires login (only server and username are remembered).
final class GammaAPI: NSObject, URLSessionTaskDelegate {
    let baseURL: URL
    private var session: URLSession!
    private(set) var authenticatedUsername: String?
    init(server: String, configuration: URLSessionConfiguration? = nil) throws {
        guard let url = URL(string: server.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            throw APIError.message("Enter an HTTPS Gamma server URL without credentials, query, or fragment.")
        }
        baseURL = url
        super.init()
        let config = configuration ?? URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 60
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }
    func close() { session.invalidateAndCancel() }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, url.scheme == baseURL.scheme, url.host == baseURL.host,
              url.port == baseURL.port else { completionHandler(nil); return }
        completionHandler(request)
    }
    @discardableResult
    func login(username: String, password: String) async throws -> String {
        struct Login: Decodable { let username: String }
        let data = try await json("api/login", method: "POST", body: ["username": username, "password": password])
        let actual = try JSONDecoder().decode(Login.self, from: data).username
        authenticatedUsername = actual
        return actual
    }
    func logout() async { _ = try? await json("api/logout", method: "POST", body: [:]) }
    func papers() async throws -> [GammaPaper] {
        struct Children: Decodable { let children: [GammaBlock] }
        return try JSONDecoder().decode(Children.self, from: await get("api/blocks/root/children")).children.filter {
            !($0.properties.docID ?? "").isEmpty
        }
    }
    func subtree(_ id: String) async throws -> GammaBlock {
        struct Tree: Decodable { let block: GammaBlock }
        return try JSONDecoder().decode(Tree.self, from: await get("api/blocks/\(component(id))/subtree")).block
    }
    func updateContent(id: String, content: String) async throws {
        _ = try await json("api/blocks/\(component(id))", method: "PUT", body: ["content": content])
    }
    func putNote(id: String, parent: String, content: String, revision: Int) async throws -> GammaBlock {
        let data = try await json("api/blocks/\(component(id))/note", method: "PUT", body: [
            "parent_id": parent, "content": content, "expected_revision": revision])
        return try JSONDecoder().decode(GammaBlock.self, from: data)
    }
    func putInk(id: String, body: [String: Any]) async throws -> GammaBlock {
        let data = try await json("api/blocks/\(component(id))/ink", method: "PUT", body: body)
        return try JSONDecoder().decode(GammaBlock.self, from: data)
    }
    func putAudio(id: String, parent: String, revision: Int, state: String, segments: [GammaAudioSegment], replayEvents: [GammaReplayEvent]? = nil) async throws -> GammaBlock {
        let values: [[String: Any]] = try segments.map { segment in
            guard let asset = segment.asset else { throw APIError.message("Audio segment must be uploaded before saving its block.") }
            return ["id": segment.id, "asset": asset, "duration": segment.duration]
        }
        var body: [String: Any] = ["parent_id": parent, "expected_revision": revision, "audio_state": state, "segments": values]
        if let replayEvents {
            body["replay_events"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(replayEvents))
        }
        let data = try await json("api/blocks/\(component(id))/audio", method: "PUT", body: body)
        return try JSONDecoder().decode(GammaBlock.self, from: data)
    }
    func upload(data: Data, fileExtension ext: String, mime: String) async throws -> String {
        let boundary = "Gamma-\(UUID().uuidString)"
        var request = makeRequest("api/assets")
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"drawing.\(ext)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8)
        body.append(data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        request.httpBody = body
        let (result, response) = try await session.data(for: request)
        try validate(response)
        struct Asset: Decodable { let url: String }
        return try JSONDecoder().decode(Asset.self, from: result).url
    }
    func asset(_ name: String) async throws -> Data {
        let prefix = "/api/assets/"
        guard name.hasPrefix(prefix) else { throw APIError.message("Unsupported Gamma asset reference.") }
        return try await get("api/assets/\(component(String(name.dropFirst(prefix.count))))")
    }
    /// Original source only. Never writes drawing data into the PDF.
    func download(_ paper: GammaPaper) async throws -> URL {
        guard let id = paper.properties.docID, !id.isEmpty else { throw APIError.message("Missing Gamma document identity.") }
        let (url, response) = try await session.download(for: makeRequest("api/uploads/\(component(id)).pdf"))
        do { try validate(response) } catch { try? FileManager.default.removeItem(at: url); throw error }
        return url
    }
    private func component(_ value: String) throws -> String {
        guard !value.isEmpty, value != ".", value != "..",
              value.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) || "-_ .".contains(Character(String($0))) }),
              !value.contains(" ") else { throw APIError.message("Invalid Gamma identifier.") }
        return value
    }
    private func endpoint(_ path: String) -> URL { baseURL.appendingPathComponent(path) }
    func makeRequest(_ path: String) -> URLRequest {
        var request = URLRequest(url: endpoint(path))
        if !["api/login", "api/session", "api/logout"].contains(path), let authenticatedUsername {
            request.setValue(authenticatedUsername, forHTTPHeaderField: "X-Gamma-User")
        }
        return request
    }
    private func get(_ path: String) async throws -> Data {
        let (data, response) = try await session.data(for: makeRequest(path)); try validate(response); return data
    }
    private func json(_ path: String, method: String, body: [String: Any]) async throws -> Data {
        var request = makeRequest(path); request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request); try validate(response); return data
    }
    func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.message("Invalid server response.") }
        if http.statusCode == 409, http.value(forHTTPHeaderField: "X-Gamma-Session-User") != nil {
            throw APIError.message("Gamma session account changed. Sign in again to the original account; pending changes remain isolated and were not uploaded.")
        }
        switch http.statusCode {
        case 200..<300: return
        case 409: throw APIError.conflict
        case 405, 501: throw APIError.serverUpgradeRequired(http.url?.path ?? "/api")
        case 401, 403: throw APIError.message("Session expired or access denied. Your pending changes are preserved; sign in again.")
        case 404: throw APIError.message("Not found on Gamma. Cached originals and pending changes are preserved.")
        default: throw APIError.message("Gamma returned HTTP \(http.statusCode). Pending changes will retry.")
        }
    }
    enum APIError: LocalizedError {
        case message(String), conflict, serverUpgradeRequired(String)
        var errorDescription: String? {
            switch self { case .message(let text): return text
            case .conflict: return "Revision conflict. Local handwriting is preserved. Resolve before uploading again."
            case .serverUpgradeRequired(let path): return "Gamma server needs an update: \(path) is unavailable. Changes are saved on this iPad. Automatic sync is paused; retry after updating the server." }
        }
    }
}
