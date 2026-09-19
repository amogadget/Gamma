# PDF + Pencil reader (phase 1)

Target: iPadOS 17, Swift 5.9. Add both Swift files to the app target. No audio, replay, PDF annotations, PDF writes, or third-party reader dependency.

## Integration contract

```swift
PDFInkView(
    document: document,
    loadDrawing: { pageIndex in try store.loadDrawing(pageIndex) },
    saveDrawing: { pageIndex, drawing in
        try store.saveDrawing(pageIndex, drawing)
    },
    onError: { message in /* present a persistent, visible error */ },
    isDrawing: true // optional; false hides picker and disables ink editing
)
```

- Page indexes are **zero-based**. Callbacks execute synchronously on the main thread. Keep the `PDFDocument` instance and its page order/rotation/boxes immutable while open. Store sidecars under a stable document identity/fingerprint, not just the page number. Recreating the PDFDocument on every SwiftUI render unnecessarily reloads the reader.
- Return `PKDrawing()` only when no saved ink exists. Throw on read/decode failure. A failed load is locked against drawing and saving for this reader's lifetime; the error is surfaced, not silently replaced with a writable empty canvas. Close/reopen after repairing the file to retry the load.
- `saveDrawing` is called **immediately on each changed PencilKit drawing**, including erasure and undo/redo. There is no debounce, detached task, or saving only on page disappearance. Complete the durable atomic write before returning; do not enqueue an eventual write and report success. Preserve the previous good sidecar if replacement fails. The storage agent owns the atomic-write/fsync/file-protection policy.
- Stroke end, page disappearance, application resign-active, turning drawing off, document replacement, and teardown perform additional synchronous dirty-save attempts. Drawing state is compared to its last observed serialized bytes to ignore initialization/layout notifications, including an unchanged empty drawing.
- A failed save remains dirty in memory and retries on the next drawing change or flush trigger, on application activation, and every five seconds while the app is active. The retry timer exists only after failure and stops when all pages are clean or the reader is dismantled. Repeated identical errors are deduplicated. Toggle drawing off after restoring storage access to retry immediately without adding ink. A document replacement is rejected while old ink cannot be saved, and old callbacks are retained so ink cannot be written under the new document's identity.
- **The parent must block dismissal/navigation after a failed write, or keep failed drawing snapshots outside this view.** The callback receives the complete drawing, so a storage wrapper can retain it and expose pending-save state. Destruction of this reader while writes still fail necessarily loses its in-memory recovery state; teardown explicitly reports that failure. `onError` is a UI message, not an unsaved-state binding or a reliable close gate. It is dispatched to the next main-queue turn to avoid modifying SwiftUI state inside an update. Never dismiss the reader automatically in response to a storage error.
- Clean offscreen canvases are released and reloaded on redisplay, including when PDFKit reuses the actual overlay view. Failed-load and failed-save states remain retained to protect ink. There is no cross-reader undo/history promise.

## Coordinates and supported transforms

Persisted `PKDrawing` points use an **unrotated, upper-left-origin crop-box coordinate system in PDF points**, x right / y down. They are NOT screen points or native PDF bottom-left coordinates. For crop box `B`, canonical ink point `(x,y)` corresponds to PDF page point `(B.minX + x, B.maxY - y)`.

The overlay maps three crop-box corners through `PDFView.convert(_:from:)` and UIKit view conversion, deriving the full affine map. This accounts for nonzero/negative crop origins, the media/crop intersection reported by PDFKit, mixed page sizes, and PDF `/Rotate` multiples of 90° (0/90/180/270, including equivalent negative rotations). There is no hand-coded assumption about overlay bounds, PDFKit ancestor scale, or rotated width/height. Invalid boxes and non-quarter-turn page rotations are read-only and reported.

PencilKit's internal zoom follows PDFKit's scale (rendering clamp 0.05–16×); the outer transform cancels that extra rendering scale, preserving canonical drawing positions and widths without transforming stored strokes. Layout/window resizing and PDFView scale notifications recompute the mapping. Device orientation changes are view-layout changes, not edits to page rotation. Scrolling is native vertical continuous PDFKit scrolling.

Perspective/non-affine application transforms, changing the PDF's page boxes/rotation/order in place, and nonstandard PDF coordinate mutations are not supported. PDFs whose contents have their own drawing matrices are fine: ink aligns to the displayed page, not to content-stream coordinates.

