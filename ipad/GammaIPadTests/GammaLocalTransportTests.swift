import XCTest
@testable import GammaIPad

final class GammaLocalTransportTests: XCTestCase {
    private func access(_ raw: String = "http://127.0.0.1:49152", capability: String = String(repeating: "a", count: 32)) throws -> GammaLocalServerAccess {
        let url = URL(string: raw)!
        func cookie(_ name: String, _ value: String) -> HTTPCookie {
            HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": "\(name)=\(value); Path=/; HttpOnly; SameSite=Strict"],
                               for: URL(string: "http://127.0.0.1:49152")!).first!
        }
        return try GammaLocalServerAccess(trustedHostURL: url, account: "local-user", workspace: "local-ws",
            sessionCookie: cookie("session", "session-value"), capabilityCookie: cookie("gamma_local", capability),
            cacheIdentity: "gamma-local://device")
    }

    func testRemoteHTTPRemainsRefusedIncludingLoopback() throws {
        for raw in ["http://example.com", "http://127.0.0.1:49152"] {
            XCTAssertThrowsError(try GammaAPI(server: raw))
            let url = URL(string: raw)!
            XCTAssertFalse(GammaWebOrigin(url: url).isValidURL(url))
            XCTAssertNil(GammaWebOrigin.wireOrigin(url))
        }
    }

    func testOnlyHostBoundAuthorityAllowsHTTP() throws {
        for raw in ["http://localhost:49152", "http://127.0.0.2:49152", "http://127.0.0.1", "http://127.0.0.1:80",
                    "https://127.0.0.1:49152", "http://127.0.0.1:49152/path", "http://127.0.0.1:49152?secret=x",
                    "http://user@127.0.0.1:49152"] {
            XCTAssertThrowsError(try access(raw))
        }
        XCTAssertThrowsError(try access(capability: "short"))
        let authority = try access()
        let origin = GammaWebOrigin(access: authority)
        XCTAssertTrue(origin.isValidURL(authority.baseURL))
        XCTAssertEqual(origin.trustedWireOrigin(authority.baseURL), "http://127.0.0.1:49152")
        for raw in ["http://127.0.0.1:49153/api/session", "http://localhost:49152", "http://example.com:49152"] {
            XCTAssertFalse(origin.isValidURL(URL(string: raw)!))
            XCTAssertNil(origin.trustedWireOrigin(URL(string: raw)!))
            XCTAssertNil(authority.authorize(URLRequest(url: URL(string: raw)!)))
        }
    }

    func testEveryNativeRequestCarriesBothCredentialsAndBoundIdentity() throws {
        let authority = try access()
        let api = GammaAPI(localServer: authority)
        defer { api.close() }
        for path in ["api/session", "api/blocks/page/subtree", "api/assets/file", "api/uploads/pdf"] {
            let request = try api.makeRequest(path)
            XCTAssertEqual(request.value(forHTTPHeaderField: authority.capabilityHeader), authority.capabilityCookie.value)
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "session=session-value; gamma_local=" + authority.capabilityCookie.value)
            XCTAssertFalse(request.httpShouldHandleCookies)
            if path != "api/session" {
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Gamma-User"), authority.account)
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Gamma-Workspace"), authority.workspace)
            }
        }
        XCTAssertTrue(api.sessionCookies().isEmpty, "Local credentials cannot enter Keychain persistence")
        XCTAssertThrowsError(try api.bind(workspace: "different"))
    }

    func testRedirectCannotLeakCredentialsAcrossPortOrHost() throws {
        let authority = try access()
        let api = GammaAPI(localServer: authority)
        defer { api.close() }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let task = session.dataTask(with: authority.baseURL)
        let response = HTTPURLResponse(url: authority.baseURL, statusCode: 302, httpVersion: nil, headerFields: nil)!
        for raw in ["http://127.0.0.1:49153/", "http://localhost:49152/", "https://example.com/", "http://user@127.0.0.1:49152/"] {
            api.urlSession(session, task: task, willPerformHTTPRedirection: response,
                           newRequest: URLRequest(url: URL(string: raw)!)) { XCTAssertNil($0) }
        }
        api.urlSession(session, task: task, willPerformHTTPRedirection: response,
                       newRequest: URLRequest(url: authority.baseURL.appendingPathComponent("api/session"))) {
            XCTAssertEqual($0?.value(forHTTPHeaderField: authority.capabilityHeader), authority.capabilityCookie.value)
            XCTAssertNotNil($0?.value(forHTTPHeaderField: "Cookie"))
        }
    }

    func testExternalBrowserURLsCannotCarryLocalCredentials() throws {
        let authority = try access()
        XCTAssertTrue(authority.permitsExternalBrowserURL(URL(string: "https://example.com/paper?id=123")!))
        XCTAssertTrue(authority.permitsExternalBrowserURL(URL(string: "http://example.com/reference")!))
        for raw in ["http://127.0.0.1:49152/", "http://127.0.0.1:49153/", "http://localhost/",
                    "http://other.localhost/", "http://[::1]/", "https://user:password@example.com/",
                    "https://example.com/?token=" + authority.capabilityCookie.value,
                    "https://example.com/#session-value", "https://example.com/?token=%73ession-value",
                    "file:///tmp/reference"] {
            XCTAssertFalse(authority.permitsExternalBrowserURL(URL(string: raw)!))
        }
    }

    func testNewLifetimeHasNewEpochButStableCacheIdentity() throws {
        let first = try access(), second = try access("http://127.0.0.1:49153")
        XCTAssertNotEqual(first.epoch, second.epoch)
        XCTAssertEqual(first.cacheIdentity, second.cacheIdentity)
        let firstAPI = GammaAPI(localServer: first), secondAPI = GammaAPI(localServer: second)
        let remoteAPI = try GammaAPI(server: "https://example.com/gamma/")
        defer { firstAPI.close(); secondAPI.close(); remoteAPI.close() }
        XCTAssertEqual(firstAPI.cacheServerIdentity, "gamma-local://device")
        XCTAssertEqual(firstAPI.cacheServerIdentity, secondAPI.cacheServerIdentity)
        XCTAssertNotEqual(firstAPI.baseURL, secondAPI.baseURL)
        XCTAssertEqual(remoteAPI.cacheServerIdentity, "https://example.com/gamma")
        XCTAssertFalse(first.permits(second.baseURL))
        let repeatedPort = try access()
        XCTAssertNotEqual(first.epoch, repeatedPort.epoch)
        XCTAssertFalse(String(describing: first).contains(first.capabilityCookie.value))
        XCTAssertTrue(Mirror(reflecting: first).children.isEmpty)
    }
}
