import PDFKit
import UIKit

struct GammaSelectedText: Codable, Equatable {
    let page: Int // one-based, same as Web pdf_position
    let quote: String
    let position: GammaHighlightPosition
}

@MainActor
enum GammaTextSelection {
    /// One block per selected PDF page, matching Web's page-scoped highlight model.
    /// Store viewport-relative coordinates with their original dimensions; use
    /// PDFKit conversion so rotations/crop offsets are not guessed manually.
    static func highlights(from selection: PDFSelection?, in view: PDFView) -> [GammaSelectedText] {
        guard let selection, let document = view.document else { return [] }
        let lines = selection.selectionsByLine()
        return selection.pages.compactMap { page in
            let index = document.index(for: page)
            guard index != NSNotFound else { return nil }
            let number = index + 1
            guard number > 0, number <= document.pageCount else { return nil }
            let pageRect = view.convert(page.bounds(for: .cropBox), from: page).standardized
            guard pageRect.width > 0, pageRect.height > 0 else { return nil }
            var rects: [GammaHighlightRect] = []
            var quotes: [String] = []
            for line in lines where line.pages.contains(where: { $0 === page }) {
                let box = view.convert(line.bounds(for: page), from: page).intersection(pageRect)
                guard !box.isNull, !box.isEmpty else { continue }
                rects.append(GammaHighlightRect(x1: box.minX - pageRect.minX, y1: box.minY - pageRect.minY,
                    x2: box.maxX - pageRect.minX, y2: box.maxY - pageRect.minY,
                    width: pageRect.width, height: pageRect.height, pageNumber: number))
                if let text = line.string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { quotes.append(text) }
            }
            guard !rects.isEmpty else { return nil }
            let bound = GammaHighlightRect(x1: rects.map(\.x1).min()!, y1: rects.map(\.y1).min()!,
                x2: rects.map(\.x2).max()!, y2: rects.map(\.y2).max()!, width: pageRect.width,
                height: pageRect.height, pageNumber: number)
            return GammaSelectedText(page: number, quote: quotes.joined(separator: "\n"),
                position: GammaHighlightPosition(pageNumber: number, boundingRect: bound, rects: rects, area: false))
        }
    }
}
