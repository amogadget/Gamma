import Foundation

struct GammaProperties: Codable, Equatable {
    var type: String?
    var docID: String?
    var pdfPage: Int?
    var inkAsset: String?
    /// Browser gamma-ink source, independent of native PencilKit ink_asset.
    var inkURL: String?
    var previewAsset: String?
    var replayAsset: String?
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
        case inkURL = "ink_url"
        case audioRevision = "audio_revision", audioState = "audio_state", replayEvents = "replay_events"
        case highlightID = "highlight_id", pdfPosition = "pdf_position"
        case nativeNote = "native_note", noteRevision = "note_revision"
        case revision = "ink_revision"
        case docID = "doc_id", pdfPage = "pdf_page", inkAsset = "ink_asset"
        case previewAsset = "preview_asset", replayAsset = "replay_asset", clientMutationID = "client_mutation_id"
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
    /// Any ink_url, including an empty draft or malformed mixed representation,
    /// excludes the block from native editing and native replay/outbox hydration.
    var isInk: Bool { properties.type == "pdf_ink" && !isTimInk }
    var isTimInk: Bool { properties.inkURL != nil }
    var isAudio: Bool { properties.type == "audio" }
    var isHighlight: Bool { properties.highlightID != nil && properties.pdfPosition != nil }
    var pdfPage: Int? { properties.pdfPage ?? properties.pdfPosition?.pageNumber ?? properties.pdfPosition?.boundingRect?.pageNumber }
}
typealias GammaPaper = GammaBlock

/// One workspace this account can open, as `/api/session` reports it
/// (`backend/gamma/workspaces.py::list_for_user`). Only the fields a native
/// client needs are decoded; unknown keys are ignored.
struct GammaWorkspaceOption: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var role: String
    var personal: Bool
    var isDefault: Bool
    enum CodingKeys: String, CodingKey {
        case id, name, role, personal
        case isDefault = "default"
    }
    init(id: String, name: String, role: String, personal: Bool = false, isDefault: Bool = false) {
        self.id = id; self.name = name; self.role = role; self.personal = personal; self.isDefault = isDefault
    }
    /// The role and the default flag decide whether a write may be aimed here, so a
    /// missing key is read as "not writable, not default" rather than guessed. An
    /// entry without an `id` cannot be used safely at all, so decoding it fails and
    /// the caller sees a session it cannot trust instead of a half-known library.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? ""
        role = try values.decodeIfPresent(String.self, forKey: .role) ?? ""
        personal = try values.decodeIfPresent(Bool.self, forKey: .personal) ?? false
        isDefault = try values.decodeIfPresent(Bool.self, forKey: .isDefault) ?? false
    }
    /// Server roles are owner / editor / viewer; only the first two may write,
    /// exactly what `require_ws(request, write=True)` enforces.
    var canWrite: Bool { role == "owner" || role == "editor" }
}

/// What `/api/session` answers: identity plus every workspace this account may
/// open and the account's default one — enough to pick a library without a
/// second round trip (`backend/gamma/routers/auth.py::get_session`).
struct GammaSessionInfo: Decodable, Equatable, Sendable {
    var user: String?
    var isGuest: Bool
    var isAdmin: Bool
    var defaultWorkspace: String
    var workspaces: [GammaWorkspaceOption]
    enum CodingKeys: String, CodingKey {
        case user, workspaces
        case isGuest = "is_guest", isAdmin = "is_admin", defaultWorkspace = "default_workspace"
    }
    init(user: String?, isGuest: Bool, isAdmin: Bool, defaultWorkspace: String, workspaces: [GammaWorkspaceOption]) {
        self.user = user; self.isGuest = isGuest; self.isAdmin = isAdmin
        self.defaultWorkspace = defaultWorkspace; self.workspaces = workspaces
    }
    /// A signed-out session answers `{"user": null}` and nothing else, so every
    /// other field is optional. An unknown key is ignored; nothing here is assumed.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        user = try values.decodeIfPresent(String.self, forKey: .user)
        isGuest = try values.decodeIfPresent(Bool.self, forKey: .isGuest) ?? false
        isAdmin = try values.decodeIfPresent(Bool.self, forKey: .isAdmin) ?? false
        defaultWorkspace = try values.decodeIfPresent(String.self, forKey: .defaultWorkspace) ?? ""
        workspaces = try values.decodeIfPresent([GammaWorkspaceOption].self, forKey: .workspaces) ?? []
    }
    /// The server-verified default workspace, but only when the session actually
    /// lists it: a legacy cache is migrated exclusively to this.
    var verifiedDefaultWorkspace: String? {
        workspaces.contains(where: { $0.id == defaultWorkspace }) ? defaultWorkspace : nil
    }
    func option(_ id: String) -> GammaWorkspaceOption? { workspaces.first { $0.id == id } }
}

