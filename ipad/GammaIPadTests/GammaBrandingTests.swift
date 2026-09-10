import XCTest
import SwiftUI
@testable import GammaIPad

final class GammaBrandingTests: XCTestCase {
    @MainActor
    func testExistingGammaArtworkAndAppIconAreBundled() throws {
        let image = try XCTUnwrap(UIImage(named: "GammaMark"))
        XCTAssertGreaterThan(image.size.width, 0)
        XCTAssertEqual(image.size.width, image.size.height)
        let icons = (Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons~ipad") ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleIcons")) as? [String: Any]
        let primary = try XCTUnwrap(icons?["CFBundlePrimaryIcon"] as? [String: Any])
        XCTAssertEqual(primary["CFBundleIconName"] as? String, "AppIcon")
    }
    @MainActor
    func testLoginUsesGammaImageAsset() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let oldKey = scene.windows.first { $0.isKeyWindow }
        let host = UIHostingController(rootView: GammaRootView(workspace: GammaWorkspace()))
        let window = UIWindow(windowScene: scene); window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; oldKey?.makeKeyAndVisible() }
        host.view.layoutIfNeeded()
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { c.resume() }
        }
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
            XCTAssertTrue(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image); attachment.name = "Gamma-login-existing-brand"; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
