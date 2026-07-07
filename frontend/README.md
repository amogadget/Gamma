# frontend/

React + Vite SPA. Talks same-origin `/api/*`; in dev Vite proxies to `:9001`.

```bash
npm install
npm run dev      # :5173
npm run build    # → dist/  (FastAPI serves this in prod)
```

- `src/` — app code, see src/README.md
- `public/` — static assets served as-is (`favicon.svg`, `pdf.worker.min.mjs`)
- `vite.config.js` — dev proxy + build config

View modes are derived from the URL (no router lib): `/` home · `/?page=<id>` page · `/?share=<token>` public · `/?block=<id>` jump-to-block.
