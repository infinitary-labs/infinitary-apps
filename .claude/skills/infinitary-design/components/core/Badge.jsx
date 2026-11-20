import React from "react";
const badgeTones={neutral:{color:"var(--fg-2)",background:"var(--bg-3)",border:"transparent"},accent:{color:"var(--accent)",background:"var(--accent-dim)",border:"transparent"},ok:{color:"var(--ok)",background:"var(--ok-dim)",border:"transparent"},warn:{color:"var(--warn)",background:"var(--warn-dim)",border:"transparent"},danger:{color:"var(--danger)",background:"var(--danger-dim)",border:"transparent"},outline:{color:"var(--fg-2)",background:"transparent",border:"var(--line-1)"}};
export function Badge({tone="neutral",mono,dot,children,style}){
  const t=badgeTones[tone];
  return <span style={{display:"inline-flex",alignItems:"center",gap:6,fontFamily:mono?"var(--font-mono)":"var(--font-ui)",fontSize:"var(--text-xs)",fontWeight:500,letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:t.color,background:t.background,border:"1px solid "+t.border,borderRadius:"var(--radius-s)",padding:"3px 8px",lineHeight:1.4,...style}}>
    {dot&&<span style={{width:5,height:5,borderRadius:"50%",background:"currentColor"}}></span>}{children}
  </span>;
}
