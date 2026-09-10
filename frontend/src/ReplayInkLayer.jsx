import React, { useId } from "react";
import { pdfInkPlacement } from "./inkBlock.js";
import { revealPoints, strokeEvent, strokeProgress } from "./noteReplay.js";

export function StaticInkPreview({data}) {
  if (!data?.strokes?.length) return null;
  const bounds = data.strokes.map(s => s.bounds);
  const x = Math.min(...bounds.map(b => b.x)), y = Math.min(...bounds.map(b => b.y));
  const width = Math.max(...bounds.map(b => b.x+b.width))-x;
  const height = Math.max(...bounds.map(b => b.y+b.height))-y;
  return <svg data-static-note-ink="true" width={width} height={height} viewBox={`${x} ${y} ${width} ${height}`}
    role="img" aria-label="High-resolution handwriting preview" style={{display:"block",width:"100%",maxHeight:320,height:"auto"}}>
    {data.strokes.map((s,i)=><image key={`${s.id}-${i}`} href={`data:image/png;base64,${s.png}`}
      x={s.bounds.x} y={s.bounds.y} width={s.bounds.width} height={s.bounds.height} preserveAspectRatio="none" />)}
  </svg>;
}

export default function ReplayInkLayer({block, data, viewport, replay, onSeek}) {
  const prefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const placement = pdfInkPlacement({...block, properties: {...block.properties,
    bounds: {x:0,y:0,width:data.width,height:data.height}, crop_box:{width:data.width,height:data.height}}}, viewport);
  if (!placement) return null;
  return <svg className={replay ? "pdfReplayInk" : "pdfStaticInk"} data-replay-ink-id={replay ? block.id : undefined} data-static-ink-id={!replay ? block.id : undefined}
    width={data.width} height={data.height} viewBox={`0 0 ${data.width} ${data.height}`}
    style={{position:"absolute",left:0,top:0,overflow:"hidden",pointerEvents:"none",zIndex:3,
      transformOrigin:"0 0",transform:`matrix(${placement.matrix.join(",")})`}}>
    {data.strokes.map((stroke,index) => {
      const event = replay ? strokeEvent(replay.events,block.id,stroke.id) : null;
      const progress = replay ? strokeProgress(event,replay.time) : 1;
      if (progress <= 0) return null;
      const mask = `${prefix}-${index}`;
      const points = progress < 1 ? revealPoints(stroke.points,progress) : [];
      const b = stroke.bounds;
      return <g key={`${stroke.id}-${index}`} data-replay-stroke-id={stroke.id} data-replay-progress={progress.toFixed(3)}>
        {progress < 1 && <defs><mask id={mask} maskUnits="userSpaceOnUse" x={b.x} y={b.y} width={b.width} height={b.height}>
          {points.map((p,i) => <g key={i}>
            <circle cx={p.x} cy={p.y} r={p.radius} fill="white" />
            {i > 0 && <line x1={points[i-1].x} y1={points[i-1].y} x2={p.x} y2={p.y}
              stroke="white" strokeWidth={Math.max(points[i-1].radius,p.radius)*2} strokeLinecap="round" />}
          </g>)}
        </mask></defs>}
        <image href={`data:image/png;base64,${stroke.png}`} x={b.x} y={b.y} width={b.width} height={b.height}
          preserveAspectRatio="none" mask={progress < 1 ? `url(#${mask})` : undefined}
          style={{pointerEvents:event ? "visiblePainted" : "none",cursor:event ? "pointer" : undefined}}
          onClick={event ? e => { e.stopPropagation(); onSeek?.(Math.max(0,event.startTime-2)); } : undefined} />
      </g>;
    })}
  </svg>;
}
