"""Portable workspace-identity contract checks for the iPad client.

These do NOT replace the Xcode suite: nothing here can run PDFKit, PencilKit,
WebKit or the Swift type checker. What it can do on any machine (including the
Linux integration host) is prove that the *source* still holds the invariants the
workspace migration is built on, and that the Swift files are structurally sound
after an edit made without a compiler:

  1. every API request is built by the one helper that injects the workspace;
  2. the bridge payload names a workspace, with the same fields the Web side sends;
  3. a cache directory is derived from server + account + workspace, and the
     pre-workspace layout is recognised rather than reinterpreted;
  4. a legacy cache can only be attached to a server-verified default workspace;
  5. the outbox records and re-checks the workspace a change belongs to;
  6. all Swift sources keep balanced delimiters, closed string literals and
     unique test method names.

Run: python3 scripts/test_native_workspace_contract.py
"""
import re
import unittest
from pathlib import Path

IPAD = Path(__file__).resolve().parent.parent
APP = IPAD / "GammaIPad"
TESTS = IPAD / "GammaIPadTests"
SERVER = APP / "Server" / "GammaAPI.swift"
STORAGE = APP / "Storage"
WEB = APP / "Web"
WORKSPACE = APP / "App" / "GammaWorkspace.swift"
FRONTEND_BRIDGE = IPAD.parent / "frontend" / "src" / "native" / "nativeBridge.js"


def read(path):
    return path.read_text(encoding="utf-8")


def swift_sources():
    return sorted(APP.rglob("*.swift"))


def strip_swift(text):
    """Blank out comments and string literals, keeping line structure.

    Enough of a lexer to make delimiter counting trustworthy: Swift mixes `//`,
    nested `/* */`, `"..."` with `\\(...)` interpolation and `\"\"\"` blocks.
    """
    out = []
    index, depth, length = 0, 0, len(text)
    quote = None  # None | '"' | '"""'
    while index < length:
        char = text[index]
        pair = text[index:index + 2]
        triple = text[index:index + 3]
        if quote is None:
            if pair == "//":
                end = text.find("\n", index)
                end = length if end < 0 else end
                out.append(" " * (end - index)); index = end; continue
            if pair == "/*":
                depth += 1; out.append("  "); index += 2; continue
            if depth:
                if pair == "*/":
                    depth -= 1; out.append("  "); index += 2; continue
                out.append("\n" if char == "\n" else " "); index += 1; continue
            if triple == '"""':
                quote = '"""'; out.append("   "); index += 3; continue
            if char == '"':
                quote = '"'; out.append(" "); index += 1; continue
            out.append(char); index += 1; continue
        # inside a string literal
        if quote == '"""':
            if triple == '"""':
                quote = None; out.append("   "); index += 3; continue
            out.append("\n" if char == "\n" else " "); index += 1; continue
        if char == "\\":
            out.append("  "); index += 2; continue
        if char == "\n":
            # A single-quoted literal cannot span lines: report it as unterminated.
            out.append("\n"); index += 1; continue
        if char == '"':
            quote = None; out.append(" "); index += 1; continue
        out.append(" "); index += 1
    assert quote is None, "a string literal is never closed"
    assert depth == 0, "a block comment is never closed"
    return "".join(out)


class SwiftStructureTests(unittest.TestCase):
    def test_every_swift_source_has_balanced_delimiters_and_closed_literals(self):
        for path in swift_sources():
            with self.subTest(path=path.name):
                stripped = strip_swift(read(path))
                for opener, closer in (("{", "}"), ("(", ")"), ("[", "]")):
                    self.assertEqual(stripped.count(opener), stripped.count(closer),
                                     f"{path.name}: unbalanced {opener}{closer}")

    def test_every_swift_source_ends_with_a_newline_and_uses_no_tabs(self):
        for path in swift_sources():
            text = read(path)
            with self.subTest(path=path.name):
                self.assertTrue(text.endswith("\n"), f"{path.name} has no final newline")
                self.assertNotIn("\t", text, f"{path.name} contains a tab")

    def test_test_method_names_are_unique_within_each_file(self):
        for path in TESTS.rglob("*.swift"):
            names = re.findall(r"func (test[A-Za-z0-9_]*)", read(path))
            with self.subTest(path=path.name):
                self.assertEqual(len(names), len(set(names)), f"duplicate test method in {path.name}")

    def test_project_keeps_its_bundle_identity(self):
        project = read(IPAD / "project.yml")
        # App Store identity explicitly selected by the owner before local mode.
        self.assertIn("PRODUCT_BUNDLE_IDENTIFIER: net.blitzbuild.gamma\n", project)
        self.assertIn("PRODUCT_BUNDLE_IDENTIFIER: net.blitzbuild.gamma.tests", project)
        self.assertIn("SWIFT_VERSION", project)


