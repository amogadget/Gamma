import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeReturnRequest, applyNativeViewport, prepareNativeDisconnect } from '../src/native/nativeBridge.js';
const payload = {server:'https://gamma.test',user:'u',workspace:'w',pageID:'p',docID:'d',viewport:{pageIndex:2,anchorX:0.2,anchorY:0.375}};
test('return position validates origin, identity and displayed page geometry',()=>{
  assert.deepEqual(nativeReturnRequest(payload,'https://gamma.test'),payload);
  assert.equal(nativeReturnRequest(payload,'https://other.test'),null);
  assert.equal(nativeReturnRequest({...payload,user:''},payload.server),null);
  assert.equal(nativeReturnRequest({...payload,viewport:{...payload.viewport,anchorY:true}},payload.server),null);
});
test('page-local restore offsets both axes once using actual boxes',()=>{
  let calls=[];
  const scroller={clientWidth:400,clientHeight:500,scrollTop:1200,scrollLeft:50,clientTop:2,clientLeft:1,
    getBoundingClientRect:()=>({top:20,left:10}),
    querySelector:s=>{assert.equal(s,'.pdfPageWrap[data-page="3"]');return {getBoundingClientRect:()=>({top:300,left:-50,width:800,height:1000})};},
    scrollTo:p=>calls.push(p)};
  assert.equal(applyNativeViewport(scroller,payload.viewport),true);
  assert.deepEqual(calls,[{top:1853,left:149,behavior:'instant'}]);
});
test('disconnect works without PDF or signed in account and flushes inserts before ink',async()=>{
  const calls=[];
  const result=await prepareNativeDisconnect({settle:async()=>calls.push('settle'),flush:async()=>calls.push('ops'),flushInk:async()=>calls.push('ink'),hasPending:()=>false,dirtyInk:()=>[],recovery:()=>({})});
  assert.equal(result.ok,true);assert.deepEqual(calls,['settle','ops','ink','ops']);
});
test('hung network returns explicit failure and recovery within its deadline', async()=>{
  const result=await prepareNativeDisconnect({settle:async()=>{},flush:()=>new Promise(()=>{}),flushInk:async()=>{},hasPending:()=>true,dirtyInk:()=>[],recovery:()=>({complete:true,pages:['old-page']}),timeoutMs:5});
  assert.equal(result.ok,false);assert.equal(result.reason,'flush-timeout');assert.equal(result.recovery.complete,true);
});
test('failed flush preserves scoped raw drafts; dirty ink is never success',async()=>{
  const recovery={server:payload.server,workspace:'w',user:'u',inkDrafts:[{id:'i',ink:{strokes:[{points:[1,2]}]}}]};
  const deps={settle:async()=>{},flush:async()=>{},flushInk:async()=>{},hasPending:()=>false,dirtyInk:()=>recovery.inkDrafts,recovery:()=>recovery};
  assert.deepEqual(await prepareNativeDisconnect(deps),{ok:false,reason:'unsaved-edits',recovery});
  const failed=await prepareNativeDisconnect({...deps,flush:async()=>{throw Error('offline');}});
  assert.equal(failed.ok,false);assert.deepEqual(JSON.parse(JSON.stringify(failed.recovery)),recovery);
});
