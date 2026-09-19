// Reuse the local production build only while its inputs and outputs exist.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const frontend = fileURLToPath(new URL('../frontend/', import.meta.url));
const dist = path.join(frontend, 'dist');
const stamp = path.join(dist, '.gamma-build.json');

function files(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const relative = path.join(prefix, entry.name);
      return entry.isDirectory() ? files(path.join(dir, entry.name), relative) : [relative];
    });
}

// Root files include Vite config, package locks, index.html and .env variants.
// Include filenames as well as content so additions/deletions invalidate too.
const inputs = [
  ...readdirSync(frontend, { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name),
  ...['src', 'public'].flatMap(dir => files(path.join(frontend, dir), dir)),
].sort();
const hash = createHash('sha256');
hash.update(process.version);
hash.update(JSON.stringify(Object.entries(process.env)
  .filter(([key]) => key.startsWith('VITE_') || key === 'NODE_ENV').sort()));
for (const file of inputs) {
  const content = readFileSync(path.join(frontend, file));
  hash.update(JSON.stringify([file, content.length]));
  hash.update(content);
}
const fingerprint = hash.digest('hex');
try {
  const previous = JSON.parse(readFileSync(stamp, 'utf8'));
  if (previous.fingerprint === fingerprint && previous.outputs.includes('index.html') &&
      previous.outputs.every(file => existsSync(path.join(dist, file)))) {
    console.log('Frontend unchanged; reusing existing build.');
    process.exit(0);
  }
} catch { /* Missing/invalid stamp means a full build is needed. */ }

console.log('Building frontend...');
const result = spawnSync('npm run build', { cwd: frontend, shell: true, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
if (result.status !== 0) process.exit(result.status || 1);
writeFileSync(stamp, JSON.stringify({ fingerprint, outputs: files(dist).filter(f => f !== '.gamma-build.json') }));
