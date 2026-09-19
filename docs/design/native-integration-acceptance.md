# Native integration acceptance gates

This checklist describes required evidence, not completed verification. Recorded simulator results and verification boundaries are summarized in [iPad validation](../../ipad/VALIDATION.md).

## Preservation and workspace isolation

- Inventory original uploads and native blocks before migrating a stopped disposable copy. Inventory the migrated copy after startup/cleanup and compare hashes.
- Legacy `/api/assets` attachments survive startup, block deletion elsewhere, portable export/import and workspace backup/restore.
- A user with two workspaces cannot fetch/upload/edit an asset or block in the wrong workspace; switching the default does not redirect a pending mutation.
- Owner/editor may write; viewer, removed membership, stale account guard and unauthorized share requests fail without changing data.
- HTML image/audio URLs explicitly name the workspace because media elements cannot attach the workspace header.
- Legacy account-only iPad cache is associated only with a verified default workspace; ambiguous state is retained and surfaced, never silently discarded/reassigned.
- Reopening a cache ignores changes in workspace display name. A process death between legacy-directory rename and identity rewrite is recoverable on retry, with all original source/outbox bytes retained. Failed rollback must report where the preserved files actually remain.

## Saving and collaboration

- Native ink/audio/highlight/note updates use upstream page operations and notify connected Web clients.
- Identical retries after a lost response do not duplicate blocks or advance revisions twice.
- Stale native revisions return a conflict; source files and pending changes remain available locally.
- Ordinary block ops, bulk replace, AI writes and browser editing cannot overwrite native protected fields or drop newer manifests.
- Generic content changes remain possible without mutating native source/revision properties.
- Preview updates require matching source hash and do not alter ink revision.
- A native save arriving during Web editing is reconciled without whole-tree replacement.

## Rendering and replay

- Existing upstream `.ink` drawing, eraser, lasso, undo and PDF export still work.
- Native `.pkdrawing` is retained as editable source; browser previews are never promoted to that source.
- Native static overlays and Notes thumbnails share high-resolution previews, with explicit fallback when unavailable.
- Rotated/cropped pages use correct coordinates; ink and notes jump to the correct page and position.
- AAC playback is tested in a browser with actual codec support; successful loading alone is not playback verification.
- Audio clock drives stroke/page/note replay across segments, pause/resume, seeks and end-of-recording.
- Missing/stale replay files do not fabricate timing; fallback is visible and intentional.

## iPad and offline

- Web/native handoff checks origin, main frame, account, workspace, write role and page/doc identity after pending Web saves finish.
- Returning to Web waits for acknowledged native changes and reloads scoped state.
- Source files and pending outbox operations survive app termination, offline restart and failed preview generation.
- Recording permission, interruption, route changes and rollover preserve finalized audio; no unsupported background-recording promise.
- Cache identity includes server + authenticated user + workspace in downloads, manifests and recording/outbox paths.
- Existing bundle identity/signing configuration is retained for device cache continuity.

## Required platforms

Linux can establish backend/unit/build/browser results. Swift source review is not a substitute for compiling with Xcode. A Mac must run the iPad build and simulator tests; physical iPad + Pencil + microphone are required for writing fidelity, input latency, interruption/Bluetooth routing and offline lifecycle acceptance. Missing hardware evidence must remain explicit in the final report.

## Deployment

No automatic switch of port 9001, original container/data, or image tag `gamma:local`. Any trial uses a new image tag and a disposable intact data copy. A previous upstream trial copy with deleted attachments is not a valid migration source. Retain rollback container, original volume and full archives until explicitly released.
