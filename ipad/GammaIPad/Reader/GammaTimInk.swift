import Foundation
import CoreFoundation
import CoreGraphics
import UIKit
import PDFKit

/// Read-only gamma-ink v1. Never converts web ink into an editable native drawing.
struct GammaTimInk {
    static let maxBytes = 4 * 1024 * 1024
    static let maxStrokes = 5_000
    static let maxSamples = 500_000

    struct Space {
        let kind: String
        let page: Int?
        let width: Double
        let height: Double
    }
    struct Sample: Equatable {
        let x: Double
        let y: Double
        let p: Double
        let t: Int64?
        let a: Int64?
        let z: Int64?
    }
    struct Stroke {
        let id: String
        let tool: String
        let brush: String?
        let color: String
        let size: Double
        let opacity: Double
        let pen: Bool
        let t0: Int64?
        let ch: String
        /// Original integer channels are retained, including unclamped pressure.
        let pts: [Int64]
        let samples: [Sample]

        func width(at sample: Sample) -> Double {
            size * (tool == "pen" && brush != "monoline" && pen ? 1 + 0.5 * (sample.p - 0.5) : 1)
        }
    }
    enum InkError: Error, LocalizedError {
        case invalid(String)
        var errorDescription: String? {
            switch self { case .invalid(let reason): return "Invalid gamma-ink: \(reason)" }
        }
    }
    let space: Space
    let strokes: [Stroke]

    static func decode(_ data: Data) throws -> GammaTimInk {
        guard data.count <= maxBytes else { throw InkError.invalid("file exceeds 4 MiB") }
        let root = try object(JSONSerialization.jsonObject(with: data), keys: ["format", "version", "space", "strokes"])
        guard root["format"] as? String == "gamma-ink", try integer(root["version"]) == 1 else {
            throw InkError.invalid("unsupported format or version")
        }
        let rawSpace = try object(root["space"], keys: ["kind", "page", "width", "height"])
        let kind = try text(rawSpace["kind"] ?? "pdf-page")
        let page = try optionalInteger(rawSpace["page"])
        guard ["pdf-page", "canvas"].contains(kind), page == nil || page! >= 1,
              kind != "pdf-page" || page != nil else { throw InkError.invalid("space/page") }
        let space = Space(kind: kind, page: page.map(Int.init),
                          width: try positive(rawSpace["width"], maximum: 100_000),
                          height: try positive(rawSpace["height"], maximum: 100_000))
        guard let rawStrokes = (root["strokes"] ?? []) as? [Any], rawStrokes.count <= maxStrokes else {
            throw InkError.invalid("stroke limit or list")
        }
        var strokes: [Stroke] = [], ids = Set<String>(), total = 0
        for raw in rawStrokes {
            let s = try object(raw, keys: ["id", "tool", "brush", "color", "size", "opacity", "pen", "t0", "ch", "pts"])
            let id = try text(s["id"])
            guard matches(id, "^[A-Za-z0-9_-]{1,32}$"), ids.insert(id).inserted else {
                throw InkError.invalid("invalid or duplicate stroke id")
            }
            let tool = try text(s["tool"] ?? "pen")
            guard ["pen", "highlighter"].contains(tool) else { throw InkError.invalid("tool") }
            // Missing/null retains legacy pressure width; monoline changes only
            // rendering, never the recorded pressure or other sample channels.
            let brush: String?
            if let rawBrush = s["brush"], !(rawBrush is NSNull) {
                brush = try text(rawBrush)
                guard brush == "monoline", tool == "pen" else { throw InkError.invalid("brush") }
            } else {
                brush = nil
            }
            let color = try text(s["color"] ?? "#1f1f1f")
            guard color.count <= 40, rgba(color) != nil else { throw InkError.invalid("color") }
            let size = try positive(s["size"] ?? 1.6, maximum: 100)
            let opacity = try positive(s["opacity"] ?? 1, maximum: 1)
            let rawPen = s["pen"] ?? true
            guard let penNumber = rawPen as? NSNumber, CFGetTypeID(penNumber) == CFBooleanGetTypeID() else {
                throw InkError.invalid("pen must be a boolean")
            }
            let t0 = try optionalInteger(s["t0"])
            guard t0 == nil || t0! >= 0 else { throw InkError.invalid("t0") }
            let ch = try text(s["ch"] ?? "xy"), channels = Array(ch)
            guard ch.hasPrefix("xy"), channels.count <= 6,
                  Set(channels).count == channels.count,
                  channels.dropFirst(2).allSatisfy({ "ptaz".contains($0) }) else {
                throw InkError.invalid("channels")
            }
            guard let values = s["pts"] as? [Any], !values.isEmpty,
                  values.count % channels.count == 0 else { throw InkError.invalid("sample shape") }
            total += values.count / channels.count
            guard total <= maxSamples else { throw InkError.invalid("sample limit") }
            let pts = try values.map { try integer($0) }
            var x: Int64 = 0, y: Int64 = 0, time: Int64 = 0
            var samples: [Sample] = []
            samples.reserveCapacity(values.count / channels.count)
            for i in stride(from: 0, to: pts.count, by: channels.count) {
                var p = 0.5, t: Int64?, a: Int64?, z: Int64?
                for (k, channel) in channels.enumerated() {
                    let v = pts[i + k]
                    switch channel {
                    case "x": x = try sum(x, v)
                    case "y": y = try sum(y, v)
                    case "p": p = min(1, max(0, Double(v) / 1000))
                    case "t": time = try sum(time, v); t = time
                    case "a": a = v
                    case "z": z = v
                    default: break
                    }
                }
                samples.append(Sample(x: Double(x) / 100, y: Double(y) / 100, p: p, t: t, a: a, z: z))
            }
            strokes.append(Stroke(id: id, tool: tool, brush: brush, color: color, size: size, opacity: opacity,
                                  pen: penNumber.boolValue, t0: t0, ch: ch, pts: pts, samples: samples))
        }
        return GammaTimInk(space: space, strokes: strokes)
    }

