import PDFKit
import PencilKit
import SwiftUI
import UIKit

/// Native, immutable-PDF reader with page-local PencilKit sidecars.
///
/// Callbacks run on the main thread. `loadDrawing` must throw on corrupt or
/// unreadable data (return an empty drawing only for a genuinely missing file).
/// `saveDrawing` must finish its durable, atomic write before returning; errors
/// leave ink dirty in memory and are surfaced through `onError`.
@MainActor
struct PDFInkView: UIViewRepresentable {
    let document: PDFDocument
    let loadDrawing: (Int) throws -> PKDrawing
    let saveDrawing: (Int, PKDrawing) throws -> Void
    let onError: (String) -> Void
    var isDrawing: Bool = true
    var backgroundDrawing: (Int) throws -> PKDrawing = { _ in PKDrawing() }
    var editablePage: Int? = nil
    var contentRevision: Int = 0
    var onPageChanged: (Int) -> Void = { _ in }
    var requestedPage: Int? = nil
    var highlights: (Int) -> [GammaPDFHighlight] = { _ in [] }
    var inkHitTest: (Int, CGPoint, CGFloat) -> String? = { _, _, _ in nil }
    var onSelectInk: (String) -> Void = { _ in }
    var onInkBegan: (Int) -> Void = { _ in }
    var onInkEnded: (Int) -> Void = { _ in }
    var replayActive = false
    var replayDrawing: (Int) -> PKDrawing? = { _ in nil }
    var replayHitTest: (Int, CGPoint, CGFloat) -> Double? = { _, _, _ in nil }
    var onReplaySeek: (Double) -> Void = { _ in }
    var textSelectionEnabled = false
    var selectionReset = 0
    var onTextSelection: ([GammaSelectedText]) -> Void = { _ in }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> PDFView {
        let view = InkPDFView()
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.displayBox = .cropBox
        view.autoScales = true
        view.backgroundColor = .secondarySystemBackground
        // PDF selections would otherwise compete with Pencil input.
        view.isInMarkupMode = true
        context.coordinator.attach(view)
        context.coordinator.update(from: self)
        return view
    }

    func updateUIView(_ uiView: PDFView, context: Context) {
        context.coordinator.update(from: self)
    }

    static func dismantleUIView(_ uiView: PDFView, coordinator: Coordinator) {
        coordinator.dismantle()
    }

    @MainActor
    final class Coordinator: NSObject, PDFPageOverlayViewProvider, PKCanvasViewDelegate, UIGestureRecognizerDelegate {
        private final class PageState {
            let index: Int
            let overlay: InkPageOverlay
            let loaded: Bool
            let writable: Bool
            // Retain the callback belonging to this snapshot, not a later selection.
            let saveDrawing: (Int, PKDrawing) throws -> Void
            let onInkBegan: (Int) -> Void
            let onInkEnded: (Int) -> Void
            var drawing: PKDrawing
            var observedData: Data
            var dirty = false
            var saving = false
            var lastSaveError: String?
            var geometryErrorReported = false

            init(index: Int, overlay: InkPageOverlay, drawing: PKDrawing, loaded: Bool,
                 writable: Bool, saveDrawing: @escaping (Int, PKDrawing) throws -> Void,
                 onInkBegan: @escaping (Int) -> Void, onInkEnded: @escaping (Int) -> Void) {
                self.index = index
                self.overlay = overlay
                self.drawing = drawing
                self.loaded = loaded
                self.writable = writable
                self.saveDrawing = saveDrawing
                self.onInkBegan = onInkBegan; self.onInkEnded = onInkEnded
                observedData = drawing.dataRepresentation()
            }
        }

        private weak var view: InkPDFView?
        private var configuration: PDFInkView?
        private var states: [Int: PageState] = [:]
        private var displayed: Set<Int> = []
        private let picker = PKToolPicker()
        private weak var activeCanvas: PKCanvasView?
        private var alive = true
        private var retryTimer: Timer?
        private var selectionTarget: String?
        private var replaySeekTarget: Double?
        private lazy var pencilSelectionTap: UITapGestureRecognizer = {
            let tap = UITapGestureRecognizer(target: self, action: #selector(selectInkWithPencil))
            tap.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.pencil.rawValue), NSNumber(value: UITouch.TouchType.direct.rawValue)]
            tap.cancelsTouchesInView = true
            tap.delaysTouchesBegan = true
            tap.delegate = self
            return tap
        }()

