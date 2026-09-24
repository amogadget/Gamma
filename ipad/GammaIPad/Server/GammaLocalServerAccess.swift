import Foundation

/// Host-created, memory-only authority for one embedded backend lifetime. Never
/// decode this from a Web message, persist it, or expose credentials to JavaScript.
public struct GammaLocalServerAccess: CustomStringConvertible, CustomReflectable {
    public let baseURL: URL
    public let account: String
    public let workspace: String
    public let epoch: UUID
    /// Stable host-owned cache namespace, NOT the ephemeral transport origin.
    public let cacheIdentity: String
    let sessionCookie: HTTPCookie
    let capabilityCookie: HTTPCookie
    let capabilityHeader: String
    var cookies: [HTTPCookie] { [sessionCookie, capabilityCookie] }
    public var description: String { "<private local server access>" }
    public var customMirror: Mirror { Mirror(self, children: [:]) }

    /// Internal on purpose: only trusted native host bootstrap wiring calls this.
    init(trustedHostURL url: URL, account: String, workspace: String,
         sessionCookie: HTTPCookie, capabilityCookie: HTTPCookie,
         capabilityHeader: String = "X-Gamma-Local-Capability", cacheIdentity: String = "gamma-local://device") throws {
        let cacheIdentity = cacheIdentity.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let cacheURL = URL(string: cacheIdentity),
              cacheURL.host?.isEmpty == false, cacheURL.port == nil,
              cacheURL.user == nil, cacheURL.password == nil, cacheURL.query == nil, cacheURL.fragment == nil,
              cacheURL.scheme == "gamma-local" || (cacheURL.scheme == "http" && cacheURL.host == "127.0.0.1") else {
            throw InvalidBootstrap.invalid
        }
        guard url.scheme == "http", url.host == "127.0.0.1",
              let port = url.port, (1024...65535).contains(port),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              !account.isEmpty, account.utf8.count <= 512,
              !account.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              GammaAPI.isValidWorkspace(workspace), !cacheIdentity.isEmpty,
              capabilityHeader == "X-Gamma-Local-Capability",
              sessionCookie.name == "session", capabilityCookie.name != "session",
              capabilityCookie.value.count >= 32 else { throw InvalidBootstrap.invalid }
        for cookie in [sessionCookie, capabilityCookie] {
            guard cookie.domain == "127.0.0.1", cookie.path == "/", cookie.isHTTPOnly,
                  !cookie.isSecure, cookie.expiresDate == nil,
                  !cookie.name.isEmpty, !cookie.value.isEmpty,
                  cookie.name.utf8.allSatisfy({ (33...126).contains($0) && !"()<>@,;:\\\"/[]?={} ".utf8.contains($0) }),
                  cookie.value.utf8.allSatisfy({ (33...126).contains($0) && !"\";,\\".utf8.contains($0) })
            else { throw InvalidBootstrap.invalid }
        }
        self.baseURL = url; self.account = account; self.workspace = workspace
        self.sessionCookie = sessionCookie; self.capabilityCookie = capabilityCookie
        self.capabilityHeader = capabilityHeader; self.cacheIdentity = cacheIdentity
        self.epoch = UUID()
    }

    func permits(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == baseURL.port &&
        url.user == nil && url.password == nil
    }

    /// Safari receives only a URL, never this transport's request or cookie jar.
    /// Refuse loopback targets and any accidental credential-bearing URL.
    func permitsExternalBrowserURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil,
              host != "localhost", !host.hasSuffix(".localhost"),
              host != "127.0.0.1", !host.hasPrefix("127."),
              !host.contains(":"), host != "0.0.0.0",
              !host.allSatisfy({ $0.isNumber || $0 == "." }),
              url.absoluteString.utf8.count <= 16384 else { return false }
        var text = url.absoluteString
        for _ in 0..<8 {
            guard !text.contains(capabilityCookie.value), !text.contains(sessionCookie.value) else { return false }
            guard let decoded = text.removingPercentEncoding, decoded != text else { return true }
            text = decoded
        }
        return false
    }

    func authorize(_ request: URLRequest) -> URLRequest? {
        guard let url = request.url, permits(url) else { return nil }
        var request = request
        request.httpShouldHandleCookies = false
        request.setValue(capabilityCookie.value, forHTTPHeaderField: capabilityHeader)
        request.setValue(cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; "), forHTTPHeaderField: "Cookie")
        return request
    }

    enum InvalidBootstrap: Error { case invalid }
}
