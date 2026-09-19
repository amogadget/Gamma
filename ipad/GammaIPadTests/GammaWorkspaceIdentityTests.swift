import XCTest
import Foundation
import PencilKit
@testable import GammaIPad

/// Workspace identity is the safety property this suite exists for: every request,
/// snapshot, manifest and queued change must name ONE library, and nothing may be
/// rebound, migrated or uploaded into another.
///
/// The stub answers the routes the client needs and records every request, so a
/// test can assert what was — and was not — sent.
private final class IdentityURLProtocol: URLProtocol {
    static let defaultSessionBody = """
    {"user":"alice","is_guest":false,"is_admin":false,"default_workspace":"ws-personal",
     "workspaces":[
       {"id":"ws-personal","name":"Personal","kind":"personal","role":"owner","personal":true,"default":true},
       {"id":"ws-shared","name":"Team","kind":"shared","role":"editor","personal":false,"default":false},
       {"id":"ws-readonly","name":"Read only","kind":"shared","role":"viewer","personal":false,"default":false}]}
    """
    static var requests: [URLRequest] = []
    static var sessionBody = IdentityURLProtocol.defaultSessionBody
    static func reset() {
        requests = []
        sessionBody = IdentityURLProtocol.defaultSessionBody
    }

    static func paths() -> [String] { requests.map { $0.url?.path ?? "" } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let path = request.url?.path ?? ""
        let body: String
        if path.hasSuffix("/login") {
            body = #"{"ok":true,"username":"alice"}"#
        } else if path.hasSuffix("/session") {
            body = Self.sessionBody
        } else if path.hasSuffix("/children") {
            body = #"{"children":[]}"#
        } else if path.hasSuffix("/subtree") {
            body = #"{"block":{"id":"page-1","parent_id":"root","content":"Paper","properties":{"doc_id":"doc-1"}}}"#
        } else if path.contains("/blocks/") {
            // The native writers answer with the saved block, as the server does.
            let id = request.url!.deletingLastPathComponent().lastPathComponent
            body = "{\"id\":\"\(id)\",\"parent_id\":\"page-1\",\"content\":\"edited\",\"properties\":{\"native_note\":true,\"note_revision\":2,\"type\":\"pdf_ink\",\"pdf_page\":1,\"ink_revision\":1,\"audio_revision\":1,\"audio_state\":\"stopped\"}}"
        } else {
            body = "{}"
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class GammaWorkspaceIdentityTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        IdentityURLProtocol.reset()
    }
    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        IdentityURLProtocol.reset()
    }

