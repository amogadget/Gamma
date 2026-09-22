// End-to-end check of the desktop shell — the executable half of
// docs/checklist.md. Drives the real app (dev tree by default, the packaged build
// with --packaged) through Playwright's Electron driver over a throwaway
// profile, so the real registry, cookies and servers are never touched.
//
//   npm run e2e               # dev: sidecars from backend/venv + frontend/dist
//   npm run e2e:packaged      # after `npm run pack`: the frozen bundle
//   node test/e2e.js --keep   # leave the temp profile behind for inspection
//   node test/e2e.js --continue   # run every step even after a failure
//
// Prints one line per step and a summary; exit 1 on any failure.

const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const packaged = process.argv.includes('--packaged');
const keep = process.argv.includes('--keep');
const continueOnFail = process.argv.includes('--continue');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note || '', ms: Date.now() - t0 });
    console.log(`  ok    ${name}${note ? '  — ' + note : ''}`);
  } catch (e) {
    results.push({ name, ok: false, note: String((e && e.message) || e), ms: Date.now() - t0 });
    console.log(`  FAIL  ${name}\n        ${String((e && e.stack) || e).split('\n').join('\n        ')}`);
    if (!continueOnFail) throw e;
  }
}

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

// A valid one-page PDF with real text (PyPDF2/pypdfium2 must parse it: the
// annotated-PDF export and the search index read it back).
function minimalPdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  ];
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// A port nothing listens on (bind, read, release) — for the "server down" case.
function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function pidAlive(pid) {
  if (!pid) return false;
  if (process.platform === 'win32') {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' });
    return out.includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ driver -------

async function launch(userData, downloadDir) {
  const env = {
    ...process.env,
    GAMMA_SHELL_USER_DATA: userData,
    GAMMA_SHELL_DOWNLOAD_DIR: downloadDir,
    GAMMA_SHELL_TEST: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // Unpacked Linux dir: no setuid chrome-sandbox (the .deb's postinst sets it
  // up), so Chromium only starts with --no-sandbox. Same as test/smoke.js.
  const packagedArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];
  const opts = packaged ? { executablePath: packagedBinary(), args: packagedArgs, env } : { args: [ROOT], env };
  return electron.launch({ ...opts, timeout: 60_000 });
}

// The shell's views are separate webContents = separate Playwright pages.
async function findPage(app, pred, timeout = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = app.windows().find((p) => pred(p.url()));
    if (hit) return hit;
    await sleep(150);
  }
  throw new Error('page not found: ' + app.windows().map((p) => p.url()).join(', '));
}
const isBar = (u) => u.endsWith('/ui/bar.html');
const isLauncher = (u) => u.includes('/ui/launcher.html');

const hook = (app, fn, arg) => app.evaluate(({ app: _a }, [src, a]) => {
  // eslint-disable-next-line no-new-func
  return new Function('shell', 'arg', `return (${src})(shell, arg)`)(global.__gammaShell, a);
}, [fn.toString(), arg]);

async function waitFor(fn, what, timeout = 60_000, every = 300) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`timeout waiting for ${what} (last: ${last && last.message ? last.message : JSON.stringify(last)})`);
}

const sessionUser = (page) =>
  page.evaluate(() => fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => j.user || ''));

const rootTitles = (page) =>
  page.evaluate(() => fetch('/api/blocks/root/children', { credentials: 'same-origin' }).then((r) => r.json())
    .then((d) => (d.children || d.blocks || []).map((b) => b.content)));

async function waitLoggedIn(page, user = 'admin') {
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+/, { timeout: 90_000 });
  await waitFor(async () => (await sessionUser(page)) === user, `session=${user}`);
}

