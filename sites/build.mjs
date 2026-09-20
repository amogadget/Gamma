// Assemble ./dist for `wrangler deploy`:
//   ./site/**            copied as-is, `<!--#include name -->` expanded from ./templates
//   ./dist/media/**      brand artwork, demos, the screenshot and the favicon,
//                        copied from the repository (the site keeps no copies)
//   ./dist/privacy/      PRIVACY.md at the repository root, rendered through
//                        templates/page.html
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(HERE, 'dist');
const SITE = path.join(HERE, 'site');
const TEMPLATES = path.join(HERE, 'templates');

// Destination (under dist/media) → source (under the repository root).
const MEDIA = {
  'favicon.svg': 'frontend/public/media/icons/favicon.svg',
  'logo.svg': 'docs/assets/branding/gamma-logo.svg',
  'app.png': 'docs/assets/screenshots/01-annotated-pdf.png',
  'hero-light.png': 'docs/assets/branding/gamma-hero-light.png',
  'hero-dark.png': 'docs/assets/branding/gamma-hero-dark.png',
  'library-light.svg': 'docs/assets/branding/gamma-library-light.svg',
  'library-dark.svg': 'docs/assets/branding/gamma-library-dark.svg',
  'connections-light.svg': 'docs/assets/branding/gamma-connections-light.svg',
  'connections-dark.svg': 'docs/assets/branding/gamma-connections-dark.svg',
  'workspaces-light.svg': 'docs/assets/branding/gamma-workspaces-light.svg',
  'workspaces-dark.svg': 'docs/assets/branding/gamma-workspaces-dark.svg',
  'anywhere-light.svg': 'docs/assets/branding/gamma-anywhere-light.svg',
  'anywhere-dark.svg': 'docs/assets/branding/gamma-anywhere-dark.svg',
  'demo-annotate-and-ink.webp': 'docs/assets/demos/demo-annotate-and-ink.webp',
  'demo-notes.webp': 'docs/assets/demos/demo-notes.webp',
  'demo-native-agentic.webp': 'docs/assets/demos/demo-native-agentic.webp',
  'demo-library.webp': 'docs/assets/demos/demo-library.webp',
  'demo-reference-links.webp': 'docs/assets/demos/demo-reference-links.webp',
  'demo-metadata.webp': 'docs/assets/demos/demo-metadata.webp',
};

// Markdown pages rendered through templates/page.html.
const PAGES = [
  {
    rel: 'privacy/index.html',
    source: 'PRIVACY.md',
    title: 'Privacy policy',
    description: 'What Gamma stores, where it stays, and the network requests it makes.',
  },
];

const template = name => fs.readFileSync(path.join(TEMPLATES, `${name}.html`), 'utf8');
const expand = html => html.replace(/<!--#include (\w+) -->/g, (_, name) => expand(template(name)));
const write = (rel, content) => {
  const out = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, content);
};
const walk = dir => fs.readdirSync(dir, { withFileTypes: true, recursive: true })
  .filter(entry => entry.isFile())
  .map(entry => path.join(entry.parentPath ?? entry.path, entry.name));

fs.rmSync(DIST, { recursive: true, force: true });

for (const abs of walk(SITE)) {
  const rel = path.relative(SITE, abs);
  if (abs.endsWith('.html')) write(rel, expand(fs.readFileSync(abs, 'utf8')));
  else write(rel, fs.readFileSync(abs));
}

for (const [dest, src] of Object.entries(MEDIA)) {
  const from = path.join(ROOT, src);
  if (!fs.existsSync(from)) throw new Error(`Missing repository asset: ${src}`);
  write(path.join('media', dest), fs.readFileSync(from));
}

for (const page of PAGES) {
  const md = fs.readFileSync(path.join(ROOT, page.source), 'utf8');
  const html = expand(template('page'))
    .replaceAll('{{title}}', page.title)
    .replaceAll('{{description}}', page.description)
    .replaceAll('{{path}}', `/${path.posix.dirname(page.rel)}/`)
    .replace('{{content}}', () => marked.parse(md, { gfm: true }));
  write(page.rel, html);
}

const out = walk(DIST);
const bytes = out.reduce((n, f) => n + fs.statSync(f).size, 0);
console.log(`dist/: ${out.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