    private func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [IdentityURLProtocol.self]
        return configuration
    }
    private func serverURL() -> URL { URL(string: "https://gamma.example")! }
    private func signedInAPI(workspace: String = "") async throws -> GammaAPI {
        let api = workspace.isEmpty
            ? try GammaAPI(server: "https://gamma.example", configuration: configuration())
            : try GammaAPI(server: "https://gamma.example", workspace: workspace, configuration: configuration())
        _ = try await api.login(username: "alice", password: "fake")
        return api
    }
    private func cache(workspace: String = "ws-personal", username: String = "alice") throws -> GammaCache {
        try GammaCache(rootURL: root, server: serverURL(), username: username, workspace: workspace)
    }

    // MARK: - The request identity

    func testUnboundClientCanLogInAndReadSessionButCannotReachWorkspaceData() async throws {
        let api = try await signedInAPI()
        defer { api.close() }
        XCTAssertEqual(api.workspace, "")
        XCTAssertNoThrow(try api.makeRequest("api/session"))
        XCTAssertNoThrow(try api.makeRequest("api/login"))
        for path in ["api/blocks/root/children", "api/blocks/root/subtree", "api/assets/x.pkdrawing", "api/uploads/x.pdf"] {
            XCTAssertThrowsError(try api.makeRequest(path), path) { error in
                guard case GammaAPI.APIError.workspaceUnbound = error else {
                    return XCTFail("\(path) must be refused until a workspace is chosen")
                }
            }
        }
        // The session itself answers with the workspaces, so binding is possible.
        let info = try await api.session()
        XCTAssertEqual(info.workspaces.map(\.id), ["ws-personal", "ws-shared", "ws-readonly"])
        XCTAssertEqual(info.workspaces.filter(\.canWrite).map(\.id), ["ws-personal", "ws-shared"])
        XCTAssertEqual(info.verifiedDefaultWorkspace, "ws-personal")
        try api.bind(workspace: "ws-personal")
        XCTAssertEqual(try api.makeRequest("api/blocks/root/children").value(forHTTPHeaderField: "X-Gamma-Workspace"),
                       "ws-personal")
        XCTAssertEqual(try api.makeRequest("api/blocks/root/children").value(forHTTPHeaderField: "X-Gamma-User"), "alice")
    }

    func testWorkspaceBindsOnceAndNeverRebinds() async throws {
        let api = try await signedInAPI(workspace: "ws-shared")
        defer { api.close() }
        XCTAssertEqual(api.workspace, "ws-shared")
        XCTAssertThrowsError(try api.bind(workspace: "ws-personal"))
        XCTAssertEqual(api.workspace, "ws-shared", "a refused rebind must not change the client")
    }

    func testUnboundLibraryReadIsRefusedBeforeAnyRequest() async throws {
        let unbound = try await signedInAPI()
        defer { unbound.close() }
        for path in ["api/blocks/root/children", "api/blocks/page-1/subtree", "api/blocks/page-1/ink"] {
            XCTAssertThrowsError(try unbound.makeRequest(path), path) { error in
                guard case GammaAPI.APIError.workspaceUnbound = error else {
                    return XCTFail("Unexpected error for \(path): \(error)")
                }
            }
        }
        IdentityURLProtocol.reset()
        do {
            _ = try await unbound.papers()
            XCTFail("An unbound client must not read a library")
        } catch let error as GammaAPI.APIError {
            guard case .workspaceUnbound = error else { return XCTFail("Unexpected error: \(error)") }
        }
        XCTAssertTrue(IdentityURLProtocol.paths().isEmpty)
    }

    func testInvalidWorkspaceIdentifiersAreRefused() throws {
        // Whitespace or a malformed id must be REFUSED, never trimmed into the
        // unbound state: a caller that asked for a library and silently got a
        // client that cannot reach one is the bug this guards.
        for value in ["   ", "ws\nother", "ws\u{0}other", "ws other", "ws/personal",
                      "ws-personal ", String(repeating: "w", count: 65)] {
            XCTAssertThrowsError(try GammaAPI(server: "https://gamma.example", workspace: value), value)
            XCTAssertFalse(GammaAPI.isValidWorkspace(value), value)
        }
        // `""` is the deliberate unbound state — login/session only, no library.
        let unbound = try GammaAPI(server: "https://gamma.example", workspace: "")
        defer { unbound.close() }
        XCTAssertEqual(unbound.workspace, "")
        XCTAssertThrowsError(try unbound.makeRequest("api/blocks/root/children"))
        XCTAssertFalse(GammaAPI.isValidWorkspace(""))
        // Exactly the server's rule for the id that names workspaces/<id>/
        // (`backend/gamma/db.py`: ^[A-Za-z0-9_-]{1,64}$), so nothing looser passes.
        XCTAssertTrue(GammaAPI.isValidWorkspace("ws-personal"))
        XCTAssertTrue(GammaAPI.isValidWorkspace("AbC012_-"))
        XCTAssertTrue(GammaAPI.isValidWorkspace("dGhpc19pc19h"))
        XCTAssertTrue(GammaAPI.isValidWorkspace(String(repeating: "w", count: 64)))
    }

    func testSessionWithoutTheDefaultInTheListHasNoVerifiedDefault() async throws {
        IdentityURLProtocol.sessionBody = """
        {"user":"alice","default_workspace":"ws-ghost",
         "workspaces":[{"id":"ws-personal","name":"Personal","role":"owner","default":false}]}
        """
        let api = try await signedInAPI()
        defer { api.close() }
        let info = try await api.session()
        XCTAssertNil(info.verifiedDefaultWorkspace)
        XCTAssertFalse(info.workspaces[0].isDefault)
        XCTAssertEqual(info.workspaces[0].role, "owner")
    }

    // MARK: - Workspace selection

    func testChooseWorkspacePrefersRememberedThenVerifiedDefault() throws {
        let workspace = GammaWorkspace()
        let info = GammaSessionInfo(user: "alice", isGuest: false, isAdmin: false,
                                    defaultWorkspace: "ws-personal",
                                    workspaces: [GammaWorkspaceOption(id: "ws-personal", name: "Personal", role: "owner", isDefault: true),
                                                 GammaWorkspaceOption(id: "ws-shared", name: "Team", role: "editor")])
        XCTAssertEqual(try workspace.chooseWorkspace(info, server: "https://gamma.example", username: "alice",
                                                     reconnect: false, remembered: "ws-shared").id, "ws-shared")
        XCTAssertEqual(try workspace.chooseWorkspace(info, server: "https://gamma.example", username: "alice",
                                                     reconnect: false, remembered: nil).id, "ws-personal")
        XCTAssertEqual(try workspace.chooseWorkspace(info, server: "https://gamma.example", username: "alice",
                                                     reconnect: false, remembered: "ws-gone").id, "ws-personal")
    }

    func testReconnectNeverSilentlySwitchesToAnotherWorkspace() throws {
        let workspace = GammaWorkspace()
        let info = GammaSessionInfo(user: "alice", isGuest: false, isAdmin: false,
                                   defaultWorkspace: "ws-personal",
                                   workspaces: [GammaWorkspaceOption(id: "ws-personal", name: "Personal", role: "owner", isDefault: true),
                                                GammaWorkspaceOption(id: "ws-readonly", name: "Read only", role: "viewer")])
        XCTAssertThrowsError(try workspace.chooseWorkspace(info, server: "https://gamma.example", username: "alice",
                                                           reconnect: true, remembered: "ws-readonly")) { error in
            XCTAssertTrue((error as? LocalizedError)?.errorDescription?.contains("no longer writable") == true,
                          "\(error)")
        }
        XCTAssertThrowsError(try workspace.chooseWorkspace(info, server: "https://gamma.example", username: "alice",
                                                           reconnect: true, remembered: "ws-vanished"))
        XCTAssertEqual(try workspace.chooseWorkspace(info, server: "https://gamma.example", username: "alice",
                                                     reconnect: true, remembered: "ws-personal").id, "ws-personal")
    }

    func testAccountWithoutAWritableWorkspaceIsRefusedWithAnExplanation() {
        let workspace = GammaWorkspace()
        let info = GammaSessionInfo(user: "alice", isGuest: false, isAdmin: false, defaultWorkspace: "ws-readonly",
                                    workspaces: [GammaWorkspaceOption(id: "ws-readonly", name: "Read only", role: "viewer")])
        XCTAssertThrowsError(try workspace.chooseWorkspace(info, server: "https://gamma.example", username: "alice",
                                                           reconnect: false, remembered: nil)) { error in
            XCTAssertTrue((error as? LocalizedError)?.errorDescription?.contains("cannot write") == true, "\(error)")
        }
    }

    // MARK: - Cache identity

    func testCacheDirectoryIsScopedToServerAccountAndWorkspace() throws {
        let personal = try cache(workspace: "ws-personal")
        let shared = try cache(workspace: "ws-shared")
        XCTAssertNotEqual(personal.rootURL, shared.rootURL)
        XCTAssertNotEqual(personal.rootURL, try cache(username: "bob").rootURL)
        XCTAssertEqual(personal.rootURL.lastPathComponent,
                       GammaCache.directoryKey(server: "https://gamma.example", username: "alice", workspace: "ws-personal"))
        XCTAssertNotEqual(personal.rootURL.lastPathComponent,
                          GammaCache.legacyDirectoryKey(server: "https://gamma.example", username: "alice"))
        XCTAssertEqual(personal.workspace, "ws-personal")
        // A cache cannot exist without a workspace: that is the whole point.
        XCTAssertThrowsError(try GammaCache(rootURL: root, server: serverURL(), username: "alice", workspace: ""))
        XCTAssertThrowsError(try GammaCache(rootURL: root, server: serverURL(), username: "alice", workspace: "ws\nx"))
        XCTAssertThrowsError(try GammaCache(rootURL: root, server: serverURL(), username: "", workspace: "ws-personal"))
    }

    func testSnapshotAndManifestCarryTheirWorkspaceAndForeignFilesAreRefused() throws {
        let personal = try cache(workspace: "ws-personal")
        let shared = try cache(workspace: "ws-shared")
        let page = GammaPageCache(pageID: "page-1", docID: "doc-1", blocks: [
            GammaBlock(id: "page-1", parentID: "root", content: "Paper", properties: GammaProperties(docID: "doc-1"))
        ])
        try personal.savePage(page)
        let stored = try JSONDecoder().decode(GammaPageCache.self,
                                              from: Data(contentsOf: personal.rootURL.appendingPathComponent("page-\(GammaCache.key("page-1")).json")))
        XCTAssertEqual(stored.workspace, "ws-personal")

        // The same bytes copied into another library's directory must not be adopted.
        try FileManager.default.copyItem(at: personal.rootURL.appendingPathComponent("page-\(GammaCache.key("page-1")).json"),
                                         to: shared.rootURL.appendingPathComponent("page-\(GammaCache.key("page-1")).json"))
        XCTAssertThrowsError(try shared.loadPage(pageID: "page-1", docID: "doc-1"))
        XCTAssertThrowsError(try shared.pendingPages())

        // And an in-memory snapshot claiming another library cannot be written here.
        var foreign = GammaPageCache(pageID: "page-2", docID: "doc-2")
        foreign.workspace = "ws-personal"
        XCTAssertThrowsError(try shared.savePage(foreign))
        XCTAssertFalse(FileManager.default.fileExists(atPath: shared.rootURL.appendingPathComponent("page-\(GammaCache.key("page-2")).json").path))
    }

    func testOfflineManifestIsStampedAndRefusesAnotherWorkspace() throws {
        let shared = try cache(workspace: "ws-shared")
        let paper = GammaPaper(id: "page-1", parentID: nil, content: "Paper",
                               properties: GammaProperties(docID: "doc-1"), children: nil, updatedAt: nil)
        try shared.saveOfflineEntry(GammaOfflineEntry(pageID: "page-1", paper: paper))
        let stored = try JSONDecoder().decode([String: GammaOfflineEntry].self,
                                              from: Data(contentsOf: shared.rootURL.appendingPathComponent("offline.json")))
        XCTAssertEqual(stored["page-1"]?.workspace, "ws-shared")

        var foreign = GammaOfflineEntry(pageID: "page-2", paper: paper)
        foreign.workspace = "ws-personal"
        XCTAssertThrowsError(try shared.saveOfflineEntry(foreign))
        XCTAssertNil(try shared.loadOfflineEntry(pageID: "page-2"))
    }

    // MARK: - Legacy (pre-workspace) caches

    /// Writes the on-disk shape older builds produced: a `server + username`
    /// directory, an identity without a `workspace` key, and a pending outbox.
    @discardableResult
    private func seedLegacyCache(username: String = "alice", server: String = "https://gamma.example",
                                pending: Bool = true) throws -> URL {
        let directory = root.appendingPathComponent(GammaCache.legacyDirectoryKey(server: server, username: username),
                                                    isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(#"{"server":"\#(server)","username":"\#(username)"}"#.utf8)
            .write(to: directory.appendingPathComponent("identity.json"))
        try Data("pdf".utf8).write(to: directory.appendingPathComponent("source-\(GammaCache.key("doc-1")).pdf"))
        var page = GammaPageCache(pageID: "page-1", docID: "doc-1")
        if pending {
            page.outbox = [GammaMutation(kind: .content, blockID: "block-1", parentID: "page-1", content: "offline edit")]
        }
        try JSONEncoder().encode(page).write(to: directory.appendingPathComponent("page-\(GammaCache.key("page-1")).json"))
        return directory
    }

    func testStoredDisplayNameIsALabelNotIdentity() throws {
        let store = try cache(workspace: "ws-personal")
        // A cache always starts with no label: the initializer cannot know one.
        XCTAssertEqual(try store.accountIdentity()?.workspaceName, "")
        try store.updateWorkspaceName("Personal")
        XCTAssertEqual(try store.accountIdentity()?.workspaceName, "Personal")
        // The label can be re-read, and re-opening the same cache must not reject it
        // just because the new instance cannot know the label yet.
        let reopened = try cache(workspace: "ws-personal")
        XCTAssertEqual(try reopened.accountIdentity()?.workspaceName, "Personal")
        try reopened.updateWorkspaceName("Personal Library")
        XCTAssertEqual(try reopened.accountIdentity()?.workspaceName, "Personal Library")
        XCTAssertEqual(try reopened.accountIdentity()?.workspace, "ws-personal")
        XCTAssertEqual(try reopened.accountIdentity()?.username, "alice")
        // Opening yet again must neither reject the label nor erase it: the
        // initializer's own `ensureAccountIdentity` runs with no label at all.
        _ = try cache(workspace: "ws-personal")
        XCTAssertEqual(try reopened.accountIdentity()?.workspaceName, "Personal Library")
        // A label is not a licence to rebrand: the coordinates still decide.
        let parked = root.appendingPathComponent(GammaCache.directoryKey(server: "https://gamma.example",
                                                                        username: "alice", workspace: "ws-other"),
                                                isDirectory: true)
        try FileManager.default.createDirectory(at: parked, withIntermediateDirectories: true)
        let bytes = try JSONEncoder().encode(GammaOfflineIdentity(server: "https://gamma.example", username: "alice",
                                                                 workspace: "ws-personal", workspaceName: "Renamed"))
        try bytes.write(to: parked.appendingPathComponent("identity.json"))
        XCTAssertThrowsError(try GammaCache(rootURL: root, server: serverURL(), username: "alice", workspace: "ws-other"),
                             "a stored identity naming another workspace must still be refused")
    }

    /// The exact failure mode a review of this code must be able to rule out: the
    /// rename leaves the pre-workspace `identity.json` inside the workspace
    /// directory, whose own validation rejects an identity that names no workspace.
    /// Migration therefore has to re-stamp the identity BEFORE a cache instance is
    /// formed, and the result has to reopen.
    func testMigrationProducesACacheThatReopensWithItsName() throws {
        let legacy = try seedLegacyCache()
        let destination = root.appendingPathComponent(GammaCache.directoryKey(server: "https://gamma.example",
                                                                              username: "alice", workspace: "ws-personal"),
                                                     isDirectory: true)
        guard case .migrated = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example",
                                                                username: "alice",
                                                                verifiedDefaultWorkspace: "ws-personal",
                                                                workspaceName: "Personal") else {
            return XCTFail("migration must succeed for a verified default workspace")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))

        // A brand-new instance over the moved directory — the step that used to throw.
        let reopened = try cache(workspace: "ws-personal")
        let identity = try XCTUnwrap(try reopened.accountIdentity())
        XCTAssertEqual(identity.server, "https://gamma.example")
        XCTAssertEqual(identity.username, "alice")
        XCTAssertEqual(identity.workspace, "ws-personal")
        XCTAssertEqual(identity.workspaceName, "Personal")
        XCTAssertEqual(identity.id, destination.lastPathComponent)

        // ...and every reader the app uses works on it.
        XCTAssertEqual(try reopened.loadPage(pageID: "page-1", docID: "doc-1").outbox.count, 1)
        XCTAssertEqual(try reopened.pendingPages().map(\.pageID), ["page-1"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: reopened.sourceURL(docID: "doc-1").path))
        XCTAssertEqual(try GammaCache.discoverOfflineIdentities(rootURL: root).map(\.workspace), ["ws-personal"])
        // The label survives further opens, because identity ignores it.
        _ = try cache(workspace: "ws-personal")
        XCTAssertEqual(try reopened.accountIdentity()?.workspaceName, "Personal")
    }

    func testInterruptedRenameRecoversWithoutChangingPayloadBytes() throws {
        let legacy = try seedLegacyCache()
        let destination = root.appendingPathComponent(GammaCache.directoryKey(server: "https://gamma.example", username: "alice", workspace: "ws-personal"), isDirectory: true)
        let pageName = "page-\(GammaCache.key("page-1")).json"
        let pageBytes = try Data(contentsOf: legacy.appendingPathComponent(pageName))
        let pdfName = "source-\(GammaCache.key("doc-1")).pdf"
        let pdfBytes = try Data(contentsOf: legacy.appendingPathComponent(pdfName))
        // Simulate process death immediately after rename, before identity write.
        try FileManager.default.moveItem(at: legacy, to: destination)
        XCTAssertEqual(try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example", username: "alice", verifiedDefaultWorkspace: "ws-personal", workspaceName: "Named library"), .migrated(to: destination))
        XCTAssertEqual(try Data(contentsOf: destination.appendingPathComponent(pageName)), pageBytes)
        XCTAssertEqual(try Data(contentsOf: destination.appendingPathComponent(pdfName)), pdfBytes)
        let reopened = try cache()
        XCTAssertEqual(try reopened.accountIdentity()?.workspaceName, "Named library")
        XCTAssertEqual(try reopened.pendingPages().first?.outbox.count, 1)
        XCTAssertEqual(try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example", username: "alice", verifiedDefaultWorkspace: "ws-personal"), .alreadyWorkspaceScoped)
    }

    func testInterruptedRenameReportsRollbackFailureTruthfully() throws {
        let legacy = try seedLegacyCache()
        let destination = root.appendingPathComponent(GammaCache.directoryKey(server: "https://gamma.example", username: "alice", workspace: "ws-personal"), isDirectory: true)
        let fm = FileManager.default
        try fm.moveItem(at: legacy, to: destination)
        let identityURL = destination.appendingPathComponent("identity.json")
        let original = try Data(contentsOf: identityURL)
        // Recovery cannot re-stamp a read-only directory or rename it out of a
        // read-only parent. Both operations must be reported, never swallowed.
        try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: destination.path)
        try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: root.path)
        defer {
            try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
            try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: destination.path)
        }
        let outcome = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example", username: "alice", verifiedDefaultWorkspace: "ws-personal")
        guard case .refused(let reason) = outcome else { throw XCTSkip("runner does not enforce directory permissions") }
        XCTAssertTrue(reason.contains("rollback failed"), reason)
        XCTAssertTrue(reason.contains(destination.path), reason)
        XCTAssertFalse(reason.contains("was restored"), reason)
        XCTAssertFalse(fm.fileExists(atPath: legacy.path))
        XCTAssertEqual(try Data(contentsOf: identityURL), original)
    }

    func testInterruptedRenameRefusesForeignMissingAndAmbiguousIdentity() throws {
        let legacy = try seedLegacyCache()
        let destination = root.appendingPathComponent(GammaCache.directoryKey(server: "https://gamma.example", username: "alice", workspace: "ws-personal"), isDirectory: true)
        try FileManager.default.moveItem(at: legacy, to: destination)
        let identityURL = destination.appendingPathComponent("identity.json")
        for identity in [
            GammaOfflineIdentity(server: "https://other.example", username: "alice"),
            GammaOfflineIdentity(server: "https://gamma.example", username: "bob"),
            GammaOfflineIdentity(server: "https://gamma.example", username: "alice", workspace: "ws-other")
        ] {
            let bytes = try JSONEncoder().encode(identity)
            try bytes.write(to: identityURL)
            guard case .refused = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example", username: "alice", verifiedDefaultWorkspace: "ws-personal") else { return XCTFail("foreign identity adopted") }
            XCTAssertEqual(try Data(contentsOf: identityURL), bytes)
        }
        try FileManager.default.removeItem(at: identityURL)
        guard case .refused = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example", username: "alice", verifiedDefaultWorkspace: "ws-personal") else { return XCTFail("missing identity adopted") }
        try JSONEncoder().encode(GammaOfflineIdentity(server: "https://gamma.example", username: "alice")).write(to: identityURL)
        var page = GammaPageCache(pageID: "page-1", docID: "doc-1")
        page.workspace = "ws-other"
        let pageURL = destination.appendingPathComponent("page-\(GammaCache.key("page-1")).json")
        let bytes = try JSONEncoder().encode(page)
        try bytes.write(to: pageURL)
        guard case .refused = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example", username: "alice", verifiedDefaultWorkspace: "ws-personal") else { return XCTFail("ambiguous payload adopted") }
        XCTAssertEqual(try Data(contentsOf: pageURL), bytes)
    }

    func testIdentityMismatchInAnyCoordinateIsStillRefused() throws {
        let directory = try cache(workspace: "ws-personal").rootURL
        let identityURL = directory.appendingPathComponent("identity.json")
        for stored in [GammaOfflineIdentity(server: "https://other.example", username: "alice", workspace: "ws-personal"),
                       GammaOfflineIdentity(server: "https://gamma.example", username: "bob", workspace: "ws-personal"),
                       GammaOfflineIdentity(server: "https://gamma.example", username: "alice", workspace: "ws-shared")] {
            try JSONEncoder().encode(stored).write(to: identityURL)
            XCTAssertThrowsError(try GammaCache(rootURL: root, server: serverURL(), username: "alice", workspace: "ws-personal"),
                                 "\(stored) must be refused: only the display name is ignorable")
        }
    }

    func testRefusedMigrationLeavesIdentityBytesUntouched() throws {
        let legacy = try seedLegacyCache()
        let identityURL = legacy.appendingPathComponent("identity.json")
        let identityBytes = try Data(contentsOf: identityURL)
        // Occupy the destination so the migration must refuse.
        _ = try cache(workspace: "ws-personal")
        guard case .refused = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example",
                                                               username: "alice", verifiedDefaultWorkspace: "ws-personal") else {
            return XCTFail("an occupied destination must be refused")
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacy.path))
        XCTAssertEqual(try Data(contentsOf: identityURL), identityBytes,
                       "a refused migration must not rewrite the legacy identity")
        XCTAssertTrue(try GammaCache.discoverOfflineIdentities(rootURL: root).contains { $0.isLegacy })
    }

    /// Fault injection for the rollback: `rename(2)` needs write permission on the
    /// parent directories, not on the directory being moved, so a read-only legacy
    /// directory moves successfully and then fails at the atomic re-stamp. That is
    /// the only window in which a half-claimed cache could exist.
    func testMigrationRollsBackAtomicallyWhenTheNewIdentityCannotBeWritten() throws {
        let legacy = try seedLegacyCache()
        let identityURL = legacy.appendingPathComponent("identity.json")
        let identityBytes = try Data(contentsOf: identityURL)
        let destination = root.appendingPathComponent(GammaCache.directoryKey(server: "https://gamma.example",
                                                                              username: "alice", workspace: "ws-personal"),
                                                     isDirectory: true)
        let fm = FileManager.default
        let original = try fm.attributesOfItem(atPath: legacy.path)[.posixPermissions] as? NSNumber
        try fm.setAttributes([.posixPermissions: 0o500], ofItemAtPath: legacy.path)
        defer {
            try? fm.setAttributes([.posixPermissions: original ?? 0o700], ofItemAtPath: legacy.path)
            if fm.fileExists(atPath: destination.path) {
                try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: destination.path)
            }
        }

        let outcome = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example",
                                                       username: "alice", verifiedDefaultWorkspace: "ws-personal",
                                                       workspaceName: "Personal")
        guard case .refused = outcome else {
            // A privileged runner (root) ignores the permission bits; the rollback
            // path is then unreachable rather than unverified.
            throw XCTSkip("permissions are not enforced for this runner, so the re-stamp cannot be made to fail")
        }
        XCTAssertTrue(fm.fileExists(atPath: legacy.path), "the legacy cache must be back where it was")
        XCTAssertFalse(fm.fileExists(atPath: destination.path), "no half-claimed workspace directory may remain")
        XCTAssertEqual(try Data(contentsOf: identityURL), identityBytes,
                       "the rollback must restore the legacy identity bytes")
    }

    func testLegacyCacheIsListedButNotOpenedUntilAWorkspaceIsKnown() throws {
        try seedLegacyCache()
        let discovered = try GammaCache.discoverOfflineIdentities(rootURL: root)
        XCTAssertEqual(discovered.count, 1)
        XCTAssertTrue(discovered[0].isLegacy)
        XCTAssertEqual(discovered[0].workspace, "")
        XCTAssertEqual(discovered[0].username, "alice")
        XCTAssertEqual(discovered[0].id, GammaCache.legacyDirectoryKey(server: "https://gamma.example", username: "alice"))

        let workspace = GammaWorkspace()
        workspace.enterOffline(discovered[0])
        XCTAssertTrue(workspace.cache == nil, "A workspaceless cache must not be opened")
        XCTAssertEqual(workspace.errorMessage?.contains("attach them to your default workspace"), true)
    }

    func testLegacyCacheMigratesOnlyToTheVerifiedDefaultWorkspace() throws {
        let legacy = try seedLegacyCache()
        let outcome = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example",
                                                       username: "alice", verifiedDefaultWorkspace: "ws-personal",
                                                       workspaceName: "Personal")
        let destination = root.appendingPathComponent(GammaCache.directoryKey(server: "https://gamma.example",
                                                                              username: "alice", workspace: "ws-personal"),
                                                      isDirectory: true)
        guard case .migrated(let moved) = outcome else { return XCTFail("expected a migration, got \(outcome)") }
        XCTAssertEqual(moved, destination)
        XCTAssertFalse(FileManager.default.fileExists(atPath: legacy.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: destination.path))

        let identity = try JSONDecoder().decode(GammaOfflineIdentity.self,
                                                from: Data(contentsOf: destination.appendingPathComponent("identity.json")))
        XCTAssertEqual(identity.workspace, "ws-personal")
        XCTAssertEqual(identity.workspaceName, "Personal")
        XCTAssertFalse(identity.isLegacy)
        // Files and pending work survive the move unchanged.
        XCTAssertTrue(FileManager.default.fileExists(atPath: destination.appendingPathComponent("source-\(GammaCache.key("doc-1")).pdf").path))
        let storage = try cache(workspace: "ws-personal")
        let page = try storage.loadPage(pageID: "page-1", docID: "doc-1")
        XCTAssertEqual(page.outbox.count, 1)
        XCTAssertEqual(page.outbox.first?.content, "offline edit")
        XCTAssertEqual(try storage.accountIdentity()?.workspace, "ws-personal")

        // Idempotent: a second attempt finds the workspace directory, not the legacy one.
        XCTAssertEqual(try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example",
                                                        username: "alice", verifiedDefaultWorkspace: "ws-personal"),
                       .alreadyWorkspaceScoped)
        XCTAssertEqual(try GammaCache.discoverOfflineIdentities(rootURL: root).map(\.workspace), ["ws-personal"])
    }

    func testLegacyCacheIsNotMovedWithoutAVerifiedDefaultOrIntoAnOccupiedWorkspace() throws {
        let legacy = try seedLegacyCache()
        // No verified default (offline sign-in, an unlisted default): nothing moves.
        for candidate in ["", "ws-personal\nother"] {
            let outcome = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example",
                                                           username: "alice", verifiedDefaultWorkspace: candidate)
            guard case .refused = outcome else { return XCTFail("expected a refusal for \(candidate), got \(outcome)") }
            XCTAssertTrue(FileManager.default.fileExists(atPath: legacy.path))
        }
        // An occupied destination is never merged or overwritten.
        _ = try cache(workspace: "ws-personal")
        let outcome = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example",
                                                       username: "alice", verifiedDefaultWorkspace: "ws-personal")
        guard case .refused(let reason) = outcome else { return XCTFail("expected a refusal, got \(outcome)") }
        XCTAssertTrue(reason.contains("left untouched"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacy.path))
        XCTAssertEqual(try GammaCache.discoverOfflineIdentities(rootURL: root).count, 2)
    }

    func testLegacyCacheOfAnotherAccountOrServerIsNeverClaimed() throws {
        let legacy = try seedLegacyCache()
        for (server, username) in [("https://gamma.example", "bob"), ("https://other.example", "alice")] {
            let outcome = try GammaCache.migrateLegacyCache(rootURL: root, server: server, username: username,
                                                           verifiedDefaultWorkspace: "ws-personal")
            XCTAssertEqual(outcome, .noLegacyCache)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacy.path))

        // A legacy directory whose identity is corrupt is refused, not guessed.
        try Data("not json".utf8).write(to: legacy.appendingPathComponent("identity.json"))
        let outcome = try GammaCache.migrateLegacyCache(rootURL: root, server: "https://gamma.example",
                                                       username: "alice", verifiedDefaultWorkspace: "ws-personal")
        guard case .refused(let reason) = outcome else { return XCTFail("expected a refusal, got \(outcome)") }
        XCTAssertTrue(reason.contains("inconsistent"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: legacy.path))
    }

    // MARK: - The outbox

    func testQueuedChangeIsStampedWithItsWorkspaceAndSentWithIt() async throws {
        let api = try await signedInAPI(workspace: "ws-shared")
        defer { api.close() }
        let storage = try cache(workspace: "ws-shared")
        let page = GammaPageCache(pageID: "page-1", docID: "doc-1", blocks: [
            GammaBlock(id: "page-1", parentID: "root", content: "Paper", properties: GammaProperties(docID: "doc-1")),
            GammaBlock(id: "note-1", parentID: "page-1", content: "note", properties: GammaProperties(nativeNote: true, noteRevision: 1))
        ])
        try storage.savePage(page)
        let workspace = GammaWorkspace(cache: storage, api: api)
        workspace.page = page
        try workspace.editContent(blockID: "note-1", text: "edited")
        let queued = try XCTUnwrap(try storage.loadPage(pageID: "page-1", docID: "doc-1").outbox.first)
        XCTAssertEqual(queued.workspace, "ws-shared")
        XCTAssertEqual(queued.kind, .child)

        IdentityURLProtocol.reset()
        await workspace.sync()
        XCTAssertTrue(try storage.loadPage(pageID: "page-1", docID: "doc-1").outbox.isEmpty, workspace.errorMessage ?? "")
        for request in IdentityURLProtocol.requests {
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Gamma-Workspace"), "ws-shared")
        }
        XCTAssertTrue(IdentityURLProtocol.paths().contains { $0.hasSuffix("/note") })
    }

    func testQueuedChangeFromAnotherWorkspaceIsParkedNotUploaded() async throws {
        let api = try await signedInAPI(workspace: "ws-shared")
        defer { api.close() }
        let storage = try cache(workspace: "ws-shared")
        var page = GammaPageCache(pageID: "page-1", docID: "doc-1", blocks: [
            GammaBlock(id: "page-1", parentID: "root", content: "Paper", properties: GammaProperties(docID: "doc-1"))
        ])
        // The stamp is what a snapshot written in another library carries.
        page.outbox = [GammaMutation(kind: .content, blockID: "note-1", parentID: "page-1", content: "other library",
                                     workspace: "ws-personal")]
        try storage.savePage(page)
        let workspace = GammaWorkspace(cache: storage, api: api)
        workspace.page = page
        IdentityURLProtocol.reset()
        await workspace.sync()
        let after = try storage.loadPage(pageID: "page-1", docID: "doc-1")
        XCTAssertEqual(after.outbox.count, 1, "the change must be preserved")
        XCTAssertEqual(after.outbox.first?.content, "other library")
        XCTAssertTrue(after.outbox.first?.conflict == true)
        XCTAssertEqual(after.outbox.first?.workspace, "ws-personal")
        XCTAssertTrue(workspace.errorMessage?.contains("another workspace") == true, workspace.errorMessage ?? "")
        XCTAssertFalse(IdentityURLProtocol.paths().contains { $0.contains("/blocks/note-1") },
                       "nothing may be uploaded while the workspace disagrees")
    }

    func testCacheAndClientFromDifferentWorkspacesAreNeverPaired() async throws {
        let storage = try cache(workspace: "ws-shared")
        try storage.savePage(GammaPageCache(pageID: "page-1", docID: "doc-1",
                                            outbox: [GammaMutation(kind: .content, blockID: "block-1", parentID: "page-1",
                                                                   workspace: "ws-shared")]))
        let shared = try await signedInAPI(workspace: "ws-shared")
        defer { shared.close() }
        let other = try await signedInAPI(workspace: "ws-personal")
        defer { other.close() }

        // Wiring a client at another library to this cache is refused at once.
        let mismatched = GammaWorkspace(cache: storage, api: other)
        XCTAssertNil(mismatched.api)
        XCTAssertTrue(mismatched.isOffline)
        XCTAssertTrue(mismatched.errorMessage?.contains("does not match") == true, mismatched.errorMessage ?? "")

        // And the sync gate holds even if a client is swapped in later.
        let workspace = GammaWorkspace(cache: storage, api: shared)
        workspace.api = other
        IdentityURLProtocol.reset()
        await workspace.sync()
        XCTAssertEqual(try storage.loadPage(pageID: "page-1", docID: "doc-1").outbox.count, 1)
        XCTAssertTrue(workspace.errorMessage?.contains("same account and workspace") == true, workspace.errorMessage ?? "")
        XCTAssertTrue(IdentityURLProtocol.paths().isEmpty, "no request may be made from a mismatched pair")
    }

    func testWorkspaceSwitchRequiresAnEmptyOutboxAndAWritableTarget() async throws {
        let api = try await signedInAPI(workspace: "ws-shared")
        defer { api.close() }
        let storage = try cache(workspace: "ws-shared")
        let workspace = GammaWorkspace(cache: storage, api: api)
        workspace.workspaceOptions = [GammaWorkspaceOption(id: "ws-personal", name: "Personal", role: "owner", isDefault: true),
                                      GammaWorkspaceOption(id: "ws-shared", name: "Team", role: "editor"),
                                      GammaWorkspaceOption(id: "ws-readonly", name: "Read only", role: "viewer")]
        workspace.workspaceID = "ws-shared"

        await workspace.switchWorkspace(to: "ws-readonly")
        XCTAssertTrue(workspace.errorMessage?.contains("cannot write") == true, workspace.errorMessage ?? "")
        XCTAssertEqual(workspace.workspaceID, "ws-shared")

        try storage.savePage(GammaPageCache(pageID: "page-1", docID: "doc-1",
                                            outbox: [GammaMutation(kind: .content, blockID: "block-1", parentID: "page-1",
                                                                   workspace: "ws-shared")]))
        await workspace.switchWorkspace(to: "ws-personal")
        XCTAssertTrue(workspace.errorMessage?.contains("pending change") == true, workspace.errorMessage ?? "")
        XCTAssertEqual(workspace.workspaceID, "ws-shared")
        XCTAssertFalse(workspace.canSwitchWorkspace)
    }
}