    /// Inverse pdf.js rotation, returning UNROTATED crop-local top-left points.
    /// Crop origin cancels: PDF user-space (minX + x, maxY - y) becomes (x,y).
    /// The containing overlay applies the page rotation exactly once afterwards.
    static func nativePoint(viewport: CGPoint, cropBounds: CGRect, rotation: Int,
                            spaceWidth: Double, spaceHeight: Double) -> CGPoint {
        guard spaceWidth.isFinite, spaceHeight.isFinite, spaceWidth > 0, spaceHeight > 0,
              viewport.x.isFinite, viewport.y.isFinite,
              cropBounds.width.isFinite, cropBounds.height.isFinite,
              cropBounds.width > 0, cropBounds.height > 0 else { return .zero }
        let u = viewport.x / CGFloat(spaceWidth), v = viewport.y / CGFloat(spaceHeight)
        let w = cropBounds.width, h = cropBounds.height
        switch ((rotation % 360) + 360) % 360 {
        case 90: return CGPoint(x: v * w, y: (1 - u) * h)
        case 180: return CGPoint(x: (1 - u) * w, y: (1 - v) * h)
        case 270: return CGPoint(x: (1 - v) * w, y: u * h)
        default: return CGPoint(x: u * w, y: v * h)
        }
    }

