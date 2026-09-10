import XCTest
import SwiftUI
@testable import GammaIPad

final class GammaLibraryUITests: XCTestCase {
    @MainActor
    private func fixture() -> GammaWorkspace {
        let workspace = GammaWorkspace()
        workspace.username = "Reader"
        let entries = [
            ("Sign-changing photon-mediated atom interactions in multimode cavity QED", "Cavity QED"),
            ("Probing many-body dynamics on a 51-atom quantum simulator", "Atom arrays"),
            ("Quantum phases of matter on a 256-atom programmable quantum simulator", "Atom arrays"),
            ("Cavity QED with quantum gases: new paradigms in many-body physics", "Cavity QED"),
            ("Microwave shielding of ultracold polar molecules", "Molecular physics"),
            ("Deterministic preparation of low-entropy molecular arrays", "Molecular physics/Preparation"),
        ]
        workspace.papers = entries.enumerated().map { index, item in
            GammaBlock(id: "page-\(index)", parentID: "root", content: item.0,
                       properties: GammaProperties(docID: "doc-\(index)", folder: item.1), updatedAt: "2026-09-09T12:00:0\(index)")
        }
        workspace.recentPageIDs = ["page-0", "page-3", "page-2", "page-1"]
        workspace.status = "Synced with Gamma"
        return workspace
    }
    @MainActor
    func testAuthenticatedLibraryLandscapeAndPortraitScreenshots() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let oldKey = scene.windows.first { $0.isKeyWindow }
        for size in [CGSize(width: 1194, height: 834), CGSize(width: 834, height: 1194)] {
            let workspace = fixture()
            let host = UIHostingController(rootView: GammaRootView(workspace: workspace).frame(width: size.width, height: size.height))
            let window = UIWindow(windowScene: scene); window.frame = CGRect(origin: .zero, size: size)
            window.rootViewController = host; window.makeKeyAndVisible()
            defer { window.isHidden = true; window.rootViewController = nil; oldKey?.makeKeyAndVisible() }
            host.view.frame = window.bounds; host.view.layoutIfNeeded()
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { c.resume() }
            }
            let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
                XCTAssertTrue(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true))
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = size.width > size.height ? "Gamma-library-landscape" : "Gamma-library-portrait"
            attachment.lifetime = .keepAlways; add(attachment)
            XCTAssertEqual(workspace.papers.count, 6)
        }
    }
    @MainActor
    func testRealFolderMembershipIsHierarchyAware() {
        let workspace = fixture()
        let nested = workspace.papers[5]
        XCTAssertTrue(GammaLibraryView.belongs(nested, to: "Molecular physics"))
        XCTAssertTrue(GammaLibraryView.belongs(nested, to: "Molecular physics/Preparation"))
        XCTAssertFalse(GammaLibraryView.belongs(nested, to: "Molecular"))
    }
    func testRecentsPersistPerAccountAndDeduplicate() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = URL(string: "https://gamma.example")!
        let cache = try GammaCache(rootURL: root, server: url, username: "alice")
        _ = try cache.recordRecent("page-a"); _ = try cache.recordRecent("page-b")
        XCTAssertEqual(try cache.recordRecent("page-a"), ["page-a", "page-b"])
        XCTAssertEqual(try GammaCache(rootURL: root, server: url, username: "alice").recentPageIDs(), ["page-a", "page-b"])
        XCTAssertTrue(try GammaCache(rootURL: root, server: url, username: "bob").recentPageIDs().isEmpty)
    }
}
