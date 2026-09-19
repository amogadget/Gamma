import Foundation

extension GammaWorkspace {
    /// Read-only browser ink for a zero-based PDF page. Native drawing, replay,
    /// selection and the outbox deliberately never consume these sources.
    func timInk(pdfPage zeroBased: Int) -> [GammaTimInk] {
        guard zeroBased >= 0, zeroBased < Int.max, let snapshot = page else { return [] }
        // The document scene asks once per PDF page; skip unrelated source
        // files before decoding their samples, rather than decoding all ink N times.
        return snapshot.blocks.filter { $0.isTimInk && ($0.pdfPage == nil || $0.pdfPage == zeroBased + 1) }
            .compactMap { try? snapshot.decodedTimInk(for: $0) }
            .filter { $0.space.page == zeroBased + 1 }
    }

    /// Persistent reader warning derived from the published page snapshot. Unlike
    /// the general operation errorMessage, unrelated successful actions cannot
    /// dismiss it. It disappears only once ink is valid or the page is closed.
    var timInkErrorMessage: String? {
        guard let page else { return nil }
        return timInkFailureMessage(page)
    }

    private func timInkFailureMessage(_ snapshot: GammaPageCache) -> String? {
        let failures = snapshot.blocks.filter(\.isTimInk).compactMap { block -> String? in
            do { _ = try snapshot.decodedTimInk(for: block); return nil }
            catch { return "Handwriting \(block.id): \(error.localizedDescription)" }
        }
        return failures.isEmpty ? nil : failures.joined(separator: "\n")
    }

    /// Successful PDF/tree loading must not hide missing or unsupported ink.
    func reportTimInkErrors(_ snapshot: GammaPageCache) {
        if let message = timInkFailureMessage(snapshot) { errorMessage = message }
    }

    /// A failed group does not hide successfully loaded groups or the PDF. The
    /// failure stays in the snapshot so cold/offline reopen explains the absence.
    func hydrateTimInk(_ original: GammaPageCache, api: GammaAPI, generation: UUID) async throws -> GammaPageCache {
        var snapshot = original
        snapshot.invalidateTimInkSources()
        snapshot.timInkErrors = [:]
        guard snapshot.blocks.contains(where: \.isTimInk) else { return snapshot }
        guard let cache, cache.workspace == api.workspace,
              cache.username == api.authenticatedUsername,
              cache.server == GammaCache.canonicalServer(api.baseURL) else {
            throw GammaAPI.APIError.message("Handwriting session does not match the cached account and workspace.")
        }
        try cache.assertWorkspace(snapshot.workspace, what: "handwriting snapshot")
        for block in snapshot.blocks where block.isTimInk {
            do {
                if (try? snapshot.decodedTimInk(for: block)) != nil { continue }
                guard let url = block.properties.inkURL, !url.isEmpty else {
                    throw GammaAPI.APIError.message("Handwriting has not finished uploading in Gamma.")
                }
                let data = try await api.timInk(url)
                try Task.checkCancellation()
                guard accountGeneration == generation else { throw CancellationError() }
                _ = try GammaTimInk.decode(data)
                snapshot.timInkSources?[block.id] = GammaTimInkSource(inkURL: url, data: data)
                _ = try snapshot.decodedTimInk(for: block)
            } catch {
                if error is CancellationError || Task.isCancelled || accountGeneration != generation { throw CancellationError() }
                snapshot.timInkSources?.removeValue(forKey: block.id)
                snapshot.timInkErrors?[block.id] = error.localizedDescription
            }
        }
        return snapshot
    }
}