    private static func object(_ value: Any?, keys: Set<String>) throws -> [String: Any] {
        guard let dict = value as? [String: Any], Set(dict.keys).isSubset(of: keys) else {
            throw InkError.invalid("object or unknown fields")
        }
        return dict
    }
    private static func text(_ value: Any?) throws -> String {
        guard let value = value as? String else { throw InkError.invalid("expected string") }
        return value
    }
    private static func number(_ value: Any?) throws -> Double {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite else { throw InkError.invalid("expected finite number") }
        return value.doubleValue
    }
    private static func positive(_ value: Any?, maximum: Double) throws -> Double {
        let value = try number(value)
        guard value > 0, value <= maximum else { throw InkError.invalid("number out of range") }
        return value
    }
    private static func integer(_ value: Any?) throws -> Int64 {
        let n = try number(value)
        // Match the browser's exact-integer domain; refuse lossy conversions.
        guard n.rounded() == n, abs(n) <= 9_007_199_254_740_991 else {
            throw InkError.invalid("expected safe integer")
        }
        return Int64(n)
    }
    private static func optionalInteger(_ value: Any?) throws -> Int64? {
        guard let value, !(value is NSNull) else { return nil }
        return try integer(value)
    }
    private static func sum(_ a: Int64, _ b: Int64) throws -> Int64 {
        let (value, overflow) = a.addingReportingOverflow(b)
        guard !overflow, value >= -9_007_199_254_740_991, value <= 9_007_199_254_740_991 else {
            throw InkError.invalid("delta accumulation exceeds exact integer range")
        }
        return value
    }
    private static func matches(_ text: String, _ pattern: String) -> Bool {
        guard let range = text.range(of: pattern, options: .regularExpression) else { return false }
        return range == text.startIndex..<text.endIndex
    }
    fileprivate static func rgba(_ color: String) -> (CGFloat, CGFloat, CGFloat, CGFloat)? {
        if matches(color, "^#[0-9a-fA-F]{6}$"), let rgb = UInt32(color.dropFirst(), radix: 16) {
            return (CGFloat((rgb >> 16) & 255) / 255, CGFloat((rgb >> 8) & 255) / 255,
                    CGFloat(rgb & 255) / 255, 1)
        }
        guard matches(color, #"^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(,\s*[0-9.]+\s*)?\)$"#),
              let start = color.firstIndex(of: "(") else { return nil }
        let fields = color[color.index(after: start)..<color.index(before: color.endIndex)].split(separator: ",")
        let components = fields.compactMap { Double($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
        guard components.count == fields.count, (3...4).contains(components.count),
              components.allSatisfy(\.isFinite) else { return nil }
        return (CGFloat(min(255, components[0])) / 255, CGFloat(min(255, components[1])) / 255,
                CGFloat(min(255, components[2])) / 255, CGFloat(components.count == 4 ? min(1, components[3]) : 1))
    }
}

/** Immutable, document-wide render snapshot. Compiles each outline once, not once
 per destination or zoom tick. Only edge-crossing strokes enter the foreign-page
 candidate list. Source overlays are deliberately not involved in this index. */
@MainActor
final class GammaTimInkScene {
    struct Stroke {
        let id: Int
        let page: PDFPage
        let crop: CGRect
        let path: CGPath // unrotated crop-local top-left points
        let color: CGColor
        let opacity: Float
    }
    let document: PDFDocument
    private var own: [Int: [Stroke]] = [:]
    private var overflow: [Stroke] = []

    init(document: PDFDocument, ink: (Int) -> [GammaTimInk]) {
        self.document = document
        var identifier = 0
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { continue }
            let crop = page.bounds(for: .cropBox).standardized
            guard crop.width > 0, crop.height > 0, page.rotation % 90 == 0,
                  [crop.minX, crop.minY, crop.width, crop.height].allSatisfy(\.isFinite) else { continue }
            for source in ink(index) where source.space.kind == "pdf-page" {
                func local(_ point: CGPoint) -> CGPoint {
                    GammaTimInk.nativePoint(viewport: point, cropBounds: crop, rotation: page.rotation,
                                            spaceWidth: source.space.width, spaceHeight: source.space.height)
                }
                let o = local(.zero), x = local(CGPoint(x: 1, y: 0)), y = local(CGPoint(x: 0, y: 1))
                var transform = CGAffineTransform(a: x.x - o.x, b: x.y - o.y, c: y.x - o.x,
                                                  d: y.y - o.y, tx: o.x, ty: o.y)
                for stroke in source.strokes {
                    guard let path = GammaTimInkView.outline(stroke).copy(using: &transform),
                          let (r, g, b, a) = GammaTimInk.rgba(stroke.color) else { continue }
                    let entry = Stroke(id: identifier, page: page, crop: crop, path: path,
                                       color: UIColor(red: r, green: g, blue: b, alpha: 1).cgColor,
                                       opacity: Float(a * CGFloat(stroke.opacity)))
                    identifier += 1
                    own[index, default: []].append(entry)
                    if !CGRect(origin: .zero, size: crop.size).contains(path.boundingBoxOfPath) {
                        overflow.append(entry)
                    }
                }
            }
        }
    }

    func candidates(for page: PDFPage) -> [Stroke] {
        (own[document.index(for: page)] ?? []) + overflow.filter { $0.page !== page }
    }
}

/// Each PDF page owns every tim pixel inside its surface, including ink whose
/// source page is not mounted. Never rely on overflow through PDFKit siblings:
/// an opaque sibling background can cover that overflow regardless of clipping.
@MainActor
final class GammaTimInkProjectionView: UIView {
    var scene: GammaTimInkScene? {
        didSet {
            guard oldValue !== scene else { return }
            shapes.values.forEach { $0.removeFromSuperlayer() }
            shapes.removeAll()
        }
    }
    private var shapes: [Int: CAShapeLayer] = [:]
    private let pageMask = CAShapeLayer()
    var renderedStrokeCount: Int { shapes.count }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        backgroundColor = .clear
        isUserInteractionEnabled = false
        layer.mask = pageMask
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }

    func update(pdfView: PDFView, destination: PDFPage) {
        guard let scene, scene.document === pdfView.document else { return }
        let destinationRect = convert(pdfView.convert(destination.bounds(for: .cropBox), from: destination), from: pdfView)
        guard !destinationRect.isEmpty, !destinationRect.isInfinite, !destinationRect.isNull else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        pageMask.path = CGPath(rect: destinationRect, transform: nil)
        var retained = Set<Int>()
        var transforms: [ObjectIdentifier: CGAffineTransform] = [:]
        for stroke in scene.candidates(for: destination) {
            let key = ObjectIdentifier(stroke.page)
            let transform: CGAffineTransform
            if let cached = transforms[key] { transform = cached } else {
                func local(_ point: CGPoint) -> CGPoint {
                    convert(pdfView.convert(point, from: stroke.page), from: pdfView)
                }
                let crop = stroke.crop
                let o = local(CGPoint(x: crop.minX, y: crop.maxY))
                let x = local(CGPoint(x: crop.maxX, y: crop.maxY))
                let y = local(CGPoint(x: crop.minX, y: crop.minY))
                transform = CGAffineTransform(a: (x.x - o.x) / crop.width, b: (x.y - o.y) / crop.width,
                                              c: (y.x - o.x) / crop.height, d: (y.y - o.y) / crop.height,
                                              tx: o.x, ty: o.y)
                transforms[key] = transform
            }
            guard [transform.a, transform.b, transform.c, transform.d, transform.tx, transform.ty].allSatisfy(\.isFinite),
                  abs(transform.a * transform.d - transform.b * transform.c) > 0.000001,
                  stroke.path.boundingBoxOfPath.applying(transform).intersects(destinationRect) else { continue }
            retained.insert(stroke.id)
            let shape: CAShapeLayer
            if let existing = shapes[stroke.id] { shape = existing } else {
                shape = CAShapeLayer()
                shape.anchorPoint = .zero
                shape.path = stroke.path
                shape.fillColor = stroke.color
                shape.fillRule = .nonZero
                shape.opacity = stroke.opacity
                shapes[stroke.id] = shape
                layer.addSublayer(shape)
            }
            // Source order is stable even when a layer re-enters after zoom/layout.
            shape.zPosition = CGFloat(stroke.id)
            shape.setAffineTransform(transform)
            shape.contentsScale = max(1, (window?.screen.scale ?? 2) * min(16, max(0.05, pdfView.scaleFactor)))
        }
        for id in Array(shapes.keys) where !retained.contains(id) {
            shapes.removeValue(forKey: id)?.removeFromSuperlayer()
        }
        CATransaction.commit()
    }
}

/// Vector-only visual context. Its bounds represent the unrotated crop, possibly
/// scaled for zoom. The overlay owns the outer PDF-to-screen rotation/transform.
@MainActor
final class GammaTimInkView: UIView {
    var inks: [GammaTimInk] = [] { didSet { rebuild() } }
    var cropBounds: CGRect = .zero { didSet { rebuild() } }
    var rotation: Int = 0 { didSet { rebuild() } }
    override var contentScaleFactor: CGFloat { didSet { setNeedsLayout() } }
    private var strokeLayers: [CAShapeLayer] = []

