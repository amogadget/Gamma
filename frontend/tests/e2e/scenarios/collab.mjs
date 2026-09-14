// Two people on one page of a shared workspace: presence (header stack, row
// chips), each other's ops arriving live, concurrent edits to different
// blocks converging, same-block typing settling on one server value, one
// person's undo leaving the other's edit alone, a rename reaching the other
// tab, edits made offline landing once the network is back, and a highlight
// one person makes on the PDF showing up for the other.
import { tree, same, editRow, closeEditor } from "./notes.mjs";
import { waitForPdf, selectPdfText } from "./pdf.mjs";

export async function collabScenarios({ server, browser, alice, bob, makePdf, step, until, sleep, assert, assertEq, assertNoProblems, openPage }) {
  // A shared workspace: alice owns it, bob edits. (manage.py: admin-only setup.)
  const out = server.manage("create-workspace", "Team", "alice", "shared");
  const teamId = (out.match(/workspace (\S+)/) || [])[1];
  assert(teamId, `shared workspace id from: ${out}`);
  server.manage("set-member", teamId, "bob", "editor");
  const aliceT = Object.assign(Object.create(Object.getPrototypeOf(alice)), alice, { ws: teamId });
  const bobT = Object.assign(Object.create(Object.getPrototypeOf(bob)), bob, { ws: teamId });

  const created = await aliceT.api("/api/pages", { method: "POST", body: { title: "Team notes" } });
  const pageId = created.id;
  await aliceT.api("/api/blocks", { method: "POST", body: { parent_id: pageId, content: "alpha" } });
  await aliceT.api("/api/blocks", { method: "POST", body: { parent_id: pageId, content: "beta" } });

  const ctxA = await aliceT.context(browser);
  const ctxB = await bobT.context(browser);
  const url = `${server.base}/?page=${pageId}&ws=${teamId}`;
  const A = await openPage(ctxA, url);
  const B = await openPage(ctxB, url);
  const bodyHas = (p, s) => until(async () => (await p.textContent("body")).includes(s), { what: `"${s}" visible`, timeout: 10000 });
  const serverHas = (s) => until(async () => JSON.stringify(await tree(aliceT, pageId)).includes(s), { what: `server has "${s}"` });

  await step("collab: both see each other in the presence stack", async () => {
    await bodyHas(A, "beta"); await bodyHas(B, "beta");
    await until(async () => (await A.$$(".presenceBar .peerAvatar")).length >= 1, { what: "alice sees a peer" });
    await until(async () => (await B.$$(".presenceBar .peerAvatar")).length >= 1, { what: "bob sees a peer" });
    assertNoProblems(A); assertNoProblems(B);
  });

  await step("collab: bob's typing shows up live for alice, with a chip on the row", async () => {
    await editRow(B, "beta");
    await until(async () => (await A.$$(".blockRowWrap .peerChips .peerAvatar")).length >= 1, { what: "row chip on alice's side" });
    await B.keyboard.type(" from bob");
    await bodyHas(A, "beta from bob");
    await closeEditor(B);
    assertNoProblems(A); assertNoProblems(B);
  });

  await step("collab: concurrent edits to different blocks converge on both screens and the server", async () => {
    await editRow(A, "alpha");
    await editRow(B, "beta from bob");
    await A.keyboard.type(" (alice)");
    await B.keyboard.type(" (bob)");
    await closeEditor(A);
    await closeEditor(B);
    const want = [{ content: "alpha (alice)", children: [] }, { content: "beta from bob (bob)", children: [] }];
    await until(async () => same(await tree(aliceT, pageId), want), { what: `server tree ${JSON.stringify(want)}` });
    await bodyHas(A, "beta from bob (bob)"); await bodyHas(A, "alpha (alice)");
    await bodyHas(B, "alpha (alice)"); await bodyHas(B, "beta from bob (bob)");
    assertNoProblems(A); assertNoProblems(B);
  });

  await step("collab: same-block typing settles on one value everywhere (last writer wins)", async () => {
    await editRow(A, "alpha (alice)");
    await editRow(B, "alpha (alice)");
    await A.keyboard.type(" A1");
    await B.keyboard.type(" B1");
    await closeEditor(A);
    await closeEditor(B);
    const final = await until(async () => {
      const t = await tree(aliceT, pageId);
      const c = t[0]?.content || "";
      return /^alpha \(alice\)( A1| B1)$/.test(c) ? c : null;
    }, { what: "server holds one of the two versions" });
    await bodyHas(A, final); await bodyHas(B, final);
    const bodies = [await A.textContent("body"), await B.textContent("body")];
    const other = final.endsWith("A1") ? "B1" : "A1";
    assert(!bodies[0].includes(other) && !bodies[1].includes(other), `the losing version "${other}" still shows`);
    assertNoProblems(A); assertNoProblems(B);
    return final;
  });

  await step("collab: alice's undo reverts only her own edit", async () => {
    const alpha = (await tree(aliceT, pageId))[0].content;
    await editRow(A, alpha);
    await A.keyboard.type(" again");
    await serverHas(`${alpha} again`);
    await editRow(B, "beta from bob (bob)");
    await B.keyboard.type(" later");
    await closeEditor(B);
    await serverHas("(bob) later");
    await bodyHas(A, "(bob) later");
    await A.keyboard.press("Control+z");
    await closeEditor(A);
    const want = [{ content: alpha, children: [] }, { content: "beta from bob (bob) later", children: [] }];
    await until(async () => same(await tree(aliceT, pageId), want), { what: `after undo ${JSON.stringify(want)}` });
    assertNoProblems(A); assertNoProblems(B);
  });

  await step("collab: renaming the page in one tab updates the other's title and tab", async () => {
    await A.click("h3.titleText");
    await A.waitForSelector(".titleEdit");
    await A.keyboard.press("Control+a");
    await A.keyboard.type("Team notes renamed");
    await A.keyboard.press("Enter");
    await until(async () => (await B.textContent("h3.titleText")) === "Team notes renamed", { what: "bob's title" });
    await until(async () => (await B.textContent(".tabStrip")).includes("Team notes renamed"), { what: "bob's tab label" });
    assertNoProblems(A); assertNoProblems(B);
  });

  await step("collab: an edit made offline is kept and lands once the network is back", async () => {
    await ctxA.setOffline(true);
    await editRow(A, "(bob) later");
    await A.keyboard.type(" offline");
    await closeEditor(A);
    await sleep(1500);
    assert(!JSON.stringify(await tree(aliceT, pageId)).includes("offline"), "nothing reached the server while offline");
    await ctxA.setOffline(false);
    await serverHas("(bob) later offline");
    await bodyHas(B, "(bob) later offline");
    // The failed POSTs and the dropped socket are expected while offline.
    assertNoProblems(A, [/ERR_INTERNET_DISCONNECTED|Failed to fetch|WebSocket|net::ERR/]);
    assertNoProblems(B);
  });

  await step("collab: a block bob deletes disappears for alice", async () => {
    const wrap = B.locator(".sortableBlockWrap", { hasText: "alpha" }).first();
    await wrap.hover();
    await wrap.locator(".dragHandle").click();
    await B.locator(".ctxMenuItem", { hasText: "Delete" }).click();
    await until(async () => !(await A.textContent("body")).includes("alpha"), { what: "row gone on alice's side" });
    await until(async () => same(await tree(aliceT, pageId), [{ content: "beta from bob (bob) later offline", children: [] }]), { what: "server tree" });
    assertNoProblems(A); assertNoProblems(B);
  });

  await step("collab: a highlight bob makes on the PDF appears on alice's page", async () => {
    const pdf = makePdf([["Shared paper about tensor networks", "and matrix product states"]]);
    const up = await aliceT.upload("/api/uploads", pdf, "shared.pdf", "application/pdf");
    const paper = await aliceT.api(`/api/blocks/by-doc/${up.doc_id}`, { method: "POST", body: { default_title: "Shared paper", source_url: up.source_url } });
    const purl = `${server.base}/?page=${paper.id}&ws=${teamId}`;
    await A.goto(purl); await B.goto(purl);
    await waitForPdf(A, 1); await waitForPdf(B, 1);
    await selectPdfText(B, 1, "tensor networks");
    await B.waitForSelector(".plainTip .colorBtn", { timeout: 5000 });
    await B.locator(".plainTip .colorBtn").first().click();
    await A.waitForSelector('[data-page="1"] [data-hl-id]', { timeout: 10000 });
    await until(async () => ((await A.textContent(".blockRow .blockQuote").catch(() => "")) || "").includes("tensor networks"), { what: "quote row on alice's side" });
    assertNoProblems(A); assertNoProblems(B);
  });

  await ctxA.close();
  await ctxB.close();
  return { teamId, teamPageId: pageId };
}
