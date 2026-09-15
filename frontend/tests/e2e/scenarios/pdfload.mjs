// PDF loading (docs/dev/pdf_loading.md). First the timing probe: a 300-page,
// ~20 MB document opened cold on a throttled connection, then warm from the
// browser caches once the background backfill has landed, then again from
// the parsed-document cache. It reads the performance marks App stamps per
// load phase and reports them as the step's note; it asserts only that the
// document paints at all, so a slow machine never fails the suite — the
// numbers are the deliverable. Then the behaviours the fast path must keep:
// page boxes laid out from the manifest, a reading position restored across
// a reload, two large documents alternating without mixing, and the share
// view opening a large document by ranges with the token on every request.
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
  const waitPainted = (page, before) =>
    until(async () => (await paintCount(page)) > before, { timeout: 120000, every: 200, what: "first page paint" });
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
  async function meter(page, throttle = true) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    if (throttle) await cdp.send("Network.emulateNetworkConditions", NET);
    const byId = new Map();
    const stat = { ranges: 0, whole: 0, bytes: 0, manifest: 0 };
    cdp.on("Network.responseReceived", (e) => {
      const u = e.response.url;
      if (u.includes("/api/pdf-info/")) stat.manifest += 1;
      if (u.includes("/api/uploads/") && u.includes(".pdf")) byId.set(e.requestId, e.response.status);
    });
    cdp.on("Network.loadingFinished", (e) => {
      const status = byId.get(e.requestId);
      if (status == null) return;
      if (status === 206) stat.ranges += 1; else stat.whole += 1;
      stat.bytes += e.encodedDataLength;
    });
    stat.text = () => `${stat.ranges} range + ${stat.whole} whole request(s), ${(stat.bytes / 1048576).toFixed(1)} MB on the wire${stat.manifest ? ", manifest used" : ""}`;
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
  const pageText = (page, n) => page.textContent(`[data-page="${n}"] .textLayer`).catch(() => "");
  // The text of the page the viewer says it is on — after a restore that is
  // not page 1, and page 1 may not even be rendered.
  const currentPageText = async (page) => {
    const n = await page.inputValue("input[aria-label='Current page']").catch(() => "");
    return n ? `page ${n}: ${await pageText(page, n)}` : "";
  };
  const box = (page, sel) => page.evaluate((s) => {
    const r = document.querySelector(s)?.getBoundingClientRect();
    return r ? { top: r.top, width: r.width, height: r.height } : null;
  }, sel);

  // A NON-default workspace on purpose: pdf.js fetches the range requests
  // itself, with an absolute url, and the fetch wrapper has to tag those with
  // the workspace too — in the default workspace a missing header goes
  // unnoticed.
  const probeWs = await alice.api("/api/workspaces", { method: "POST", body: { name: "Probe" } });
  const account = Object.assign(Object.create(Object.getPrototypeOf(alice)), alice, { ws: probeWs.id });
  async function bigDoc(title, lines) {
    const pdf = makePdf(Array.from({ length: PAGES }, (_, i) => lines(i + 1)), { padBytes: PAD });
    const up = await account.upload("/api/uploads", pdf, `${title}.pdf`, "application/pdf");
    const created = await account.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: title, source_url: up.source_url } });
    return { up, pageId: created.id, url: `${server.base}/?page=${created.id}&ws=${account.ws}` };
  }
  const A = await bigDoc("Timing probe", (n) => [`Timing probe page ${n}`, "Lorem ipsum dolor sit amet"]);

  let ctx, page;
  await step("pdf load: cold open of a 300-page, 20 MB document at 20 Mbps", async () => {
    ctx = await account.context(browser);
    page = await openPage(ctx); // collectors attached, no navigation yet
    const stat = await meter(page);
    await page.goto(A.url);
    await waitPainted(page, 0);
    const m = await marks(page);
    assert((await page.$$("[data-page]")).length >= PAGES, "every page box is in the DOM");
    assertNoProblems(page);
    return `${fmt(m)} ms; ${stat.text()}; ${await workerFetch(page)}`;
  });

  await step("pdf load: the whole file is backfilled into IndexedDB after the range open", async () => {
    const t0 = Date.now();
    await until(() => hasDiskCopy(page, A.up.source_url), { timeout: 120000, every: 500, what: "IndexedDB copy" });
    assertNoProblems(page);
    return `landed ${Date.now() - t0} ms after first paint`;
  });

  let p2;
  await step("pdf load: warm reopen of the same document", async () => {
    // A fresh page in the same context keeps IndexedDB and the HTTP cache.
    p2 = await openPage(ctx);
    const stat = await meter(p2);
    await p2.goto(A.url);
    await waitPainted(p2, 0);
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
    await waitPainted(p2, before);
    const m = await marks(p2);
    assertNoProblems(p2);
    await ctx.close();
    return `${fmt(m)} ms`;
  });

  // ---- behaviours -----------------------------------------------------------

  await step("pdf load: page boxes come from the manifest — a landscape page far below the fold has its own shape", async () => {
    // 40 pages so page 30 sits well past the render look-ahead: its box is
    // never measured by pdf.js here, so a landscape box can only have come
    // from the manifest (the old estimate gave every unmeasured page page 1's
    // portrait shape).
    const pdf = makePdf(Array.from({ length: 40 }, (_, i) => (i === 29
      ? { lines: [`Wide page ${i + 1}`], box: [792, 612] }
      : [`Narrow page ${i + 1}`])));
    const up = await account.upload("/api/uploads", pdf, "mixed.pdf", "application/pdf");
    const created = await account.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: "Mixed sizes", source_url: up.source_url } });
    const c = await account.context(browser);
    const p = await openPage(c, `${server.base}/?page=${created.id}&ws=${account.ws}`);
    await waitPainted(p, 0);
    const first = await box(p, '[data-page="1"]');
    const wide = await box(p, '[data-page="30"]');
    assert(first && wide, "page boxes exist");
    assert(!(await p.$('[data-page="30"] .textLayer span')), "page 30 is not rendered (below the look-ahead)");
    assert(Math.abs(first.width / first.height - 612 / 792) < 0.02, `page 1 portrait: ${first.width}x${first.height}`);
    assert(Math.abs(wide.width / wide.height - 792 / 612) < 0.02, `page 30 landscape: ${wide.width}x${wide.height}`);
    assertNoProblems(p);
    await c.close();
  });

  let ctx3, p3;
  await step("pdf load: the reading position survives a reload of the large document", async () => {
    ctx3 = await account.context(browser);
    p3 = await openPage(ctx3, A.url);
    await waitPainted(p3, 0);
    // Jump to page 150 the way a reader does, then wait for the position to
    // be recorded (localStorage gets it at once; the server later).
    await p3.fill("input[aria-label='Current page']", "150");
    await p3.press("input[aria-label='Current page']", "Enter");
    await until(() => p3.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("gamma-read-pos:") && /"page":150\b/.test(localStorage.getItem(k) || ""))),
      { timeout: 15000, what: "page 150 recorded" });
    await p3.reload(); // a reload starts a fresh performance timeline: marks count from zero again
    await waitPainted(p3, 0);
    const m = await marks(p3);
    assert(m.layout != null, `the skeleton was laid out (${fmt(m)})`);
    // Page 150's box sits at the top of the viewer (under the viewer's 80 px
    // context margin): the restore landed.
    await until(async () => {
      const v = await box(p3, ".pdfViewer");
      const b = await box(p3, '[data-page="150"]');
      return v && b && b.top >= v.top - 2 && b.top <= v.top + 100;
    }, { timeout: 10000, what: "page 150 at the top of the viewer" });
    await until(async () => (await p3.inputValue("input[aria-label='Current page']")) === "150", { timeout: 5000, what: "page indicator 150" });
    assertNoProblems(p3);
    return fmt(m) + " ms";
  });

  await step("pdf load: two large documents alternate through the parsed-document cache without mixing", async () => {
    const B = await bigDoc("Second book", (n) => [`Second book page ${n}`, "Alpha beta gamma delta"]);
    // Open a paper from the library and check that the page the viewer lands
    // on (A comes back at its restored page 150) shows THAT book's text.
    const open = async (re, book) => {
      const before = await paintCount(p3);
      await p3.click("button[aria-label='Home']");
      // A recently viewed paper is a card in the recents strip; one never
      // opened in this browser is only a row in the library list.
      const card = p3.locator(".pageCard, .fileRow", { hasText: re }).first();
      await card.waitFor({ timeout: 15000 });
      await card.dblclick();
      await waitPainted(p3, before);
      // Text-layer spans concatenate without spaces ("page 1Alpha beta"), so no word boundary after the number.
      const shows = new RegExp(`^page (\\d+): .*${book} page \\1(?!\\d)`);
      await until(async () => shows.test(await currentPageText(p3)), { timeout: 15000, what: `the visible page is from "${book}"` });
      return marks(p3);
    };
    const firstB = await open(/Second book|Alpha beta/, "Second book"); // cold: ranges
    const backA = await open(/Timing probe|Lorem ipsum/, "Timing probe");
    const backB = await open(/Second book|Alpha beta/, "Second book");
    assert(backA.cached != null && backB.cached != null, `both reopen from the cache (A ${fmt(backA)}; B ${fmt(backB)})`);
    assertNoProblems(p3);
    await ctx3.close();
    return `B cold ${fmt(firstB)} ms; A back ${fmt(backA)} ms; B back ${fmt(backB)} ms`;
  });

  await step("pdf load: an anonymous share visitor opens the large document by ranges", async () => {
    const share = await account.api(`/api/share/${A.pageId}`, { method: "POST" });
    assert(share.token, "share token");
    const c = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const p = await openPage(c);
    const stat = await meter(p, false);
    await p.goto(`${server.base}/?share=${share.token}`);
    await waitPainted(p, 0);
    await until(async () => (await pageText(p, 1)).includes("Timing probe page 1"), { timeout: 15000, what: "page 1 text" });
    assert(stat.ranges >= 1 && stat.whole === 0, `opened by ranges: ${stat.text()}`);
    assert(stat.manifest >= 1, "the manifest was fetched through the share");
    assertNoProblems(p); // a HEAD, a manifest or a range without the token would have logged a 401/403
    await c.close();
    return stat.text();
  });
}