class RequestIdentityTests(unittest.TestCase):
    def test_all_requests_are_built_by_the_identity_injecting_helper(self):
        text = read(SERVER)
        # `URLRequest(url:)` may appear only in makeRequest, plus the redirect
        # delegate's pass-through (which receives a request, never builds one).
        builders = [match for match in re.finditer(r"URLRequest\(url:", text)]
        self.assertEqual(len(builders), 1, "every request must be built by makeRequest")
        helper = text[text.index("func makeRequest"):]
        helper = helper[:helper.index("\n    private func get(")]
        self.assertIn('request.setValue(workspace, forHTTPHeaderField: "X-Gamma-Workspace")', helper)
        self.assertIn('request.setValue(authenticatedUsername, forHTTPHeaderField: "X-Gamma-User")', helper)
        self.assertIn("guard !workspace.isEmpty else { throw APIError.workspaceUnbound }", helper)

    def test_session_endpoints_alone_skip_the_identity_headers(self):
        text = read(SERVER)
        match = re.search(r"sessionPaths = \[([^\]]*)\]", text)
        self.assertIsNotNone(match, "sessionPaths must be declared explicitly")
        paths = re.findall(r'"([^"]+)"', match.group(1))
        self.assertEqual(sorted(paths), ["api/login", "api/logout", "api/session"])
        # The frontend's fetch wrapper skips the same three; keep them in step.
        utils = IPAD.parent / "frontend" / "src" / "shared" / "lib" / "utils.js"
        if utils.exists():
            auth = re.search(r"AUTH_PATHS = new Set\(\[([^\]]*)\]\)", read(utils))
            if auth:
                frontend = {"api" + path for path in re.findall(r"\$\{API\}(/[a-z-]+)", auth.group(1))}
                # The native client may never treat a data endpoint as session-only,
                # or it would issue a request with no workspace. The Web side has
                # extra session paths native does not use (guest login) — that is fine.
                self.assertTrue(set(paths).issubset(frontend),
                                f"native treats non-session endpoints as session-only: {sorted(set(paths) - frontend)}")

    def test_workspace_binds_once_and_never_rebinds(self):
        text = read(SERVER)
        self.assertIn("private(set) var workspace: String", text)
        helper = text[text.index("func bind(workspace:"):]
        helper = helper[:helper.index("\n    func close()")]
        self.assertIn("guard self.workspace.isEmpty else {", helper)
        assignments = re.findall(r"self\.workspace = ", text)
        self.assertEqual(len(assignments), 2, "workspace is assigned in the initializer and bind() only")
        # No call site may bind after construction outside the documented flow.
        for path in swift_sources():
            for line in read(path).splitlines():
                if ".bind(workspace:" in line:
                    self.assertTrue(path.name in {"GammaWorkspace.swift", "GammaSessionCoordinator.swift"},
                                    f"bind() is only for verified sign-in/restore, not {path.name}")
                    if path.name == "GammaSessionCoordinator.swift":
                        coordinator = read(path)
                        self.assertLess(coordinator.index("try record.validate(info)"),
                                        coordinator.index("client.bind(workspace:"))

    def test_workspace_is_validated_before_it_is_worn_as_a_header(self):
        text = read(SERVER)
        validator = text[text.index("static func isValidWorkspace"):]
        validator = validator[:validator.index("/// Attaches this client")]
        self.assertIn("!value.isEmpty", validator)
        self.assertIn("value.utf8.count <= 64", validator)
        self.assertIn("workspaceCharacters.contains", validator)
        charset = text[text.index("static let workspaceCharacters"):]
        charset = charset[:charset.index("\n    /// Attaches this client")]
        for allowed in "AZaz09":
            self.assertIn(allowed, charset)
        self.assertIn("-_", charset, "the server's URL-safe alphabet includes - and _")
        # A caller passing only whitespace must be refused, not trimmed into the
        # unbound state, so the initializer compares against the raw value.
        init = text[text.index("init(server: String, workspace: String"):]
        init = init[:init.index("static func isValidWorkspace")]
        self.assertIn("workspace == rawWorkspace", init)
        # The charset must mirror backend/gamma/db.py's own rule for the id.
        server_db = SERVER.parent.parent.parent / "backend" / "gamma" / "db.py"
        if server_db.exists():
            rule = re.search(r'_WS_ID_RE\s*=\s*re\.compile\(r"\^\[([^\]]+)\]\{(\d+),(\d+)\}\$"\)',
                             read(server_db))
            if rule:
                allowed, low, high = rule.group(1), int(rule.group(2)), int(rule.group(3))
                self.assertEqual(low, 1)
                self.assertEqual(high, 64, "the client's length bound must match the server's")
                self.assertEqual(set(allowed), set("A-Za-z0-9_-"),
                                 "the client's charset must match the server's")

    def test_native_routes_are_the_ported_ones(self):
        text = read(SERVER)
        for route in ["api/assets", "/ink", "/audio", "/note", "/highlight", "/replay-preview"]:
            self.assertIn(route, text, f"the native route {route} must still be called")
        # An older server answers an unknown GET /api/... with the SPA's HTML, so
        # HTML must be rejected instead of being cached as an asset.
        asset = text[text.index("func asset(_ name: String)"):]
        asset = asset[:asset.index("private static func looksLikeHTML")]
        self.assertIn("text/html", asset)
        self.assertIn("looksLikeHTML(data)", asset)
        self.assertIn("serverUpgradeRequired", asset)

    def test_a_denied_workspace_is_not_retried_blindly(self):
        text = read(SERVER)
        self.assertIn("case 403: throw APIError.workspaceAccessDenied", text)
        workspace = read(WORKSPACE)
        self.assertIn("catch GammaAPI.APIError.workspaceAccessDenied {", workspace)
        denied = workspace[workspace.index("catch GammaAPI.APIError.workspaceAccessDenied {"):]
        denied = denied[:denied.index("catch GammaAPI.APIError.conflict")]
        self.assertIn("syncUnavailable = true", denied)
        self.assertIn("return", denied)


