// Regenerate tracked brand outputs, or verify provenance without a browser.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { markSvg } from './mark.mjs';
import { svgContent } from './svg-source.mjs';
import { logoSvg } from './logo.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const BRAND = path.join(ROOT, 'design/brand');
const lockPath = path.join(BRAND, 'generated.json');
const read = p => fs.readFileSync(path.join(ROOT, p));
const source = p => fs.readFileSync(path.join(BRAND, p), 'utf8');
// Git may check text out as CRLF on Windows and LF in CI.
const hash = (bytes, filename) => crypto.createHash('sha256')
  .update(/\.(json|mjs|py|svg|md|txt)$/.test(filename) ? bytes.toString().replaceAll('\r\n', '\n') : bytes).digest('hex');
const manifest = JSON.parse(source('outputs.json'));
const check = process.argv.includes('--check');
const allowed = new Set(['--check']);
for (const arg of process.argv.slice(2)) if (!allowed.has(arg)) throw new Error(`Unknown option: ${arg}`);

function files(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(entry => {
    const p = `${dir}/${entry.name}`;
    return entry.isDirectory() ? (entry.name === '__pycache__' ? [] : files(p)) : [p];
  });
}
const scenes = () => files('tools/branding').filter(p => /\/build-[a-z-]+\.py$/.test(p)).sort();
function inputs() {
  return Object.fromEntries([
    ...files('design/brand').filter(p => !p.endsWith('/generated.json') && !p.endsWith('.md')),
    ...files('tools/branding').filter(p => /\.(mjs|py)$/.test(p)),
    'frontend/package-lock.json',
    // The connections illustration embeds these licensed third-party marks.
    ...files('frontend/src/shared/illustrations/brands').filter(p => !p.endsWith('/gamma.svg')),
  ].sort().map(p => [p, hash(read(p), p)]));
}
function dimensions(bytes, filename) {
  if (filename.endsWith('.png')) {
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`Invalid PNG: ${filename}`);
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  const svg = bytes.toString();
  const width = svg.match(/<svg\b[^>]*\bwidth="(\d+)"/);
  const height = svg.match(/<svg\b[^>]*\bheight="(\d+)"/);
  if (!width || !height) throw new Error(`Missing SVG dimensions: ${filename}`);
  return [+width[1], +height[1]];
}
if (check) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const failures = [];
  if (JSON.stringify(inputs()) !== JSON.stringify(lock.inputs)) failures.push('Brand sources or rendering toolchain changed; regenerate outputs.');
  for (const [p, expected] of Object.entries(lock.outputs)) {
    try {
      const bytes = read(p);
      if (hash(bytes, p) !== expected.sha256 || JSON.stringify(dimensions(bytes, p)) !== JSON.stringify(expected.size)) failures.push(`Stale or modified: ${p}`);
    } catch (error) { failures.push(`${p}: ${error.message}`); }
  }
  for (const entry of manifest) if (!lock.outputs[entry.destination]) failures.push(`Unrecorded destination: ${entry.destination}`);
  for (const dir of ['desktop/assets/appx', 'desktop/assets/store', 'extension/assets/icons', 'docs/assets/branding']) {
    for (const p of files(dir).filter(p => /\.(png|svg)$/.test(p))) if (!lock.outputs[p]) failures.push(`Unmanaged asset: ${p}`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`Brand check passed: ${Object.keys(lock.outputs).length} outputs; sources, hashes and dimensions verified.`);
} else {
  const { chromium, renderPng } = await import('./runtime.mjs');
  const { storeJobs } = await import('./store-layouts.mjs');
  const outputs = {};
  function emit(p, bytes, recipe) {
    bytes = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const destination = path.resolve(ROOT, p);
    if (!destination.startsWith(ROOT)) throw new Error(`Output outside repository: ${p}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
    outputs[p] = { ...recipe, size: dimensions(bytes, p), sha256: hash(bytes, p) };
  }
  for (const entry of manifest) {
    if (entry.kind === 'png') continue;
    let bytes = fs.readFileSync(path.join(BRAND, entry.source));
    if (entry.kind === 'monochrome') bytes = markSvg(32, { bare: true });
    if (entry.kind === 'hero' || entry.kind === 'logo') {
      const logo = logoSvg({ dark: entry.theme === 'dark' });
      bytes = entry.kind === 'logo' ? logo : bytes.toString().replace('{{gamma-logo}}', svgContent(logo));
    }
    emit(entry.destination, bytes, { source: entry.source, variant: entry.kind });
  }
  // Every README scene is a build-*.py script that prints the SVG paths it wrote.
  for (const script of scenes()) {
    const result = spawnSync(process.env.PYTHON || 'python', [script], { cwd: ROOT, encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
    for (const p of result.stdout.split(/\r?\n/).map(line => line.trim().replaceAll(path.sep, '/')).filter(line => line.startsWith('docs/assets/branding/'))) {
      emit(p, read(p), { source: script, variant: 'light' });
    }
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const rendered = new Map();
    for (const entry of manifest.filter(entry => entry.kind === 'png')) {
      const svg = markSvg(entry.size, { disabled: entry.disabled, bleed: entry.bleed });
      if (!rendered.has(svg)) rendered.set(svg, await renderPng(browser, svg, entry.size, entry.size, entry.bleed == null));
      emit(entry.destination, rendered.get(svg), { source: entry.source, variant: entry.disabled ? 'disabled' : entry.bleed != null ? `icon-bleed-${entry.bleed}` : 'icon' });
    }
    for (const [p, width, height, svg, transparent] of storeJobs) {
      emit(p, await renderPng(browser, svg, width, height, transparent), { source: 'tools/branding/store-layouts.mjs', variant: path.basename(p, '.png') });
    }
    for (const theme of ['light']) {
      const p = `docs/assets/branding/gamma-hero-${theme}`;
      emit(`${p}.png`, await renderPng(browser, read(`${p}.svg`).toString(), 1920, 1080, false), { source: `${p}.svg`, variant: theme });
    }
  } finally { await browser.close(); }
  fs.writeFileSync(lockPath, JSON.stringify({ inputs: inputs(), outputs }, null, 2) + '\n');
  console.log(`Generated ${Object.keys(outputs).length} brand outputs. Run node tools/branding/build.mjs --check to verify.`);
}
