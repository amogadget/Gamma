---
name: readme-media
description: Record and regenerate README screenshots and demos from the curated demo workspace using the tooling in tools/readme-media.
---

# README media

Read [the media tooling guide](../../../tools/readme-media/README.md) before
recording. Scripts and recipes live there; this skill contains no executable
helpers or generated artifacts.

- Use the real curated demo workspace. For ink, export through the login/export
  APIs and let `record-ink.mjs` import it into an isolated disposable server.
  Do not invent a replacement library or read account databases for credentials.
- Credentials may be in project memory (`gamma-demo-account.md`); otherwise ask
  for the demo login. Never commit credentials, cookies, or workspace exports.
- Follow [the existing shot recipes](../../../tools/readme-media/WORKFLOW.md)
  for older clips and their account/AI requirements. New demos should follow
  the current pacing and delivery guidance in the tooling README.
- Keep scripts in `tools/readme-media/`, final media in `docs/assets/demos/` or
  `docs/assets/screenshots/`, and intermediates in ignored `tmp/readme-media/`.
- Inspect encoded sample frames, verify the demonstrated action saved correctly,
  update the matching README link, and stop any isolated server you started.
- Leave changes in the working tree. Do not commit unless the user asks.

The research behind the style lives in
[demo-production.md](../../../docs/research/demo-production.md).