class BridgeContractTests(unittest.TestCase):
    def test_bridge_payload_requires_a_workspace(self):
        text = read(WEB / "GammaWebValidation.swift")
        parser = text[text.index("public static func openPDF"):]
        parser = parser[:parser.index("\n    }")]
        for field in ["pageID", "docID", "title", "user", "workspace"]:
            self.assertIn(f'body["{field}"]', parser, f"the bridge must read {field}")
        self.assertIn('body["type"] as? String == "openPDF"', parser)

    def test_bridge_field_names_match_the_web_sender(self):
        text = read(WEB / "GammaWebValidation.swift")
        parser = text[text.index("public static func openPDF"):]
        parser = parser[:parser.index("\n    }")]
        native_fields = set(re.findall(r'body\["([A-Za-z]+)"\]', parser))
        self.assertTrue(native_fields)
        if not FRONTEND_BRIDGE.exists():
            self.skipTest("the Web sender is not part of this worktree")
        sender = read(FRONTEND_BRIDGE)
        # The Web side builds `{type, pageID, docID, workspace, user, title}`.
        sent = set(re.findall(r"^\s*([A-Za-z]+),?$", sender[sender.index("return {"):], re.M))
        sent = {name for name in sent if name != "type"}
        self.assertTrue(sent, "could not read the Web sender's field list")
        self.assertTrue(sent.issubset(native_fields),
                        f"the Web side sends fields the native parser ignores: {sorted(sent - native_fields)}")
        self.assertIn("workspace", sent, "the Web handoff must send the workspace")
        self.assertIn('type: "openPDF"', sender)

    def test_handoff_checks_the_session_workspace_and_role(self):
        text = read(WEB / "GammaWebValidation.swift")
        self.assertIn("static func workspace(_ claimed: String, session: GammaSessionInfo)", text)
        self.assertIn("guard option.canWrite else { return .failure(.workspaceReadOnly) }", text)
        self.assertIn("guard let option = session.option(claimed) else { return .failure(.workspaceUnknown) }", text)
        self.assertIn("guard let user = session.user, !user.isEmpty, user == claimed", text)
        workspace = read(WORKSPACE)
        handoff = workspace[workspace.index("func openFromWeb("):]
        handoff = handoff[:handoff.index("func startRecording(")]
        self.assertIn("let info = try await client.adoptWebSession(cookies: cookies)", handoff)
        # The handoff must go through the checked helpers, so the pure contract the
        # unit tests cover is the one the real path executes.
        self.assertIn("GammaWebHandoffCheck.account(request.user, session: info)", handoff)
        self.assertIn("GammaWebHandoffCheck.workspace(request.workspace, session: info)", handoff)
        self.assertIn("GammaWebHandoffCheck.page(", handoff)
        self.assertIn("try client.bind(workspace: option.id)", handoff)
        self.assertLess(handoff.index("adoptWebSession"), handoff.index("bind(workspace: option.id)"),
                        "the session must be verified before the claimed workspace is bound")

    def test_web_view_opens_the_same_library_and_carries_it_in_the_url(self):
        session = read(WEB / "GammaWebSession.swift")
        self.assertIn("static func startURL(serverURL: URL, workspace: String) -> URL", session)
        self.assertIn('URLQueryItem(name: "ws", value: workspace)', session)
        self.assertIn('items.removeAll { $0.name == "ws" }', session)
        text = read(WEB / "GammaWebWorkspace.swift")
        self.assertIn("self.webView.load(URLRequest(url: self.startURL))", text)
        self.assertIn("public let workspace: String", text)
        self.assertIn("public let workspace: String\n", text[:text.index("@MainActor\npublic struct GammaWebWorkspace")] if False else text)


