import PencilKit
import CoreGraphics

/// Hit testing uses individual stroke bounds, not the annotation's large union
/// rectangle, so whitespace between separate lines is not a selection target.
enum InkSelection {
    static func contains(_ drawing: PKDrawing, point: CGPoint, tolerance: CGFloat) -> Bool {
        guard point.x.isFinite, point.y.isFinite, tolerance.isFinite, tolerance >= 0 else { return false }
        return drawing.strokes.contains { stroke in
            stroke.renderBounds.insetBy(dx: -tolerance, dy: -tolerance).contains(point)
        }
    }
    static func target(at point: CGPoint, drawings: [(id: String, drawing: PKDrawing)],
                       selectedID: String?, tolerance: CGFloat) -> String? {
        // Don't steal a dot/stroke while writing on the active annotation, even
        // when another annotation overlaps it.
        if let selected = drawings.first(where: { $0.id == selectedID }),
           contains(selected.drawing, point: point, tolerance: tolerance) { return nil }
        return drawings.reversed().first {
            $0.id != selectedID && contains($0.drawing, point: point, tolerance: tolerance)
        }?.id
    }
}