## Input and tools

`PKCanvasView.drawingPolicy = .pencilOnly`; a retained `PKToolPicker` observes the canvases and follows the active Pencil page. Canvas scrolling/pinch are disabled. Public `UIScrollView` ancestors of each overlay have pan/pinch touch types restricted to direct/indirect-pointer input, so fingers navigate the PDF and Pencil does not pan it. This uses the actual ancestor chain and public UIKit types, not PDFKit private class names/KVC. It relies on PDFKit placing overlays within its navigation scroll view; verify this on supported OS versions.

Hit testing deliberately does **not** inspect `UIEvent.allTouches`: UIKit can call it before touches are populated, and mixed Pencil/finger events cannot be classified by the presence of any Pencil alone. In read-only mode overlays return no hit target. No finger drawing is provided in phase 1. Navigation remains finger/trackpad-only when drawing is disabled; Pencil panning is not enabled. The default pen is black to remain visible on a white PDF in system dark mode.

## Review / device acceptance checklist

Implementation received a focused independent source review and follow-up review. A synthetic Python check passed 2,880 crop/rotation/ancestor-scale/render-zoom affine invariance cases; this verifies the algebra, not UIKit behavior. Added-file whitespace checks passed. Subsequent remote Mac verification compiled the app with Xcode 26.6 and passed all 23 simulator XCTest cases, including four explicit reader integration tests (see `../../VALIDATION.md`). Real Pencil input and physical-device acceptance remain **unverified**; the synthetic algebra and explicit-callback tests do not establish real gesture or pixel-alignment correctness. Run these before release:

1. Build with Xcode/iPadOS 17 SDK and Swift 5.9; open a multi-page PDF on a real Pencil-capable iPad.
2. Test all four page rotations, nonzero/negative crop origins and a crop smaller than media, mixed sizes, portrait/landscape device rotation, and split-view resizing. Put corner/crosshair strokes on landmarks; zoom repeatedly, scroll away/back, relaunch, and confirm exact alignment/widths.
3. Draw at fit size and maximum pinch zoom; verify sharp ink and unchanged saved point coordinates. Test drawing near each crop edge.
4. One-finger PDF pan, two-finger pinch, Pencil drawing, and mixed Pencil/finger input must not steal each other's gestures. Confirm picker appears, switches tools/colors/eraser, and follows the page being inked. Confirm it hides in read-only mode and on reader teardown.
5. Scribble, erase the last stroke, undo/redo, immediately background, and reopen. Confirm each changed drawing invokes the durable callback before returning and an intentionally empty final drawing persists.
6. Inject unreadable/corrupt ink: visible error, no editable empty replacement, and **zero save callbacks for that page**, including teardown. Repair and reopen.
7. Inject write failure: previous sidecar intact, visible error, dirty drawing remains on return to page, old document cannot be replaced. Restore writes and turn drawing off; verify recovery. Parent navigation must remain gated while pending writes exist.
8. Traverse a long ink-heavy PDF and monitor memory: clean offscreen canvases should be released by this reader. PDFKit may maintain its own internal cache.

## Apple references checked

- [PDFPageOverlayViewProvider](https://developer.apple.com/documentation/pdfkit/pdfpageoverlayviewprovider), including `overlayViewFor`, `willDisplayOverlayView`, and `willEndDisplayingOverlayView` declarations.
- [PDFPage.bounds(for:)](https://developer.apple.com/documentation/pdfkit/pdfpage/bounds(for:)): page-space coordinates, rotation caveat, media-box intersection.
- [canvasViewDrawingDidChange](https://developer.apple.com/documentation/pencilkit/pkcanvasviewdelegate/canvasviewdrawingdidchange(_:)): changed-drawing persistence callback.
- [PKCanvasView.drawingPolicy](https://developer.apple.com/documentation/pencilkit/pkcanvasview/drawingpolicy).
- [PKToolPicker.setVisible(_:forFirstResponder:)](https://developer.apple.com/documentation/pencilkit/pktoolpicker/setvisible(_:forfirstresponder:)): responder monitoring/removal lifecycle.

The actual Apple documentation JSON declarations and discussion were fetched during implementation, not inferred from unofficial API names.
