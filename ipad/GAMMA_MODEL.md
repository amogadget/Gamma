# Gamma-native iPad model

This supersedes the import-only prototype. The iPad app is a client of the same Gamma account, library and unified block tree—not a second notebook database.

## Identity and navigation

- Connect/sign in to a Gamma server; library entries are server page blocks.
- Open an existing page by its Gamma block id and doc_id. Cached PDF bytes are not another imported document.
- Cache and pending operations are isolated by normalized server origin/deployment path and the authenticated username returned by the server, then page and block ids.
- A network failure is a pending sync or visible error, never a claim that local-only changes reached Gamma.
- Old UUID-based prototype note bundles must not be silently deleted or silently attached to unrelated server papers.

## Handwriting and notes

The user explicitly chooses **New Ink** on a PDF page. This creates one `pdf_ink` block with a stable client-generated UUID under the existing Gamma PDF page block. Multiple strokes belong to that one annotation; selecting it later permits continued editing.

The annotation block's `content` holds the corresponding textual note. Its `children` are ordinary Gamma note blocks. The Notes tree and the PDF ink surface are views of the same object; they must not maintain independent annotation/note identities.

Only the selected annotation is editable. Other annotations on the page are displayed as read-only background ink, preventing an eraser from silently modifying a different block.

A drawing save updates ink assets/properties, never overwrites the note text or replaces its children. Text edits do not overwrite ink properties.

## Coordinates and persistence

- `pdf_page` in server properties is one-based; PDFKit indexes are zero-based at the reader boundary.
- PKDrawing points use unrotated crop-box points, origin at top-left, x right, y down (`pdf-crop-top-left-v1`).
- Each annotation preserves the editable PKDrawing source and a PNG preview cropped to its declared ink bounds.
- Canonical page-relative coordinates are independent of viewport zoom, orientation and scrolling.
- The local save boundary atomically preserves pending drawing data before scheduling network upload.
- Upload content-addressed assets, then conditionally upsert the block. Retry uses the same UUID; conflicting server revision must be surfaced, not overwritten.

## Phase 1 boundaries

No recording, audio timestamps or replay. Programmatically generated PKDrawing/framework tests are not proof of real Pencil input latency, palm rejection or gesture arbitration. A successful simulator suite alone does not satisfy full Phase 1 hardware acceptance.
