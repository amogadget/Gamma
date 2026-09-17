// One library conversation: @ paper context, search/read, then a PDF citation.
// Requires a disposable curated workspace with AI on its owning account.
import fs from 'node:fs';
import path from 'node:path';
import { chromium, ROOT, configureContext } from './runtime.mjs';
import { Account } from '../../frontend/tests/e2e/harness.mjs';

const scratch = path.resolve(process.env.MEDIA_SCRATCH || path.join(ROOT, 'artifacts/readme-media/revised'));
const state = JSON.parse(fs.readFileSync(path.join(scratch, 'workspace.json')));
if (state.removed) throw new Error('Recording workspace was removed');
const account = new Account({ base: state.base }, state.username, '');
account.session = fs.readFileSync(path.join(scratch, 'session.txt'), 'utf8').trim();
account.ws = state.workspace;
const { children: pages } = await account.api('/api/blocks/root/children');
const paper = pages.find(p => p.content?.includes('coherent transport'));
if (!paper) throw new Error('Curated atom-arrays paper missing');
await account.api('/api/chats/home', { method: 'DELETE' });
await account.api('/api/prefs/open-tabs', { method: 'PUT', body: { value: [] } });
const browser = await chromium.launch({ headless: true });
let context, page;
const marks = {}, actions = [], verified = {}, framing = {};
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
  async function answer(phase) {
    let previous = 0;
    for (let i=0;i<240;i++) {
      await hold(500);
      if (await page.locator('.chatBubble.ai.error').count()) throw new Error('AI request failed');
      const count = await page.locator('.chatToolAction').count();
      if (count !== previous) {
        actions.push({phase,at:(Date.now()-t0)/1000,count,text:await page.locator('.chatToolActionHead').allTextContents()});
        previous=count;
      }
      if (await page.locator('.chatBubbleRow.ai').count() && !await page.getByRole('button',{name:'Stop',exact:true}).count() && !await page.locator('.chatTyping').count()) {
        if ((await page.locator('.chatBubbleRow.ai').last().innerText()).length>60) break;
      }
      if(i===239) throw new Error('AI did not finish');
    }
    mark(`${phase}Answer`);
    await hold(2200);
  }
  await page.goto(`${state.base}/?ws=${account.ws}`);
  const notes = page.getByRole('button',{name:'Close Notes',exact:true});
  if(await notes.isVisible()) await click(notes);
  await page.locator('.chatInput').waitFor();
  const sash = page.locator('[role="separator"][data-panel-group-direction="horizontal"]');
  const sashBox = await sash.boundingBox();
  await page.mouse.move(sashBox.x+2,sashBox.y+200);
  await page.mouse.down();
  await page.mouse.move(790,sashBox.y+200,{steps:30});
  await page.mouse.up();
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
    // Finish the camera move before typing @; the picker is the first action.
    mark('mentionZoom');
    await hold(1100);
    mark('mentionTyping');
    await page.keyboard.type('Compare ', {delay:65});
    await page.keyboard.type('@quantum', {delay:110});
    await page.getByRole('listbox',{name:'Library pages'}).waitFor();
    mark('mention'); await hold(1700);
    await page.screenshot({path:path.join(scratch,'agentic-mention.png')});
    const option=page.getByRole('option').filter({hasText:'coherent transport'}).first();
    await click(option);
    await page.keyboard.type(' with one related quantum error correction paper in my library. Search and read it, then give two short bullets with p. 1 citations.',{delay:25});
    await page.locator('.chatReferenceChip').waitFor();
    await hold(1300); mark('attached');
    await page.keyboard.press('Enter'); mark('librarySent');
    await answer('library');
    const heads=page.locator('.chatToolActionHead');
    const labels=await heads.allTextContents();
    if(!labels.some(s=>/search/i.test(s)) || !labels.some(s=>/read/i.test(s))) throw new Error('Expected real search and read actions');
    verified.expandedSteps = await page.locator('.chatToolDetail').count();
    if (verified.expandedSteps) throw new Error('Keep individual tool steps collapsed');
    await page.locator('.chatBubbleRow.ai').last().scrollIntoViewIfNeeded();
    const citation = page.locator('.chatPageLink[title="Show this passage in the PDF"]')
      .filter({hasText:/^p\.\s*1$/}).first();
    await citation.waitFor();
    await citation.scrollIntoViewIfNeeded();
    framing.citation = await citation.boundingBox();
    verified.citationHref = await citation.getAttribute('href');
    await hold(2000); mark('citationStart');
    await page.screenshot({path:path.join(scratch,'agentic-answer.png')});
    // Do not expand individual thinking/tool steps. Follow the actual p. 1 link.
    mark('citationClick');
    await click(citation);
    await page.locator('[data-page="1"] .textLayer span').first().waitFor({timeout:60000});
    await page.locator('[data-page="1"] .pdfCitationMark').first().waitFor({timeout:20000});
    await hold(700); mark('citationReady');
    verified.citationMarks = await page.locator('[data-page="1"] .pdfCitationMark').count();
    verified.citationNotice = await page.locator('.pdfCitationNotice').allTextContents();
    if (verified.citationNotice.length) throw new Error('Citation must resolve to an exact passage');
    framing.passage = await page.locator('[data-page="1"] .pdfCitationMark').first().boundingBox();
    await page.screenshot({path:path.join(scratch,'agentic-citation.png')});
    await hold(5000); mark('end');
    // Verify the original home conversation even after the citation opens a PDF.
    const saved=await account.api('/api/chats/home');
    fs.writeFileSync(path.join(scratch,'agentic-saved.json'),JSON.stringify(saved,null,2));
    const savedTools = (saved.messages || []).flatMap(m => (m.actions || []).map(a => a.tool));
    if (!savedTools.includes('search_library') || !savedTools.includes('read_page')) throw new Error('Search/read actions were not persisted');
    verified.persistedTools = savedTools;
    verified.singleConversation = (saved.messages || []).filter(m => m.role === 'user').length === 1;
    if (!verified.singleConversation) throw new Error('Expected one library question');
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
}
