import { pdfInkPlacement } from "./inkBlock.js";

// Use the same affine transform as the actual ink layer (including crop/rotation).
export function inkJumpPosition(block, viewport) {
  const pageNumber=block?.properties?.pdf_page;
  if (!Number.isSafeInteger(pageNumber) || pageNumber<1) return null;
  const ink=pdfInkPlacement(block,viewport);
  if (!ink) return {pageNumber};
  const [a,b,c,d,e,f]=ink.matrix;
  const corners=[[0,0],[ink.width,0],[0,ink.height],[ink.width,ink.height]].map(([x,y])=>[a*x+c*y+e,b*x+d*y+f]);
  return {pageNumber,boundingRect:{
    x1:Math.min(...corners.map(p=>p[0])),y1:Math.min(...corners.map(p=>p[1])),
    x2:Math.max(...corners.map(p=>p[0])),y2:Math.max(...corners.map(p=>p[1])),
    width:viewport.width,height:viewport.height,pageNumber,
  }};
}
