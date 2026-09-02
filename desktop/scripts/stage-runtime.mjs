// Assemble everything the packaged app needs that isn't JavaScript:
//
//   build/resources/python/        a standalone CPython (no system Python)
//   build/resources/site-packages/ the backend's dependencies
//   build/resources/backend/       the gamma package itself
//   build/resources/static/        the built frontend
//
// electron-builder copies that tree to Contents/Resources, which is exactly
// where desktop/supervisor.js looks for it.
//
//   node scripts/stage-runtime.mjs [--platform darwin|linux|win32] [--arch arm64|x64]
//
// Defaults to the host. Cross-staging is only partly possible: the interpreter
// is downloaded per target, but pip installs wheels for the *host* unless the
// target matches, so a release build for macOS has to run on macOS. That is
// what .github/workflows/desktop-release.yml is for.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, "..");
const repo = path.resolve(desktop, "..");
const out = path.join(desktop, "build", "resources");

// python-build-standalone: a relocatable CPython that runs from any directory,
// which a venv does not (its shebangs and pyvenv.cfg hardcode paths).
const PY_VERSION = "3.12.11";
const PY_RELEASE = "20250712";
const PY_BASE =
  `https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}`;

const TRIPLES = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const platform = arg("platform", process.platform);
const arch = arg("arch", process.arch);
const triple = TRIPLES[`${platform}-${arch}`];
if (!triple) {
  console.error(`no standalone CPython for ${platform}-${arch}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

// --- CPython -----------------------------------------------------------------

function stagePython() {
  const name =
    `cpython-${PY_VERSION}+${PY_RELEASE}-${triple}-install_only_stripped.tar.gz`;
  const cache = path.join(os.homedir(), ".cache", "gamma-desktop");
  fs.mkdirSync(cache, { recursive: true });
  const tarball = path.join(cache, name);

  if (!fs.existsSync(tarball)) {
    // -sS: no progress meter. It is one line containing thousands of \r,
    // which eats the whole budget of a failure annotation.
    run("curl", ["-fsSL", "--retry", "3", "-o", tarball, `${PY_BASE}/${name}`]);
  } else {
    console.log(`using cached ${name}`);
  }

  const dest = path.join(out, "python");
  rmrf(dest);
  fs.mkdirSync(dest, { recursive: true });
  // The archive contains a single `python/` directory; strip it.
  run("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);
  return dest;
}

/** The interpreter inside a staged tree. */
function pythonExe(pythonDir) {
  return platform === "win32"
    ? path.join(pythonDir, "python.exe")
    : path.join(pythonDir, "bin", "python3");
}

/**
 * Everything the backend actually imports, in one go. Run after trimming, so a
 * trim that goes too far fails here instead of in front of a user.
 */
const IMPORT_CHECK =
  "import ssl, sqlite3, lzma, zlib, ctypes, hashlib, socket, secrets; " +
  "import bcrypt, fastapi, uvicorn, pydantic, PyPDF2, pypdfium2, pikepdf, PIL.Image, " +
  "lxml.etree, multipart, fractional_indexing, ziamath; " +
  "import gamma.app, gamma.desktop_main; " +
  "print('bundle imports ok')";

function verifyBundle(pythonDir) {
  const env = {
    ...process.env,
    PYTHONPATH: [path.join(out, "site-packages"), path.join(out, "backend")].join(
      path.delimiter,
    ),
    PYTHONDONTWRITEBYTECODE: "1",
    // Don't let a developer's own settings leak into the check.
    GAMMA_DATA_DIR: path.join(os.tmpdir(), "gamma-stage-check"),
  };
  execFileSync(pythonExe(pythonDir), ["-c", IMPORT_CHECK], { stdio: "inherit", env });
}

/**
 * Drop what a headless web server never reads. Each removal is either
 * obviously unused (Tk, IDLE, terminfo, headers, static libs) or verified by
 * putting it back if the interpreter stops working without it.
 */
function trimPython(pythonDir) {
  const before = sizeOf(pythonDir);
  const minor = PY_VERSION.split(".").slice(0, 2).join(".");
  const lib = path.join(pythonDir, "lib");

  // The two layouts are genuinely different: Unix keeps the standard library
  // under lib/pythonX.Y, Windows under Lib/ beside DLLs/ and libs/. A list
  // written for one silently trims nothing on the other — which is how a
  // Windows bundle would have shipped with IDLE, Tk and the test suite in it.
  const stdlib =
    platform === "win32"
      ? path.join(pythonDir, "Lib")
      : path.join(lib, `python${minor}`);

  const doomed = [
    path.join(pythonDir, "include"),
    // Tk: the GUI toolkit, in an app whose entire UI is Electron.
    ...["tkinter", "idlelib", "turtledemo", "lib2to3", "test", "ensurepip", "pydoc_data"].map(
      (d) => path.join(stdlib, d),
    ),
    // pip and friends did their job at stage time.
    ...["pip", "setuptools", "pkg_resources", "wheel", "_distutils_hack"].map((d) =>
      path.join(stdlib, "site-packages", d),
    ),
  ];

  if (platform === "win32") {
    doomed.push(
      path.join(pythonDir, "tcl"),
      path.join(pythonDir, "libs"), // import libraries, for building extensions
      path.join(pythonDir, "DLLs", "_tkinter.pyd"),
      path.join(pythonDir, "Scripts"),
    );
    for (const f of fs.existsSync(path.join(pythonDir, "DLLs"))
      ? fs.readdirSync(path.join(pythonDir, "DLLs"))
      : []) {
      if (/^(tcl|tk)\d|^tix/.test(f)) doomed.push(path.join(pythonDir, "DLLs", f));
    }
  } else {
    doomed.push(
      path.join(pythonDir, "share", "terminfo"),
      path.join(pythonDir, "share", "man"),
      ...["tcl8.6", "tk8.6", "Tix8.4.3", "itcl4.2.4", "sqlite3.51.0", "thread2.8.9"].map((d) =>
        path.join(lib, d),
      ),
    );
  }

  for (const p of doomed) rmrf(p);
  for (const f of fs.existsSync(lib) ? fs.readdirSync(lib) : []) {
    if (f.endsWith(".a")) rmrf(path.join(lib, f)); // static libs, for building C extensions
  }

  // The shared libpython is ~28 MB and, on some builds, entirely redundant
  // because the launcher is statically linked. Whether that holds is a
  // property of the build, not something to assume — so try it and see.
  // Windows is excluded: python3.dll and pythonXY.dll sit beside python.exe
  // and it links them by name, so there is nothing to test here.
  const candidates =
    platform === "win32"
      ? []
      : (fs.existsSync(lib) ? fs.readdirSync(lib) : []).filter((f) =>
          /^libpython.*\.(so|dylib)/.test(f),
        );
  for (const name of candidates) {
    const live = path.join(lib, name);
    const parked = `${live}.parked`;
    fs.renameSync(live, parked);
    try {
      verifyBundle(pythonDir);
      rmrf(parked);
      console.log(`dropped ${name} — the launcher does not need it`);
    } catch {
      fs.renameSync(parked, live);
      console.log(`kept ${name} — the launcher links against it`);
    }
  }

  console.log(`python: ${before} → ${sizeOf(pythonDir)}`);
}

// --- dependencies ------------------------------------------------------------

function stageDependencies(pythonDir) {
  const exe = pythonExe(pythonDir);
  const target = path.join(out, "site-packages");
  rmrf(target);

  // Installed with the bundled interpreter, so the wheels match its ABI. When
  // cross-staging (platform !== host) that interpreter cannot execute, and the
  // caller has been warned above.
  run(exe, [
    "-m", "pip", "install",
    "--disable-pip-version-check",
    "--no-compile",                 // .pyc files are 40% of the tree
    "--target", target,
    "-r", path.join(repo, "backend", "requirements.txt"),
  ]);

  // Trim what a running app never reads. Note: *.dist-info stays — ziamath's
  // dependency latex2mathml looks itself up through importlib.metadata, and
  // removing it turns into an ImportError at first use.
  for (const dir of ["pip", "setuptools", "wheel", "pkg_resources"]) {
    rmrf(path.join(target, dir));
  }
  let removed = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__" || entry.name === "tests") {
          rmrf(p);
          removed += 1;
          continue;
        }
        walk(p);
      }
    }
  };
  walk(target);
  console.log(`trimmed ${removed} directories from site-packages`);
  return target;
}

// --- the app's own code ------------------------------------------------------

function stageBackend() {
  const dest = path.join(out, "backend");
  rmrf(dest);
  fs.mkdirSync(dest, { recursive: true });
  // Only the package. Not tests, not venv, not the uploads directory a
  // developer has accumulated locally.
  fs.cpSync(path.join(repo, "backend", "gamma"), path.join(dest, "gamma"), {
    recursive: true,
    filter: (src) => !/(__pycache__|\.pyc$)/.test(src),
  });
  return dest;
}

function stageFrontend() {
  const dist = path.join(repo, "frontend", "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    console.error(
      "frontend/dist/index.html is missing — run `npm --prefix ../frontend run build` first",
    );
    process.exit(1);
  }
  const dest = path.join(out, "static");
  rmrf(dest);
  fs.cpSync(dist, dest, { recursive: true });
  return dest;
}

function sizeOf(p) {
  const line = execFileSync("du", ["-sh", p], { encoding: "utf8" });
  return line.split("\t")[0];
}

// --- go ----------------------------------------------------------------------

fs.mkdirSync(out, { recursive: true });
console.log(`staging for ${platform}-${arch} (${triple})`);

const pythonDir = stagePython();
if (platform !== process.platform) {
  console.warn(
    `\n! cross-staging: dependencies cannot be installed with a ${platform} ` +
      `interpreter on ${process.platform}. Staging the interpreter and code only.\n`,
  );
} else {
  stageDependencies(pythonDir);
}
stageBackend();
stageFrontend();

if (platform === process.platform) {
  trimPython(pythonDir);
  verifyBundle(pythonDir);
}

console.log("\nstaged:");
for (const part of ["python", "site-packages", "backend", "static"]) {
  const p = path.join(out, part);
  if (fs.existsSync(p)) console.log(`  ${sizeOf(p).padStart(6)}  ${part}`);
}
console.log(`  ${sizeOf(out).padStart(6)}  total`);
