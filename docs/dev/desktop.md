# Desktop app (`desktop/`)

The desktop app's developer docs live in the folder itself, separate from
Gamma's — the shell treats Gamma as a black box (HTTP API + env config), so
nothing in `backend/` or `frontend/` needs to know about it:

- [desktop/README.md](../../desktop/README.md) — overview + run / develop.
- [desktop/docs/architecture.md](../../desktop/docs/architecture.md) — the
  workspace model (local sidecar servers + remote URLs), the window (shell
  bar with the workspace switcher + content view), remote reachability
  probes, in-app updates, shell state, file map, invariants.
- [desktop/docs/release.md](../../desktop/docs/release.md) — package, the
  `desktop` workflow, secret-gated code signing, the auto-update feed,
  distribution alternatives. All workflows side by side:
  [github_actions.md](github_actions.md).
- [desktop/docs/checklist.md](../../desktop/docs/checklist.md) — the
  pre-release QA checklist and what `npm run e2e` / `npm run e2e:packaged`
  cover.

The only contract Gamma keeps for the shell: the env variables
`GAMMA_DATA_DIR`, `GAMMA_STATIC_DIR`, `GAMMA_ADMIN_USER`,
`GAMMA_ADMIN_PASSWORD`; `/api/health`; `/api/session` + `/api/login` for the
silent first login; and the `data-theme` attribute on `<html>` (the shell
mirrors it into its own chrome).
