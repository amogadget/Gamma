import Foundation
import CoreFoundation

/// Zero-based page and normalized top-left visible anchor in the displayed,
/// rotation-applied crop box. Geometry is advisory, never document identity.
public struct GammaReadingPosition: Equatable, Sendable {
    public let pageIndex: Int
    public let anchorX: Double
    public let anchorY: Double

    public init?(pageIndex: Int, anchorX: Double, anchorY: Double) {
        guard (0...999999).contains(pageIndex), anchorX.isFinite, anchorY.isFinite,
              (0...1).contains(anchorX), (0...1).contains(anchorY) else { return nil }
        self.pageIndex = pageIndex; self.anchorX = anchorX; self.anchorY = anchorY
    }

    public static func parse(_ value: Any) -> GammaReadingPosition? {
        guard let value = value as? [String: Any] else { return nil }
        func number(_ key: String) -> Double? {
            guard let n = value[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                  n.doubleValue.isFinite else { return nil }
            return n.doubleValue
        }
        guard let page = number("pageIndex"), (0...999999).contains(page), page.rounded() == page,
              let x = number("anchorX"), let y = number("anchorY") else { return nil }
        return GammaReadingPosition(pageIndex: Int(page), anchorX: x, anchorY: y)
    }
}

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
///
/// Field rules mirror `frontend/src/native/nativeBridge.js` exactly, so a payload
/// the Web side is willing to send is the payload the native side accepts — and
/// nothing else. `workspace` is validated like the other identifiers: the bridge
/// names a library, and the native side re-verifies that claim against the live
/// session before it opens anything.
public enum GammaWebMessageValidator {
    /// A bounded opaque identifier: non-empty, no control characters, and short
    /// enough that it cannot carry a second field. Deliberately stricter than the
    /// Web side's 200-character rule for the byte count.
    public static func bounded(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty, value.count <= 200, value.utf8.count <= 512,
              !value.unicodeScalars.contains(where: { $0 == "\0" || CharacterSet.newlines.contains($0) }) else { return nil }
        return value
    }

    public static func openPDF(from body: Any) -> GammaWebOpenRequest? {
        guard let body = body as? [String: Any], body["type"] as? String == "openPDF",
              let pageID = bounded(body["pageID"]), let docID = bounded(body["docID"]),
              let title = bounded(body["title"]), let user = bounded(body["user"]),
              let workspace = bounded(body["workspace"]) else { return nil }
        var viewport: GammaReadingPosition?
        if let raw = body["viewport"] {
            guard let parsed = GammaReadingPosition.parse(raw) else { return nil }
            viewport = parsed
        }
        return GammaWebOpenRequest(pageID: pageID, docID: docID, title: title, user: user, workspace: workspace, viewport: viewport)
    }
}

/// The claims a bridge handoff makes. Every one of them is re-checked against the
/// live session before a native workspace is opened: account and workspace come
/// from `/api/session` (the cookie), never from the message.
///
/// App-internal, unlike the payload validator above: it works with app types, and
/// only the wire shape the Web side sends needs to be `public`.
struct GammaWebHandoffCheck: Equatable, Sendable {
    enum Failure: Error, Equatable, Sendable, LocalizedError {
        case accountChanged
        case workspaceUnknown
        case workspaceReadOnly
        case pageIdentity
        var message: String {
            switch self {
            case .accountChanged: return "The Web account changed during handoff. Please try again."
            case .workspaceUnknown: return "The handoff named a Gamma workspace this session cannot open. Reload the Web page and try again."
            case .workspaceReadOnly: return "That Gamma workspace is read-only for this account; the native editor needs edit access."
            case .pageIdentity: return "Gamma document identity changed. Reload it before opening Pencil mode."
            }
        }
        var errorDescription: String? { message }
    }

    /// The workspace the handoff may open: it must be one the *verified* session
    /// lists AND one whose role permits writing, because every native save is a
    /// writer-role request (`require_ws_writer`).
    static func workspace(_ claimed: String, session: GammaSessionInfo) -> Result<GammaWorkspaceOption, Failure> {
        guard let option = session.option(claimed) else { return .failure(.workspaceUnknown) }
        guard option.canWrite else { return .failure(.workspaceReadOnly) }
        return .success(option)
    }

    /// The handoff may only name the account the cookie actually belongs to.
    static func account(_ claimed: String, session: GammaSessionInfo) -> Result<String, Failure> {
        guard let user = session.user, !user.isEmpty, user == claimed else { return .failure(.accountChanged) }
        return .success(user)
    }

    static func page(_ block: GammaBlock, pageID: String, docID: String) -> Result<GammaBlock, Failure> {
        guard block.id == pageID, block.parentID == "root", block.properties.docID == docID else {
            return .failure(.pageIdentity)
        }
        return .success(block)
    }
}
