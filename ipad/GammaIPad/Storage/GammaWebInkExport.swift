import Foundation
import UIKit
import PencilKit
import CryptoKit

/// The display-only, final-state representation consumed by the web ink player.
enum GammaWebInkExport {
    enum ExportError: Error, LocalizedError, Equatable {
        case invalidPageSize
        case unsupportedLimit(String)
        case unableToRasterize
        case unableToEncodeJSON

        var errorDescription: String? {
            switch self {
            case .invalidPageSize: return "Ink replay page dimensions must be finite, positive and no larger than 100000 points."
            case .unsupportedLimit(let message): return message
            case .unableToRasterize: return "A final-state ink stroke could not be rasterized as PNG."
            case .unableToEncodeJSON: return "Ink replay JSON could not be encoded."
            }
        }
    }

    private struct ReplayPoint: Codable {
        let x: Double
        let y: Double
        let t: Double
        let radius: Double
    }

    private struct ReplayBounds: Codable {
        let x: Double
        let y: Double
        let width: Double
        let height: Double
    }

    private struct ReplayStroke: Codable {
        let id: String
        let bounds: ReplayBounds
        let png: String
        let points: [ReplayPoint]
    }

    private struct ReplayDocument: Codable {
        let format: String
        let sourceSHA256: String
        let width: Double
        let height: Double
        let strokes: [ReplayStroke]

        enum CodingKeys: String, CodingKey {
            case format, sourceSHA256 = "source_sha256", width, height, strokes
        }
    }

    private static let maxStrokes = 2_000
    private static let maxPoints = 200_000
    private static let maxImageDimension = 4_096
    private static let maxDecodedPixels = 24_000_000
    private static let maxJSONBytes = 32 * 1024 * 1024

    static func encode(drawing: PKDrawing, sourceData: Data, pageSize: CGSize) throws -> Data {
        guard pageSize.width.isFinite, pageSize.height.isFinite,
              pageSize.width > 0, pageSize.height > 0, pageSize.width <= 100_000, pageSize.height <= 100_000 else { throw ExportError.invalidPageSize }
        guard drawing.strokes.count <= maxStrokes else {
            throw ExportError.unsupportedLimit("Ink replay supports at most 2000 strokes.")
        }

        let page = CGRect(origin: .zero, size: pageSize)
        struct Prepared {
            let stroke: PKStroke
            let bounds: CGRect
            let points: [ReplayPoint]
        }
        var prepared: [Prepared] = []
        prepared.reserveCapacity(drawing.strokes.count)
        var totalPoints = 0

        for stroke in drawing.strokes {
            let raw = stroke.renderBounds
            guard raw.origin.x.isFinite, raw.origin.y.isFinite,
                  raw.size.width.isFinite, raw.size.height.isFinite,
                  raw.width > 0, raw.height > 0 else {
                throw ExportError.unsupportedLimit("Ink replay contains an empty or unbounded stroke.")
            }
            let crop = raw.intersection(page)
            guard crop.width > 0, crop.height > 0,
                  crop.origin.x.isFinite, crop.origin.y.isFinite else { continue }

            let controlPoints = Array(stroke.path)
            guard !controlPoints.isEmpty else { continue }
            totalPoints += controlPoints.count
            guard totalPoints <= maxPoints else {
                throw ExportError.unsupportedLimit("Ink replay supports at most 200000 total points.")
            }
            let transform = stroke.transform
            let transformScale = max(0.000001, sqrt(Double(transform.a * transform.a + transform.b * transform.b + transform.c * transform.c + transform.d * transform.d)))
            var points: [ReplayPoint] = []
            points.reserveCapacity(controlPoints.count)
            var previousTime = 0.0
            for point in controlPoints {
                let location = point.location.applying(transform)
                let time = Double(point.timeOffset)
                guard time.isFinite, time >= previousTime else {
                    throw ExportError.unsupportedLimit("Ink replay contains invalid point timing.")
                }
                let size = max(Double(point.size.width), Double(point.size.height))
                let radius = max(0, size.isFinite ? size * transformScale / 2.0 : 0) + 1.0
                guard location.x.isFinite, location.y.isFinite, radius.isFinite else {
                    throw ExportError.unsupportedLimit("Ink replay contains a non-finite point.")
                }
                points.append(ReplayPoint(x: Double(location.x), y: Double(location.y), t: time, radius: radius))
                previousTime = time
            }
            prepared.append(Prepared(stroke: stroke, bounds: crop, points: points))
        }

        // Pick one scale for all rasters. Binary search accounts for ceil() and
        // the one-pixel minimum, so the decoded-pixel limit is exact.
        let dimensionScale = min(2.0, min(Double(maxImageDimension) / Double(pageSize.width),
                                           Double(maxImageDimension) / Double(pageSize.height)))
        var upper = max(0, dimensionScale)
        func pixelCount(at scale: Double) -> Int {
            prepared.reduce(0) { result, item in
                result + max(1, Int(ceil(Double(item.bounds.width) * scale))) * max(1, Int(ceil(Double(item.bounds.height) * scale)))
            }
        }
        if pixelCount(at: upper) > maxDecodedPixels {
            var low = 0.0
            for _ in 0..<48 {
                let middle = (low + upper) / 2
                if pixelCount(at: middle) <= maxDecodedPixels { low = middle } else { upper = middle }
            }
            upper = low
        }
        guard pixelCount(at: upper) <= maxDecodedPixels else {
            throw ExportError.unsupportedLimit("Ink replay raster budget exceeds 24 million decoded pixels.")
        }

        var output: [ReplayStroke] = []
        output.reserveCapacity(prepared.count)
        for item in prepared {
            guard let png = drawingImage(for: item.stroke, bounds: item.bounds, scale: upper).pngData() else {
                throw ExportError.unableToRasterize
            }
            output.append(ReplayStroke(id: GammaReplay.strokeID(item.stroke),
                                       bounds: ReplayBounds(x: Double(item.bounds.minX), y: Double(item.bounds.minY),
                                                           width: Double(item.bounds.width), height: Double(item.bounds.height)),
                                       png: png.base64EncodedString(), points: item.points))
        }

        let sourceHash = SHA256.hash(data: sourceData).map { String(format: "%02x", $0) }.joined()
        let document = ReplayDocument(format: "gamma-ink-replay-v1", sourceSHA256: sourceHash,
                                      width: Double(pageSize.width), height: Double(pageSize.height), strokes: output)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(document)
        guard data.count <= maxJSONBytes else {
            throw ExportError.unsupportedLimit("Ink replay JSON exceeds the 32 MiB limit.")
        }
        return data
    }

    private static func drawingImage(for stroke: PKStroke, bounds: CGRect, scale: Double) -> UIImage {
        let safeScale = max(0.000001, scale)
        return PKDrawing(strokes: [stroke]).image(from: bounds, scale: CGFloat(safeScale))
    }
}
