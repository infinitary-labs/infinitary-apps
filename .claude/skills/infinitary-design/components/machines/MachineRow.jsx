import React from "react";
const DOT={ok:"var(--ok)",warn:"var(--warn)",idle:"var(--idle)"};
export function MachineRow({name,detail,summary,state,tone="ok",busy=false,action,style}){
  return <div style={{display:"flex",alignItems:"center",gap:14,padding:"14px 18px",...style}}>
    <span style={{width:7,height:7,borderRadius:"50%",flexShrink:0,background:DOT[tone]||DOT.idle,boxShadow:tone==="ok"?"0 0 8px var(--ok)":"none"}}></span>
    <div style={{display:"flex",flexDirection:"column",gap:1,minWidth:0,flex:1}}>
      <span style={{fontSize:"var(--text-base)",fontWeight:500,color:"var(--fg-1)"}}>{name}</span>
      {detail&&<span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>{detail}</span>}
      {summary&&<span style={{fontSize:"var(--text-sm)",color:"var(--fg-2)"}}>{summary}</span>}
    </div>
    {state&&<span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",whiteSpace:"nowrap",color:tone==="warn"?"var(--warn)":busy?"var(--accent)":"var(--fg-3)"}}>{state}</span>}
    {action}
  </div>;
}
