import UIKit

struct GammaHighlightRect: Codable, Equatable {
    var x1: Double
    var y1: Double
    var x2: Double
    var y2: Double
    var width: Double?
    var height: Double?
    var pageNumber: Int?
}

struct GammaHighlightPosition: Codable, Equatable {
    var pageNumber: Int?
    var boundingRect: GammaHighlightRect?
    var rects: [GammaHighlightRect]?
    var area: Bool?
}

struct GammaPDFHighlight {
    let id: String
    let position: GammaHighlightPosition
    let color: String?
    let selected: Bool

    /// Web stores top-left viewport coordinates and the viewport's original size.
    /// PDFView supplies the *displayed* page rect, already accounting for rotation.
    func rectangles(in displayedPage: CGRect, pageNumber: Int) -> [CGRect] {
        let stored = position.rects ?? position.boundingRect.map { [$0] } ?? []
        let width = position.boundingRect?.width ?? stored.first?.width ?? 1
        let height = position.boundingRect?.height ?? stored.first?.height ?? 1
        guard width.isFinite, height.isFinite, width > 0, height > 0 else { return [] }
        return stored.compactMap { rect in
            guard (rect.pageNumber ?? position.pageNumber ?? pageNumber) == pageNumber,
                  [rect.x1, rect.x2, rect.y1, rect.y2].allSatisfy(\.isFinite),
                  rect.x2 > rect.x1, rect.y2 > rect.y1 else { return nil }
            let result = CGRect(x: displayedPage.minX + rect.x1 / width * displayedPage.width,
                                y: displayedPage.minY + rect.y1 / height * displayedPage.height,
                                width: (rect.x2 - rect.x1) / width * displayedPage.width,
                                height: (rect.y2 - rect.y1) / height * displayedPage.height)
                .intersection(displayedPage)
            return result.isNull || result.isEmpty ? nil : result
        }
    }

    static func uiColor(_ value: String?) -> UIColor {
        guard let value else { return UIColor(red: 1, green: 0.84, blue: 0.36, alpha: 0.35) }
        if value.hasPrefix("#") {
            let hex = String(value.dropFirst())
            if hex.count == 6, let rgb = UInt32(hex, radix: 16) {
                return UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
                               green: CGFloat((rgb >> 8) & 255) / 255,
                               blue: CGFloat(rgb & 255) / 255, alpha: 0.35)
            }
        }
        if value.hasPrefix("rgb"), let start = value.firstIndex(of: "("), let end = value.firstIndex(of: ")") {
            let values = value[value.index(after: start)..<end].split(separator: ",").compactMap {
                Double($0.trimmingCharacters(in: .whitespaces))
            }
            if values.count >= 3, values.allSatisfy(\.isFinite) {
                return UIColor(red: CGFloat(min(255, max(0, values[0]))) / 255,
                               green: CGFloat(min(255, max(0, values[1]))) / 255,
                               blue: CGFloat(min(255, max(0, values[2]))) / 255,
                               alpha: CGFloat(values.count > 3 ? min(0.45, max(0.12, values[3])) : 0.35))
            }
        }
        return UIColor(red: 1, green: 0.84, blue: 0.36, alpha: 0.35)
    }
}

@MainActor
final class GammaHighlightLayer: UIView {
    var highlights: [GammaPDFHighlight] = []
    var displayedPage: CGRect = .zero
    var pageNumber = 1
    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        for item in highlights {
            let color = GammaPDFHighlight.uiColor(item.color)
            for box in item.rectangles(in: displayedPage, pageNumber: pageNumber) {
                context.setFillColor(color.withAlphaComponent(item.position.area == true ? 0.10 : color.cgColor.alpha).cgColor)
                context.fill(box)
                if item.position.area == true || item.selected {
                    context.setStrokeColor(color.withAlphaComponent(0.85).cgColor)
                    context.setLineWidth(item.selected ? 1.5 : 1)
                    context.stroke(box.insetBy(dx: 0.75, dy: 0.75))
                }
            }
        }
    }
}
