import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('brand provenance detects drift and tolerates checkout line endings', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'gamma-brand-check-'));
  const ledger = JSON.parse(fs.readFileSync(path.join(root, 'design/brand/generated.json')));
  try {
    for (const name of new Set([...Object.keys(ledger.inputs), ...Object.keys(ledger.outputs), 'design/brand/generated.json'])) {
      const target = path.join(fixture, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(root, name), target);
    }
    const run = () => spawnSync(process.execPath, [path.join(fixture, 'tools/branding/build.mjs'), '--check'], { encoding: 'utf8' });
    assert.equal(run().status, 0, 'clean generated assets pass');
    const icon = path.join(fixture, 'desktop/assets/icon.png');
    const original = fs.readFileSync(icon);
    fs.appendFileSync(icon, 'modified');
    assert.match(run().stderr, /Stale or modified: desktop\/assets\/icon.png/);
    fs.unlinkSync(icon);
    assert.notEqual(run().status, 0, 'missing assets fail');
    fs.writeFileSync(icon, original);
    const tokens = path.join(fixture, 'design/brand/tokens.json');
    const tokensText = fs.readFileSync(tokens, 'utf8');
    fs.writeFileSync(tokens, tokensText.replace('#e8a020', '#ffffff'));
    assert.match(run().stderr, /Brand sources or rendering toolchain changed/);
    fs.writeFileSync(tokens, tokensText);
    const extra = path.join(fixture, 'extension/assets/icons/obsolete.png');
    fs.writeFileSync(extra, original);
    assert.match(run().stderr, /Unmanaged asset/);
    fs.unlinkSync(extra);
    for (const name of new Set([...Object.keys(ledger.inputs), ...Object.keys(ledger.outputs)])) {
      if (/\.(json|mjs|py|svg|md|txt)$/.test(name)) {
        const p = path.join(fixture, name);
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
      }
    }
    const crlf = run();
    assert.equal(crlf.status, 0, crlf.stderr);
  } finally {
    // mkdtemp creates an isolated directory directly beneath the system temp dir.
    if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith('gamma-brand-check-')) throw new Error('Unexpected temporary path');
    fs.rmSync(fixture, { recursive: true });
  }
});
