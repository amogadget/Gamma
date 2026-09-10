// Full App entry: Notes audio block -> player -> actual AAC clock -> PDF ink.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
const dir=process.env.GAMMA_REPLAY_FIXTURE_DIR || "/tmp/gamma-browser-replay-fixtures";
const manifest=JSON.parse(await fs.readFile(path.join(dir,"manifest.json"),"utf8"));
async function fixture(prefix){const a=manifest.flatMap(x=>x.attachments).find(x=>x.suggestedHumanReadableName.startsWith(prefix));return fs.readFile(path.join(dir,a.exportedFileName));}
const data=JSON.parse(await fixture("web-replay-page1")), audio=await fixture("web-replay-audio");
const pdf=await fs.readFile(new URL("./fixtures/ink-coordinates.pdf",import.meta.url));
const ink={id:"ink-replay",parent_id:"paper-replay",position:"a0",content:"Timed ink",properties:{type:"pdf_ink",pdf_page:1,
  ink_asset:`/api/assets/${data.source_sha256}.pkdrawing`,preview_asset:`/api/assets/${"c".repeat(64)}.png`,replay_asset:`/api/assets/${"a".repeat(64)}.inkjson`,
  bounds:{x:18,y:37,width:164,height:6},crop_box:{width:612,height:792},coordinate_space:"pdf-crop-top-left-v1"}};
const fallback=process.env.GAMMA_STATIC_FALLBACK === "1";
if(fallback) delete ink.properties.replay_asset;
const recording={id:"recording-replay",parent_id:"paper-replay",position:"a1",content:"Recorded explanation",properties:{type:"audio",duration:.25,
  segments:[{id:"segment",duration:.25,asset:`/api/assets/${"d".repeat(64)}.m4a`}],replay_events:[{kind:"page",segment_id:"segment",start:0,end:0,pdf_page:1},
  ...data.strokes.map((s,i)=>({kind:"stroke",segment_id:"segment",start:i===0?.02:.12,end:i===0?.10:.22,pdf_page:1,block_id:ink.id,stroke_id:s.id}))]}};
