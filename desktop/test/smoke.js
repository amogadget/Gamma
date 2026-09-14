// Runs the shell's built-in `--smoke` self-test (throwaway local server →
// sidecar health → auto-login) against the dev tree (default) or the
// packaged app (`--packaged`, after `npm run pack`/`dist`), and fails on a
// non-OK result. Used by CI after electron-builder; `npm run smoke` locally.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const packaged = process.argv.includes('--packaged');

function packagedBinary() {
  const dist = path.join(ROOT, 'dist');
  const candidates = [
    path.join(dist, 'win-unpacked', 'Gamma.exe'),
    path.join(dist, 'mac-arm64', 'Gamma.app', 'Contents', 'MacOS', 'Gamma'),
    path.join(dist, 'mac', 'Gamma.app', 'Contents', 'MacOS', 'Gamma'),
    path.join(dist, 'linux-unpacked', 'gamma'), // linux.executableName in electron-builder.cjs
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`no packaged app under ${dist} — run "npm run pack" first`);
  return hit;
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // IDE terminals set it; Electron would run as plain Node
let cmd, args;
if (packaged) {
  cmd = packagedBinary();
  args = ['--smoke'];
  // The unpacked Linux dir has no setuid chrome-sandbox (the .deb's postinst
  // sets that up at install time), so Chromium refuses to start without this.
  if (process.platform === 'linux') args.push('--no-sandbox');
} else {
  cmd = require('electron'); // path to the electron binary
  args = [ROOT, '--smoke'];
}
console.log(`smoke: ${cmd} ${args.join(' ')}`);

const child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '';
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});
const timer = setTimeout(() => {
  console.error('smoke: timed out after 150 s');
  child.kill();
  process.exit(1);
}, 150_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  const line = out.split(/\r?\n/).find((l) => l.startsWith('SMOKE '));
  if (!line) {
    console.error(`smoke: no SMOKE line (exit ${code})`);
    process.exit(1);
  }
  const res = JSON.parse(line.slice(6));
  if (!res.ok) {
    console.error('smoke: FAILED', res);
    process.exit(1);
  }
  console.log(`smoke: ok (session=${res.session || res.firstLogin}, data dir: ${(res.dataDir || []).join(', ')})`);
  process.exit(0);
});
