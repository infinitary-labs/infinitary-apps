import React from "react";
// Pace semantics follow quota-axi: "ahead" = usage ahead of the reset clock
// (burning faster than linear - the conserve signal, warn); "behind" = usage
// behind the clock (allowance building up, calm/ok).
const paceColors={ahead:"var(--warn)",on_pace:"var(--accent)",behind:"var(--ok)",unknown:"var(--idle)"};
const paceLabels={ahead:"ahead",on_pace:"on pace",behind:"behind",unknown:"—"};
export function QuotaMeter({label,percentRemaining,pace="unknown",resetText,clockPercent,style}){
  const known=typeof percentRemaining==="number";
  const low=known&&percentRemaining<=10;
  const color=low?"var(--danger)":paceColors[pace]||paceColors.unknown;
  const clock=typeof clockPercent==="number"?Math.max(0,Math.min(100,clockPercent)):undefined;
  return <div style={{display:"flex",flexDirection:"column",gap:6,...style}}>
    {/* The label holds its ground; a cramped host truncates the value's tail
        (the reset note) with an ellipsis instead of overlapping neighbors. */}
    <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:12}}>
      <span style={{fontSize:"var(--text-xs)",fontWeight:500,letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:"var(--fg-3)",flexShrink:0}}>{label}</span>
      <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-sm)",color:"var(--fg-2)",whiteSpace:"nowrap",minWidth:0,overflow:"hidden",textOverflow:"ellipsis"}}>
        {known?<span style={{color:"var(--fg-1)"}}>{Math.round(percentRemaining)}% left</span>:"no data"}
        {/* An unknown pace says nothing - no placeholder glyph. */}
        {known&&(low||pace!=="unknown")&&<span> · <span style={{color}}>{low?"low":paceLabels[pace]}</span></span>}
        {resetText&&<span style={{color:"var(--fg-3)"}}> · {resetText}</span>}
      </span>
    </div>
    {/* The clock marker (quota-axi's ┃): the fill position of exactly linear
        burn - the window's timeRemainingPercent. Fill ending left of the
        marker means burning faster than the reset clock. Omitted when the
        window's pace is unknown. */}
    <div style={{position:"relative",height:3,borderRadius:2,background:"var(--bg-3)"}}>
      <div style={{position:"absolute",inset:0,borderRadius:2,overflow:"hidden"}}>
        <div style={{height:"100%",width:(known?percentRemaining:0)+"%",background:color,borderRadius:2,transition:"width var(--dur-slow) var(--ease-drift)"}}></div>
      </div>
      {clock!==undefined&&<div style={{position:"absolute",top:-2,bottom:-2,left:clock+"%",width:1,background:"var(--fg-3)"}}></div>}
    </div>
  </div>;
}
