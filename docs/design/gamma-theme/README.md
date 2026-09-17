# Paper & amber — Gamma palette proposal

Open [index.html](index.html) in a browser. Toggle **Hero palette / Current palette**
and **Light / Dark** to compare the same illustrative reading workspace. This is
a standalone color study with sample content; it does not change the app or
connect to a workspace. The current comparison uses the app's existing colors,
not a screenshot of the running application.

The starting colors come directly from `docs/assets/branding/gamma-hero-*.svg`:
paper `#f6f4ef`, ink `#1a1a18`, warm gray `#6b6a65`, and amber `#e8a020`.
The supporting workspace illustration supplies the warm charcoal surfaces.

| Role | Light | Dark |
|---|---|---|
| Canvas | `#f6f4ef` | `#1b1b1a` |
| Surface | `#ffffff` | `#272725` |
| Main text | `#1a1a18` | `#f0ede6` |
| Muted text | `#6b6a65` | `#a9a69e` |
| Brand mark / highlight edge | `#e8a020` | `#e8a020` |
| Links, focus, primary actions | `#92620e` | `#e8b451` |
| Selected background | `#f4e8cf` | `#493b23` |
| Text on primary action | `#ffffff` | `#1b1b1a` |

The hero's bright amber is decorative. The darker light-theme amber makes small
links and white button text legible; dark mode uses a lighter amber with charcoal
button text. Warm neutral surfaces do most of the work, with amber reserved for
selection and interaction. PDF paper stays white, and existing annotation colors
retain their meaning. Success and destructive actions remain green and red.

[`palette.css`](palette.css) maps the proposal to Gamma's existing CSS token names,
plus `--brand` and `--on-accent`. It is deliberately scoped to this preview. Before
app integration, solid accent buttons would need to adopt `--on-accent`, and
callouts, other themes, PDF inversion, and desktop chrome would need review.

Generate light/dark and mobile screenshots using the frontend's Playwright:

```sh
node tools/branding/preview.mjs
```

Screenshots are written to ignored `artifacts/theme-preview/`.
