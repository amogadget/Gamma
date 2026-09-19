import Foundation

/// Source URL is part of the cache identity: changing ink_url must not replay
/// stale strokes, even when the new upload is missing or the device is offline.
struct GammaTimInkSource: Codable, Equatable {
    var inkURL: String
    var data: Data
}

extension GammaPageCache {
    func decodedTimInk(for block: GammaBlock) throws -> GammaTimInk {
        guard block.isTimInk, let url = block.properties.inkURL, !url.isEmpty else {
            throw GammaAPI.APIError.message("Handwriting has not finished uploading in Gamma.")
        }
        _ = try GammaAPI.timInkPath(url)
        guard let source = timInkSources?[block.id], source.inkURL == url else {
            throw GammaAPI.APIError.message(timInkErrors?[block.id] ?? "Gamma handwriting is not cached. Connect and refresh to download it.")
        }
        let ink = try GammaTimInk.decode(source.data)
        guard ink.space.kind == "pdf-page", let inkPage = ink.space.page,
              block.pdfPage == nil || block.pdfPage == inkPage else {
            throw GammaAPI.APIError.message("Gamma handwriting page does not match its PDF block.")
        }
        return ink
    }

    mutating func invalidateTimInkSources() {
        let references = Dictionary(blocks.filter(\.isTimInk).map { ($0.id, $0.properties.inkURL ?? "") },
                                    uniquingKeysWith: { first, _ in first })
        timInkSources = (timInkSources ?? [:]).filter { references[$0.key] == $0.value.inkURL }
        timInkErrors = (timInkErrors ?? [:]).filter { references[$0.key] != nil }
    }
}
