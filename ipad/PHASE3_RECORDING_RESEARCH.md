# Phase 3 Recording — research and simulation

## Scope

Research only. No recording UI, microphone request, recording capability, backend audio route or release is added. All prototype code is under `GammaIPadTests/RecordingResearch` and therefore excluded from the application target. Existing PDF/ink/note behavior is unchanged.

Phase 3 covers explicit record, pause/resume, stop and reliable session/file persistence. Stroke timestamps, navigation timestamps and playback replay remain Phase 4/5 work.

## Proposed native path

- iPadOS 17+: request microphone permission using `AVAudioApplication.requestRecordPermission`; add `NSMicrophoneUsageDescription` only when integrating the actual feature.
- Start with `AVAudioRecorder`, mono AAC in `.m4a`, targeting 48 kHz / 64 kbps as an initial experiment, not a finalized quality choice. Read actual file format/duration instead of assuming the device uses the requested rate.
- Use `AVAudioSession` to configure and activate recording explicitly. A Phase 3 recorder can begin with `.record`; choose `.playAndRecord` only if concurrent playback becomes a requirement. Do not capture audio without explicit user action.
- Observe interruptions, route changes and media-services reset separately from SwiftUI scene changes. An interruption ending is not unconditional permission to resume; initial behavior should require an explicit Resume action.
- Start with the built-in microphone. Bluetooth transitions, unplugging an external mic, background recording, lock-screen behavior and long sessions require physical-device checks before support is promised.

## Segment strategy

Proposal: finalize a file when pausing or handling an interruption, then create a new segment on explicit resume. The UI still displays one recording session. This is deliberately simpler for recovery than keeping a single AAC file open through long pauses.

Long continuous recording also needs periodic segment finalization. The first engineering spike should compare 1–5 minute segments for recoverable loss window and upload cost. `AVAudioRecorder` stop/new-file rollover does **not** establish gapless audio. Measure any gap; move to `AVAudioEngine` plus a continuous capture buffer only if measured requirements justify it. Do not promise sample-perfect switching based on this simulation.

The session duration is the sum of finalized, validated segment durations plus the active recorder's audio-clock observation. Never use `Date() - startedAt`: pauses, clock changes and interruptions must not advance the audio timeline. Snapshot a recorder's time before stopping, then validate the finalized file duration. AAC priming/padding can differ from live clock measurements and must be reconciled before any future timestamp/replay contract is finalized.

## Gamma-native storage proposal

A recording session should eventually be an `audio` block under the existing Gamma page, not a separate local library. Proposed assets are immutable finalized `.m4a` segments and a versioned manifest. The current `/api/assets` accepts only PNG/PKDrawing: audio support, MIME validation, quota checks, backup coverage and conflict handling need a separate reviewed implementation.

Suggested manifest fields:

- schema version, Gamma page id, stable recording block/session id;
- phase (`idle`, `recording`, `paused`, `interrupted`, `recoveryRequired`, `stopped`);
- ordered segments with stable IDs, local/remote asset references, measured audio duration and finalization state;
- confirmed immutable segment start offsets derived from preceding segment durations.

Do not reuse ink revisions for audio. Upload finalized segments first, then conditionally update the audio block manifest; retries keep the same IDs. Audio-source preservation and staged-asset cleanup need explicit policies.

## Failure boundaries

1. Permission denied: no session advertised as recording, no microphone started.
2. Audio driver fails to start: preserve prior state and show failure.
3. Manifest save fails: do not report a successful transition. Stop/suspend capture safely if the driver already started; preserve any produced file for recovery. A state-file transaction alone cannot make hardware capture and filesystem changes atomic.
4. Interruption: finalize if possible, persist a paused/interrupted state, never silently auto-start later.
5. Process death: a previously `recording` manifest becomes `recoveryRequired`. An open AAC segment is not assumed playable. Validate/decode it; keep earlier finalized segments regardless of current partial-file failure.
6. Valid partial recovery may be shorter than the last observed clock. Recover measured playable duration explicitly; mark invalid partial files unrecoverable without pretending their time is intact audio.
7. Corrupt/unknown manifest or inconsistent segment structure: surface an error, do not silently replace it with a new blank session.

## Simulations implemented

`RecordingSimulation.swift` is a pure test-only state machine. It accepts audio-clock observations and a throwing persistence callback. State is committed only after that callback succeeds. It tests permission denial, monotonic audio time, pause/resume, explicit interruption recovery, snapshot reopen, write failures and crash reconciliation. This is not an AVAudioRecorder implementation.

`SyntheticRecordingAudioTests.swift` uses actual Apple `AVAudioFile` encoding/decoding on the simulator: generated PCM tone → finalized AAC `.m4a` segments → reopened decoded audio. It does not open a microphone, ask permission or play audio. Duration assertions allow codec padding and explicitly do not claim gapless rollover.

Run the focused suite on the Mac:

```sh
xcodebuild -project GammaIPad.xcodeproj -scheme GammaIPad \
  -destination 'platform=iOS Simulator,id=YOUR-IPAD-SIMULATOR-UDID' \
  -only-testing:GammaIPadTests/RecordingSimulationTests \
  -only-testing:GammaIPadTests/SyntheticRecordingAudioTests \
  CODE_SIGNING_ALLOWED=NO test
```

## Verified result

`RecordingResearch-1.xcresult` on the remote Mac: **11 tests passed, zero failures/skips**, confirmed through xcresulttool (9 state/persistence simulations + 2 actual synthetic AAC file tests). Xcode 26.6, iPad Pro 11-inch (M5) simulator, iOS 26.5. The pre-existing PDFKit Swift 6 conformance warning remains unrelated to this research.

This result validates the isolated model and finalized synthetic audio encode/decode path, not AVAudioRecorder microphone capture, real interruptions, unfinalized AAC salvage or background hardware behavior. No production app recording feature was installed or enabled, and no files were committed/pushed.

## Physical-device gate before integration is considered done

- Explicit permission flow including deny/revoke; microphone indicator and recording controls are clear.
- 10+ minute lecture recording, pause for several minutes, resume, reopen session and verify audio duration excludes the pause.
- App background/lock, interruptions, Bluetooth/external route changes and media-services reset.
- Low storage, failed file creation/finalization and force-termination recovery with bounded loss reporting.
- Measure segment boundary gaps, real microphone quality and battery/thermal behavior.

## Apple references

- [AVAudioRecorder](https://developer.apple.com/documentation/avfaudio/avaudiorecorder)
- [Microphone permission](https://developer.apple.com/documentation/avfaudio/avaudioapplication/requestrecordpermission(completionhandler:))
- [Handling audio interruptions](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions)
- [Responding to route changes](https://developer.apple.com/documentation/avfaudio/responding-to-audio-route-changes)

These references establish API direction; they do not replace a physical microphone spike or prove crash recovery of an unfinalized recording.
