# gammapdf.com

The product website: one static page plus the privacy policy, served by a
Cloudflare Worker with static assets. Nothing here is part of the app; the
app's own README and `docs/` stay the source of the copy and the artwork.

```
sites/
  site/            the pages as deployed: index.html, styles.css, site.js,
                   404.html, robots.txt, sitemap.xml, _redirects, _headers
  templates/       header, footer and the wrapper for Markdown pages,
                   pulled into every page by `<!--#include name -->`
  build.mjs        assembles dist/ (see below)
  src/index.js     the Worker: sends www to the apex, serves everything else
                   from the assets binding
  wrangler.jsonc   the Worker config, custom domains gammapdf.com + www
  dist/            build output, ignored
```

## What the build does

`npm run build` runs `build.mjs`, which:

1. copies `site/` to `dist/`, expanding the includes in every `.html`;
2. copies the artwork the page uses from the repository into `dist/media/`:
   the favicon (`frontend/public/media/icons/`), the hero PNG and the
   illustration SVGs (`docs/assets/branding/`), the six README demos
   (`docs/assets/demos/`) and the app screenshot (`docs/assets/screenshots/`).
   The site keeps no copies of its own, so regenerating brand assets or
   re-recording a demo updates the site on its next deploy;
3. renders `PRIVACY.md` at the repository root to `dist/privacy/` through
   `templates/page.html` (the Store listing links to that page).

The page itself has no framework and no web fonts (the brand's system font
stack), and makes one kind of outbound request: `site.js` asks the GitHub API
for the release list to fill in the version, the per-OS installer links and
the extension zip, and for the star count. Every element keeps a working
fallback link if that call fails. There are no cookies and no analytics, in
line with the app's privacy policy.

The header's **Sign in** link and the `/login`, `/account` and `/signup`
short links go to the Gamma Cloud account server at `account.gammapdf.com`
([docs/dev/cloud_accounts.md](../docs/dev/cloud_accounts.md)); the site
itself has no accounts.

`_redirects` gives the short links (`/download`, `/download/windows`,
`/docs`, `/github`, …); its sources must be relative paths, so the `www.` to
apex redirect is the Worker script's job. `_headers` sets the security
headers and a one-day cache on `/media/*`.

## Run locally

```bash
cd sites
npm install
npm run dev        # build, then wrangler dev on http://localhost:8787
```

`wrangler dev` needs the `workerd` binary that npm's install scripts fetch;
if npm reports pending install scripts, run `npm approve-scripts` for
`workerd` and `esbuild` once. Without it, `npm run build` still works and any
static file server over `dist/` shows the site.

## Deploy

Manually, from a machine that is logged in (`npx wrangler login` once):

```bash
cd sites
npm run deploy     # build + wrangler deploy
```

From CI: `.github/workflows/site.yml` deploys on every push to `main` that
touches `sites/`, the assets it copies, or `PRIVACY.md` (and on manual
dispatch). It needs two repository secrets:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | an API token with the *Edit Cloudflare Workers* template (Workers Scripts: Edit, plus Zone → Workers Routes: Edit for the custom domains) |
| `CLOUDFLARE_ACCOUNT_ID` | the account id from the Workers overview page |

### First-time setup of the domain

1. Add `gammapdf.com` as a zone on the Cloudflare account (change the
   registrar's nameservers to the ones Cloudflare assigns). The `routes` in
   `wrangler.jsonc` are Custom Domains, which Cloudflare can only create
   inside a zone it serves.
2. Deploy. Wrangler creates the Worker, uploads `dist/`, and attaches
   `gammapdf.com` and `www.gammapdf.com` as custom domains (DNS records and
   certificates are created automatically). The Worker script then sends
   `www` to the apex.
3. Until the zone exists, comment the `routes` block out; the deploy then
   lands on the `*.workers.dev` preview URL only.

## Editing the page

- Copy comes from the README and the Store listing
  (`desktop/assets/store/listing.md`); keep the three in step when a feature
  changes.
- Section order and tone follow the survey in
  [docs/research/website.md](../docs/research/website.md).
- The page must work without `site.js` (it does: every link has a static
  fallback) and in both color schemes (the illustrations are light-only;
  the screenshot and demos are shown as recorded).
- A new page: add a `.html` under `site/` with the two includes, or a
  Markdown source to the `PAGES` list in `build.mjs`, and a `<url>` to
  `sitemap.xml`.
