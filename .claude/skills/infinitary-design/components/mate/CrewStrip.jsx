import React from "react";
import {Crewmate} from "./Crewmate.jsx";
// Quiet crew overview: no chrome at rest; hover reveals the pill (it's interactive — a detail sheet pops above later).
// Zero counts are omitted entirely; each nonzero label is prefixed by ONE representative crewmate.
// Queued (tasks waiting on a gate) and waiting (decisions deferred by the user) are text-only segments —
// waiting things have no living crewmate to draw; "waiting on you" reads in --fg-1 because it is the user's.
export function CrewStrip({working=0,idle=0,queued=0,waiting=0,style}){
  const [hover,setHover]=React.useState(false);
  const seg={display:"inline-flex",alignItems:"center",gap:8};
  const label={fontFamily:"var(--font-mono)",fontSize:"var(--text-sm)",color:"var(--fg-2)",whiteSpace:"nowrap"};
  if(!working&&!idle&&!queued&&!waiting)return null;
  return <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
    style={{display:"inline-flex",alignItems:"center",gap:12,padding:"6px 14px",borderRadius:"var(--radius-pill)",border:"1px solid "+(hover?"var(--line-1)":"transparent"),background:hover?"var(--bg-1)":"transparent",cursor:"pointer",transition:"background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out)",...style}}>
    {working>0&&<span style={seg}><Crewmate status="working" size={22}/><span style={label}>{working} working</span></span>}
    {working>0&&idle>0&&<span style={{color:"var(--fg-3)"}}>·</span>}
    {idle>0&&<span style={seg}><Crewmate status="idle" size={22}/><span style={label}>{idle} idle</span></span>}
    {(working>0||idle>0)&&queued>0&&<span style={{color:"var(--fg-3)"}}>·</span>}
    {queued>0&&<span style={seg}><span style={label}>{queued} queued</span></span>}
    {(working>0||idle>0||queued>0)&&waiting>0&&<span style={{color:"var(--fg-3)"}}>·</span>}
    {waiting>0&&<span style={seg}><span style={{...label,color:"var(--fg-1)"}}>{waiting} waiting on you</span></span>}
  </div>;
}
