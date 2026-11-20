import React from "react";
const slotMeta={premium:{label:"Premium",color:"var(--slot-premium)",bars:4},high:{label:"Hard",color:"var(--slot-high)",bars:3},medium:{label:"Normal",color:"var(--slot-medium)",bars:2},low:{label:"Simple",color:"var(--slot-low)",bars:1}};
export function SlotBadge({slot="medium",style}){
  const b=slotMeta[slot]||slotMeta.medium;
  return <span style={{display:"inline-flex",alignItems:"center",gap:6,fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",fontWeight:500,letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:b.color,...style}}>
    <span style={{display:"inline-flex",gap:2,alignItems:"flex-end"}}>
      {[0,1,2,3].map(i=><span key={i} style={{width:3,height:4+i*2,borderRadius:1,background:i<b.bars?b.color:"var(--bg-3)"}}></span>)}
    </span>{b.label}
  </span>;
}
