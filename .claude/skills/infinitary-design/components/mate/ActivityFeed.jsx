import React from "react";
// Quiet crewmate event log: chromeless thread — a 1px rail ties events together.
// Rows fade with age; LAST line is the most recent. The right-side kind trail
// carries type and relative age, so rows need no redundant left-side dot.
// Home sizes the column to 33vh; extra rows scroll. No default row cap.
// Overflow: thin left-edge thumb on the rail (scroller is mirrored) + top dissolve.
const feedKind={info:"var(--fg-2)",ok:"var(--ok)",warn:"var(--warn)",danger:"var(--danger)",you:"var(--captain)"};
function fmtAge(d){const s=Math.max(0,Math.floor((Date.now()-new Date(d).getTime())/1000));if(s<60)return"now";const m=Math.floor(s/60);if(m<60)return m+"m";const h=Math.floor(m/60);return h<24?h+"h":Math.floor(h/24)+"d";}
export function ActivityFeed({events=[],max,style}){
  const shown=max==null?events:events.slice(-max); // oldest first, newest last
  if(!shown.length)return null;
  return <div data-activity-feed="" style={{position:"relative",display:"flex",flexDirection:"column",minHeight:0,overflow:"hidden",...style}}>
    <div data-activity-feed-scroller="" style={{display:"flex",flexDirection:"column",overflowY:"auto",overflowX:"hidden",minHeight:0,flex:1,transform:"scaleX(-1)"}}>
      <div style={{marginTop:"auto",display:"flex",flexDirection:"column",gap:7,paddingLeft:14,borderLeft:"1px solid var(--line-1)",marginLeft:2,transform:"scaleX(-1)"}}>
        {shown.map((e,i)=><div key={i} data-activity-kind={e.kind} style={{display:"grid",gridTemplateColumns:"minmax(0,1fr) 48px",columnGap:12,opacity:0.3+0.7*(shown.length===1?1:i/(shown.length-1)),transition:"opacity 0.3s"}}>
          <span style={{fontSize:"var(--text-sm)",color:"var(--fg-2)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.text}</span>
          <span style={{display:"flex",flexDirection:"column",alignItems:"flex-end",fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",lineHeight:"var(--leading-body)",textAlign:"right"}}>
            <span style={{color:feedKind[e.kind]||"var(--fg-3)",letterSpacing:"0.09em"}}>{String(e.kind).toUpperCase()}</span>
            <span style={{color:"var(--fg-3)"}}>{fmtAge(e.time)}</span>
          </span>
        </div>)}
      </div>
    </div>
  </div>;
}
