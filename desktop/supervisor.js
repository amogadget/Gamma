// Owns the Python backend: finds an interpreter, starts it, waits for it to be
// ready, keeps it alive, and — the part that matters most — makes sure it is
// gone when the app quits.
//
// The backend announces itself on stdout (gamma/desktop_main.py):
//   GAMMA_READY {"port":9001,"pid":4242,"url":"http://127.0.0.1:9001/",…}
//   GAMMA_ALREADY_RUNNING {"port":9001,"pid":4242}
// so there is no guessing at ports and no sleeping-and-hoping.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const READY = "GAMMA_READY";
const BUSY = "GAMMA_ALREADY_RUNNING";

// Unexpected exits worth retrying before giving up and telling the user. A
// crash loop must not restart forever: it would hide the failure and burn CPU.
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

// Keep the tail of stderr so a failure dialog can show why, rather than "it
// didn't start".
const LOG_TAIL_LINES = 60;

function existing(...candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Where the interpreter and the backend package are, in both worlds:
 * a packaged app (everything under Resources/) and a source checkout.
 */
function resolveRuntime() {
  const packaged = !!process.resourcesPath && !process.defaultApp;
  if (packaged) {
    const res = process.resourcesPath;
    const python = existing(
      path.join(res, "python", "bin", "python3"),
      path.join(res, "python", "bin", "python"),
      path.join(res, "python", "python.exe"),
    );
    return {
      packaged: true,
      python,
      cwd: path.join(res, "backend"),
      staticDir: path.join(res, "static"),
    };
  }
  // Source checkout: desktop/ sits beside backend/ and frontend/.
  const repo = path.resolve(__dirname, "..");
  const python = existing(
    path.join(repo, "backend", "venv", "bin", "python"),
    path.join(repo, "backend", "venv", "Scripts", "python.exe"),
    process.env.GAMMA_PYTHON,
  );
  return {
    packaged: false,
    python,
    cwd: path.join(repo, "backend"),
    staticDir: path.join(repo, "frontend", "dist"),
  };
}

class Supervisor {
  /**
   * @param {object} hooks
   *  onReady(info)    — the backend is serving; info has port/url/data_dir
   *  onBusy(info)     — another instance owns the library; info has its port
   *  onFatal(message, logTail) — gave up; show the user something true
   *  onLog(line)      — every stdout/stderr line, for the log window
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.child = null;
    this.info = null;
    this.quitting = false;
    this.restarts = [];
    this.logTail = [];
    this.runtime = resolveRuntime();
  }

  get port() {
    return this.info ? this.info.port : 0;
  }

  get url() {
    return this.info ? this.info.url : "";
  }

  _log(line) {
    const text = String(line).replace(/\s+$/, "");
    if (!text) return;
    this.logTail.push(text);
    if (this.logTail.length > LOG_TAIL_LINES) this.logTail.shift();
    this.hooks.onLog?.(text);
  }

  tail() {
    return this.logTail.join("\n");
  }

  start() {
    if (!this.runtime.python) {
      this.hooks.onFatal?.(
        "No Python interpreter was found inside the app.",
        "Looked for a bundled interpreter under Resources/python and for " +
          "backend/venv in a source checkout.",
      );
      return;
    }
    this._spawn();
  }

  _spawn() {
    const { python, cwd, staticDir } = this.runtime;
    const env = {
      ...process.env,
      GAMMA_DESKTOP: "1",
      GAMMA_STATIC_DIR: staticDir,
      // Unbuffered, or the READY line can sit in a pipe buffer while the app
      // waits for it.
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    };
    if (this.runtime.packaged) {
      // The bundled tree is not installed; point at it explicitly.
      env.PYTHONPATH = [path.join(process.resourcesPath, "site-packages"), cwd]
        .join(path.delimiter);
    }

    const child = spawn(python, ["-m", "gamma.desktop_main"], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a stray Ctrl+C in a dev terminal doesn't
      // kill the backend behind the app's back.
      detached: process.platform !== "win32",
    });
    this.child = child;

    let stdoutBuf = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      let nl;
      while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        this._handleLine(line);
      }
    });
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) this._log(line);
    });

    child.on("exit", (code, signal) => {
      this.child = null;
      if (this.quitting) return;
      this._onUnexpectedExit(code, signal);
    });
    child.on("error", (err) => {
      this._log(`spawn error: ${err.message}`);
      this.hooks.onFatal?.("Gamma's backend could not be started.", this.tail());
    });
  }

  _handleLine(line) {
    if (line.startsWith(READY)) {
      try {
        this.info = JSON.parse(line.slice(READY.length).trim());
        this.hooks.onReady?.(this.info);
        return;
      } catch {
        /* fall through to logging */
      }
    }
    if (line.startsWith(BUSY)) {
      try {
        this.hooks.onBusy?.(JSON.parse(line.slice(BUSY.length).trim()));
        return;
      } catch {
        /* fall through */
      }
    }
    this._log(line);
  }

  _onUnexpectedExit(code, signal) {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    this._log(`backend exited unexpectedly (code=${code} signal=${signal})`);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.hooks.onFatal?.(
        "Gamma's backend keeps stopping.",
        this.tail(),
      );
      return;
    }
    this.restarts.push(now);
    this.info = null;
    this._log(`restarting (attempt ${this.restarts.length} of ${MAX_RESTARTS})`);
    setTimeout(() => {
      if (!this.quitting) this._spawn();
    }, 500);
  }

  /**
   * Stop the backend and don't come back. Resolves once the child is gone, so
   * the app can wait before tearing the process down — otherwise quitting
   * Electron can orphan a Python holding the single-instance lock, and the
   * next launch refuses to start.
   */
  async stop({ timeoutMs = 8000 } = {}) {
    this.quitting = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;

    const gone = new Promise((resolve) => child.once("exit", resolve));

    if (process.platform === "win32") {
      // Windows has no SIGTERM: `child.kill()` calls TerminateProcess, which
      // the backend cannot handle, so uvicorn never drains and the `finally`
      // that clears the instance record never runs. `taskkill /T` at least
      // takes the whole tree down rather than orphaning descendants.
      //
      // Leaving the record behind is survivable by design: running_instance()
      // checks whether the recorded pid is alive and clears a stale one, and
      // the OS releases the lock file when the process dies. A hard kill can
      // still interrupt a write, which is why SQLite's WAL matters here.
      await this._taskkill(child.pid);
      await Promise.race([gone, new Promise((r) => setTimeout(r, 4000))]);
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const timedOut = await Promise.race([
      gone.then(() => false),
      new Promise((r) => setTimeout(() => r(true), timeoutMs)),
    ]);
    if (timedOut) {
      this._log("backend did not exit in time — forcing");
      try {
        child.kill("SIGKILL");
      } catch {
        /* nothing more to do */
      }
      await Promise.race([gone, new Promise((r) => setTimeout(r, 2000))]);
    }
  }

  /** Kill a process tree on Windows. */
  _taskkill(pid) {
    return new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("exit", () => resolve());
      killer.on("error", (err) => {
        this._log(`taskkill failed: ${err.message}`);
        try {
          this.child?.kill();
        } catch {
          /* nothing more to do */
        }
        resolve();
      });
    });
  }
}

module.exports = { Supervisor, resolveRuntime, READY, BUSY, MAX_RESTARTS };
