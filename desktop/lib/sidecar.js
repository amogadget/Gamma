// Local-workspace server lifecycle. A "sidecar" is one Gamma backend process
// bound to 127.0.0.1 on a free port with GAMMA_DATA_DIR pointing at the
// workspace's data directory. Two launch modes, resolved in this order:
//
//   1. explicit settings (pythonPath + backendDir) — run uvicorn from a repo
//   2. packaged: the frozen backend bundled under resources/gamma-server
//   3. dev auto-detect: ../backend/venv relative to this file (the repo layout)
//
// The server seeds itself on an empty data dir (schema + first admin); the
// shell passes GAMMA_ADMIN_USER/GAMMA_ADMIN_PASSWORD so the one-time password
// lands in the registry instead of a hidden console.

const { spawn, spawnSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const running = new Map(); // workspace id -> { child, port, url, logPath }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function repoRoot() {
  // desktop/lib/sidecar.js -> repo root is two levels up from lib/.
  return path.resolve(__dirname, '..', '..');
}

function detectDev(settings) {
  const backendDir = settings.backendDir || path.join(repoRoot(), 'backend');
  const venvPy =
    process.platform === 'win32'
      ? path.join(backendDir, 'venv', 'Scripts', 'python.exe')
      : path.join(backendDir, 'venv', 'bin', 'python');
  const pythonPath = settings.pythonPath || venvPy;
  const staticDir = settings.staticDir || path.join(repoRoot(), 'frontend', 'dist');
  return { pythonPath, backendDir, staticDir };
}

function resolveBackend(settings, { isPackaged, resourcesPath }) {
  const dev = detectDev(settings);
  const explicit = settings.pythonPath && fs.existsSync(settings.pythonPath);
  if (explicit) return { mode: 'dev', ...dev };

  if (isPackaged) {
    const exe = path.join(
      resourcesPath,
      'gamma-server',
      process.platform === 'win32' ? 'gamma-server.exe' : 'gamma-server'
    );
    if (fs.existsSync(exe)) return { mode: 'frozen', exe };
  }

  if (fs.existsSync(dev.pythonPath)) return { mode: 'dev', ...dev };
  throw new Error(
    isPackaged
      ? 'Bundled server missing and no Python configured in launcher settings.'
      : `No backend found: expected ${dev.pythonPath} (or set a Python path in launcher settings).`
  );
}

async function healthy(url, timeoutMs = 1500) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(url + '/api/health', { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

function logTail(logPath, lines = 15) {
  try {
    return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

async function start(ws, settings, appInfo) {
  const existing = running.get(ws.id);
  if (existing) {
    if (await healthy(existing.url)) return existing;
    running.delete(ws.id); // stale entry (crashed server) — respawn below
  }

  const backend = resolveBackend(settings, appInfo);
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  fs.mkdirSync(ws.dataDir, { recursive: true });

  const env = { ...process.env, GAMMA_DATA_DIR: ws.dataDir };
  // Fresh data dir: hand the server its first-admin credentials so the
  // one-time seed matches what the registry remembers.
  if (!fs.existsSync(path.join(ws.dataDir, 'users.db')) && ws.adminUser) {
    env.GAMMA_ADMIN_USER = ws.adminUser;
    env.GAMMA_ADMIN_PASSWORD = ws.adminPassword;
  }

  let child;
  if (backend.mode === 'frozen') {
    child = spawn(backend.exe, ['--port', String(port), '--data-dir', ws.dataDir], {
      env,
      windowsHide: true,
    });
  } else {
    if (!fs.existsSync(path.join(backend.staticDir, 'index.html'))) {
      throw new Error(`Frontend build missing: ${backend.staticDir}\nRun "npm run build" in frontend/ first.`);
    }
    env.GAMMA_STATIC_DIR = backend.staticDir;
    child = spawn(
      backend.pythonPath,
      ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)],
      { cwd: backend.backendDir, env, windowsHide: true }
    );
  }

  const logDir = path.join(appInfo.userDataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${ws.id}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n--- ${new Date().toISOString()} start (${backend.mode}) port ${port} ---\n`);
  child.stdout.on('data', (d) => logStream.write(d));
  child.stderr.on('data', (d) => logStream.write(d));

  let exited = false;
  child.once('exit', (code) => {
    exited = true;
    logStream.write(`--- server exited (code ${code}) ---\n`);
    if (running.get(ws.id)?.child === child) running.delete(ws.id);
  });

  // Frozen PyInstaller apps cold-start slowly; give it a generous window.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Server exited during startup. Last log lines:\n${logTail(logPath)}`);
    if (await healthy(url)) {
      const entry = { child, port, url, logPath };
      running.set(ws.id, entry);
      return entry;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  killChild(child);
  throw new Error(`Server did not become healthy in 60s. Last log lines:\n${logTail(logPath)}`);
}

function killChild(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // Kill the whole tree; child.kill() alone can strand python subprocesses.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

function stop(id) {
  const entry = running.get(id);
  if (entry) {
    killChild(entry.child);
    running.delete(id);
  }
}

function stopAll() {
  for (const [, entry] of running) killChild(entry.child);
  running.clear();
}

function status(id) {
  return running.get(id) || null;
}

module.exports = { start, stop, stopAll, status, detectDev };
