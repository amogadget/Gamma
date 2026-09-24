import XCTest
@testable import GammaIPad

final class GammaEmbeddedRuntimeContractTests: XCTestCase {
    private func payload(url: String = "http://127.0.0.1:49152/", secure: Bool = false) throws -> Data {
        func cookie(_ name: String) -> [String: Any] {
            ["name": name, "value": String(repeating: "x", count: 48),
             "domain": "127.0.0.1", "path": "/", "http_only": true,
             "same_site": "Strict", "secure": secure, "host_only": true]
        }
        return try JSONSerialization.data(withJSONObject: [
            "url": url, "account": "test-owner", "workspace": "test-workspace",
            "session_cookie": cookie("session"),
            "capability_cookie": cookie("gamma-test-capability"),
            "capability_header": "X-Gamma-Local-Capability"
        ])
    }
    func testPrivateBootstrapAndCookies() throws {
        let bootstrap = try GammaEmbeddedBootstrap(json: payload())
        XCTAssertEqual(bootstrap.capability, bootstrap.capabilityCookie.value)
        XCTAssertEqual(String(describing: bootstrap), "<private embedded bootstrap>")
        XCTAssertTrue(bootstrap.customMirror.children.isEmpty)
        let cookie = try bootstrap.sessionCookie.httpCookie(origin: bootstrap.url)
        XCTAssertEqual(cookie.domain, "127.0.0.1")
        XCTAssertEqual(cookie.path, "/")
        XCTAssertTrue(cookie.isHTTPOnly)
        XCTAssertFalse(cookie.isSecure)
        XCTAssertNil(cookie.expiresDate)
        XCTAssertTrue(bootstrap.permits(URL(string: "http://127.0.0.1:49152/api/session")!))
        XCTAssertFalse(bootstrap.permits(URL(string: "http://127.0.0.1:49153/")!))
    }
    func testRejectsUnsafeOriginsAndCredentialURLs() throws {
        for url in ["https://127.0.0.1:49152/", "http://localhost:49152/",
                    "http://127.0.0.1:80/", "http://127.0.0.1:49152/?cap=secret",
                    "http://user:secret@127.0.0.1:49152/", "http://127.0.0.1:49152/#secret",
                    "http://127.0.0.1:49152/secret"] {
            XCTAssertThrowsError(try GammaEmbeddedBootstrap(json: payload(url: url)))
        }
        XCTAssertThrowsError(try GammaEmbeddedBootstrap(json: payload(secure: true)))
    }
}
