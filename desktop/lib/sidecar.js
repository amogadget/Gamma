// Local servers: one Gamma backend per local workspace, each bound to
// loopback with GAMMA_DATA_DIR pointing at that workspace's library.
//
// The backend announces itself on stdout (gamma/desktop_main.py):
//
//   GAMMA_READY {"port":9001,"pid":4242,"url":"http://127.0.0.1:9001/",…}
//   GAMMA_ALREADY_RUNNING {"port":9001,"pid":4242}
//
// so there is no port guessing and no sleep-and-hope. It also takes an
// advisory lock on the library directory, which is what makes several
// workspaces safe: two servers over one set of SQLite files is the failure
// that would corrupt notes, and the lock is per directory.
//
// Servers stay up once started, so switching back to a workspace is instant.
// They are all stopped — and *waited for* — when the app quits: an orphan
// holds its library's lock, and the next launch would refuse to start.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const READY = "GAMMA_READY";
const BUSY = "GAMMA_ALREADY_RUNNING";

// A crash loop must not restart forever: that hides the failure and burns CPU.
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

// Cold starts are slow on a fresh library (schema, seeding) and slower still
// on a loaded CI runner. Overridable so the failure path can be tested without
// waiting a minute and a half for it.
const READY_TIMEOUT_MS = Number(process.env.GAMMA_READY_TIMEOUT_MS) || 90_000;
const HEALTH_POLL_MS = 150;

const LOG_TAIL_LINES = 80;