    override init(frame: CGRect) { super.init(frame: frame); configure() }
    required init?(coder: NSCoder) { super.init(coder: coder); configure() }
    private func configure() {
        isUserInteractionEnabled = false
        isOpaque = false
        backgroundColor = .clear
        // Match tim's overflow-visible SVG: negative/outside-page points are
        // legal source data and must retain their upper/side stroke portions.
        clipsToBounds = false
    }
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? { nil }

    static func nativePoint(viewport: CGPoint, cropBounds: CGRect, rotation: Int,
                            spaceWidth: Double, spaceHeight: Double) -> CGPoint {
        GammaTimInk.nativePoint(viewport: viewport, cropBounds: cropBounds, rotation: rotation,
                                spaceWidth: spaceWidth, spaceHeight: spaceHeight)
    }

    private func rebuild() {
        strokeLayers.forEach { $0.removeFromSuperlayer() }
        strokeLayers.removeAll()
        guard cropBounds.width > 0, cropBounds.height > 0 else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for ink in inks where ink.space.kind == "pdf-page" {
            func local(_ point: CGPoint) -> CGPoint {
                GammaTimInk.nativePoint(viewport: point, cropBounds: cropBounds, rotation: rotation,
                                        spaceWidth: ink.space.width, spaceHeight: ink.space.height)
            }
            let o = local(.zero), x = local(CGPoint(x: 1, y: 0)), y = local(CGPoint(x: 0, y: 1))
            var transform = CGAffineTransform(a: x.x - o.x, b: x.y - o.y, c: y.x - o.x,
                                              d: y.y - o.y, tx: o.x, ty: o.y)
            for stroke in ink.strokes {
                let path = Self.outline(stroke)
                guard let mapped = path.copy(using: &transform), let (r, g, b, a) = GammaTimInk.rgba(stroke.color) else { continue }
                let shape = CAShapeLayer()
                shape.path = mapped
                shape.fillColor = UIColor(red: r, green: g, blue: b, alpha: 1).cgColor
                shape.fillRule = .nonZero
                // One silhouette and one opacity per stroke: overlapping segments
                // never darken themselves. Highlighters are a source-over preview
                // approximation of browser multiply: UIKit's transparent overlay
                // cannot multiply the underlying PDF through a local CGContext.
                // Do not use unsupported CALayer compositing filters to fake it.
                // Browser fill/stroke opacity multiplies the RGBA color alpha.
                shape.opacity = Float(a * CGFloat(stroke.opacity))
                layer.addSublayer(shape)
                strokeLayers.append(shape)
            }
        }
        CATransaction.commit()
        setNeedsLayout()
    }