const paper={id:"paper-replay",parent_id:"root",position:"a0",content:"Replay integration paper",properties:{doc_id:"fixture",source_url:"/api/uploads/fixture.pdf"},children:[ink,recording]};
const browser=await chromium.launch({headless:true,...(process.env.GAMMA_CHROME_PATH?{executablePath:process.env.GAMMA_CHROME_PATH}:{})});
let page;
try{
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on("pageerror",error=>console.error(error.message));
  await page.route("**/api/**",async route=>{
    const url=new URL(route.request().url()), p=url.pathname;
    if(p.endsWith(".pdf")) return route.fulfill({contentType:"application/pdf",body:pdf});
    if(p.endsWith(".m4a")) return route.fulfill({contentType:"audio/mp4",body:audio});
    if(p.endsWith(".inkjson")) return route.fulfill({contentType:"application/json",body:JSON.stringify(data)});
    if(p.endsWith(".png")) return route.fulfill({contentType:"image/png",body:Buffer.from(data.strokes[0].png,"base64")});
    let body={};
    if(p==="/api/session") body={user:"replay-owner",is_admin:false};
    else if(p==="/api/blocks/root/children") body={children:[paper]};
    else if(p.endsWith("/subtree")) body={block:paper};
    else if(p==="/api/prefs") body={prefs:{}};
    else if(p.includes("recent")) body={items:[]};
    return route.fulfill({contentType:"application/json",body:JSON.stringify(body)});
  });
  await page.goto((process.env.GAMMA_TEST_URL || "http://127.0.0.1:5193")+"/?block=paper-replay");
  if(fallback) {
    await page.locator('img[data-ink-block-id="ink-replay"]').waitFor();
    assert.equal(await page.locator('.pdfStaticInk, [data-static-note-ink]').count(),0);
    await page.getByRole('button',{name:'Open Note Replay'}).click();
    await page.getByRole('checkbox',{name:'Play audio with static fallback notes'}).waitFor();
    assert.ok(await page.getByRole('button',{name:'Play replay',exact:true}).isDisabled());
    await page.getByRole('checkbox',{name:'Play audio with static fallback notes'}).check();
    await page.getByRole('button',{name:'Play replay',exact:true}).click();
    await page.waitForFunction(()=>Number(document.querySelector('[aria-label="Replay timeline"]').value)>.1);
    assert.equal(await page.locator('.pdfReplayInk').count(),0);
    console.log('PASS: old PNG static fallback remains available and is never presented as timed strokes');
  } else {
  await page.waitForFunction(()=>document.querySelectorAll('[data-static-ink-id="ink-replay"] image').length===2 && document.querySelectorAll('[data-static-note-ink] image').length===2);
  const staticImages=await page.locator('[data-static-ink-id="ink-replay"] image').evaluateAll(images=>images.map(image=>image.getAttribute('href')));
  await page.locator('.pdfZoomOverlay button[title="Zoom in"]').click();
  await page.locator('.pdfZoomOverlay button[title="Zoom in"]').click();
  await page.waitForFunction(()=>{const el=document.querySelector('.pdfViewer');return el.scrollWidth>el.clientWidth;});
  await page.locator('.pdfViewer').evaluate(el=>{el.scrollTop=el.scrollHeight;el.scrollLeft=el.scrollWidth;});
  await page.getByRole('button',{name:'Jump to handwriting',exact:true}).click();
  await page.locator('[data-ink-jump-target="ink-replay"]').waitFor();
  const jumpTop=await page.locator('[data-ink-jump-target="ink-replay"]').evaluate(el=>el.getBoundingClientRect().top);
  assert.ok(jumpTop>=0 && jumpTop<250,`handwriting jump top=${jumpTop}`);
  await page.waitForFunction(()=>document.querySelector('[data-ink-jump-target="ink-replay"]').getBoundingClientRect().left>=0);
  await page.locator('.pdfViewer').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.locator('[data-static-note-ink]').click();
  await page.waitForFunction(()=>{const el=document.querySelector('[data-ink-jump-target="ink-replay"]');return el && el.getBoundingClientRect().top>=0 && el.getBoundingClientRect().top<250;});
  await page.screenshot({path:'/tmp/gamma-handwriting-note-jump.png'});
  await page.getByRole("button",{name:"Open Note Replay"}).click({timeout:20000});
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Play replay"]').disabled);
  await page.getByRole("button",{name:"Play replay",exact:true}).click();
  await page.waitForFunction(()=>Number(document.querySelector('[aria-label="Replay timeline"]').value)>.1);
  await page.waitForFunction(()=>document.querySelector('[data-replay-ink-id="ink-replay"] image'));
  await page.screenshot({path:'/tmp/gamma-note-replay-app.png'});
  await page.getByRole("button",{name:"Done",exact:true}).click();
  assert.equal(await page.locator('.noteReplayBar').count(),0);
  assert.equal(await page.locator('.pdfReplayInk').count(),0);
  assert.deepEqual(await page.locator('[data-static-ink-id="ink-replay"] image').evaluateAll(images=>images.map(image=>image.getAttribute('href'))),staticImages);
  assert.deepEqual(await page.locator('[data-static-note-ink] image').evaluateAll(images=>images.map(image=>image.getAttribute('href'))),staticImages);
  await page.screenshot({path:'/tmp/gamma-static-hd-ink.png'});
  console.log('PASS: static PDF/Notes use identical high-resolution stroke images before/after AAC replay');
  }
}catch(error){if(page){console.error((await page.locator('body').innerText()).slice(-3000));await page.screenshot({path:'/tmp/gamma-note-replay-app-failure.png'});}throw error;}
finally{await browser.close();}
