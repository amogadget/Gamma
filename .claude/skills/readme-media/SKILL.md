---
name: readme-media
description: Record and regenerate README screenshots and demos from the curated demo workspace using the tooling in tools/readme-media.
---

# README media

Read [the media tooling guide](../../../tools/readme-media/README.md) before
recording: setup, the recipe per README slot, the delivery rules and the
review steps live there, and the per-shot details in
[WORKFLOW.md](../../../tools/readme-media/WORKFLOW.md). This skill holds no
scripts.

- Use the real curated demo workspace (exported through the API). Do not invent
  a replacement library or read account databases for credentials. Credentials
  may be in project memory (`gamma-demo-account.md`); otherwise ask for the demo
  login. Never commit credentials, cookies, or workspace exports.
- After a capture, run `check-media.mjs`, inspect the contact sheets, verify the
  demonstrated action saved, update the matching README link, and stop any
  isolated server you started.
- Leave changes in the working tree. Do not commit unless the user asks.

The research behind the style lives in
[demo-production.md](../../../docs/research/demo-production.md).