class CacheIdentityTests(unittest.TestCase):
    def test_directory_key_includes_the_workspace_and_the_legacy_key_is_kept(self):
        text = read(STORAGE / "GammaCache.swift")
        key = text[text.index("static func directoryKey"):]
        key = key[:key.index("static func legacyDirectoryKey")]
        self.assertIn("username + \"\\n\" + workspace", key)
        legacy = text[text.index("static func legacyDirectoryKey"):]
        legacy = legacy[:legacy.index("\n    }")]
        self.assertIn("canonicalServer(server) + \"\\n\" + username", legacy)
        self.assertNotIn("workspace", legacy)

    def test_cache_requires_a_valid_workspace_and_an_account(self):
        text = read(STORAGE / "GammaCache.swift")
        init = text[text.index("init(rootURL: URL, server: URL, username: String, workspace: String"):]
        init = init[:init.index("static func canonicalServer")]
        self.assertIn("guard GammaAPI.isValidWorkspace(workspace) else {", init)
        self.assertIn("guard !username.isEmpty else {", init)
        self.assertIn("directoryKey(server: canonical, username: username, workspace: workspace)", init)

    def test_snapshots_and_manifests_carry_and_check_their_workspace(self):
        cache = read(STORAGE / "GammaCache.swift")
        self.assertIn("var workspace: String? = nil", cache)
        self.assertIn("func assertWorkspace(_ recorded: String?, what: String) throws", cache)
        save = cache[cache.index("func savePage(_ page: GammaPageCache)"):]
        save = save[:save.index("func assertWorkspace")]
        self.assertIn("try assertWorkspace(page.workspace, what: \"page snapshot\")", save)
        self.assertIn("page.workspace = workspace", save)
        self.assertIn("page.outbox[index].workspace == nil { page.outbox[index].workspace = workspace }", save)
        pending = cache[cache.index("func pendingPages()"):]
        pending = pending[:pending.index("func sourceURL")]
        self.assertIn("try assertWorkspace(page.workspace, what: \"cached page\")", pending)

        offline = read(STORAGE / "GammaOfflineCache.swift")
        self.assertIn("try assertWorkspace(entry.workspace, what: \"offline download\")", offline)
        self.assertIn("entries[key]?.workspace = workspace", offline)

    def test_identity_comparison_ignores_the_display_label(self):
        text = read(STORAGE / "GammaOfflineCache.swift")
        ensure = text[text.index("func ensureAccountIdentity"):]
        ensure = ensure[:ensure.index("/// Records the workspace's display name")]
        self.assertIn("validated.workspace == normalized.workspace", ensure)
        self.assertNotIn("validated.workspaceName", ensure,
                         "the display label is not identity; comparing it rejects every cache that stored a name")
        self.assertNotIn("== normalized else", ensure)
        # There must be no unconditional "save identity" API left: one existed and
        # looked like the natural way to finish a rename, which is how the migration
        # bug happened. Identity is written by ensureAccountIdentity and the label
        # writer only.
        self.assertNotIn("func saveAccountIdentity", text,
                         "an unconditional identity writer invites the migration bug back")
        # The label may only be written through a re-validated path.
        label = text[text.index("func updateWorkspaceName"):]
        label = label[:label.index("/// The stored identity must name this exact directory")]
        self.assertIn("let current = try accountIdentity()", label)
        self.assertIn("try validatedIdentity(GammaOfflineIdentity(server: current.server", label)
        # And the three places that learn the name must record it.
        workspace = read(WORKSPACE)
        self.assertEqual(workspace.count("try storage.updateWorkspaceName("), 3,
                         "sign-in, workspace switch and Web handoff each learn the name")

    def test_identity_decodes_a_missing_workspace_as_legacy(self):
        text = read(STORAGE / "GammaOfflineModels.swift")
        self.assertIn('workspace = try values.decodeIfPresent(String.self, forKey: .workspace) ?? ""', text)
        self.assertIn("var isLegacy: Bool { workspace.isEmpty }", text)
        self.assertIn("workspace: String = \"\"", text)

    def test_legacy_migration_needs_a_verified_default_and_never_merges(self):
        text = read(STORAGE / "GammaOfflineCache.swift")
        start = text.index("static func migrateLegacyCache")
        migrate = text[start:text.index("\n    func diskUsage()")]
        self.assertIn("verifiedDefaultWorkspace: String", migrate)
        self.assertIn("guard GammaAPI.isValidWorkspace(verifiedDefaultWorkspace) else {", migrate)
        self.assertIn("return .refused", migrate)
        self.assertIn("if !recovering && fm.fileExists(atPath: destination.path) {", migrate)
        self.assertLess(migrate.index("if !recovering && fm.fileExists(atPath: destination.path)"),
                        migrate.index("try fm.moveItem(at: legacy, to: destination)"),
                        "the destination must be checked before anything moves")
        self.assertLess(migrate.index("let stored = try? JSONDecoder().decode(GammaOfflineIdentity.self"),
                        migrate.index("try fm.moveItem(at: legacy, to: destination)"),
                        "the legacy identity must be verified before anything moves")
        # The moved directory still holds the pre-workspace identity, which names no
        # workspace and would be rejected inside its own new directory. It must be
        # REPLACED before a cache instance is formed, or every migration "fails".
        self.assertLess(migrate.index("try JSONEncoder().encode(identity).write(to: destination"),
                        migrate.index("let storage = try GammaCache(rootURL: rootURL"),
                        "re-stamp identity.json before constructing the cache")
        self.assertIn("try legacyIdentity.write(to: target", migrate,
                      "a refused migration must restore the identity file it replaced")
        self.assertNotIn("saveAccountIdentity", migrate,
                         "the migration must re-stamp identity itself, before any cache instance exists")
        rollback = migrate[migrate.index("} catch {"):]
        self.assertIn("try fm.moveItem(at: destination, to: legacy)", rollback)
        self.assertNotIn("try? fm.moveItem", rollback)
        self.assertIn("rollback failed", rollback)
        self.assertIn("recovering && stored.workspace == verifiedDefaultWorkspace", migrate)
        self.assertIn('page.outbox.allSatisfy({ ($0.workspace ?? "").isEmpty })', migrate)
        # Only the verified default workspace may claim it.
        workspace = read(WORKSPACE)
        self.assertIn("if chosen.id == info.verifiedDefaultWorkspace {", workspace)
        handoff = workspace[workspace.index("func openFromWeb("):]
        self.assertIn("if option.id == info.verifiedDefaultWorkspace {", handoff)

    def test_offline_entry_points_refuse_a_workspaceless_cache(self):
        text = read(APP / "App" / "GammaWorkspaceOffline.swift")
        enter = text[text.index("func enterOffline"):]
        enter = enter[:enter.index("/// A single persisted manifest")]
        self.assertIn("guard !account.isLegacy else {", enter)
        self.assertIn("try GammaCache(rootURL: try GammaCache.applicationSupportRoot(), server: server,\n                                         username: account.username, workspace: account.workspace)", enter)


