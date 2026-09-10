import XCTest
@testable import GammaIPad

final class GammaAPITests: XCTestCase {
    func testRejectsUnsafeServerURLs() {
        for server in ["http://example.com", "file:///tmp/server", "https://user:pass@example.com",
                       "https://example.com?token=secret", "https://example.com#fragment", "not a url"] {
            XCTAssertThrowsError(try GammaAPI(server: server), server)
        }
    }

    func testDecodesGammaBlockPropertiesWithoutRequiringOtherMetadata() throws {
        let data = Data(#"{"id":"page-1","content":"A paper","properties":{"type":"page","doc_id":"abc123","meta":{"year":2026}}}"#.utf8)
        let paper = try JSONDecoder().decode(GammaPaper.self, from: data)
        XCTAssertEqual(paper.id, "page-1")
        XCTAssertEqual(paper.content, "A paper")
        XCTAssertEqual(paper.properties.docID, "abc123")
        let note = try JSONDecoder().decode(GammaPaper.self, from: Data(#"{"id":"note-1","content":"Note","properties":{}}"#.utf8))
        XCTAssertNil(note.properties.docID)
    }

    func testDecodesInkAndNestedNotesUsingGammaIdentity() throws {
        let data = Data(#"{"id":"page-1","content":"Paper","properties":{"doc_id":"doc-1"},"children":[{"id":"ink-1","parent_id":"page-1","content":"My annotation","properties":{"type":"pdf_ink","pdf_page":2,"ink_asset":"/api/assets/abc.pkdrawing","preview_asset":"/api/assets/abc.png","ink_revision":4},"children":[{"id":"note-1","parent_id":"ink-1","content":"A child note","properties":{}}]}]}"#.utf8)
        let tree = try JSONDecoder().decode(GammaBlock.self, from: data)
        XCTAssertEqual(tree.flattened.map(\.id), ["page-1", "ink-1", "note-1"])
        let ink = try XCTUnwrap(tree.children?.first)
        XCTAssertTrue(ink.isInk)
        XCTAssertEqual(ink.properties.pdfPage, 2)
        XCTAssertEqual(ink.properties.revision, 4)
        XCTAssertEqual(ink.properties.inkAsset, "/api/assets/abc.pkdrawing")
        XCTAssertEqual(ink.children?.first?.parentID, ink.id)
    }

    func testAccountMismatchIsNotAnInkRevisionConflict() throws {
        let api = try GammaAPI(server: "https://example.com")
        defer { api.close() }
        let url = URL(string: "https://example.com/api/blocks/ink/ink")!
        let mismatch = HTTPURLResponse(url: url, statusCode: 409, httpVersion: nil,
                                       headerFields: ["X-Gamma-Session-User": "other-user"])!
        XCTAssertThrowsError(try api.validate(mismatch)) { error in
            guard case GammaAPI.APIError.message(let message) = error else {
                return XCTFail("Account mismatch must not trigger ink conflict resolution")
            }
            XCTAssertTrue(message.contains("account changed"))
        }
        let conflict = HTTPURLResponse(url: url, statusCode: 409, httpVersion: nil, headerFields: nil)!
        XCTAssertThrowsError(try api.validate(conflict)) { error in
            guard case GammaAPI.APIError.conflict = error else { return XCTFail("Expected ink conflict") }
        }
        for path in ["api/login", "api/session", "api/logout"] {
            XCTAssertNil(api.makeRequest(path).value(forHTTPHeaderField: "X-Gamma-User"))
        }
    }

    func testAcceptsHTTPSAndDeploymentPrefix() throws {
        let api = try GammaAPI(server: "https://example.com/gamma/")
        api.close()
    }

    func testRedirectPolicyRejectsOtherOriginAndDowngrade() throws {
        let api = try GammaAPI(server: "https://example.com")
        defer { api.close() }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let original = URL(string: "https://example.com/api/login")!
        let task = session.dataTask(with: original)
        let response = HTTPURLResponse(url: original, statusCode: 302, httpVersion: nil, headerFields: nil)!
        for destination in ["https://other.example.com/api/login", "http://example.com/api/login",
                            "https://example.com:8443/api/login"] {
            var called = false
            api.urlSession(session, task: task, willPerformHTTPRedirection: response,
                           newRequest: URLRequest(url: URL(string: destination)!)) { request in
                called = true
                XCTAssertNil(request)
            }
            XCTAssertTrue(called)
        }
        api.urlSession(session, task: task, willPerformHTTPRedirection: response,
                       newRequest: URLRequest(url: URL(string: "https://example.com/api/session")!)) {
            XCTAssertNotNil($0)
        }
    }
}
