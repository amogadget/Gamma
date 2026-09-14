# frontend/

React + Vite SPA. Talks same-origin `/api/*`; in dev Vite proxies to `:9001`.

```bash
npm install
npm run dev      # :5173
npm run build    # → dist/  (FastAPI serves this in prod)
```

- `src/` — app code, see src/README.md
- `public/media/icons/` — app icons served as-is (`/media/icons/favicon.svg`)
- `dist/assets/` — Vite-generated, content-hashed bundles; do not put unversioned public files here
- `vite.config.js` — dev proxy + build config

View modes are derived from the URL (no router lib): `/` home · `/?page=<id>` page · `/?share=<token>` public · `/?block=<id>` jump-to-block.

Repository and asset locations: [docs/dev/repository.md](../docs/dev/repository.md).
Planned application decomposition: [docs/dev/frontend-refactor.md](../docs/dev/frontend-refactor.md).
