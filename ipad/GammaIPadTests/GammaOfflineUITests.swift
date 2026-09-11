import XCTest
import SwiftUI
@testable import GammaIPad

final class GammaOfflineUITests: XCTestCase {
    @MainActor
    func testDownloadManagementPortraitAndLandscape() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let oldKey = scene.windows.first { $0.isKeyWindow }
        for size in [CGSize(width: 1194, height: 834), CGSize(width: 834, height: 1194)] {
            let workspace = GammaWorkspace()
            workspace.username = "Offline test reader"; workspace.accountServer = "https://offline-test.invalid"
            workspace.isOffline = true; workspace.localUsageBytes = 12_000_000
            workspace.papers = (0..<4).map { index in
                GammaPaper(id: "page-\(index)", parentID: "root", content: "Offline document \(index + 1)", properties: GammaProperties(docID: "doc-\(index)"))
            }
            for (index, paper) in workspace.papers.enumerated() {
                workspace.localDocumentBytes[paper.id] = 3_000_000
                workspace.offlineEntries[paper.id] = GammaOfflineEntry(pageID: paper.id, paper: paper,
                    state: index == 0 ? .ready : .failed, pdfReady: true, snapshotReady: true, audioReady: index == 0,
                    error: index == 0 ? nil : "A recording segment is missing. Local recovery files were preserved.")
            }
            let host = UIHostingController(rootView: GammaDownloadsView(workspace: workspace))
            let window = UIWindow(windowScene: scene); window.frame = CGRect(origin: .zero, size: size)
            window.rootViewController = host; window.makeKeyAndVisible()
            defer { window.isHidden = true; window.rootViewController = nil; oldKey?.makeKeyAndVisible() }
            host.view.frame = window.bounds; host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(400))
            let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
                XCTAssertTrue(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true))
            }
            let attachment = XCTAttachment(image: image)
            attachment.name = size.width > size.height ? "Gamma-offline-landscape" : "Gamma-offline-portrait"
            attachment.lifetime = .keepAlways; add(attachment)
            XCTAssertNil(workspace.webSession)
            XCTAssertEqual(workspace.offlineEntries.count, 4)
        }
    }
    @MainActor
    func testReconnectFormShowsAccountAndPasswordWithoutLeavingLocalWorkspace() async throws {
        let workspace = GammaWorkspace()
        workspace.username = "Offline test reader"
        workspace.accountServer = "https://offline-test.invalid"
        workspace.isOffline = true
        let paper = GammaPaper(id: "current", parentID: "root", content: "Current PDF", properties: GammaProperties(docID: "doc"))
        workspace.paper = paper
        let host = UIHostingController(rootView: GammaReconnectView(workspace: workspace))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let oldKey = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; oldKey?.makeKeyAndVisible() }
        host.view.layoutIfNeeded()
        try await Task.sleep(for: .milliseconds(400))
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
            XCTAssertTrue(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image); attachment.name = "Gamma-reconnect-form"
        attachment.lifetime = .keepAlways; add(attachment)
        XCTAssertTrue(workspace.isOffline); XCTAssertEqual(workspace.paper?.id, paper.id)
        XCTAssertNil(workspace.api)
    }

}
