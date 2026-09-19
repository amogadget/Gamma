import XCTest
import Foundation
@testable import GammaIPad

private final class GammaWireProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        let path = request.url!.path
        let body: String
        if path.hasSuffix("/login") {
            body = #"{"ok":true,"username":"actual-user"}"#
        } else if path.hasSuffix("/session") {
            body = #"{"user":"actual-user","default_workspace":"ws-alpha","workspaces":[{"id":"ws-alpha","name":"Personal","role":"owner","personal":true,"default":true}]}"#
        } else if path.hasSuffix("/note") {
            let id = request.url!.deletingLastPathComponent().lastPathComponent
            body = "{\"id\":\"\(id)\",\"parent_id\":\"ink-parent\",\"content\":\"Note\",\"properties\":{\"native_note\":true,\"note_revision\":1}}"
        } else if path.hasSuffix("/ink") {
            let id = request.url!.deletingLastPathComponent().lastPathComponent
            body = "{\"id\":\"\(id)\",\"parent_id\":\"page\",\"content\":\"\",\"properties\":{\"type\":\"pdf_ink\",\"pdf_page\":1,\"ink_revision\":1}}"
        } else { body = #"{"children":[]}"# }
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class GammaWireTests: XCTestCase {
    func testWebCookieAdoptionRevalidatesIdentityAndExportsOwnCookies() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GammaWireProtocol.self]
        let api = try GammaAPI(server: "https://gamma.example", workspace: "ws-alpha", configuration: config)
        defer { api.close() }
        let own = try XCTUnwrap(HTTPCookie(properties: [.domain: "gamma.example", .path: "/", .name: "session", .value: "test-only", .secure: "TRUE"]))
        let foreign = try XCTUnwrap(HTTPCookie(properties: [.domain: "other.example", .path: "/", .name: "foreign", .value: "never-copy"]))
        let info = try await api.adoptWebSession(cookies: [own, foreign])
        XCTAssertEqual(info.user, "actual-user")
        // The adopted session also reports the workspaces the handoff may name.
        XCTAssertEqual(info.workspaces.map(\.id), ["ws-alpha"])
        XCTAssertEqual(info.verifiedDefaultWorkspace, "ws-alpha")
        XCTAssertEqual(try api.makeRequest("api/blocks/root/children").value(forHTTPHeaderField: "X-Gamma-User"), "actual-user")
        XCTAssertEqual(try api.makeRequest("api/blocks/root/children").value(forHTTPHeaderField: "X-Gamma-Workspace"), "ws-alpha")
        XCTAssertEqual(api.sessionCookies().filter { $0.name == "session" }.count, 1)
        XCTAssertFalse(api.sessionCookies().contains { $0.name == "foreign" })
    }
    func testLoginIdentityAndIdempotentNativeNoteWireContract() async throws {
        GammaWireProtocol.requests = []
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GammaWireProtocol.self]
        let api = try GammaAPI(server: "https://gamma.example/prefix", workspace: "ws-alpha", configuration: config)
        defer { api.close() }
        let user = try await api.login(username: "typed-user", password: "test-only")
        XCTAssertEqual(user, "actual-user")
        let id = UUID().uuidString.lowercased()
        let first = try await api.putNote(id: id, parent: "ink-parent", content: "Note", revision: 0)
        let retry = try await api.putNote(id: id, parent: "ink-parent", content: "Note", revision: 0)
        XCTAssertEqual(first.id, id)
        XCTAssertEqual(retry.id, id)
        XCTAssertEqual(first.properties.noteRevision, 1)
        XCTAssertEqual(first.properties.nativeNote, true)
        let requests = GammaWireProtocol.requests
        XCTAssertEqual(requests.count, 3)
        XCTAssertNil(requests[0].value(forHTTPHeaderField: "X-Gamma-User"))
        for request in requests.dropFirst() {
            XCTAssertEqual(request.httpMethod, "PUT")
            XCTAssertEqual(request.url?.path, "/prefix/api/blocks/\(id)/note")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Gamma-User"), "actual-user")
            // Every data request names its library, so a retry cannot land elsewhere.
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Gamma-Workspace"), "ws-alpha")
        }
        XCTAssertNil(try api.makeRequest("api/logout").value(forHTTPHeaderField: "X-Gamma-User"))
        XCTAssertNil(try api.makeRequest("api/logout").value(forHTTPHeaderField: "X-Gamma-Workspace"))
    }
}
