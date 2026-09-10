import XCTest
import SwiftUI
import PDFKit
@testable import GammaIPad

final class GammaReaderUITests: XCTestCase {
    @MainActor
    func testReadingLayoutWithExistingHighlights() async throws {
        let title = "Sign-changing photon-mediated atom interactions in multimode cavity QED"
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792))
        let pdf = try XCTUnwrap(PDFDocument(data: renderer.pdfData { context in
            context.beginPage()
            ("Sign-changing photon-mediated atom interactions" as NSString).draw(at: CGPoint(x: 40, y: 50),
                withAttributes: [.font: UIFont(name: "TimesNewRomanPS-BoldMT", size: 20)!])
            ("in multimode cavity QED" as NSString).draw(at: CGPoint(x: 40, y: 78),
                withAttributes: [.font: UIFont(name: "TimesNewRomanPS-BoldMT", size: 20)!])
            ("Yudan Guo, Ronen M. Kroeze, Varun D. Vaidya, and Benjamin L. Lev" as NSString)
                .draw(at: CGPoint(x: 40, y: 120), withAttributes: [.font: UIFont.systemFont(ofSize: 11)])
            let text = "Sign-changing interactions are at the heart of frustrated systems.\n\nWe investigate how cavity photons mediate interactions between atoms.\nThe spatial structure of the field determines the sign of the interaction.\n\nThis provides a route to studying many-body physics with controllable\ncouplings, opening new possibilities for experimental quantum simulation."
            (text as NSString).draw(in: CGRect(x: 40, y: 180, width: 532, height: 500),
                withAttributes: [.font: UIFont(name: "TimesNewRomanPSMT", size: 15)!])
        }))
        let rect = GammaHighlightRect(x1: 40, y1: 180, x2: 440, y2: 198, width: 612, height: 792, pageNumber: 1)
        let position = GammaHighlightPosition(pageNumber: 1, boundingRect: rect, rects: [rect], area: false)
        let highlight = GammaBlock(id: "highlight-1", parentID: "paper", content: "Key idea: photon-mediated interactions whose sign depends on atom position.",
            properties: GammaProperties(pdfPage: 1, highlightID: "h1", quote: "Sign-changing interactions are at the heart of frustrated systems.", color: "rgba(255,226,143,0.65)", pdfPosition: position))
        let paper = GammaBlock(id: "paper", parentID: "root", content: title, properties: GammaProperties(docID: "preview"))
        let workspace = GammaWorkspace()
        workspace.paper = paper; workspace.document = pdf
        workspace.page = GammaPageCache(pageID: paper.id, docID: "preview", blocks: [highlight,
            GammaBlock(id: "note", parentID: highlight.id, content: "Compare with the phonon-mediated approach.", properties: GammaProperties())])
        workspace.selectedID = highlight.id
        workspace.status = "Synced with Gamma"
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let oldKey = scene.windows.first { $0.isKeyWindow }
        let host = UIHostingController(rootView: GammaReaderView(workspace: workspace, paper: paper, document: pdf)
            .frame(width: 1194, height: 834))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1194, height: 834)
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; oldKey?.makeKeyAndVisible() }
        host.view.frame = window.bounds; host.view.setNeedsLayout(); host.view.layoutIfNeeded()
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { c.resume() }
        }
        host.view.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: host.view.bounds).image { _ in
            XCTAssertTrue(host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true))
        }
        let attachment = XCTAttachment(image: image); attachment.name = "Gamma-reader-web-inspired-landscape"; attachment.lifetime = .keepAlways
        add(attachment)
        XCTAssertEqual(workspace.page?.blocks.first?.properties.quote, highlight.properties.quote)
        XCTAssertGreaterThan(host.view.bounds.width, 900)
    }
}
