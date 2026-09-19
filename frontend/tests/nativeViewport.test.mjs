import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeViewport, nativePDFRequest, captureNativeViewport } from '../src/native/nativeBridge.js';
const identity = {pageID:'p', docID:'d', workspace:'w', user:'u'};
test('optional viewport stays additive and never relaxes identity', () => {
  const viewport = {pageIndex:9, anchorX:0.2, anchorY:0.63};
  assert.deepEqual(nativePDFRequest({...identity, viewport}).viewport, viewport);
  assert.equal('viewport' in nativePDFRequest(identity), false);
  assert.equal(nativePDFRequest({...identity, user:'', viewport}), null);
  for (const bad of [NaN, Infinity, -0.01, 1.01, '0.3', true]) {
    assert.equal(nativeViewport({...viewport, anchorY:bad}), null);
    assert.equal(nativePDFRequest({...identity, viewport:{...viewport, anchorX:bad}}), null);
  }
  for (const pageIndex of [-1, 0.1, 1000000, Infinity, '1', true]) assert.equal(nativeViewport({...viewport,pageIndex}),null);
});
test('actual visible page-local offset ignores whole-document scroll fraction and gaps', () => {
  const boxes = [
    {top:-1300,bottom:-500,left:20,width:600,height:800},
    {top:-500,bottom:300,left:-100,width:600,height:800},
    {top:300,bottom:1100,left:20,width:600,height:800},
  ];
  const scroller = {clientWidth:400,clientHeight:600, getBoundingClientRect:()=>({top:0,left:0}),
    querySelectorAll:()=>boxes.map((box,i)=>({dataset:{page:String(i+1)},getBoundingClientRect:()=>box}))};
  assert.deepEqual(captureNativeViewport(scroller),{pageIndex:1,anchorX:1/6,anchorY:0.625});
  boxes[1].top = -300; boxes[1].bottom = 500;
  assert.equal(captureNativeViewport(scroller).anchorY,0.375);
  boxes[0].bottom = 0; boxes[1].top = 12;
  assert.equal(captureNativeViewport(scroller).anchorY,0);
  assert.equal(captureNativeViewport(null),null);
});