/// One authenticated session spans the library and all readers. Verified session
/// cookies are persisted by GammaSessionStore in the device-only Keychain; this
/// client's cookie jar is ephemeral and never shares another client's cookies.
///
/// The workspace is part of the client's identity, not a request option. A new
/// client starts *unbound* (usable only for `api/login`, `api/session`,
/// `api/logout`) and is bound once, to the workspace `/api/session` reports; every
/// later request carries it as `X-Gamma-Workspace`, which upstream resolves in
/// `auth.require_ws` / `require_ws_writer`. A queued or in-flight write therefore
/// cannot be retargeted at another library — reaching a different one means
/// building a new client.
final class GammaAPI: NSObject, URLSessionTaskDelegate {
    let baseURL: URL
    private(set) var localServerAccess: GammaLocalServerAccess?
    /// Stable identity for cache construction AND workspace/cache binding checks.
    /// The transport's ephemeral local port must never key a durable outbox.
    var cacheServerIdentity: String {
        (localServerAccess?.cacheIdentity ?? baseURL.absoluteString)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
    var cacheIdentity: String { cacheServerIdentity }
    /// The workspace this client speaks for. `""` is the short-lived *unbound*
    /// state used only to log in and read `/api/session`; see `bind(workspace:)`.
    private(set) var workspace: String
    /// Endpoints that legitimately inspect or change the session: the frontend's
    /// fetch wrapper skips the identity headers for exactly these, and so do we.
    private static let sessionPaths = ["api/login", "api/session", "api/logout"]
    private var session: URLSession!
    private(set) var authenticatedUsername: String?
    /// A client that may only log in and read the session: no workspace is known
    /// until `/api/session` names one, and an unbound client cannot reach data.
    convenience init(server: String, configuration: URLSessionConfiguration? = nil) throws {
        try self.init(server: server, workspace: "", configuration: configuration)
    }
    init(server: String, workspace: String, configuration: URLSessionConfiguration? = nil) throws {
        guard let url = URL(string: server.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            throw APIError.message("Enter an HTTPS Gamma server URL without credentials, query, or fragment.")
        }
        let rawWorkspace = workspace
        let workspace = rawWorkspace.trimmingCharacters(in: .whitespacesAndNewlines)
        // `""` is the deliberate unbound state (login/session only). A caller that
        // passed only whitespace is not asking for that — it is asking for a
        // workspace it failed to name — so it is refused instead of being silently
        // downgraded to a client that cannot reach any library.
        guard (workspace.isEmpty || Self.isValidWorkspace(workspace)), workspace == rawWorkspace else {
            throw APIError.message("That Gamma workspace identifier is not valid.")
        }
        baseURL = url
        self.workspace = workspace
        super.init()
        let config = (configuration?.copy() as? URLSessionConfiguration) ?? URLSessionConfiguration.ephemeral
        if configuration == nil { config.timeoutIntervalForRequest = 15 }
        config.urlCache = nil
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }
    /// Only the trusted host can supply local authority. No remote initializer
    /// accepts HTTP, and no local credentials are exported to session persistence.
    init(localServer access: GammaLocalServerAccess, configuration: URLSessionConfiguration? = nil) {
        baseURL = access.baseURL
        workspace = access.workspace
        localServerAccess = access
        authenticatedUsername = access.account
        super.init()
        let config = (configuration?.copy() as? URLSessionConfiguration) ?? .ephemeral
        config.urlCache = nil
        // Cookies are applied explicitly per request: Foundation cookies do not
        // have reliable port isolation, and must never enter a shared cookie jar.
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }
    /// Exactly the server's own rule for the id that names `workspaces/<id>/`
    /// (`backend/gamma/db.py`: `_WS_ID_RE = ^[A-Za-z0-9_-]{1,64}$`), because this
    /// value is worn as the `X-Gamma-Workspace` header. A stricter charset than
    /// "no newlines" is what makes whitespace, NULs and header injection
    /// impossible rather than merely unlikely.
    static func isValidWorkspace(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 64 && value.unicodeScalars.allSatisfy(workspaceCharacters.contains)
    }
    private static let workspaceCharacters = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    /// Attaches this client to one workspace — once. Every later request names
    /// that workspace, so a queued or in-flight write can never be retargeted at
    /// another library: reaching a different one means building a new client.
    func bind(workspace: String) throws {
        let workspace = workspace.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.isValidWorkspace(workspace) else {
            throw APIError.message("A Gamma workspace must be selected before the library can be opened.")
        }
        guard self.workspace.isEmpty else {
            throw APIError.message("This session is already bound to its workspace; open the library again to switch.")
        }
        self.workspace = workspace
    }
    func close() { session.invalidateAndCancel() }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        guard let url = request.url, url.scheme == baseURL.scheme, url.host == baseURL.host,
              url.port == baseURL.port else { completionHandler(nil); return }
        guard url.user == nil, url.password == nil else { completionHandler(nil); return }
        if let access = localServerAccess { completionHandler(access.authorize(request)) }
        else { completionHandler(request) }
    }
    @discardableResult
    func login(username: String, password: String) async throws -> String {
        struct Login: Decodable { let username: String }
        let data = try await json("api/login", method: "POST", body: ["username": username, "password": password])
        let actual = try JSONDecoder().decode(Login.self, from: data).username
        authenticatedUsername = actual
        return actual
    }
    func sessionCookies() -> [HTTPCookie] {
        guard localServerAccess == nil else { return [] }
        return (session.configuration.httpCookieStorage?.cookies(for: baseURL.appendingPathComponent("api/session")) ?? [])
            .filter { $0.name == "session" }
    }
    /// Restoring cookies grants no workspace access; /api/session must validate first.
    func installSessionCookies(_ cookies: [HTTPCookie]) {
        guard localServerAccess == nil, let host = baseURL.host?.lowercased() else { return }
        let storage = session.configuration.httpCookieStorage
        for old in storage?.cookies ?? [] { storage?.deleteCookie(old) }
        for cookie in cookies where cookie.name == "session" {
            let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
            guard host == domain, cookie.expiresDate.map({ $0 > Date() }) ?? true else { continue }
            storage?.setCookie(cookie)
        }
    }
    func clearSessionCookies() {
        let storage = session.configuration.httpCookieStorage
        for cookie in storage?.cookies ?? [] { storage?.deleteCookie(cookie) }
        authenticatedUsername = nil
    }
    /// Who the session cookie actually belongs to, plus every workspace it may
    /// open. Identity comes from the cookie, never from a bridge message.
    func session() async throws -> GammaSessionInfo {
        let info = try JSONDecoder().decode(GammaSessionInfo.self, from: await get("api/session"))
        if let access = localServerAccess {
            guard info.user == access.account, info.option(access.workspace) != nil else { throw APIError.accountChanged }
        }
        authenticatedUsername = info.user
        return info
    }
    func adoptWebSession(cookies: [HTTPCookie]) async throws -> GammaSessionInfo {
        installSessionCookies(cookies)
        let info = try await session()
        guard let user = info.user, !user.isEmpty else { throw APIError.message("Sign in to Gamma before opening the native reader.") }
        return info
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
    func createHighlight(id: String, parent: String, selection: GammaSelectedText, color: String) async throws -> GammaBlock {
        let position = try JSONSerialization.jsonObject(with: JSONEncoder().encode(selection.position))
        let data = try await json("api/blocks/\(component(id))/highlight", method: "PUT", body: [
            "parent_id": parent, "quote": selection.quote, "color": color, "pdf_position": position])
        return try JSONDecoder().decode(GammaBlock.self, from: data)
    }
    func setReplayPreview(id: String, inkAsset: String, replayAsset: String) async throws -> GammaBlock {
        let data = try await json("api/blocks/\(component(id))/replay-preview", method: "PUT",
                                  body: ["ink_asset": inkAsset, "replay_asset": replayAsset])
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
        var request = try makeRequest("api/assets")
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
        let path = "api/assets/\(try component(String(name.dropFirst(prefix.count))))"
        let (data, response) = try await getRaw(path)
        // A Gamma server without the native routes answers an unknown `GET /api/...`
        // with the SPA's index.html and HTTP 200, because the static catch-all is
        // registered last. Caching that as a drawing would look like corruption, so
        // it is reported as what it is: a server that needs the native routes.
        let type = ((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        if type.contains("text/html") || type.contains("application/xhtml") || Self.looksLikeHTML(data) {
            throw APIError.serverUpgradeRequired((response.url?.path) ?? "/api/assets")
        }
        return data
    }
    /// Only upstream's canonical content-addressed upload route is accepted.
    /// No absolute URLs, query overrides, traversal, or native asset routes.
    static func timInkPath(_ reference: String) throws -> String {
        let prefix = "/api/uploads/", suffix = ".ink"
        guard reference.hasPrefix(prefix), reference.hasSuffix(suffix) else {
            throw APIError.message("Unsupported Gamma handwriting reference.")
        }
        let hash = reference.dropFirst(prefix.count).dropLast(suffix.count)
        guard hash.count == 24, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }) else {
            throw APIError.message("Invalid Gamma handwriting upload hash.")
        }
        return String(reference.dropFirst())
    }
    func timInk(_ reference: String) async throws -> Data {
        let (data, response) = try await getRaw(Self.timInkPath(reference))
        let type = ((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? "").lowercased()
        guard !type.contains("text/html"), !type.contains("application/xhtml"), !Self.looksLikeHTML(data) else {
            throw APIError.message("Gamma returned a web page instead of handwriting. Retry after checking the server.")
        }
        return data
    }
    private static func looksLikeHTML(_ data: Data) -> Bool {
        // Only a short prefix matters, and asset payloads are binary or JSON.
        let head = String(decoding: data.prefix(64), as: UTF8.self).lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return head.hasPrefix("<!doctype html") || head.hasPrefix("<html") || head.hasPrefix("<head")
    }
    /// Original source only. Never writes drawing data into the PDF.
    func download(_ paper: GammaPaper) async throws -> URL {
        guard let id = paper.properties.docID, !id.isEmpty else { throw APIError.message("Missing Gamma document identity.") }
        let (url, response) = try await session.download(for: try makeRequest("api/uploads/\(component(id)).pdf"))
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
    /// Every non-session request names BOTH the account the tab believes it is and
    /// the workspace whose data it means to touch. Upstream's middleware refuses a
    /// mismatched `X-Gamma-User` with 409 instead of reading another account's data,
    /// and `require_ws` resolves `X-Gamma-Workspace` (else the account default) so an
    /// ambiguous request can never silently land in the wrong library. An unbound
    /// client therefore cannot make a workspace-scoped request at all.
    func makeRequest(_ path: String) throws -> URLRequest {
        var request = URLRequest(url: endpoint(path))
        if let access = localServerAccess {
            guard let authorized = access.authorize(request) else { throw APIError.message("Invalid local server destination.") }
            request = authorized
        }
        if Self.sessionPaths.contains(path) { return request }
        guard !workspace.isEmpty else { throw APIError.workspaceUnbound }
        if let authenticatedUsername { request.setValue(authenticatedUsername, forHTTPHeaderField: "X-Gamma-User") }
        request.setValue(workspace, forHTTPHeaderField: "X-Gamma-Workspace")
        return request
    }
    private func get(_ path: String) async throws -> Data {
        try await getRaw(path).0
    }
    private func getRaw(_ path: String) async throws -> (Data, URLResponse) {
        let (data, response) = try await session.data(for: try makeRequest(path))
        try validate(response)
        return (data, response)
    }
    private func json(_ path: String, method: String, body: [String: Any]) async throws -> Data {
        var request = try makeRequest(path); request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request); try validate(response); return data
    }
    func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.message("Invalid server response.") }
        if http.statusCode == 409, http.value(forHTTPHeaderField: "X-Gamma-Session-User") != nil {
            throw APIError.accountChanged
        }
        switch http.statusCode {
        case 200..<300: return
        case 409: throw APIError.conflict
        case 405, 501: throw APIError.serverUpgradeRequired(http.url?.path ?? "/api")
        case 401: throw APIError.unauthorized
        // A 403 is the workspace gate: no membership (`require_ws`) or a viewer
        // role on a write (`require_ws_writer`). Never retried blindly, because a
        // retry could only be aimed at a different library than the data belongs to.
        case 403: throw APIError.workspaceAccessDenied
        case 408, 429, 500, 502, 503, 504: throw APIError.temporarilyUnavailable
        case 404: throw APIError.message("Not found in this Gamma workspace. Cached originals and pending changes are preserved.")
        default: throw APIError.message("Gamma returned HTTP \(http.statusCode). Pending changes will retry.")
        }
    }
    enum APIError: LocalizedError {
        case message(String), conflict, serverUpgradeRequired(String), workspaceAccessDenied, workspaceUnbound, unauthorized, accountChanged, temporarilyUnavailable
        var errorDescription: String? {
            switch self { case .message(let text): return text
            case .unauthorized: return "Session expired. Sign in again; cached files and pending changes are preserved."
            case .accountChanged: return "Gamma session account changed. Sign in to the original account; local changes remain isolated."
            case .temporarilyUnavailable: return "Gamma is temporarily unavailable. Cached files and pending changes are preserved."
            case .conflict: return "Revision conflict. Local handwriting is preserved. Resolve before uploading again."
            case .workspaceAccessDenied: return "This account may no longer write in the selected workspace (membership or role changed). Nothing was uploaded. Sign in again and choose the workspace; local changes are preserved."
            case .workspaceUnbound: return "No Gamma workspace has been selected yet. Sign in so the app can verify which library to open."
            case .serverUpgradeRequired(let path): return "Gamma server needs an update: \(path) is unavailable. Changes are saved on this iPad. Automatic sync is paused; retry after updating the server." }
        }
    }
}