    /// Backend's round variable-width segments, a deliberate approximation of
    /// perfect-freehand rather than a fabricated PencilKit pressure curve.
    fileprivate static func outline(_ stroke: GammaTimInk.Stroke) -> CGPath {
        let result = CGMutablePath(), samples = stroke.samples
        guard let first = samples.first else { return result }
        if samples.count == 1 || (stroke.tool == "highlighter" && samples.allSatisfy({ $0.x == first.x && $0.y == first.y })) {
            let radius = stroke.width(at: first) / 2
            result.addEllipse(in: CGRect(x: first.x - radius, y: first.y - radius,
                                         width: radius * 2, height: radius * 2))
        } else if stroke.tool == "highlighter" {
            let line = CGMutablePath()
            line.move(to: CGPoint(x: first.x, y: first.y))
            for sample in samples.dropFirst() { line.addLine(to: CGPoint(x: sample.x, y: sample.y)) }
            result.addPath(line.copy(strokingWithWidth: CGFloat(stroke.size), lineCap: .round, lineJoin: .round, miterLimit: 1))
        } else {
            for (a, b) in zip(samples, samples.dropFirst()) {
                let line = CGMutablePath()
                line.move(to: CGPoint(x: a.x, y: a.y))
                line.addLine(to: CGPoint(x: b.x, y: b.y))
                let width = (stroke.width(at: a) + stroke.width(at: b)) / 2
                if a.x == b.x && a.y == b.y {
                    result.addEllipse(in: CGRect(x: a.x - width / 2, y: a.y - width / 2, width: width, height: width))
                } else {
                    result.addPath(line.copy(strokingWithWidth: CGFloat(width), lineCap: .round, lineJoin: .round, miterLimit: 1))
                }
            }
        }
        return result
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard cropBounds.width > 0, cropBounds.height > 0 else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let scale = CGAffineTransform(scaleX: bounds.width / cropBounds.width, y: bounds.height / cropBounds.height)
        for shape in strokeLayers {
            shape.anchorPoint = .zero
            shape.position = bounds.origin
            shape.setAffineTransform(scale)
            shape.contentsScale = max(contentScaleFactor, window?.screen.scale ?? traitCollection.displayScale)
        }
        CATransaction.commit()
    }
}
