import XCTest
import SwiftUI
import Vision
@testable import GammaIPad

private final class LocalUISessionStore: GammaSessionPersistence {
    func load() throws -> GammaSavedSession? { nil }
    func save(_ session: GammaSavedSession) throws { XCTFail("Local startup must not save a server session") }
    func clear() throws { XCTFail("Local startup must not erase a server session") }
}

final class GammaLocalUIIntegrationTests: XCTestCase {
    @MainActor
    func testFreshRootRendersLocalImportWithoutLoginOrNetworking() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let suite = UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { try? FileManager.default.removeItem(at: root); defaults.removePersistentDomain(forName: suite) }
        var requests = 0
        let workspace = GammaWorkspace(sessionStore: LocalUISessionStore(),
            localLibraryRoot: root, libraryDefaults: defaults,
            sessionAPIFactory: { _ in requests += 1; throw URLError(.notConnectedToInternet) })
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let oldKey = scene.windows.first(where: \.isKeyWindow)
        let size = CGSize(width: 1194, height: 834)
        let host = UIHostingController(rootView: GammaRootView(workspace: workspace).frame(width: size.width, height: size.height))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; oldKey?.makeKeyAndVisible() }
        host.view.frame = window.bounds; host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(600))
        host.view.layoutIfNeeded()
        XCTAssertTrue(workspace.isLocal)
        XCTAssertNil(workspace.username); XCTAssertNil(workspace.api); XCTAssertNil(workspace.webSession)
        XCTAssertEqual(requests, 0)
        XCTAssertNil(workspace.sessionLifecycle.monitor)
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
            XCTAssertTrue(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = "Gamma-local-first-launch-no-login"
        attachment.lifetime = .keepAlways; add(attachment)
        // Inspect actual rendered text, not only the view model or Swift source.
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(cgImage: XCTUnwrap(image.cgImage), options: [:]).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ").lowercased()
        XCTAssertTrue(text.contains("import pdf"), "Missing visible local import action: \(text)")
        XCTAssertTrue(text.contains("on this ipad"), "Missing local library label: \(text)")
        XCTAssertFalse(text.contains("sign in"), "Fresh local startup must not show a login form: \(text)")
    }
}
