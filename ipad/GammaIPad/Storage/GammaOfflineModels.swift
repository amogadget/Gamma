import Foundation

struct GammaOfflineEntry: Codable, Equatable, Identifiable {
    enum State: String, Codable { case queued, downloading, ready, failed, cancelled }
    var pageID: String
    var paper: GammaPaper
    /// The workspace this manifest row was queued in. Optional so a manifest
    /// written before workspaces existed still decodes; `GammaCache` re-asserts
    /// the directory's workspace on every read and stamps it on every write.
    var workspace: String? = nil
    var state: State = .queued
    var pdfReady: Bool = false
    var snapshotReady: Bool = false
    var audioReady: Bool = false
    var error: String?
    var id: String { pageID }
}

/// The non-secret metadata that lets the sign-in screen list local caches without
/// a server session. It names all three coordinates of a cache directory —
/// server, account AND workspace — because the workspace is what decides which
/// library a queued change may be sent to.
struct GammaOfflineIdentity: Codable, Equatable, Identifiable {
    var server: String
    var username: String
    /// Workspace id. `""` marks a cache written before workspaces existed: it is
    /// listed, but never opened or synced until a verified sign-in attaches it to
    /// the account's default workspace (see `GammaCache.migrateLegacyCache`).
    var workspace: String = ""
    /// Display name captured at sign-in, so the offline list can name the library
    /// without a network round trip. Non-secret, like the username.
    var workspaceName: String = ""
    var isLegacy: Bool { workspace.isEmpty }
    var id: String {
        isLegacy ? GammaCache.legacyDirectoryKey(server: server, username: username)
                 : GammaCache.directoryKey(server: server, username: username, workspace: workspace)
    }
    init(server: String, username: String, workspace: String = "", workspaceName: String = "") {
        self.server = server; self.username = username
        self.workspace = workspace; self.workspaceName = workspaceName
    }
    /// A pre-workspace `identity.json` has no `workspace` key at all; decoding it
    /// as the empty id keeps the directory discoverable instead of discarding it.
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        server = try values.decode(String.self, forKey: .server)
        username = try values.decode(String.self, forKey: .username)
        workspace = try values.decodeIfPresent(String.self, forKey: .workspace) ?? ""
        workspaceName = try values.decodeIfPresent(String.self, forKey: .workspaceName) ?? ""
    }
    /// What the sign-in screen shows: the library, then the account that owns it.
    var displayName: String {
        let library = workspaceName.isEmpty ? (isLegacy ? "Workspace unknown" : workspace) : workspaceName
        return "\(library) · \(username)"
    }
}

struct GammaOfflineDiskUsage: Equatable {
    var bytes: Int64
    var fileCount: Int
}

struct GammaOfflineRemoval: Equatable {
    var pdfRemoved: Bool
    var audioFilesRemoved: Int
    var protected: Bool
    var reason: String?
}
