import PDFKit
import PencilKit
import UIKit

/// PencilKit handles Pencil strokes; its own scrolling is disabled so finger
/// drags/pinches are handled by the containing PDFKit scroll view.
@MainActor
final class InkPageOverlay: UIView {
    let canvas = PKCanvasView()
    /// Other annotation blocks are visual context only, never a save source.
    let backgroundCanvas = PKCanvasView()
    let replayCanvas = PKCanvasView()
    var isReplaying = false
    let highlightLayer = GammaHighlightLayer()
    weak var pdfView: PDFView?
    let page: PDFPage
    let cropBox: CGRect
    var acceptsInk = false
    var onGeometryError: (() -> Void)?
    private var geometryIsValid = false

    init(page: PDFPage, pdfView: PDFView) {
        self.page = page
        self.pdfView = pdfView
        cropBox = page.bounds(for: .cropBox).standardized
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
        clipsToBounds = true
        highlightLayer.backgroundColor = .clear
        highlightLayer.isOpaque = false
        highlightLayer.isUserInteractionEnabled = false
        addSubview(highlightLayer)
        for layer in [backgroundCanvas, canvas, replayCanvas] {
            layer.backgroundColor = .clear
            layer.isOpaque = false
            layer.drawingPolicy = .pencilOnly
            layer.isScrollEnabled = false
            layer.bounces = false
            layer.bouncesZoom = false
            layer.minimumZoomScale = 0.05
            layer.maximumZoomScale = 16
            layer.contentInset = .zero
            layer.contentInsetAdjustmentBehavior = .never
            layer.showsHorizontalScrollIndicator = false
            layer.showsVerticalScrollIndicator = false
            layer.panGestureRecognizer.isEnabled = false
            layer.pinchGestureRecognizer?.isEnabled = false
            layer.tool = PKInkingTool(.pen, color: .black, width: 2)
            addSubview(layer)
        }
        backgroundCanvas.isUserInteractionEnabled = false
        backgroundCanvas.drawingGestureRecognizer.isEnabled = false
        replayCanvas.isUserInteractionEnabled = false
        replayCanvas.drawingGestureRecognizer.isEnabled = false
        replayCanvas.isHidden = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateGeometry()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        setNeedsLayout()
    }

    /// Persisted ink coordinates: unrotated crop-box points, origin at the
    /// crop's upper-left, x right / y down. No screen zoom is persisted.
    /// Compose public PDFKit conversions with UIKit conversions, rather than
    /// assuming the provider's overlay bounds or ancestors have a given scale.
    func updateGeometry() {
        guard let pdfView, window != nil, superview != nil,
              cropBox.width > 0, cropBox.height > 0 else { return }
        configureNavigationAncestors(upTo: pdfView)
        highlightLayer.frame = bounds
        highlightLayer.displayedPage = convert(pdfView.convert(cropBox, from: page), from: pdfView)
        highlightLayer.setNeedsDisplay()
        func local(_ point: CGPoint) -> CGPoint {
            convert(pdfView.convert(point, from: page), from: pdfView)
        }
        let origin = local(CGPoint(x: cropBox.minX, y: cropBox.maxY))
        let right = local(CGPoint(x: cropBox.maxX, y: cropBox.maxY))
        let down = local(CGPoint(x: cropBox.minX, y: cropBox.minY))
        let a = (right.x - origin.x) / cropBox.width
        let b = (right.y - origin.y) / cropBox.width
        let c = (down.x - origin.x) / cropBox.height
        let d = (down.y - origin.y) / cropBox.height
        let determinant = a * d - b * c
        guard [origin.x, origin.y, a, b, c, d, determinant].allSatisfy({ $0.isFinite }),
              abs(determinant) > 0.000001 else {
            geometryIsValid = false
            canvas.isHidden = true
            backgroundCanvas.isHidden = true
            replayCanvas.isHidden = true
            onGeometryError?()
            return
        }
        geometryIsValid = true
        canvas.isHidden = isReplaying
        backgroundCanvas.isHidden = isReplaying
        replayCanvas.isHidden = !isReplaying

        // Ask PencilKit to render at the PDF's current zoom, then cancel that
        // extra scale in the outer affine transform. Merely magnifying a
        // page-sized canvas makes zoomed handwriting a blurry bitmap.
        let zoom = min(max(pdfView.scaleFactor, 0.05), 16)
        let size = CGSize(width: cropBox.width * zoom, height: cropBox.height * zoom)
        let mapping = CGAffineTransform(a: a / zoom, b: b / zoom,
                                        c: c / zoom, d: d / zoom, tx: 0, ty: 0)
        let center = CGPoint(x: origin.x + (a * cropBox.width + c * cropBox.height) / 2,
                             y: origin.y + (b * cropBox.width + d * cropBox.height) / 2)
        // Never set frame on a transformed view, or transform PKDrawing itself.
        for layer in [backgroundCanvas, canvas, replayCanvas] {
            if layer.bounds.size != size { layer.bounds = CGRect(origin: .zero, size: size) }
            if abs(layer.zoomScale - zoom) > 0.0001 { layer.setZoomScale(zoom, animated: false) }
            if layer.contentSize != size { layer.contentSize = size }
            if layer.contentOffset != .zero { layer.contentOffset = .zero }
            if layer.transform != mapping { layer.transform = mapping }
            if layer.center != center { layer.center = center }
        }
    }

    private func configureNavigationAncestors(upTo pdfView: PDFView) {
        // Use public UIScrollView APIs on the actual ancestor chain, without
        // assuming PDFKit private class names or a particular subview depth.
        // Parent recognizers see touches delivered to canvas descendants.
        // Excluding Pencil prevents PDF panning from cancelling ink strokes.
        let navigationTouches = [NSNumber(value: UITouch.TouchType.direct.rawValue),
                                 NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
        var ancestor = superview
        while let current = ancestor, current !== pdfView {
            if let scroll = current as? UIScrollView {
                if scroll.panGestureRecognizer.allowedTouchTypes != navigationTouches {
                    scroll.panGestureRecognizer.allowedTouchTypes = navigationTouches
                }
                if let pinch = scroll.pinchGestureRecognizer,
                   pinch.allowedTouchTypes != navigationTouches {
                    pinch.allowedTouchTypes = navigationTouches
                }
                scroll.delaysContentTouches = false
            }
            ancestor = current.superview
        }
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard acceptsInk, geometryIsValid else { return nil }
        // Never classify touches via event.allTouches here: UIKit can call
        // hitTest before populating it. Pencil-only policy and ancestor gesture
        // touch-type filtering provide routing, including mixed input.
        return super.hitTest(point, with: event)
    }
}

/// PDFKit may relayout its overlays after a split-view/window-size change.
@MainActor
final class InkPDFView: PDFView {
    var onLayout: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}
