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
    func testLoginIdentityAndIdempotentNativeNoteWireContract() async throws {
        GammaWireProtocol.requests = []
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [GammaWireProtocol.self]
        let api = try GammaAPI(server: "https://gamma.example/prefix", configuration: config)
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
        }
        XCTAssertNil(api.makeRequest("api/logout").value(forHTTPHeaderField: "X-Gamma-User"))
    }
}
