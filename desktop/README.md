# Gamma desktop (`desktop/`)

The Windows/macOS/Linux app. It is deliberately a **thin shell**: Gamma's backend
and frontend are untouched — the shell is an Electron window plus a process
manager, and the app the window shows always loads from the Gamma server it
is connected to (exactly like a browser tab). No API-base plumbing, no CORS,
no version skew: each server serves its own matching frontend. Gamma's own
workspaces (the libraries inside a server) are switched from the same shell
bar as the servers.

This folder is self-contained; the rest of the repo only knows the shell
through the black-box contract listed under *Invariants* in the
architecture doc. **Read the relevant doc before working in that area and
keep it in sync:**

- [docs/architecture.md](docs/architecture.md) — servers (local sidecars +
  remote URLs) and Gamma's workspaces in the switcher, the window (shell bar
  + content view),
  remote reachability probes, in-app updates, shell state on disk, the file
  map, invariants.
- [docs/release.md](docs/release.md) — package, the `desktop` workflow,
  code signing (Azure Trusted Signing / Apple notarization, secret-gated),
  the auto-update feed, distribution alternatives (Store, winget). The
  repo's workflows side by side:
  [docs/dev/github_actions.md](../docs/dev/github_actions.md).
- [docs/checklist.md](docs/checklist.md) — the pre-release QA checklist and
  what `npm run e2e` / `npm run e2e:packaged` cover.

## Run / develop

```bash
cd desktop && npm install       # once (needs the fnm node on PATH)
npm start                       # dev mode: sidecars run from backend/venv,
                                # frontend served from frontend/dist (build it first)
npm run smoke                   # quick self-test: temp local server → health → auto-login
npm run e2e                     # full suite (docs/checklist.md), ~3 min
```

On Windows, `desktop\start.cmd` launches without any PATH setup — it finds
the fnm-managed node itself and clears `ELECTRON_RUN_AS_NODE` (pass
`--smoke` to run the self-test instead).

Dev-mode gotchas: unset `ELECTRON_RUN_AS_NODE` if launching from inside an
Electron-based tool (VSCode terminals set it and Electron then runs as plain
Node). The smoke test prints one `SMOKE {...}` JSON line and exits 0/1. The
in-app updater is inert in dev (`app.isPackaged` is false) and under the
test harness; a packaged build reports *Development build* / *disabled* in
the launcher's Updates row accordingly.

Packaging and releasing: [docs/release.md](docs/release.md).

Packaging inputs live in `assets/`: the app icon, macOS entitlements,
`appx/` tiles, and `store/` listing artwork. `scripts/store-art.js` regenerates
the Store images through `npm run store-art`. `build/` is for generated
PyInstaller work/spec files; `dist/`, `dist-backend/`, and `dist-store/` hold
build outputs. See the [repository map](../docs/dev/repository.md).
