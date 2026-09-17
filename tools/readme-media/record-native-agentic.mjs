// One PDF conversation: a substantive question, passage citation, then figure Q&A.
// Requires a disposable curated workspace with AI on its owning account.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, ROOT, configureContext } from './runtime.mjs';
import { Account } from '../../frontend/tests/e2e/harness.mjs';
import { getDocument } from '../../frontend/node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import { parsePdfCitation, citationRuns, matchCitation } from '../../frontend/src/pdf/pdfCitation.js';

const scratch = path.resolve(process.env.MEDIA_SCRATCH || path.join(ROOT, 'artifacts/readme-media/revised'));
const state = JSON.parse(fs.readFileSync(path.join(scratch, 'workspace.json')));
if (state.removed) throw new Error('Recording workspace was removed');
const account = new Account({ base: state.base }, state.username, '');
account.session = fs.readFileSync(path.join(scratch, 'session.txt'), 'utf8').trim();
account.ws = state.workspace;
const { children: pages } = await account.api('/api/blocks/root/children');
const paper = pages.find(p => p.content?.includes('coherent transport'));
if (!paper) throw new Error('Curated atom-arrays paper missing');
const pdfResponse = await account.api(paper.properties.source_url, {raw:true});
if (!pdfResponse.ok) throw new Error('Cannot load the curated PDF for citation verification');
const pdf = await getDocument({data:new Uint8Array(await pdfResponse.arrayBuffer())}).promise;
await account.api(`/api/chats/${paper.id}`, { method: 'DELETE' });
await account.api('/api/prefs/open-tabs', { method: 'PUT', body: { value: [] } });
const browser = await chromium.launch({ headless: true });
let context, page;
const marks = {}, actions = [], verified = {}, framing = {}, requests = [];
try {
  context = await account.context(browser, {
    viewport: { width: 1440, height: 900 }, colorScheme: 'light', deviceScaleFactor: 2,
    recordVideo: { dir: path.join(scratch, 'video-agentic'), size: { width: 1440, height: 900 } },
  });
  await configureContext(context);
  // Serve the actual private build while all API/PDF requests reach Gamma.
  if (process.env.GAMMA_MEDIA_DIST) {
    const dist = path.resolve(process.env.GAMMA_MEDIA_DIST);
    await context.route(`${state.base}/**`, async route => {
      const u = new URL(route.request().url());
      if (u.pathname === '/') return route.fulfill({ path: path.join(dist, 'index.html'), contentType: 'text/html' });
      if (u.pathname.startsWith('/assets/')) {
        const file = path.resolve(dist, '.' + u.pathname);
        if (!file.startsWith(dist + path.sep)) throw new Error('Invalid asset path');
        return route.fulfill({ path: file });
      }
      return route.continue();
    });
  }
  await context.addInitScript(() => {
    localStorage.setItem('gamma-theme', 'light');
    addEventListener('DOMContentLoaded', () => {
      const c = document.createElement('div');
      c.style.cssText = 'position:fixed;left:0;top:0;width:12px;height:12px;border:2px solid white;border-radius:50%;background:#2563eb;box-shadow:0 1px 4px #0004;pointer-events:none;z-index:999999;';
      document.body.append(c);
      addEventListener('mousemove', e => c.style.transform = `translate(${e.clientX-6}px,${e.clientY-6}px)`, true);
    });
  });
  page = await context.newPage();
  page.on('request', r => {
    if (new URL(r.url()).pathname === '/api/ai/chat' && r.method() === 'POST') {
      const body = r.postDataJSON();
      requests.push({ pageId: body.page_id, images: body.images?.length || 0 });
    }
  });
  page.on('pageerror', e => console.log('Page error:', e.message));
  page.on('response', r => { if(r.url().includes('/api/') && r.status()>=400) console.log('API error:',r.status(),new URL(r.url()).pathname); });
  page.on('response', async r => { if(r.url().includes('/api/blocks/root/children')) { const j=await r.json().catch(()=>({})); console.log('Library loaded:',j.children?.length); } });
  const t0 = Date.now();
  const mark = name => { marks[name] = (Date.now()-t0)/1000; console.log(name, marks[name]); };
  const hold = ms => page.waitForTimeout(ms);
  async function click(locator) {
    await locator.scrollIntoViewIfNeeded();
    const b = await locator.boundingBox();
    await page.mouse.move(b.x+b.width/2,b.y+b.height/2,{steps:25});
    await locator.click();
  }
  async function answer(phase, expectedReplies) {
    let previous = 0;
    for (let i=0;i<480;i++) {
      await hold(500);
      if (await page.locator('.chatBubble.ai.error').count()) throw new Error('AI request failed');
      const count = await page.locator('.chatToolAction').count();
      if (count !== previous) {
        actions.push({phase,at:(Date.now()-t0)/1000,count,text:await page.locator('.chatToolActionHead').allTextContents()});
        previous=count;
      }
      if (await page.locator('.chatBubbleRow.ai').count() >= expectedReplies && !await page.getByRole('button',{name:'Stop',exact:true}).count() && !await page.locator('.chatTyping').count()) {
        if ((await page.locator('.chatBubbleRow.ai').last().innerText()).length>60) break;
      }
      if(i===479) throw new Error('AI did not finish');
    }
    mark(`${phase}Answer`);
    await hold(2200);
  }
  await page.goto(`${state.base}/?page=${paper.id}&ws=${account.ws}`);
  await page.locator('.textLayer span').first().waitFor({timeout:60000});
  const notes = page.getByRole('button',{name:'Close Notes',exact:true});
  if(await notes.isVisible()) await click(notes);
  await page.locator('.chatInput').waitFor();
  const sash = page.locator('[role="separator"][data-panel-group-direction="horizontal"]');
  const sashBox = await sash.boundingBox();
  await page.mouse.move(sashBox.x+2,sashBox.y+200);
  await page.mouse.down();
  await page.mouse.move(790,sashBox.y+200,{steps:30});
  await page.mouse.up();
  const initialPage = page.getByRole('textbox', {name:'Current page',exact:true});
  await initialPage.fill('1'); await initialPage.press('Enter');
  await hold(1200);
  const toolsOff=page.getByRole('button',{name:'Tools off',exact:true});
  if(await toolsOff.isVisible()) await click(toolsOff);
  const health = page.locator('.chatHealthStrip');
  if (await health.count()) throw new Error('Demo AI connection is unhealthy; fix it before recording');
  await page.screenshot({path:path.join(scratch,'agentic-setup.png')});
  if(process.argv.includes('--inspect')) {
    console.log(await page.locator('[role="separator"]').evaluateAll(es=>es.map(e=>({html:e.outerHTML.slice(0,400),box:e.getBoundingClientRect().toJSON()}))));
    console.log('Input:',await page.locator('.chatInput').boundingBox());
  } else {
    mark('start');
    await hold(1000);
    await click(page.locator('.chatInput'));
    mark('questionZoom');
    await hold(1000);
    await page.keyboard.insertText('How does coherent transport enable non-local gates without destroying entanglement? Connect the storage and gate mechanisms to the Bell-state evidence and the speed-limiting error. Give 3 concise bullets, citing short verbatim passages without ellipses.');
    await hold(2800);
    await page.keyboard.press('Enter'); mark('pdfSent');
    await answer('pdf', 1);
    verified.expandedSteps = await page.locator('.chatToolDetail').count();
    if (verified.expandedSteps) throw new Error('Keep individual tool steps collapsed');
    await page.locator('.chatBubbleRow.ai').last().scrollIntoViewIfNeeded();
    const citations = page.locator('.chatPageLink[title="Show this passage in the PDF"]');
    await citations.first().waitFor();
    // Pick an actual answer link whose quote matches the PDF.js text exactly.
    // Model links can include ellipses or omit formula/reference characters.
    let citation;
    for (const candidate of await citations.all()) {
      const parsed = parsePdfCitation(await candidate.getAttribute('href'), state.base);
      if (!parsed || parsed.pageId !== paper.id) continue;
      const text = await (await pdf.getPage(parsed.page)).getTextContent();
      const match = matchCitation(citationRuns(text.items), parsed.quote);
      if (match.status === 'matched' && !match.approximate) { citation = candidate; break; }
    }
    if (!citation) throw new Error('No exact passage citation in the answer');
    await citation.scrollIntoViewIfNeeded();
    framing.citation = await citation.boundingBox();
    verified.citationHref = await citation.getAttribute('href');
    await hold(2000); mark('citationStart');
    await page.screenshot({path:path.join(scratch,'agentic-answer.png')});
    // Follow the answer's real passage link, without expanding tool steps.
    mark('citationClick');
    await click(citation);
    await page.locator('.pdfCitationMark').first().waitFor({timeout:20000});
    await hold(700); mark('citationReady');
    verified.citationMarks = await page.locator('.pdfCitationMark').count();
    verified.citationNotice = await page.locator('.pdfCitationNotice').allTextContents();
    if (verified.citationNotice.length) throw new Error('Citation must resolve to an exact passage');
    framing.passage = await page.locator('.pdfCitationMark').evaluateAll(es => {
      const boxes = es.map(e => e.getBoundingClientRect());
      const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
      return {x,y,width:Math.max(...boxes.map(b=>b.right))-x,height:Math.max(...boxes.map(b=>b.bottom))-y};
    });
    await page.screenshot({path:path.join(scratch,'agentic-citation.png')});
    await hold(3500); mark('passageEnd');

    // Figure 1c,d on page 2: select the parity/fidelity plots with Ctrl+drag.
    mark('figureStart');
    const pageNumber = page.getByRole('textbox', {name:'Current page',exact:true});
    await click(pageNumber);
    await pageNumber.fill('2'); await pageNumber.press('Enter');
    await page.locator('[data-page="2"] .textLayer span').first().waitFor({timeout:60000});
    await hold(1000);
    const sheet = await page.locator('[data-page="2"]').first().boundingBox();
    // Coordinates relative to the actual PDF page; they scale with its width.
    const box = {x:sheet.x + sheet.width * .515, y:sheet.y + sheet.width * .365,
      width:sheet.width * .43, height:sheet.width * .22};
    framing.figure = box;
    await page.mouse.move(box.x,box.y,{steps:25});
    await hold(600); mark('boxStart');
    await page.keyboard.down('Control'); await page.mouse.down();
    for(let i=1;i<=40;i++) {
      await page.mouse.move(box.x+box.width*i/40,box.y+box.height*i/40);
      await hold(25);
    }
    await page.mouse.up(); await page.keyboard.up('Control');
    await page.locator('.chatImgPreview img').waitFor();
    verified.boxAttachment = await page.locator('.chatImgPreview img').count();
    await hold(1300); mark('boxReady');
    await page.screenshot({path:path.join(scratch,'agentic-box.png')});
    // The plot's extracted text can be just a stray axis digit. Keep the
    // screenshot as context and remove that unhelpful text chip through the UI.
    const passageChip = page.getByTitle('Remove this passage', {exact:true});
    if (await passageChip.isVisible()) await click(passageChip);
    await click(page.locator('.chatInput')); mark('figureQuestionZoom');
    await hold(900);
    await page.keyboard.insertText('Why does the raw fidelity fall while the loss-normalized inset stays flat? What does the parity comparison tell us? Answer in 2 concise bullets.');
    await hold(2300);
    await page.keyboard.press('Enter'); mark('figureSent');
    await answer('figure', 2);
    await page.locator('.chatBubbleRow.ai').last().scrollIntoViewIfNeeded();
    framing.figureAnswer = await page.locator('.chatBubbleRow.ai').last().boundingBox();
    await hold(4000); mark('end');
    await page.screenshot({path:path.join(scratch,'agentic-final.png')});
    // Both questions and the selected image must belong to this PDF's chat.
    const saved=await account.api(`/api/chats/${paper.id}`);
    fs.writeFileSync(path.join(scratch,'agentic-saved.json'),JSON.stringify(saved,null,2));
    const savedTools = (saved.messages || []).flatMap(m => (m.actions || []).map(a => a.tool));
    verified.persistedTools = savedTools;
    const questions = (saved.messages || []).filter(m => m.role === 'user');
    const replies = (saved.messages || []).filter(m => m.role === 'ai');
    verified.singleConversation = questions.length === 2;
    verified.savedFigure = questions[1]?.images?.length === 1;
    verified.pdfChat = paper.id;
    verified.requests = requests;
    if (!verified.singleConversation || !verified.savedFigure || replies.length !== 2) throw new Error('Expected two saved PDF questions, answers and one figure');
    if (requests.length !== 2 || requests.some(r=>r.pageId !== paper.id) || requests[1].images !== 1) throw new Error('Both requests must use PDF context, with the figure on the second');
  }
  const video=page.video();
  await context.close(); context=null;
  if(!process.argv.includes('--inspect')) fs.writeFileSync(path.join(scratch,'agentic-timeline.json'),JSON.stringify({video:await video.path(),marks,actions,framing,verified},null,2));
} catch(error) {
  if(page&&!page.isClosed()) await page.screenshot({path:path.join(scratch,'agentic-failure.png')}).catch(()=>{});
  throw error;
} finally {
  if(context) await context.close();
  await browser.close();
  await pdf.destroy();
}
