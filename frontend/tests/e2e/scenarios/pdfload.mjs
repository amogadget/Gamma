// PDF load timing probe (docs/dev/pdf_loading.md): a 300-page, ~20 MB
// document opened cold on a throttled connection, then warm from the browser
// caches once the background backfill has landed. Reads the performance marks
// App stamps per load phase and reports them as the step's note; asserts only
// that the document paints at all, so a slow machine never fails the suite —
// the numbers are the deliverable.
export async function pdfLoadScenarios({ server, browser, alice, makePdf, step, until, assert, assertNoProblems, openPage }) {
  const PAGES = 300;
  const PAD = 20 * 1024 * 1024;
  // 20 Mbps down, 40 ms latency — a home connection to a self-hosted server.
  const NET = { offline: false, latency: 40, downloadThroughput: (20e6) / 8, uploadThroughput: (5e6) / 8 };

  // The marks of the LATEST load (from its "open" on), so a second open in
  // the same tab is not read against the first one's phases.
  async function marks(page) {
    return page.evaluate(() => {
      const all = performance.getEntriesByType("mark").filter((m) => m.name.startsWith("pdf-"));
      const opens = all.filter((m) => m.name === "pdf-open");
      const since = opens.length ? opens[opens.length - 1].startTime : 0;
      const out = {};
      for (const m of all) if (m.startTime >= since) out[m.name.slice(4)] = m.detail?.ms;
      return out;
    });
  }
  const paintCount = (page) => page.evaluate(() => performance.getEntriesByName("pdf-painted").length);
  // The pdf.js worker script as the page's resource timing saw it: bytes over
  // the wire (0 = served from the browser cache) and how long it took.
  const workerFetch = (page) => page.evaluate(() => {
    const r = performance.getEntriesByType("resource").find((e) => e.name.includes("pdf.worker"));
    return r ? `worker ${r.transferSize ? `${(r.transferSize / 1048576).toFixed(1)} MB` : "from cache"} in ${Math.round(r.duration)} ms` : "worker fetch not seen";
  });
  function fmt(m) {
    return Object.entries(m).filter(([, v]) => v != null).sort((a, b) => a[1] - b[1]).map(([k, v]) => `${k} +${v}`).join(" ");
  }
  // What the browser actually pulled over the wire for the PDF file: CDP's
  // encodedDataLength counts bytes received, not what a cancelled request
  // would have been, and the status tells ranges (206) from whole files (200).
  async function meter(page) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", NET);
    const byId = new Map();
    const stat = { ranges: 0, whole: 0, bytes: 0, manifest: 0, worker: "" };
    const workerIds = new Set();
    cdp.on("Network.responseReceived", (e) => {
      const u = e.response.url;
      if (u.includes("/api/pdf-info/")) stat.manifest += 1;
      if (u.includes("/api/uploads/") && u.includes(".pdf")) byId.set(e.requestId, e.response.status);
      // The pdf.js worker script: 1.4 MB that must come from the browser cache on a reopen.
      if (u.includes("pdf.worker")) {
        workerIds.add(e.requestId);
        stat.worker = e.response.fromDiskCache || e.response.fromMemoryCache ? "worker cached" : `worker ${e.response.status}`;
      }
    });
    cdp.on("Network.loadingFinished", (e) => {
      if (workerIds.has(e.requestId) && !stat.worker.endsWith("cached")) stat.worker += ` ${(e.encodedDataLength / 1048576).toFixed(1)} MB`;
      const status = byId.get(e.requestId);
      if (status == null) return;
      if (status === 206) stat.ranges += 1; else stat.whole += 1;
      stat.bytes += e.encodedDataLength;
    });
    stat.text = () => `${stat.ranges} range + ${stat.whole} whole request(s), ${(stat.bytes / 1048576).toFixed(1)} MB on the wire${stat.manifest ? ", manifest used" : ""}${stat.worker ? `, ${stat.worker}` : ""}`;
    return stat;
  }
  const hasDiskCopy = (page, pdfUrl) => page.evaluate((u) => new Promise((resolve) => {
    const rq = indexedDB.open("gamma-pdf-cache", 1);
    rq.onerror = () => resolve(false);
    rq.onsuccess = () => {
      const db = rq.result;
      try {
        const g = db.transaction("pdfs").objectStore("pdfs").getKey(u);
        g.onsuccess = () => { db.close(); resolve(g.result !== undefined); };
        g.onerror = () => { db.close(); resolve(false); };
      } catch { db.close(); resolve(false); }
    };
  }), pdfUrl);

  const pdf = makePdf(Array.from({ length: PAGES }, (_, i) => [`Timing probe page ${i + 1}`, "Lorem ipsum dolor sit amet"]), { padBytes: PAD });
  const up = await alice.upload("/api/uploads", pdf, "probe.pdf", "application/pdf");
  const created = await alice.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: "Timing probe", source_url: up.source_url } });
  const url = `${server.base}/?page=${created.id}&ws=${alice.ws}`;

  let ctx, page;
  await step("pdf load: cold open of a 300-page, 20 MB document at 20 Mbps", async () => {
    ctx = await alice.context(browser);
    page = await openPage(ctx); // collectors attached, no navigation yet
    const stat = await meter(page);
    await page.goto(url);
    await until(async () => (await marks(page)).painted != null, { timeout: 120000, every: 250, what: "first page paint" });
    const m = await marks(page);
    assert((await page.$$("[data-page]")).length >= PAGES, "every page box is in the DOM");
    assertNoProblems(page);
    return `${fmt(m)} ms; ${stat.text()}; ${await workerFetch(page)}`;
  });

  await step("pdf load: the whole file is backfilled into IndexedDB after the range open", async () => {
    const t0 = Date.now();
    await until(() => hasDiskCopy(page, up.source_url), { timeout: 120000, every: 500, what: "IndexedDB copy" });
    assertNoProblems(page);
    return `landed ${Date.now() - t0} ms after first paint`;
  });

  let p2;
  await step("pdf load: warm reopen of the same document", async () => {
    // A fresh page in the same context keeps IndexedDB and the HTTP cache.
    p2 = await openPage(ctx);
    const stat = await meter(p2);
    await p2.goto(url);
    await until(async () => (await marks(p2)).painted != null, { timeout: 120000, every: 250, what: "first page paint" });
    const m = await marks(p2);
    assertNoProblems(p2);
    return `${fmt(m)} ms; ${stat.text()}; ${await workerFetch(p2)}`;
  });

  await step("pdf load: back to the paper from the home library, same tab (parsed document kept)", async () => {
    const before = await paintCount(p2);
    await p2.click("button[aria-label='Home']");
    // The title is whatever metadata extraction read off page 1, so match the document either way.
    const card = p2.locator(".pageCard", { hasText: /Timing probe|Lorem ipsum/ }).first();
    await card.waitFor({ timeout: 15000 });
    await card.dblclick();
    await until(async () => (await paintCount(p2)) > before, { timeout: 60000, every: 100, what: "the paper's paint" });
    const m = await marks(p2);
    assertNoProblems(p2);
    await ctx.close();
    return `${fmt(m)} ms`;
  });
}
