import XCTest
@testable import GammaIPad

final class GammaWebWorkspaceTests: XCTestCase {
    func testOriginAndDeploymentBoundaryAllowAnchorsButNotEscape() {
        let origin = GammaWebOrigin(url: URL(string: "https://gamma.example/app")!)
        for value in ["https://gamma.example/app", "https://gamma.example/app/?page=1#note", "https://gamma.example:443/app/document"] {
            XCTAssertTrue(origin.isValidURL(URL(string: value)!), value)
        }
        for value in ["https://gamma.example/application", "https://other.example/app/", "http://gamma.example/app/", "https://gamma.example:444/app/", "file:///app", "https://user:pass@gamma.example/app/"] {
            XCTAssertFalse(origin.isValidURL(URL(string: value)!), value)
        }
    }

    func testBridgeOnlyAcceptsBoundedDocumentIdentityAndWorkspace() {
        let payload: [String: Any] = ["type": "openPDF", "pageID": "page", "docID": "doc",
                                      "title": "Paper", "user": "alice", "workspace": "ws-alpha"]
        XCTAssertEqual(GammaWebMessageValidator.openPDF(from: payload)?.pageID, "page")
        XCTAssertEqual(GammaWebMessageValidator.openPDF(from: payload)?.workspace, "ws-alpha")
        var bad = payload; bad["user"] = ""
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: bad))
        bad = payload; bad["type"] = "execute"
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: bad))
        bad = payload; bad["title"] = String(repeating: "x", count: 513)
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: bad))
        // A newline would let one field forge the next; the ids are single tokens.
        bad = payload; bad["docID"] = "doc\nworkspace: 'ws-other'"
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: bad))
        bad = payload; bad["workspace"] = "ws\u{0}other"
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: bad))
    }

    /// A handoff that does not name a library is refused outright: opening the PDF
    /// without one would mean guessing which library's data to write into.
    func testBridgeRequiresAWorkspace() {
        let without: [String: Any] = ["type": "openPDF", "pageID": "page", "docID": "doc",
                                      "title": "Paper", "user": "alice"]
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: without))
        for value in ["", "ws\nother", "ws\u{0}other", String(repeating: "w", count: 201)] {
            var bad = without; bad["workspace"] = value
            XCTAssertNil(GammaWebMessageValidator.openPDF(from: bad), value)
        }
        var blank = without; blank["workspace"] = "   "
        // Whitespace passes the payload bound as a *claim*; the session check in
        // GammaWebHandoffCheck is what refuses it, and that is the real gate.
        XCTAssertEqual(GammaWebMessageValidator.openPDF(from: blank)?.workspace, "   ")
        guard case .failure(.workspaceUnknown) = GammaWebHandoffCheck.workspace("   ", session: info(workspaces: [owner])) else {
            return XCTFail("a blank workspace must be refused by the session check")
        }
    }

    func testWebSessionStartURLCarriesTheWorkspace() {
        let server = URL(string: "https://gamma.example")!
        XCTAssertEqual(GammaWebSession.startURL(serverURL: server, workspace: "ws-alpha").absoluteString,
                       "https://gamma.example?ws=ws-alpha")
        XCTAssertEqual(GammaWebSession.startURL(serverURL: URL(string: "https://gamma.example/app")!, workspace: "ws-a b").absoluteString,
                       "https://gamma.example/app?ws=ws-a%20b")
        // An existing ws is replaced, never duplicated, so one tab has one library.
        XCTAssertEqual(GammaWebSession.startURL(serverURL: URL(string: "https://gamma.example/?ws=old&page=1")!,
                                               workspace: "ws-new").absoluteString,
                       "https://gamma.example/?page=1&ws=ws-new")
        let session = GammaWebSession(id: UUID(), serverURL: server, workspace: "ws-alpha", cookies: [])
        XCTAssertEqual(session.startURL, GammaWebSession.startURL(serverURL: server, workspace: "ws-alpha"))
    }

    private func info(workspaces: [GammaWorkspaceOption], defaultWorkspace: String = "ws-personal") -> GammaSessionInfo {
        GammaSessionInfo(user: "alice", isGuest: false, isAdmin: false,
                         defaultWorkspace: defaultWorkspace, workspaces: workspaces)
    }
    private let owner = GammaWorkspaceOption(id: "ws-personal", name: "Personal", role: "owner", isDefault: true)
    private let editor = GammaWorkspaceOption(id: "ws-shared", name: "Team", role: "editor")
    private let viewer = GammaWorkspaceOption(id: "ws-readonly", name: "Read only", role: "viewer")

    func testHandoffWorkspaceMustBeListedAndWritable() {
        let session = info(workspaces: [owner, editor, viewer])
        XCTAssertEqual(try? GammaWebHandoffCheck.workspace("ws-shared", session: session).get().id, "ws-shared")
        XCTAssertEqual(try? GammaWebHandoffCheck.workspace("ws-personal", session: session).get().id, "ws-personal")
        guard case .failure(.workspaceReadOnly) = GammaWebHandoffCheck.workspace("ws-readonly", session: session) else {
            return XCTFail("A viewer role must be refused, not silently downgraded")
        }
        guard case .failure(.workspaceUnknown) = GammaWebHandoffCheck.workspace("ws-ghost", session: session) else {
            return XCTFail("An unlisted workspace must be refused")
        }
    }

    func testHandoffAccountComesFromTheSessionNotTheMessage() {
        let session = info(workspaces: [owner])
        XCTAssertEqual(try? GammaWebHandoffCheck.account("alice", session: session).get(), "alice")
        guard case .failure(.accountChanged) = GammaWebHandoffCheck.account("bob", session: session) else {
            return XCTFail("a different account must be refused")
        }
        let signedOut = GammaSessionInfo(user: nil, isGuest: false, isAdmin: false,
                                        defaultWorkspace: "", workspaces: [owner])
        guard case .failure(.accountChanged) = GammaWebHandoffCheck.account("alice", session: signedOut) else {
            return XCTFail("no session user must be refused")
        }
    }

    func testHandoffPageMustBeTheNamedRootDocument() {
        let page = GammaBlock(id: "page", parentID: "root", content: "Paper",
                              properties: GammaProperties(docID: "doc"))
        XCTAssertEqual(try? GammaWebHandoffCheck.page(page, pageID: "page", docID: "doc").get().id, "page")
        XCTAssertThrowsError(try GammaWebHandoffCheck.page(page, pageID: "other", docID: "doc").get())
        XCTAssertThrowsError(try GammaWebHandoffCheck.page(page, pageID: "page", docID: "other").get())
        var child = page; child.parentID = "page-parent"
        guard case .failure(.pageIdentity) = GammaWebHandoffCheck.page(child, pageID: "page", docID: "doc") else {
            return XCTFail("a non-root block must be refused")
        }
    }
}