        func attach(_ view: InkPDFView) {
            self.view = view
            view.pageOverlayViewProvider = self
            NotificationCenter.default.addObserver(self, selector: #selector(textSelectionChanged), name: .PDFViewSelectionChanged, object: view)
            view.addGestureRecognizer(pencilSelectionTap)
            view.onLayout = { [weak self] in self?.updateGeometry() }
            NotificationCenter.default.addObserver(self, selector: #selector(scaleChanged),
                                                  name: .PDFViewScaleChanged, object: view)
            NotificationCenter.default.addObserver(self, selector: #selector(pageChanged),
                                                  name: .PDFViewPageChanged, object: view)
            NotificationCenter.default.addObserver(self, selector: #selector(flushForLifecycle),
                                                  name: UIApplication.willResignActiveNotification, object: nil)
            NotificationCenter.default.addObserver(self, selector: #selector(retryPendingSaves),
                                                  name: UIApplication.didBecomeActiveNotification, object: nil)
        }

        func update(from value: PDFInkView) {
            guard let view else { return }
            let documentChanged = configuration?.document !== value.document
            let snapshotsChanged = documentChanged
                || configuration?.contentRevision != value.contentRevision
                || configuration?.editablePage != value.editablePage
            let navigationChanged = documentChanged || configuration?.requestedPage != value.requestedPage
            let resetSelection = configuration?.selectionReset != value.selectionReset || configuration?.textSelectionEnabled != value.textSelectionEnabled
            if snapshotsChanged || configuration?.isDrawing != value.isDrawing {
                // Flush while the OLD selection/configuration is still installed.
                // A failed write leaves all snapshots and callbacks intact for retry.
                deactivatePicker()
                guard flushAll() else {
                    notify("Cannot change ink selection or PDF: unsaved ink remains in the current reader. Retry saving before closing it.")
                    activateVisibleCanvas()
                    return
                }
            }
            if documentChanged {
                clearPages()
                configuration = value
                view.document = value.document
                view.autoScales = true
            } else if snapshotsChanged {
                // Reuse PDFKit's loaded overlays without resetting document, page,
                // scroll position, auto-scale policy, or zoom.
                let overlays = states.values.map { ($0.index, $0.overlay) }
                for state in states.values { release(state) }
                states.removeAll()
                configuration = value
                for (index, overlay) in overlays {
                    prepare(overlay, for: overlay.page, index: index)
                }
            } else {
                configuration = value
            }
            let markup = !value.textSelectionEnabled || value.replayActive
            if view.isInMarkupMode != markup { view.isInMarkupMode = markup }
            if resetSelection { view.clearSelection() }
            for state in states.values {
                state.overlay.acceptsInk = state.loaded && state.writable && value.isDrawing && !value.replayActive && !value.textSelectionEnabled
            }
            if navigationChanged || value.replayActive, let index = value.requestedPage,
               index >= 0, index < value.document.pageCount,
               let page = value.document.page(at: index), view.currentPage !== page {
                view.go(to: page)
            }
            if documentChanged { pageChanged() }
            if !value.isDrawing {
                _ = flushAll()
                deactivatePicker()
            } else {
                activateVisibleCanvas()
            }
            updateGeometry()
        }

        func pdfView(_ view: PDFView, overlayViewFor page: PDFPage) -> UIView? {
            guard let configuration, page.document === configuration.document else { return nil }
            let index = configuration.document.index(for: page)
            guard index != NSNotFound else { return nil }
            if let state = states[index] { return state.overlay }

            let overlay = InkPageOverlay(page: page, pdfView: view)
            prepare(overlay, for: page, index: index)
            return overlay
        }

        private func prepare(_ overlay: InkPageOverlay, for page: PDFPage, index: Int) {
            guard let configuration else { return }
            let drawing: PKDrawing
            var background = PKDrawing()
            let loaded: Bool
            let box = page.bounds(for: .cropBox)
            let validBox = [box.minX, box.minY, box.width, box.height].allSatisfy { $0.isFinite }
                && box.width > 0 && box.height > 0
            // PDF /Rotate is defined in multiples of 90 degrees. Reject unusual
            // transforms rather than persist handwriting in ambiguous geometry.
            if !validBox || page.rotation % 90 != 0 {
                drawing = PKDrawing()
                loaded = false
                notify("Page \(index + 1) has unsupported PDF geometry; handwriting is disabled on this page.")
            } else {
                do {
                    drawing = try configuration.loadDrawing(index)
                    loaded = true
                } catch {
                    drawing = PKDrawing()
                    loaded = false
                    notify("Could not load ink for page \(index + 1). Editing is disabled to protect existing ink. \(error.localizedDescription)")
                }
            }
            do {
                background = try configuration.backgroundDrawing(index)
            } catch {
                notify("Could not load background ink for page \(index + 1). \(error.localizedDescription)")
            }
            let writable = configuration.editablePage == nil || configuration.editablePage == index
            let state = PageState(index: index, overlay: overlay, drawing: drawing, loaded: loaded,
                                  writable: writable, saveDrawing: configuration.saveDrawing,
                                  onInkBegan: configuration.onInkBegan, onInkEnded: configuration.onInkEnded)
            states[index] = state
            // Install delegate only after initial assignment; observedData also
            // suppresses delayed initial-assignment notifications.
            overlay.canvas.delegate = nil
            overlay.backgroundCanvas.delegate = nil
            overlay.canvas.undoManager?.removeAllActions()
            overlay.canvas.drawing = drawing
            overlay.backgroundCanvas.drawing = background
            overlay.highlightLayer.highlights = configuration.highlights(index)
            overlay.highlightLayer.pageNumber = index + 1
            overlay.setNeedsLayout()
            overlay.canvas.delegate = self
            // A successful selection tap must not first leave a PencilKit dot
            // in the previously selected annotation. Ordinary writing fails
            // this recognizer immediately in shouldReceive below.
            overlay.canvas.drawingGestureRecognizer.require(toFail: pencilSelectionTap)
            overlay.acceptsInk = loaded && writable && configuration.isDrawing && !configuration.replayActive && !configuration.textSelectionEnabled
            overlay.onGeometryError = { [weak self, weak state] in
                guard let self, let state, !state.geometryErrorReported else { return }
                state.geometryErrorReported = true
                self.notify("Page \(state.index + 1) ink alignment is unavailable; drawing is disabled until layout recovers.")
            }
            picker.addObserver(overlay.canvas)
        }

        func pdfView(_ pdfView: PDFView, willDisplayOverlayView overlayView: UIView, for page: PDFPage) {
            guard let index = index(for: page), let overlay = overlayView as? InkPageOverlay else { return }
            // PDFKit is allowed to reuse an overlay after willEndDisplaying.
            // Re-load a clean evicted page rather than relying on cached ink.
            if states[index] == nil { prepare(overlay, for: page, index: index) }
            displayed.insert(index)
            overlayView.isUserInteractionEnabled = true
            overlayView.setNeedsLayout()
            // PDFKit calls willDisplay before the overlay necessarily has a
            // window. Focus only after attachment, and ignore stale callbacks.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.alive else { return }
                self.updateGeometry()
                self.activateVisibleCanvas()
            }
        }

