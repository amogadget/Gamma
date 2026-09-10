import test from "node:test";
import assert from "node:assert/strict";
import { replayTimeline, replayPageAt, strokeEvent, strokeProgress, revealPoints, validateReplayInk } from "./noteReplay.js";
const hash = "a".repeat(64);
const segment = id => ({id,asset:`/api/assets/${hash}.m4a`,duration:10});
const stroke = {kind:"stroke",segment_id:"two",start:2,end:4,pdf_page:2,block_id:"ink",stroke_id:"line.part"};
const timeline = replayTimeline({properties:{type:"audio",segments:[segment("one"),segment("two")],replay_events:[
  {kind:"page",segment_id:"one",start:0,end:0,pdf_page:1},
  {kind:"page",segment_id:"two",start:0,end:0,pdf_page:2},stroke]}});
test("audio segment time excludes pause gaps and restores the page", () => {
  assert.equal(timeline.duration,20);
  assert.equal(replayPageAt(timeline.events,9),1);
  assert.equal(replayPageAt(timeline.events,13),2);
  const event=strokeEvent(timeline.events,"ink","line.part");
  assert.equal(strokeProgress(event,11),0);
  assert.equal(strokeProgress(event,13),0.5);
  assert.equal(strokeProgress(event,15),1);
});
test("stroke fragments inherit lineage; unrelated/untimed ink stays static", () => {
  assert.equal(strokeEvent(timeline.events,"ink","line.fragment")?.startTime,12);
  assert.equal(strokeEvent(timeline.events,"other","line.part"),null);
  assert.equal(strokeProgress(null,0),1);
});
test("progressive reveal interpolates the current point without modifying source", () => {
  const points=[{x:0,y:10,t:0,radius:2},{x:100,y:10,t:1,radius:4}];
  assert.deepEqual(revealPoints(points,.25).at(-1),{x:25,y:10,t:.25,radius:2.5});
  assert.equal(points.length,2);
});
test("malformed and stale replay assets are rejected", () => {
  const base={format:"gamma-ink-replay-v1",source_sha256:hash,width:612,height:792,strokes:[]};
  assert.equal(validateReplayInk(base,`/api/assets/${hash}.pkdrawing`),base);
  assert.throws(()=>validateReplayInk({...base,format:"svg"},`/api/assets/${hash}.pkdrawing`));
  assert.throws(()=>validateReplayInk(base,`/api/assets/${"b".repeat(64)}.pkdrawing`));
  assert.throws(()=>validateReplayInk({...base,width:Infinity},`/api/assets/${hash}.pkdrawing`));
  assert.throws(()=>validateReplayInk({...base,strokes:[{id:"x",bounds:{x:0,y:0,width:2,height:2},png:"javascript:bad",points:[]}]},`/api/assets/${hash}.pkdrawing`));
});
