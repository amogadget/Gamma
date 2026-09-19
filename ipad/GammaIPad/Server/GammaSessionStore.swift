import Foundation
import Security

/// One atomic record, written only after account AND writer-role verification.
/// No passwords, Apple credentials, or unrelated browser cookies are stored.
struct GammaSavedSession: Codable {
    let version: Int
    let server: String
    let username: String
    let workspace: String
    let workspaceName: String
    private let cookieData: Data

    init(server: URL, username: String, workspace: GammaWorkspaceOption, cookies: [HTTPCookie]) throws {
        guard !username.isEmpty, workspace.canWrite, GammaAPI.isValidWorkspace(workspace.id),
              let host = server.host?.lowercased() else { throw GammaAPI.APIError.workspaceAccessDenied }
        let values = cookies.filter {
            $0.name == "session" && !$0.value.isEmpty &&
            $0.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) == host &&
            ($0.expiresDate.map { $0 > Date() } ?? true)
        }
        guard !values.isEmpty else { throw GammaAPI.APIError.unauthorized }
        cookieData = try PropertyListSerialization.data(fromPropertyList: values.map { cookie in
            Dictionary(uniqueKeysWithValues: (cookie.properties ?? [:]).map { ($0.key.rawValue, $0.value) })
        }, format: .binary, options: 0)
        version = 1; self.server = GammaCache.canonicalServer(server); self.username = username
        self.workspace = workspace.id; workspaceName = workspace.name
    }
    func cookies() throws -> [HTTPCookie] {
        guard version == 1, !username.isEmpty, GammaAPI.isValidWorkspace(workspace),
              let values = try PropertyListSerialization.propertyList(from: cookieData, options: [], format: nil) as? [[String: Any]] else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return try values.map { value in
            guard let cookie = HTTPCookie(properties: Dictionary(uniqueKeysWithValues: value.map {
                (HTTPCookiePropertyKey($0.key), $0.value)
            })), cookie.name == "session" else { throw CocoaError(.fileReadCorruptFile) }
            return cookie
        }
    }
    func validate(_ info: GammaSessionInfo) throws -> GammaWorkspaceOption {
        guard let user = info.user, !user.isEmpty else { throw GammaAPI.APIError.unauthorized }
        guard user == username else { throw GammaAPI.APIError.accountChanged }
        guard let option = info.option(workspace), option.canWrite else { throw GammaAPI.APIError.workspaceAccessDenied }
        return option
    }
}

/// Injectable so tests never read or erase a developer's real Keychain.
protocol GammaSessionPersistence {
    func load() throws -> GammaSavedSession?
    func save(_ session: GammaSavedSession) throws
    func clear() throws
}

final class GammaKeychainSessionStore: GammaSessionPersistence {
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "GammaIPad.verified-session.v1",
         kSecAttrAccount as String: "current",
         kSecAttrSynchronizable as String: false]
    }
    func load() throws -> GammaSavedSession? {
        var query = query
        query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw StoreError.unavailable }
        return try JSONDecoder().decode(GammaSavedSession.self, from: data)
    }
    func save(_ session: GammaSavedSession) throws {
        let data = try JSONEncoder().encode(session)
        // Accessible after first unlock, including brief app background transitions;
        // never migrates to another device and never synchronizes via iCloud.
        let fields: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, fields as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(fields) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw StoreError.unavailable }
    }
    func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StoreError.unavailable }
    }
    enum StoreError: LocalizedError {
        case unavailable
        var errorDescription: String? { "Secure session storage is unavailable. Unlock this iPad and try again. No password was saved." }
    }
}