        func pdfView(_ pdfView: PDFView, willEndDisplayingOverlayView overlayView: UIView, for page: PDFPage) {
            guard let index = index(for: page), let state = states[index] else { return }
            capture(state)
            _ = persist(state)
            displayed.remove(index)
            if activeCanvas === state.overlay.canvas {
                deactivatePicker()
                activateVisibleCanvas()
            }
            // Clean canvases can be expensive. Keep only visible pages and
            // failed-load/failed-save states (the latter must never be lost).
            if state.loaded && !state.dirty {
                release(state)
                states.removeValue(forKey: index)
            }
        }

        func canvasViewDidBeginUsingTool(_ canvasView: PKCanvasView) {
            activate(canvasView)
            if let state = states.values.first(where: { $0.overlay.canvas === canvasView }) {
                state.onInkBegan(state.index)
            }
        }

        func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
            guard let state = states.values.first(where: { $0.overlay.canvas === canvasView }),
                  state.loaded else { return }
            capture(state)
            // Deliberately synchronous, every change, including eraser/undo.
            // This is the integration boundary for the durable storage layer.
            _ = persist(state)
        }

        func canvasViewDidEndUsingTool(_ canvasView: PKCanvasView) {
            guard let state = states.values.first(where: { $0.overlay.canvas === canvasView }) else { return }
            capture(state)
            _ = persist(state)
            state.onInkEnded(state.index)
        }

        private func capture(_ state: PageState) {
            guard state.loaded, state.writable, configuration?.isDrawing == true, configuration?.replayActive != true else { return }
            let drawing = state.overlay.canvas.drawing
            let bytes = drawing.dataRepresentation()
            guard bytes != state.observedData else { return }
            state.drawing = drawing
            state.observedData = bytes
            state.dirty = true
        }

        @discardableResult
        private func persist(_ state: PageState) -> Bool {
            guard state.loaded, state.dirty else { return true }
            guard !state.saving else { return false }
            state.saving = true
            defer { state.saving = false }
            do {
                try state.saveDrawing(state.index, state.drawing)
                state.dirty = false
                state.lastSaveError = nil
                stopRetryTimerIfClean()
                return true
            } catch {
                scheduleRetryIfNeeded()
                let message = "Ink for page \(state.index + 1) is NOT saved. Keep this reader open and restore storage access. \(error.localizedDescription)"
                if state.lastSaveError != message {
                    state.lastSaveError = message
                    notify(message)
                }
                return false
            }
        }

        @discardableResult
        private func flushAll() -> Bool {
            var succeeded = true
            for state in states.values {
                capture(state)
                if !persist(state) { succeeded = false }
            }
            return succeeded
        }

        @objc private func flushForLifecycle() { _ = flushAll() }

        private func scheduleRetryIfNeeded() {
            guard alive, retryTimer == nil else { return }
            // Scheduled only after a write fails; no timer on the normal save
            // path. The owned timer is invalidated when clean or dismantled.
            let timer = Timer(timeInterval: 5, target: self,
                              selector: #selector(retryPendingSaves), userInfo: nil, repeats: true)
            RunLoop.main.add(timer, forMode: .common)
            retryTimer = timer
        }

        private func stopRetryTimerIfClean() {
            guard !states.values.contains(where: { $0.dirty }) else { return }
            retryTimer?.invalidate()
            retryTimer = nil
        }

        @objc private func retryPendingSaves() {
            guard alive, UIApplication.shared.applicationState == .active else { return }
            _ = flushAll()
            stopRetryTimerIfClean()
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard gestureRecognizer === pencilSelectionTap,
                  let view, let configuration, !configuration.textSelectionEnabled,
                  touch.type == .pencil || (configuration.replayActive && touch.type == .direct) else { return false }
            selectionTarget = nil; replaySeekTarget = nil
            let location = touch.location(in: view)
            guard let page = view.page(for: location, nearest: false) else { return false }
            let index = configuration.document.index(for: page)
            guard index != NSNotFound else { return false }
            let pdfPoint = view.convert(location, to: page)
            let crop = page.bounds(for: .cropBox).standardized
            let inkPoint = CGPoint(x: pdfPoint.x - crop.minX, y: crop.maxY - pdfPoint.y)
            let tolerance = 8 / max(view.scaleFactor, 0.05)
            if configuration.replayActive {
                replaySeekTarget = configuration.replayHitTest(index, inkPoint, tolerance)
                return replaySeekTarget != nil
            }
            selectionTarget = configuration.inkHitTest(index, inkPoint, tolerance)
            return selectionTarget != nil
        }

        @objc private func selectInkWithPencil(_ gesture: UITapGestureRecognizer) {
            guard gesture.state == .ended else { return }
            if configuration?.replayActive == true, let time = replaySeekTarget {
                replaySeekTarget = nil
                configuration?.onReplaySeek(time)
                return
            }
            guard let id = selectionTarget else { return }
            selectionTarget = nil
            guard flushAll() else {
                notify("Save the current ink before selecting another annotation.")
                return
            }
            configuration?.onSelectInk(id)
        }

        @objc private func textSelectionChanged() {
            guard let view, let configuration, configuration.textSelectionEnabled else { return }
            let selection = GammaTextSelection.highlights(from: view.currentSelection, in: view)
            let callback = configuration.onTextSelection
            DispatchQueue.main.async { [weak self] in
                guard self?.alive == true, self?.configuration?.textSelectionEnabled == true else { return }
                callback(selection)
            }
        }

        @objc private func pageChanged() {
            guard let configuration, let page = view?.currentPage else { return }
            let index = configuration.document.index(for: page)
            guard index != NSNotFound else { return }
            let document = configuration.document
            let handler = configuration.onPageChanged
            DispatchQueue.main.async { [weak self] in
                guard let self, self.alive, self.configuration?.document === document else { return }
                handler(index)
            }
        }

        @objc private func scaleChanged() {
            updateGeometry()
            DispatchQueue.main.async { [weak self] in self?.updateGeometry() }
        }

        private func updateGeometry() {
            for index in displayed {
                guard let overlay = states[index]?.overlay else { continue }
                overlay.isReplaying = configuration?.replayActive == true
                if overlay.isReplaying { overlay.replayCanvas.drawing = configuration?.replayDrawing(index) ?? PKDrawing() }
                overlay.updateGeometry()
            }
        }

        private func index(for page: PDFPage) -> Int? {
            guard let document = configuration?.document, page.document === document else { return nil }
            let index = document.index(for: page)
            return index == NSNotFound ? nil : index
        }

        private func activateVisibleCanvas() {
            guard activeCanvas == nil, configuration?.isDrawing == true else { return }
            let current = (view?.currentPage).flatMap { index(for: $0) }
            let candidates = [current].compactMap { $0 } + displayed.sorted()
            for index in candidates where displayed.contains(index) {
                guard let state = states[index], state.loaded, state.writable,
                      state.overlay.acceptsInk, state.overlay.canvas.window != nil else { continue }
                activate(state.overlay.canvas)
                break
            }
        }

        private func activate(_ canvas: PKCanvasView) {
            guard configuration?.isDrawing == true, canvas.window != nil,
                  states.values.contains(where: { $0.overlay.canvas === canvas && $0.overlay.acceptsInk }) else { return }
            if activeCanvas !== canvas { deactivatePicker() }
            activeCanvas = canvas
            picker.setVisible(true, forFirstResponder: canvas)
            canvas.becomeFirstResponder()
            // Tool-picker preferences must not turn finger drawing back on.
            canvas.drawingPolicy = .pencilOnly
        }

        private func deactivatePicker() {
            guard let canvas = activeCanvas else { return }
            picker.setVisible(false, forFirstResponder: canvas)
            canvas.resignFirstResponder()
            activeCanvas = nil
        }

        private func notify(_ message: String) {
            guard let handler = configuration?.onError else { return }
            // UIKit overlay creation can occur inside a SwiftUI update. The
            // write has already completed/failed; defer only UI error reporting.
            DispatchQueue.main.async { handler(message) }
        }

        private func release(_ state: PageState) {
            state.onInkEnded(state.index)
            state.overlay.canvas.delegate = nil
            picker.removeObserver(state.overlay.canvas)
            state.overlay.onGeometryError = nil
            state.overlay.acceptsInk = false
        }

        private func clearPages() {
            deactivatePicker()
            for state in states.values { release(state) }
            states.removeAll()
            displayed.removeAll()
        }

        func dismantle() {
            alive = false
            retryTimer?.invalidate()
            retryTimer = nil
            deactivatePicker()
            if !flushAll() {
                notify("Reader closed with unsaved ink after a storage error. The PDF is unchanged, but those edits could not be persisted.")
            }
            clearPages()
            view?.onLayout = nil
            view?.pageOverlayViewProvider = nil
            view?.removeGestureRecognizer(pencilSelectionTap)
            pencilSelectionTap.delegate = nil
            selectionTarget = nil
            NotificationCenter.default.removeObserver(self)
            configuration = nil
        }
    }
}
