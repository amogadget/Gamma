import test from "node:test";
import assert from "node:assert/strict";
import { inkJumpPosition } from "./inkNavigation.js";
const block={properties:{type:"pdf_ink",pdf_page:4,preview_asset:`/api/assets/${"a".repeat(64)}.png`,
 bounds:{x:10,y:20,width:30,height:40},crop_box:{width:100,height:200},coordinate_space:"pdf-crop-top-left-v1"}};
test("ink navigation uses the exact displayed rectangle, including rotation/crop",()=>{
 const view={viewBox:[40,60,140,260],width:200,height:100,convertToViewportPoint:(x,y)=>[y-60,x-40]};
 const position=inkJumpPosition(block,view);
 assert.deepEqual(position,{pageNumber:4,boundingRect:{x1:140,y1:10,x2:180,y2:40,width:200,height:100,pageNumber:4}});
});
test("ink navigation falls back to page when exact geometry is unavailable",()=>{
 assert.deepEqual(inkJumpPosition(block,null),{pageNumber:4});
 assert.equal(inkJumpPosition({properties:{pdf_page:-1}},null),null);
});
