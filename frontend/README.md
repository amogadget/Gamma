# frontend/

React + Vite SPA. Talks same-origin `/api/*`; in dev Vite proxies to `:9001`.

```bash
npm install
npm run dev      # :5173
npm run build    # → dist/  (FastAPI serves this in prod)
npm test         # pure-module tests
npm run e2e      # browser suite against an isolated backend (build first)
```

- `src/` — app code grouped by function (`editor/`, `pdf/`, `settings/`, etc.), with application orchestration in `app/` and reused code in `shared/`; see the [source map](src/README.md)
- `public/media/icons/` — app icons served as-is (`/media/icons/favicon.svg`)
- `dist/assets/` — Vite-generated, content-hashed bundles; do not put unversioned public files here
- `vite.config.js` — dev proxy + build config

View modes are derived from the URL (no router lib): `/` home · `/?page=<id>` page · `/?share=<token>` public · `/?block=<id>` jump-to-block.

Repository and asset locations: [docs/dev/repository.md](../docs/dev/repository.md).
File organization is implemented; the larger application decomposition remains
planned in [docs/dev/frontend-refactor.md](../docs/dev/frontend-refactor.md).
