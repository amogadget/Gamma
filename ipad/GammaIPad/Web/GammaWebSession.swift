import Foundation

/// One Web session in the app: the server, the library it must open and the
/// cookies that make it that account's session. The workspace is part of the
/// session because the Web tab resolves `?ws=` once, at boot, and every request
/// it makes then carries `X-Gamma-Workspace` for that library.
struct GammaWebSession: Identifiable {
    let id: UUID
    let serverURL: URL
    let workspace: String
    let cookies: [HTTPCookie]
    let localServerAccess: GammaLocalServerAccess?

    init(id: UUID, serverURL: URL, workspace: String, cookies: [HTTPCookie],
         localServerAccess: GammaLocalServerAccess? = nil) {
        self.id = id; self.serverURL = serverURL; self.workspace = workspace
        self.cookies = cookies; self.localServerAccess = localServerAccess
    }

    /// The URL the Web view loads: the server root plus the library, so the
    /// frontend's own `chooseWorkspace` picks the SAME one the native side holds.
    var startURL: URL { Self.startURL(serverURL: serverURL, workspace: workspace) }

    static func startURL(serverURL: URL, workspace: String) -> URL {
        guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false) else { return serverURL }
        var items = components.queryItems ?? []
        items.removeAll { $0.name == "ws" }
        items.append(URLQueryItem(name: "ws", value: workspace))
        components.queryItems = items
        return components.url ?? serverURL
    }
}
