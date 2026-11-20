import React from "react";
// The instrument form of QuotaMeter for a dense row of windows: label · 56px
// bar · percent on ONE line, so an account's every window sits side by side
// and the eye reads the low bar. Same tone rules as QuotaMeter: ≤10% forces
// danger; pace ahead = warn (burning faster than the reset clock), on_pace =
// accent, behind = ok (calm), unknown = idle. The percent tints below 50 (warn)
// and 20 (danger). A stale reading keeps its raw number but dims to tertiary
// and drops the tint - it is a last-known-good, never current headroom.
const paceColors={ahead:"var(--warn)",on_pace:"var(--accent)",behind:"var(--ok)",unknown:"var(--idle)"};
export function QuotaMicroMeter({label,percentRemaining,pace="unknown",resetText,clockPercent,stale=false,style}){
  const known=typeof percentRemaining==="number";
  const low=known&&percentRemaining<=10;
  const color=stale?"var(--idle)":low?"var(--danger)":paceColors[pace]||paceColors.unknown;
  const clock=typeof clockPercent==="number"?Math.max(0,Math.min(100,clockPercent)):undefined;
  const pctColor=stale||!known?"var(--fg-3)":percentRemaining<20?"var(--danger)":percentRemaining<50?"var(--warn)":"var(--fg-1)";
  return <span title={label+(resetText?" · "+resetText:"")} style={{display:"inline-grid",gridTemplateColumns:"auto 56px auto",alignItems:"center",gap:7,minWidth:0,...style}}>
    {/* The label never truncates: a window's name is the only thing that tells two bars apart. */}
    <span style={{fontSize:"var(--text-xs)",letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:"var(--fg-3)",whiteSpace:"nowrap"}}>{label}</span>
    <span style={{position:"relative",display:"block",height:3,borderRadius:2,background:"var(--bg-3)"}}>
      <span style={{position:"absolute",left:0,top:0,bottom:0,width:(known?Math.max(0,Math.min(100,percentRemaining)):0)+"%",borderRadius:2,background:color,opacity:stale?0.4:1,transition:"width var(--dur-slow) var(--ease-drift)"}}></span>
      {/* The linear-pace clock marker (┃), as on QuotaMeter. */}
      {clock!==undefined&&<span style={{position:"absolute",top:-2,bottom:-2,left:clock+"%",width:1,background:"var(--fg-3)"}}></span>}
    </span>
    {/* An unread window says "–", never 0. */}
    <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-sm)",color:pctColor,whiteSpace:"nowrap"}}>{known?Math.round(percentRemaining)+"%":"–"}</span>
  </span>;
}
