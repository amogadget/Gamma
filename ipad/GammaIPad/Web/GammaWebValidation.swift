import Foundation

/// Origin and deployment-prefix checks shared by navigation and the native bridge.
public struct GammaWebOrigin: Equatable, Sendable {
    public let scheme: String
    public let host: String
    public let port: Int
    public let deploymentPath: String

    public init(url: URL) {
        scheme = url.scheme?.lowercased() ?? ""
        host = url.host?.lowercased() ?? ""
        port = url.port ?? GammaWebOrigin.defaultPort(for: scheme)
        let path = url.path.isEmpty ? "/" : url.path
        deploymentPath = path.hasSuffix("/") ? path : path + "/"
    }

    public func isValidURL(_ url: URL) -> Bool {
        guard scheme == "https", !host.isEmpty,
              url.scheme?.lowercased() == scheme, url.host?.lowercased() == host,
              (url.port ?? Self.defaultPort(for: url.scheme?.lowercased() ?? "")) == port,
              url.user == nil, url.password == nil else { return false }
        let path = url.path.isEmpty ? "/" : url.path
        guard !path.split(separator: "/").contains(where: { $0 == ".." || $0 == "." }) else { return false }
        return path == String(deploymentPath.dropLast()) || path.hasPrefix(deploymentPath)
    }

    public static func defaultPort(for scheme: String) -> Int {
        scheme == "https" ? 443 : scheme == "http" ? 80 : -1
    }
}

/// Pure bridge-payload validation, kept separate so it can be unit tested without WebKit.
public enum GammaWebMessageValidator {
    public static func openPDF(from body: Any) -> GammaWebOpenRequest? {
        guard let body = body as? [String: Any], body["type"] as? String == "openPDF",
              let pageID = bounded(body["pageID"]), let docID = bounded(body["docID"]),
              let title = bounded(body["title"]), let user = bounded(body["user"]) else { return nil }
        return GammaWebOpenRequest(pageID: pageID, docID: docID, title: title, user: user)
    }

    private static func bounded(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty, value.utf8.count <= 512,
              !value.unicodeScalars.contains(where: { $0 == "\0" || CharacterSet.newlines.contains($0) }) else { return nil }
        return value
    }
}
