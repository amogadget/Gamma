import Foundation

struct GammaOfflineEntry: Codable, Equatable, Identifiable {
    enum State: String, Codable { case queued, downloading, ready, failed, cancelled }
    var pageID: String
    var paper: GammaPaper
    var state: State = .queued
    var pdfReady: Bool = false
    var snapshotReady: Bool = false
    var audioReady: Bool = false
    var error: String?
    var id: String { pageID }
}

struct GammaOfflineIdentity: Codable, Equatable, Identifiable {
    var server: String
    var username: String
    var id: String { GammaCache.key(GammaCache.canonicalServer(server) + "\n" + username) }
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