// ------------------------------------------------------------- steps -------

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gamma-e2e-'));
  const downloads = path.join(profile, 'downloads');
  fs.mkdirSync(downloads);
  console.log(`e2e (${packaged ? 'packaged' : 'dev'}) profile: ${profile}`);

  let app = await launch(profile, downloads);
  let bar, content;
  const ids = {};
  const urls = {};
  const pids = {};
  let pageId, sourceUrl;
  let backupZip;

  try {
    await step('first start shows the launcher + shell bar', async () => {
      bar = await findPage(app, isBar);
      content = await findPage(app, isLauncher);
      await content.waitForSelector('#btnAddLocal');
      await waitFor(async () => (await bar.textContent('#wsName')).trim() === 'Servers', 'bar idle label');
      const b = await hook(app, (s) => s.bounds());
      assert(b.bar.height === 38 && b.content.y === 38, `layout ${JSON.stringify(b)}`);
      const version = await content.textContent('#version');
      assert(/Gamma desktop \d/.test(version), version);
      return version.trim();
    });

    await step('create a local server from the launcher', async () => {
      await content.click('#btnAddLocal');
      await content.fill('#localName', 'Alpha');
      await content.click('#btnCreateLocal');
      await content.locator('.card', { hasText: 'Alpha' }).waitFor();
      const ws = await hook(app, (s) => s.registry.load().servers);
      assert.equal(ws.length, 1);
      ids.alpha = ws[0].id;
      assert(fs.existsSync(ws[0].dataDir), 'data dir created');
      return ws[0].dataDir;
    });

    await step('open it: sidecar starts, Gamma loads, auto-login lands', async () => {
      await content.locator('.card', { hasText: 'Alpha' }).locator('button', { hasText: 'Open' }).click();
      await waitLoggedIn(content);
      urls.alpha = new URL(content.url()).origin;
      const cur = await hook(app, (s) => s.current());
      assert.equal(cur && cur.id, ids.alpha);
      await waitFor(async () => (await bar.textContent('#wsName')).trim() === 'Alpha', 'bar shows Alpha');
      assert.equal(await bar.isHidden('#btnReload'), false, 'reload button visible');
      pids.alpha = await hook(app, (s, id) => s.sidecar.status(id).child.pid, ids.alpha);
      return `${urls.alpha} pid ${pids.alpha}`;
    });

    await step('data dir has the standard GAMMA_DATA_DIR layout', async () => {
      const dir = await hook(app, (s, id) => s.registry.get(id).dataDir, ids.alpha);
      assert(fs.existsSync(path.join(dir, 'users.db')), 'missing users.db');
      // One directory per Gamma workspace, named by id (the admin's personal one here).
      const wsDirs = fs.readdirSync(path.join(dir, 'workspaces'));
      assert(wsDirs.length >= 1, 'no workspace directory');
      for (const f of ['pages.db', 'data.db', 'uploads']) {
        assert(fs.existsSync(path.join(dir, 'workspaces', wsDirs[0], f)), `missing workspaces/<id>/${f}`);
      }
      return fs.readdirSync(dir).join(', ') + ' / workspaces: ' + wsDirs.join(', ');
    });

    await step('upload a PDF + create a paper page with a math note', async () => {
      const b64 = minimalPdf('Hello from the e2e paper').toString('base64');
      const r = await content.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new Blob([bytes], { type: 'application/pdf' }), 'e2e.pdf');
        const up = await fetch('/api/uploads', { method: 'POST', body: fd, credentials: 'same-origin' });
        if (!up.ok) throw new Error('upload ' + up.status + ' ' + (await up.text()));
        const u = await up.json();
        const H = { 'Content-Type': 'application/json' };
        const page = await fetch('/api/blocks', { method: 'POST', headers: H, credentials: 'same-origin', body: JSON.stringify({ parent_id: 'root', content: 'E2E paper' }) }).then((r) => r.json());
        await fetch('/api/blocks/' + page.id, { method: 'PUT', headers: H, credentials: 'same-origin', body: JSON.stringify({ properties: { source_url: u.source_url, doc_id: u.doc_id } }) });
        await fetch('/api/blocks', { method: 'POST', headers: H, credentials: 'same-origin', body: JSON.stringify({ parent_id: page.id, content: 'A note with $E = mc^2$ and a table\n\n| a | b |\n|---|---|\n| 1 | 2 |' }) });
        return { pageId: page.id, sourceUrl: u.source_url };
      }, b64);
      pageId = r.pageId;
      sourceUrl = r.sourceUrl;
      const dir = await hook(app, (s, id) => s.registry.get(id).dataDir, ids.alpha);
      const wsDir = fs.readdirSync(path.join(dir, 'workspaces'))[0];
      const uploads = fs.readdirSync(path.join(dir, 'workspaces', wsDir, 'uploads'));
      assert.equal(uploads.length, 1, 'one upload on disk');
      return `${sourceUrl} → ${uploads[0]}`;
    });

    await step('page exports in every mode (frozen bundle: PyPDF2, ziamath fonts)', async () => {
      const res = await content.evaluate(async (pageId) => {
        const out = {};
        const get = async (label, url) => {
          const r = await fetch(url, { credentials: 'same-origin' });
          const buf = new Uint8Array(await r.arrayBuffer());
          out[label] = { status: r.status, type: r.headers.get('content-type'), size: buf.length, head: String.fromCharCode(...buf.slice(0, 4)) };
        };
        for (const mode of ['readable', 'notes-pdf', 'logseq-graph', 'zotero-rdf', 'gamma']) {
          await get(mode, `/api/pages/${pageId}/export?mode=${mode}`);
        }
        await get('export-pdf', `/api/pages/${pageId}/export-pdf?notes=1&highlights=1`);
        return out;
      }, pageId);
      const bad = Object.entries(res).filter(([, v]) => v.status !== 200 || !v.size);
      assert(!bad.length, 'failed: ' + JSON.stringify(bad));
      assert.equal(res['notes-pdf'].head, '%PDF', 'notes-pdf is a PDF');
      assert.equal(res['export-pdf'].head, '%PDF', 'export-pdf is a PDF');
      return Object.entries(res).map(([k, v]) => `${k}:${v.size}B`).join(' ');
    });

    await step('markdown import creates a page', async () => {
      const r = await content.evaluate(async () => {
        const fd = new FormData();
        fd.append('file', new Blob(['# Imported notes\n\n- first\n  - nested\n- second'], { type: 'text/markdown' }), 'imported.md');
        const r = await fetch('/api/import/markdown', { method: 'POST', body: fd, credentials: 'same-origin' });
        return { status: r.status, body: await r.text() };
      });
      assert.equal(r.status, 200, r.body);
      const titles = await rootTitles(content);
      assert(titles.some((t) => /Imported notes|imported/i.test(t)), 'imported page listed: ' + titles.join(' | '));
      return titles.join(' | ');
    });

    await step('backup zip downloads through the browser download path', async () => {
      const r = await content.evaluate(async () => {
        const r = await fetch('/api/export', { credentials: 'same-origin' });
        const blob = await r.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'e2e-backup.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        return { status: r.status, size: blob.size };
      });
      assert.equal(r.status, 200);
      const file = await waitFor(async () => {
        const f = path.join(downloads, 'e2e-backup.zip');
        return fs.existsSync(f) && fs.statSync(f).size === r.size ? f : null;
      }, 'downloaded zip', 30_000);
      backupZip = fs.readFileSync(file);
      assert.equal(backupZip.subarray(0, 2).toString(), 'PK', 'zip magic');
      return `${file} (${r.size} B)`;
    });

    await step('second server; switch from the shell bar while Alpha keeps running', async () => {
      ids.beta = await hook(app, (s) => s.registry.addLocal('Beta').id);
      await bar.click('#wsBtn');
      await waitFor(async () => {
        const b = await hook(app, (s) => s.bounds());
        return b.bar.height > 100;
      }, 'bar expanded for the menu', 5_000);
      await bar.locator(`#menu .item[data-id="${ids.beta}"]`).click();
      await waitFor(async () => new URL(content.url()).origin !== urls.alpha && content.url().startsWith('http'), 'navigated to Beta');
      await waitLoggedIn(content);
      urls.beta = new URL(content.url()).origin;
      assert.notEqual(urls.beta, urls.alpha);
      await waitFor(async () => (await bar.textContent('#wsName')).trim() === 'Beta', 'bar shows Beta');
      const b = await hook(app, (s) => s.bounds());
      assert.equal(b.bar.height, 38, 'bar collapsed again');
      const alphaStill = await hook(app, (s, id) => Boolean(s.sidecar.status(id)), ids.alpha);
      assert(alphaStill, 'Alpha sidecar still running');
      pids.beta = await hook(app, (s, id) => s.sidecar.status(id).child.pid, ids.beta);
      return `${urls.beta} (Alpha still up on ${urls.alpha})`;
    });

    await step('import the Alpha backup into Beta', async () => {
      const r = await content.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const fd = new FormData();
        fd.append('file', new Blob([bytes], { type: 'application/zip' }), 'backup.zip');
        const r = await fetch('/api/import-data', { method: 'POST', body: fd, credentials: 'same-origin' });
        return { status: r.status, body: await r.text() };
      }, backupZip.toString('base64'));
      assert.equal(r.status, 200, r.body);
      const d = JSON.parse(r.body);
      assert(d.restored.includes('pages.db'), 'pages.db restored');
      const titles = await rootTitles(content);
      assert(titles.includes('E2E paper'), 'Alpha page now in Beta: ' + titles.join(' | '));
      const pdf = await content.evaluate((u) => fetch(u, { credentials: 'same-origin' }).then((r) => r.arrayBuffer()).then((b) => String.fromCharCode(...new Uint8Array(b).slice(0, 4))), sourceUrl);
      assert.equal(pdf, '%PDF', 'upload restored');
      assert.equal(d.uploads_in_backup, 1, 'backup carried the upload: ' + r.body);
      return `restored ${d.restored.join(', ')}, uploads ${d.uploads_added}/${d.uploads_in_backup}`;
    });

    await step('switch back to Alpha: instant, same server, no restart', async () => {
      const t0 = Date.now();
      await bar.click('#wsBtn');
      await bar.locator(`#menu .item[data-id="${ids.alpha}"]`).click();
      await waitFor(async () => new URL(content.url()).origin === urls.alpha, 'back on Alpha', 15_000);
      await waitFor(async () => (await sessionUser(content)) === 'admin', 'still logged in');
      const pid = await hook(app, (s, id) => s.sidecar.status(id).child.pid, ids.alpha);
      assert.equal(pid, pids.alpha, 'same sidecar process');
      return `${Date.now() - t0} ms`;
    });

    await step('Gamma workspaces: the bar lists them and switches with ?ws=', async () => {
      // A second Gamma workspace inside Alpha, made through the public API
      // from the signed-in page (the shell never touches Gamma's data itself).
      const lab = await content.evaluate(async () => {
        const r = await fetch('/api/workspaces', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'E2E lab' }) });
        return (await r.json()).id;
      });
      await bar.click('#wsBtn');
      await waitFor(async () => (await bar.locator(`#menu .wsItem[data-ws="${lab}"]`).count()) === 1, 'lab listed in the bar menu', 15_000);
      await bar.locator(`#menu .wsItem[data-ws="${lab}"]`).click();
      await waitFor(async () => new URL(content.url()).searchParams.get('ws') === lab, 'content navigated to ?ws=', 15_000);
      await waitFor(async () => (await bar.textContent('#wsWorkspace')).includes('E2E lab'), 'bar names the workspace', 15_000);
      const g = await hook(app, (s) => s.gamma());
      assert(g && g.current === lab && g.list.length === 2, 'shell knows the workspaces: ' + JSON.stringify(g));
      assert.equal(new URL(content.url()).origin, urls.alpha, 'same server');
      return `${lab} on ${urls.alpha}`;
    });

    await step('remote server: a URL, loads without auto-login', async () => {
      ids.remote = await hook(app, (s, url) => s.registry.addRemote('Alpha by URL', url).id, urls.alpha);
      await hook(app, (s, id) => s.openServer(id), ids.remote);
      await waitFor(async () => new URL(content.url()).origin === urls.alpha, 'remote loaded');
      const cur = await hook(app, (s) => s.current());
      assert.equal(cur.type, 'remote');
      await waitFor(async () => (await bar.textContent('#wsName')).trim() === 'Alpha by URL', 'bar shows remote');
      return cur.url;
    });

    await step('clone: the "clone" chip on a remote row makes the clone; the rows then cross-link', async () => {
      // On the remote (Alpha by URL — same server, so the session is there):
      // the personal workspace row carries the "clone" chip on hover.
      const g = await waitFor(async () => hook(app, (s) => s.gamma()), 'workspaces read off the remote', 15_000);
      const origWs = g.current;
      await bar.click('#wsBtn');
      const row = bar.locator(`#menu .wsItem[data-ws="${origWs}"]`);
      await row.waitFor({ timeout: 15_000 });
      await row.hover();
      await row.locator('.rowAct[data-act="keep"]').click();
      // The copy lands on the first local server (Alpha itself here) and the window moves to it.
      await waitFor(async () => {
        const c = await hook(app, (s) => s.current());
        return c && c.type === 'local' && new URL(content.url()).searchParams.get('ws') && new URL(content.url()).searchParams.get('ws') !== origWs;
      }, 'the window moved to the copy', 30_000);
      const copyWs = new URL(content.url()).searchParams.get('ws');
      const mirrors = await hook(app, (s) => s.registry.load().mirrors);
      assert.equal(mirrors.length, 1, 'the registry maps the copy: ' + JSON.stringify(mirrors));
      assert.equal(mirrors[0].server, ids.alpha);
      assert.equal(mirrors[0].workspace, copyWs);
      assert.equal(mirrors[0].remoteWs, origWs);
      await waitLoggedIn(content);
      // The clone's row reads "clone" and its "origin" chip opens the origin…
      await bar.click('#wsBtn');
      const copyRow = bar.locator(`#menu .wsItem[data-ws="${copyWs}"]`);
      await copyRow.waitFor({ timeout: 15_000 });
      assert((await copyRow.textContent()).includes('clone'), 'row reads clone');
      await copyRow.locator('.rowAct.on[data-act="original"]').click();
      await waitFor(async () => {
        const c = await hook(app, (s) => s.current());
        return c && c.id === ids.remote && new URL(content.url()).searchParams.get('ws') === origWs;
      }, 'back on the original', 30_000);
      // …and on the remote the origin's row now shows "open clone" instead of "clone": it opens the clone.
      await bar.click('#wsBtn');
      const again = bar.locator(`#menu .wsItem[data-ws="${origWs}"] .rowAct.on[data-act="copy"]`);
      await again.waitFor({ timeout: 15_000 });
      await again.click();
      await waitFor(async () => {
        const c = await hook(app, (s) => s.current());
        return c && c.id === ids.alpha && new URL(content.url()).searchParams.get('ws') === copyWs;
      }, 'the copy opened from the remote row', 30_000);
      // A second "clone" of the same workspace makes no second clone: it opens the existing one.
      await hook(app, (s, id) => s.openServer(id), ids.remote);
      await waitFor(async () => {
        const c = await hook(app, (s) => s.current());
        const g2 = await hook(app, (s) => s.gamma());
        return c && c.id === ids.remote && g2 && g2.list.some((w) => w.id === origWs);
      }, 'remote again, workspaces read', 15_000);
      await hook(app, (s, id) => s.keepOffline(id), origWs);
      assert.equal((await hook(app, (s) => s.registry.load().mirrors)).length, 1, 'still one copy');
      assert.equal(new URL(content.url()).searchParams.get('ws'), copyWs);
      return `${origWs} → copy ${copyWs} on Alpha`;
    });

    await step('remote reachability dot: on for the live server, off for a dead URL', async () => {
      await bar.click('#wsBtn');
      await bar.click('#menuLauncher');
      await waitFor(() => isLauncher(content.url()), 'launcher shown');
      // The live one was just opened (recorded reachable) and gets re-probed
      // on the launcher's refresh.
      const live = content.locator('.card', { hasText: 'Alpha by URL' }).first();
      await live.locator('.dot.on').waitFor({ timeout: 15_000 });
      const port = await closedPort();
      const id = await hook(app, (s, url) => s.registry.addRemote('Dead dot', url).id, `http://127.0.0.1:${port}`);
      try {
        await hook(app, (s) => s.probeRemotes(true));
        const dead = content.locator('.card', { hasText: 'Dead dot' }).first();
        await dead.locator('.dot.off').waitFor({ timeout: 15_000 });
        assert.equal(await dead.locator('.dot').getAttribute('title'), 'server unreachable');
        // Same dots in the bar's dropdown.
        await bar.click('#wsBtn');
        await bar.locator(`#menu .item[data-id="${id}"] .dot.off`).waitFor({ timeout: 10_000 });
        await bar.locator(`#menu .item[data-id="${ids.remote}"] .dot.on`).waitFor({ timeout: 10_000 });
        await bar.keyboard.press('Escape');
        await waitFor(async () => (await bar.evaluate(() => document.getElementById('menu').hidden)), 'menu closed');
        const health = await hook(app, (s) => Object.fromEntries([...s.remoteHealth].map(([k, v]) => [k, v.ok])));
        assert.equal(health[ids.remote], true);
        assert.equal(health[id], false);
        return `live=on dead=off (probe cache ${Object.keys(health).length} entries)`;
      } finally {
        await hook(app, (s, id) => s.registry.remove(id, {}), id);
      }
    });

    await step('updater: disabled under test, state exposed through the shell', async () => {
      const u = await hook(app, (s) => s.update());
      assert.equal(u.status, 'unsupported', JSON.stringify(u));
      assert.equal(u.error, 'disabled');
      assert.equal(typeof u.current, 'string');
      const st = await content.evaluate(() => gammaShell.state());
      assert.equal(st.update.status, 'unsupported', 'bar state carries the updater');
      await waitFor(() => isLauncher(content.url()), 'still on the launcher');
      const row = await content.textContent('#updText');
      assert(/Not available in this build/.test(row), row);
      assert(await content.locator('#btnUpdate').isHidden(), 'no check button when unsupported');
      assert(await bar.locator('#btnUpdate').isHidden(), 'no update pill in the bar');
      return `${u.status} (${u.error}), v${u.current}`;
    });

    await step('unreachable remote falls back to the launcher with the error', async () => {
      const port = await closedPort();
      const id = await hook(app, (s, url) => s.registry.addRemote('Dead', url).id, `http://127.0.0.1:${port}`);
      try {
        const err = await hook(app, async (s, id) => {
          try {
            await s.openServer(id);
            return null;
          } catch (e) {
            s.loadLauncher(e.message);
            return e.message;
          }
        }, id);
        assert(err, 'open rejected');
        await waitFor(() => isLauncher(content.url()), 'launcher shown');
        await content.waitForSelector('#status.err');
        const txt = await content.textContent('#status');
        assert(/ERR_CONNECTION_REFUSED|refused|failed/i.test(txt), txt);
        return txt.slice(0, 60);
      } finally {
        await hook(app, (s, id) => s.registry.remove(id, {}), id);
      }
    });

    await step('navigation guard: foreign URLs open outside, the window stays', async () => {
      await hook(app, (s, id) => s.openServer(id), ids.alpha);
      await waitLoggedIn(content);
      await content.evaluate(() => {
        window.open('https://example.org/popup');
        setTimeout(() => { location.href = 'https://example.com/leave'; }, 0);
      });
      await sleep(1200);
      assert.equal(new URL(content.url()).origin, urls.alpha, 'still on the server');
      const opened = await hook(app, (s) => s.externalOpens.slice());
      assert(opened.includes('https://example.org/popup'), 'window.open went external: ' + opened);
      assert(opened.includes('https://example.com/leave'), 'location change went external: ' + opened);
      return opened.join(', ');
    });

    await step('theme mirror: the shell chrome follows the page theme', async () => {
      const set = (t) => content.evaluate((t) => {
        if (t) { localStorage.setItem('gamma-theme', t); document.documentElement.setAttribute('data-theme', t); }
        else { localStorage.removeItem('gamma-theme'); document.documentElement.removeAttribute('data-theme'); }
      }, t);
      const seen = [];
      for (const t of ['light', 'sepia', '']) {
        await set(t);
        await waitFor(async () => (await hook(app, (s) => s.theme())) === t, `main theme=${t || 'dark'}`, 5_000);
        await waitFor(async () => (await bar.getAttribute('html', 'data-theme')) === (t || 'dark'), `bar theme=${t || 'dark'}`, 5_000);
        seen.push(t || 'dark');
      }
      await set('light');
      await waitFor(async () => (await hook(app, (s) => s.registry.getSettings().lastTheme)) === 'light', 'lastTheme persisted', 5_000);
      return seen.join(' → ') + ' → light (persisted)';
    });

    await step('launcher lists sizes, last-opened badge, painted in the mirrored theme', async () => {
      await bar.click('#wsBtn');
      await bar.click('#menuLauncher');
      await waitFor(() => isLauncher(content.url()), 'launcher shown');
      await content.waitForSelector('.card');
      const alpha = content.locator('.card', { hasText: 'Alpha' }).first();
      const detail = await alpha.locator('.detail').textContent();
      assert(/\d+(\.\d+)? (KB|MB|GB) on disk/.test(detail), detail);
      assert.equal(await content.getAttribute('html', 'data-theme'), 'light');
      const badges = await content.locator('.badge.last').count();
      assert.equal(badges, 1, 'one last-opened badge');
      return detail;
    });

    await step('rename + remove from the launcher', async () => {
      const beta = content.locator('.card', { hasText: 'Beta' }).first();
      await beta.locator('button[title="Rename"]').click();
      await content.fill('#renameName', 'Beta renamed');
      await content.click('#btnRename');
      await content.locator('.card', { hasText: 'Beta renamed' }).waitFor();
      const dead = content.locator('.card', { hasText: 'Alpha by URL' }).first();
      await dead.locator('button[title="Remove server"]').click();
      await content.click('#btnRemoveWipe');
      await waitFor(async () => (await content.locator('.card', { hasText: 'Alpha by URL' }).count()) === 0, 'card gone');
      const names = await hook(app, (s) => s.registry.load().servers.map((w) => w.name));
      assert.deepEqual(names.sort(), ['Alpha', 'Beta renamed']);
      return names.join(', ');
    });

    await step('storage folder: change the root, existing servers move, data intact', async () => {
      const newRoot = path.join(profile, 'moved-root');
      const before = await hook(app, (s) => s.registry.load().servers.filter((w) => w.type === 'local').map((w) => w.dataDir));
      assert(before.length === 2, 'two local servers');
      const r = await content.evaluate((dir) => gammaShell.setDataRoot(dir, { move: true }), newRoot);
      assert.deepEqual(r.moved.sort(), ['Alpha', 'Beta renamed'], JSON.stringify(r));
      const after = await hook(app, (s) => s.registry.load().servers.filter((w) => w.type === 'local').map((w) => w.dataDir));
      for (const d of after) {
        assert(d.startsWith(newRoot + path.sep), `moved: ${d}`);
        assert(fs.existsSync(path.join(d, 'users.db')), `users.db in ${d}`);
      }
      for (const d of before) assert(!fs.existsSync(d), `old dir removed: ${d}`);
      assert.equal(await hook(app, (s) => s.registry.getSettings().dataRoot), newRoot);
      await waitFor(async () => (await content.textContent('#dataRootText')).trim() === newRoot, 'launcher shows the new root');
      assert.equal(await content.isHidden('#btnDataRootReset'), false, 'reset button visible');
      assert(!pidAlive(pids.alpha) && !pidAlive(pids.beta), 'old sidecars stopped for the move');
      await hook(app, (s, id) => s.openServer(id), ids.alpha);
      await waitLoggedIn(content);
      const titles = await rootTitles(content);
      assert(titles.includes('E2E paper'), 'data intact after the move: ' + titles.join(' | '));
      pids.alpha = await hook(app, (s, id) => s.sidecar.status(id).child.pid, ids.alpha);
      pids.beta = null;
      return `${r.moved.length} moved to ${newRoot}`;
    });

    await step('quit: every sidecar stops, window bounds persist', async () => {
      await hook(app, (s, id) => s.openServer(id), ids.alpha);
      await waitLoggedIn(content);
      const live = Object.values(pids).filter(Boolean);
      assert(live.length, 'have sidecar pids');
      await app.close();
      await waitFor(() => live.every((p) => !pidAlive(p)), 'sidecars gone', 15_000, 500);
      const reg = JSON.parse(fs.readFileSync(path.join(profile, 'servers.json'), 'utf8'));
      assert(reg.windowBounds && reg.windowBounds.width > 0, 'bounds saved');
      assert.equal(reg.lastOpened, ids.alpha);
      return `pids ${live.join(', ')} exited; bounds ${reg.windowBounds.width}x${reg.windowBounds.height}`;
    });

    await step('relaunch reopens the last server with its data intact', async () => {
      app = await launch(profile, downloads);
      bar = await findPage(app, isBar);
      content = await findPage(app, (u) => u.startsWith('http://127.0.0.1'), 90_000);
      await waitLoggedIn(content);
      const titles = await rootTitles(content);
      assert(titles.includes('E2E paper'), 'data persisted: ' + titles.join(' | '));
      await waitFor(async () => (await bar.textContent('#wsName')).trim() === 'Alpha', 'bar shows Alpha');
      assert.equal(await bar.getAttribute('html', 'data-theme'), 'light', 'chrome painted in the persisted theme before the page reported');
      return titles.join(' | ');
    });
  } finally {
    try {
      await app.close();
    } catch {}
    await sleep(500);
    if (!keep) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {}
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? ' — FAILED: ' + failed.map((f) => f.name).join('; ') : ''}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
