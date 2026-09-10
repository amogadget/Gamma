// Real Chromium/pdf.js/player test using actual PencilKit PNG + AAC fixtures
// exported by GammaWebInkExportTests/testExportRealBrowserFixtures on the Mac.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
const directory=process.env.GAMMA_REPLAY_FIXTURE_DIR || "/tmp/gamma-browser-replay-fixtures";
const manifest=JSON.parse(await fs.readFile(path.join(directory,"manifest.json"),"utf8"));
async function fixture(prefix) {
  const item=manifest.flatMap(t=>t.attachments).find(a=>a.suggestedHumanReadableName.startsWith(prefix));
  return fs.readFile(path.join(directory,item.exportedFileName));
}
const first=JSON.parse(await fixture("web-replay-page1")), fourth=JSON.parse(await fixture("web-replay-page4"));
const audio=await fixture("web-replay-audio");
const pdf=await fs.readFile(new URL("./fixtures/ink-coordinates.pdf",import.meta.url));
const browser=await chromium.launch({headless:true,...(process.env.GAMMA_CHROME_PATH ? {executablePath:process.env.GAMMA_CHROME_PATH} : {})});
let page;
try {
  page=await browser.newPage({viewport:{width:1280,height:900}});
  page.on('pageerror',error=>console.error('PAGE ERROR',error.message));
  await page.route("**/api/**", async route=> {
    const url=route.request().url();
    if (url.endsWith(".m4a")) await route.fulfill({contentType:"audio/mp4",body:audio});
    else if (url.endsWith(".inkjson")) await route.fulfill({contentType:"application/json",body:JSON.stringify(url.includes("b".repeat(64)) ? fourth : first)});
    else await route.fulfill({contentType:"application/json",body:JSON.stringify({user:null,children:[]})});
  });
  await page.route("**/fixture.pdf", route=>route.fulfill({contentType:"application/pdf",body:pdf}));
  await page.goto(process.env.GAMMA_TEST_URL || "http://127.0.0.1:5193");
  await page.evaluate(async ({first,fourth})=>{
    const {default:React}=await import("/node_modules/.vite/deps/react.js");
    const {default:ReactDOM}=await import("/node_modules/.vite/deps/react-dom_client.js");
    const {default:PdfViewer}=await import("/src/pdfViewer.jsx");
    const {default:Player,useReplayAssets}=await import("/src/NoteReplayPlayer.jsx");
    document.getElementById("root").style.display="none";
    const host=document.createElement("div"); host.style.cssText="position:fixed;inset:0;display:flex;flex-direction:column"; document.body.appendChild(host);
    const ink=(id,page,data,hash)=>({id,properties:{type:"pdf_ink",pdf_page:page,ink_asset:`/api/assets/${data.source_sha256}.pkdrawing`,
      preview_asset:`/api/assets/${"c".repeat(64)}.png`,replay_asset:`/api/assets/${hash.repeat(64)}.inkjson`,
      bounds:{x:0,y:0,width:data.width,height:data.height},crop_box:{width:data.width,height:data.height},coordinate_space:"pdf-crop-top-left-v1"}});
    const blocks=[ink("ink1",1,first,"a"),ink("ink4",4,fourth,"b")];
    const recording={id:"recording",properties:{type:"audio",segments:[
      {id:"seg1",duration:.25,asset:`/api/assets/${"d".repeat(64)}.m4a`},
      {id:"seg2",duration:.25,asset:`/api/assets/${"e".repeat(64)}.m4a`}],replay_events:[
      {kind:"page",segment_id:"seg1",start:0,end:0,pdf_page:1},
      {kind:"page",segment_id:"seg2",start:0,end:0,pdf_page:4},
      ...blocks.flatMap((block,i)=>[first,fourth][i].strokes.map((stroke,n)=>({kind:"stroke",block_id:block.id,stroke_id:stroke.id,
        segment_id:i===0?"seg1":"seg2",start:n===0?.02:.12,end:n===0?.10:.22,pdf_page:i===0?1:4})))
    ]}};
    function Harness() {
      const [frame,setFrame]=React.useState(null),[seek,setSeek]=React.useState(null);
      const assets=useReplayAssets(blocks,recording.id);
      return React.createElement(React.Fragment,null,
        React.createElement(Player,{block:recording,inkBlocks:blocks,assets,onFrame:setFrame,onClose:()=>{},seekRequest:seek}),
        React.createElement('div',{style:{flex:1,minHeight:0,display:'flex'}},React.createElement(PdfViewer,{url:"/fixture.pdf",highlights:[],inkBlocks:blocks,
          pdfScaleValue:1,replay:frame?{...frame,assets}:null,onReplaySeek:time=>{ window.__lastInkSeek=time; setSeek({recordingID:recording.id,time,nonce:performance.now()}); }})));
    }
    ReactDOM.createRoot(host).render(React.createElement(Harness));
  },{first,fourth});
  await page.getByRole("button",{name:"Play replay",exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('[aria-label="Play replay"]').disabled);
  const slider=page.getByRole('slider',{name:'Replay timeline'});
  async function seek(value) {
    await slider.evaluate((el,value)=>{
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(el,String(value)); el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
    },value);
  }
  await seek(.16);
  await page.waitForFunction(()=>document.querySelector('[data-replay-ink-id="ink1"] [data-replay-progress="0.400"]'));
  assert.equal(await page.locator('[data-replay-ink-id="ink1"] image').count(),2);
  await page.screenshot({path:'/tmp/gamma-web-note-replay-page1.png'});
  await seek(.30);
  await page.waitForFunction(()=>document.querySelector('[data-replay-ink-id="ink4"] [data-replay-progress="0.375"]'));
  const position=await page.locator('.pdfPageWrap[data-page="4"]').evaluate(el=>el.getBoundingClientRect().top);
  assert.ok(position>=-30 && position<200,`page4 top=${position}`);
  await page.screenshot({path:'/tmp/gamma-web-note-replay-page4.png'});
  await seek(0);
  await page.getByRole("button",{name:"Play replay",exact:true}).click();
  await page.waitForFunction(()=>Number(document.querySelector('[aria-label="Replay timeline"]').value)>.3);
  await page.getByRole("button",{name:"Pause replay",exact:true}).click().catch(()=>{});
  await seek(.5);
  await page.locator('[data-replay-ink-id="ink4"] image').first().click();
  assert.equal(await page.evaluate(()=>window.__lastInkSeek),0);
  await page.waitForFunction(()=>{ const audio=document.querySelector('.noteReplayBar audio'); return audio && !audio.paused && audio.currentTime>0; });
  assert.equal(await page.locator('.noteReplayMessage[role="alert"]').count(),0);
  console.log("PASS: actual PencilKit stroke previews + AAC playback, progressive masks, cross-page seek, ink-click seek and audio-clock advance");
} catch(error) {
  if(page) {
    console.error(await page.evaluate(()=>({text:document.body.innerText.slice(-2000),progress:[...document.querySelectorAll('[data-replay-progress]')].map(el=>el.getAttribute('data-replay-progress')),svg:document.querySelectorAll('.pdfReplayInk').length,pages:document.querySelectorAll('.pdfPageWrap').length,slider:document.querySelector('[aria-label="Replay timeline"]')?.value})));
    await page.screenshot({path:'/tmp/gamma-note-replay-failure.png'});
  }
  throw error;
} finally { await browser.close(); }
