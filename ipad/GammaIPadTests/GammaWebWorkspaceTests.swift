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
    func testBridgeOnlyAcceptsBoundedDocumentIdentity() {
        let payload: [String: Any] = ["type": "openPDF", "pageID": "page", "docID": "doc", "title": "Paper", "user": "alice"]
        XCTAssertEqual(GammaWebMessageValidator.openPDF(from: payload)?.pageID, "page")
        var bad = payload; bad["user"] = ""
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: bad))
        bad = payload; bad["type"] = "execute"
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: bad))
        bad = payload; bad["title"] = String(repeating: "x", count: 513)
        XCTAssertNil(GammaWebMessageValidator.openPDF(from: bad))
    }
}
