# Phase 3 recording integration

## Use

Open a Gamma PDF and tap the microphone in the reader toolbar.

- **Start recording** asks for microphone permission, then starts native AVAudioRecorder capture. A red indicator and audio-clock timer remain in the toolbar.
- **Pause / Continue / Stop** operate on one Gamma recording session. Pause finalizes the current file; Continue creates another immutable segment.
- Continuous capture rolls over about every five minutes. This limits the open-file recovery window; it is not a claim of gapless encoding.
- Leaving the document, backgrounding the app, an audio interruption or an input-route change stops/finalizes the active segment. Resume is explicit; background/lock-screen continuous recording is not enabled in this version.
- **Play** plays the session's finalized segments in order. **Stop playback** stops it. Audio is not synchronized to Pencil strokes in Phase 3.
- If the app was killed while a segment was open, **Recover** attempts to decode it fully. **Keep finalized audio** explicitly excludes the incomplete segment while retaining its local file. A failed local metadata save remains retryable and blocks navigation/sign-out.

## Gamma model and persistence

One recording is a normal `audio` block under the existing Gamma PDF page. Its `content` is an editable note; its properties contain the audio revision, state, measured total duration and ordered segment references. Web Notes provide HTML audio controls for the same uploaded segments.

Each account-scoped page cache atomically stores `recordings` metadata with its pending `.audio` mutation. Segment files live at `GammaCache/<account>/audio/<recording UUID>/<segment UUID>.m4a`. The active segment identity is persisted before starting capture; only validated finalized segments are uploaded. Network retries keep the recording and segment UUIDs. Backend conditional revisions protect against overwriting concurrent changes; explicit conflict choices are available in recording controls.

Audio assets use the existing private `/api/assets` system (`audio/mp4`, `.m4a`, maximum 32MiB). The audio block is saved through `PUT /api/blocks/{UUID}/audio`; exact retries are idempotent. Backup/import/orphan handling includes audio. Passwords are not stored, and microphone capture never auto-starts after relaunch or permission completion in the background.

## Verification and remaining limits

- Production controller/UI compiled on Xcode 26.6 with a microphone usage description; no replay or stroke timestamp feature was added.
- `RecordingIntegration-2.xcresult`: 10 targeted tests passed (production recording cache/recovery + existing workspace + synthetic AAC codec checks).
- `AudioLive-1.xcresult`: real backend test passed using simulator-generated AAC data, production audio outbox upload, two segment assets, server-derived offsets, duplicate request handling and cache reopen. No mocked backend responses; test-only loopback bridge, not public TLS deployment.
- Backend targeted audio/ink tests: 18 passed; backend Ruff passed. Frontend: 48 tests passed and build succeeded.
- A prior lint check found two small Python style errors; fixed before deployment.
- Full AAC recovery scanning initially failed by reading beyond logical EOF. Bounded reads fixed it; `RecordingFinal-2.xcresult` passed all four production recording tests, including recovery and failed-write retry. Native AVAudioRecorder/Player callbacks hop explicitly to the main actor.
- Live Gamma audio route was deployed after a consistent data backup at `/home/ubuntu/gamma-deployment-backups/before-audio-20260910T035558Z.tar.gz`; rollback image `gamma:before-audio-integration` retained. Public health returned 200 and OpenAPI includes the audio endpoint.

The final GUI-session signed build exited 0. Verified the microphone usage string and code signature, installed on the connected physical iPad (installation sequence 1748), and launched successfully. This update also includes the previously pending Pencil-tap selection change. No live microphone recording was initiated by the agent.

**Not yet hardware-validated:** real microphone quality/permission dialogs, long recording/thermal behavior, actual phone-call interruptions, Bluetooth transitions, real disk-full events or rollover gaps. Synthetic audio/file tests do not establish those behaviors. No new GitHub release or source push was performed.