function existing(...candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Where the interpreter and the backend live, in both worlds: a packaged app
 * (everything under Resources/) and a source checkout.
 */
function resolveRuntime() {
  const packaged = !!process.resourcesPath && !process.defaultApp;
  if (packaged) {
    const res = process.resourcesPath;
    return {
      packaged: true,
      python: existing(
        path.join(res, "python", "bin", "python3"),
        path.join(res, "python", "bin", "python"),
        path.join(res, "python", "python.exe"),
      ),
      cwd: path.join(res, "backend"),
      staticDir: path.join(res, "static"),
      sitePackages: path.join(res, "site-packages"),
    };
  }
  const repo = path.resolve(__dirname, "..", "..");
  return {
    packaged: false,
    python: existing(
      process.env.GAMMA_PYTHON,
      path.join(repo, "backend", "venv", "bin", "python"),
      path.join(repo, "backend", "venv", "Scripts", "python.exe"),
    ),
    cwd: path.join(repo, "backend"),
    staticDir: path.join(repo, "frontend", "dist"),
    sitePackages: null,
  };
}

class Sidecars {
  /**
   * @param {object} opts
   *  logDir  — where per-workspace logs are written
   *  onState — called when anything a UI would render changes
   *  onRespawn(id, info) — a workspace's server came back on a new port
   *  onGaveUp(id, message, tail) — it stopped coming back
   */
  constructor({ logDir, onState = () => {}, onRespawn = () => {}, onGaveUp = () => {} } = {}) {
    this.logDir = logDir;
    this.onState = onState;
    this.onRespawn = onRespawn;
    this.onGaveUp = onGaveUp;
    this.runtime = resolveRuntime();
    /** @type {Map<string, object>} workspace id → running entry */
    this.running = new Map();
    this.quitting = false;
  }

  status(id) {
    const entry = this.running.get(id);
    return entry && entry.url ? { port: entry.port, url: entry.url, pid: entry.child?.pid } : null;
  }

  logPath(id) {
    return path.join(this.logDir, `${id}.log`);
  }

  tail(id, lines = 20) {
    const entry = this.running.get(id);
    if (entry && entry.tail.length) return entry.tail.slice(-lines).join("\n");
    try {
      return fs.readFileSync(this.logPath(id), "utf8").split(/\r?\n/).slice(-lines).join("\n");
    } catch {
      return "(nothing logged yet)";
    }
  }

  /** Start a workspace's server, or return the one already running. */
  async start(ws) {
    const existingEntry = this.running.get(ws.id);
    if (existingEntry && existingEntry.url && (await this._healthy(existingEntry.url))) {
      return { url: existingEntry.url, port: existingEntry.port };
    }
    if (existingEntry) this.running.delete(ws.id); // stale: it died while idle

    if (!this.runtime.python) {
      throw new Error(
        this.runtime.packaged
          ? "This build has no Python inside it, which should be impossible — please report it."
          : "No interpreter found. Expected backend/venv, or set GAMMA_PYTHON.",
      );
    }
    if (!fs.existsSync(path.join(this.runtime.staticDir, "index.html"))) {
      throw new Error(
        `The built frontend is missing from ${this.runtime.staticDir}.` +
          (this.runtime.packaged ? "" : ' Run "npm run build" in frontend/ first.'),
      );
    }
    return this._spawn(ws);
  }

  _spawn(ws) {
    fs.mkdirSync(ws.dataDir, { recursive: true });
    fs.mkdirSync(this.logDir, { recursive: true });

    const { python, cwd, staticDir, sitePackages } = this.runtime;
    const env = {
      ...process.env,
      GAMMA_DESKTOP: "1",
      GAMMA_DATA_DIR: ws.dataDir,
      GAMMA_STATIC_DIR: staticDir,
      // Unbuffered, or the READY line can sit in a pipe while we wait for it.
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    };
    if (sitePackages) env.PYTHONPATH = [sitePackages, cwd].join(path.delimiter);

    const child = spawn(python, ["-m", "gamma.desktop_main"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a stray Ctrl+C in a dev terminal does not
      // kill the backend behind the app's back.
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const log = fs.createWriteStream(this.logPath(ws.id), { flags: "a" });
    log.write(`\n--- ${new Date().toISOString()} starting ${ws.name} (${ws.dataDir}) ---\n`);

    const entry = {
      child, log, tail: [], port: 0, url: "", restarts: [], stopping: false, dataDir: ws.dataDir,
    };
    this.running.set(ws.id, entry);

    const record = (line) => {
      if (!line) return;
      entry.tail.push(line);
      if (entry.tail.length > LOG_TAIL_LINES) entry.tail.shift();
      log.write(`${line}\n`);
    };

    let ready;
    let failed;
    const readyPromise = new Promise((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });

    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString();
      let nl;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        const info = parseAnnouncement(line);
        if (info && info.kind === "ready") {
          entry.port = info.port;
          entry.url = info.url || `http://127.0.0.1:${info.port}/`;
          entry.dataDir = info.data_dir || entry.dataDir;
          record(`ready on port ${info.port} (pid ${info.pid})`);
          ready({ url: entry.url, port: entry.port });
        } else if (info && info.kind === "busy") {
          // The library is already served — most likely a second copy of the
          // app. Use that server rather than refusing to show anything.
          entry.port = info.port;
          entry.url = `http://127.0.0.1:${info.port}/`;
          record(`already served on port ${info.port} by pid ${info.pid}`);
          ready({ url: entry.url, port: entry.port, adopted: true });
        } else {
          record(line);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) record(line.replace(/\s+$/, ""));
    });

    child.on("error", (err) => {
      record(`could not start: ${err.message}`);
      failed(new Error(`Could not start the server: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      record(`server exited (code ${code}${signal ? `, signal ${signal}` : ""})`);
      log.end();
      if (this.running.get(ws.id) === entry) this.running.delete(ws.id);
      if (!entry.url) {
        failed(new Error(`The server stopped while starting up.\n\n${this.tail(ws.id, 12)}`));
      } else if (!entry.stopping && !this.quitting) {
        this._restart(ws, entry);
      }
      this.onState();
    });

    return this._awaitReady(ws, readyPromise);
  }

  async _awaitReady(ws, readyPromise) {
    const timeout = new Promise((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`The server did not come up.\n\n${this.tail(ws.id, 12)}`)),
        READY_TIMEOUT_MS,
      ),
    );
    try {
      const info = await Promise.race([readyPromise, timeout]);
      // READY means it is about to serve; /api/health means it is serving.
      await this._waitHealthy(info.url, ws);
      this.onState();
      return info;
    } catch (err) {
      // A server that never announced itself is still a running process. Left
      // alone it holds the library's advisory lock for the rest of the
      // session, so the next attempt spawns a second one, is told the library
      // is already served, adopts the wedged port and fails the same way —
      // two processes, one of them untracked.
      this._abandon(ws.id);
      throw err;
    }
  }

  /** Kill a server that never came up, and forget it. */
  _abandon(id) {
    const entry = this.running.get(id);
    if (!entry) return;
    this.running.delete(id);
    const child = entry.child;
    if (child && child.exitCode === null) {
      if (process.platform === "win32") taskkill(child.pid);
      else {
        try {
          // No graceful stop: it never served, so there is nothing to drain.
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    clearInstanceRecord(entry.dataDir);
    this.onState();
  }

  async _waitHealthy(url, ws) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    for (;;) {
      if (await this._healthy(url)) return;
      if (Date.now() > deadline) {
        throw new Error(`The server started but never answered.\n\n${this.tail(ws.id, 12)}`);
      }
      await sleep(HEALTH_POLL_MS);
    }
  }

  async _healthy(url, timeoutMs = 2000) {
    try {
      const res = await fetch(new URL("/api/health", url), {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  _restart(ws, dead) {
    const now = Date.now();
    const recent = dead.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (recent.length >= MAX_RESTARTS) {
      this.onGaveUp(ws.id, `${ws.name} keeps stopping.`, this.tail(ws.id, 20));
      return;
    }
    setTimeout(() => {
      if (this.quitting) return;
      this.start(ws)
        .then((info) => {
          const entry = this.running.get(ws.id);
          if (entry) entry.restarts = [...recent, now];
          this.onRespawn(ws.id, info);
        })
        .catch((err) => this.onGaveUp(ws.id, err.message, this.tail(ws.id, 20)));
    }, 500);
  }

  /** Stop one server and wait for it to actually be gone. */
  async stop(id) {
    const entry = this.running.get(id);
    if (!entry) return;
    entry.stopping = true;
    const child = entry.child;
    this.running.delete(id);
    if (!child || child.exitCode !== null) return;

    const gone = new Promise((resolve) => child.once("exit", resolve));

    if (process.platform === "win32") {
      // Windows has no SIGTERM: kill() is TerminateProcess, which the backend
      // cannot handle, so uvicorn never drains and the `finally` that clears
      // the instance record never runs. /T takes the tree down instead of
      // orphaning descendants, and the shell clears the record itself.
      await taskkill(child.pid);
      await Promise.race([gone, sleep(4000)]);
      clearInstanceRecord(entry.dataDir);
      this.onState();
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const timedOut = await Promise.race([gone.then(() => false), sleep(8000).then(() => true)]);
    if (timedOut) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* nothing more to do */
      }
      await Promise.race([gone, sleep(2000)]);
      clearInstanceRecord(entry.dataDir);
    }
    this.onState();
  }

  /** Stop everything, waited. Called on quit — see the note at the top. */
  async stopAll() {
    this.quitting = true;
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}

function parseAnnouncement(line) {
  for (const [prefix, kind] of [[READY, "ready"], [BUSY, "busy"]]) {
    if (!line.startsWith(prefix)) continue;
    try {
      return { kind, ...JSON.parse(line.slice(prefix.length).trim()) };
    } catch {
      return null; // not the announcement after all; log it as output
    }
  }
  return null;
}

function taskkill(pid) {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("exit", resolve);
    killer.on("error", resolve);
  });
}

/**
 * Remove a library's running-instance record after a kill that gave the
 * backend no chance to do it. `running_instance()` in gamma/desktop.py would
 * notice the pid is dead and clear it anyway, but leaving correct state behind
 * is better than leaving a mess for a backstop.
 */
function clearInstanceRecord(dataDir) {
  if (!dataDir) return;
  try {
    fs.unlinkSync(path.join(dataDir, "desktop.json"));
  } catch {
    /* already gone, or never written */
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { Sidecars, resolveRuntime, parseAnnouncement, READY, BUSY, MAX_RESTARTS };