class OutboxIdentityTests(unittest.TestCase):
    def test_every_queued_change_is_stamped_with_its_workspace(self):
        text = read(STORAGE / "GammaCache.swift")
        self.assertIn("var workspace: String? = nil", text)
        workspace = read(WORKSPACE)
        enqueue = workspace[workspace.index("private func enqueue("):]
        enqueue = enqueue[:enqueue.index("private func persist(")]
        self.assertIn("mutation.workspace = cache?.workspace ?? snapshot.workspace ?? mutation.workspace", enqueue)
        self.assertIn("result.outbox.append(GammaMutation(kind: .inkPreview", workspace)
        preview = workspace[workspace.index("result.outbox.append(GammaMutation(kind: .inkPreview"):]
        preview = preview[:preview.index("return result")]
        self.assertIn("workspace: cache.workspace", preview)

    def test_sync_refuses_a_change_from_another_workspace(self):
        workspace = read(WORKSPACE)
        sync = workspace[workspace.index("func sync() async {"):]
        sync = sync[:sync.index("/// Explicit conflict choices")]
        self.assertIn("identity.workspace == api.workspace", sync)
        self.assertIn("cache.workspace == api.workspace", sync)
        guard = sync[sync.index("if let recorded = operation.workspace"):]
        guard = guard[:guard.index("do {")]
        self.assertIn("recorded != api.workspace", guard)
        self.assertIn("conflict = true", guard)
        self.assertIn("return", guard)
        self.assertLess(sync.index("if let recorded = operation.workspace"),
                        sync.index("case .inkPreview:"),
                        "the workspace gate must run before any write is attempted")

    def test_switching_a_library_requires_an_empty_outbox_and_a_writable_role(self):
        workspace = read(WORKSPACE)
        switch = workspace[workspace.index("func switchWorkspace(to id: String) async {"):]
        switch = switch[:switch.index("func signOut() async {")]
        self.assertIn("guard let option = writableWorkspaces.first(where: { $0.id == id }) else {", switch)
        self.assertIn("let pending = try pendingOutbox().filter { $0.kind != .inkPreview }", switch)
        self.assertIn("guard pending.isEmpty else {", switch)
        self.assertIn("info.option(option.id)?.canWrite == true", switch)
        self.assertLess(switch.index("guard pending.isEmpty else {"), switch.index("busy = true"))
        self.assertIn("var canSwitchWorkspace: Bool {", workspace)
        self.assertIn("var writableWorkspaces: [GammaWorkspaceOption] { workspaceOptions.filter(\\.canWrite) }", workspace)

    def test_workspace_selection_never_switches_on_reconnect(self):
        workspace = read(WORKSPACE)
        choose = workspace[workspace.index("func chooseWorkspace("):]
        choose = choose[:choose.index("func login(")]
        self.assertIn("if reconnect {", choose)
        self.assertIn("guard let wanted else {", choose)
        self.assertIn("no longer writable", choose)
        self.assertIn("info.verifiedDefaultWorkspace", choose)
        self.assertIn("throw GammaAPI.APIError.message(\"This account cannot write in any Gamma workspace", choose)

    def test_a_workspaceless_pair_is_never_wired_up(self):
        workspace = read(WORKSPACE)
        init_start = workspace.index("init(cache: GammaCache? = nil")
        init_body = workspace[init_start:workspace.index("var selected: GammaBlock?")]
        self.assertIn("|| api.workspace != identity.workspace {", init_body)
        self.assertIn("self.api = nil; self.isOffline = true", init_body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
