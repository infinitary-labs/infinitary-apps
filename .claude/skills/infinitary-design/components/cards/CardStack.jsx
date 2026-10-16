import React from "react";
import {IconButton} from "../core/IconButton.jsx";
import {Badge} from "../core/Badge.jsx";
const csIcoS={fill:"none",stroke:"currentColor",strokeWidth:1.5,strokeLinecap:"round",strokeLinejoin:"round"};
// Unread: an accent dot on the arrow that leads to an unseen card, and one "N new" badge beside the pager (outside its centred group, so the arrows never move under the pointer).
const csDot={position:"absolute",top:6,right:6,width:6,height:6,borderRadius:"var(--radius-pill)",background:"var(--accent)",boxShadow:"0 0 0 2px var(--bg-0)",pointerEvents:"none"};
export function CardStack({index=0,count=1,unreadBefore=0,unreadAfter=0,onPrev,onNext,width=560,children,peekStyle,style}){
  const unread=unreadBefore+unreadAfter;
  return <div style={{position:"relative",width,...style}}>
    {count>2&&<div style={{position:"absolute",left:14,right:14,top:-14,height:14,background:"var(--acrylic-bg)",backdropFilter:"var(--acrylic-blur)",WebkitBackdropFilter:"var(--acrylic-blur)",border:"1px solid var(--acrylic-border)",borderBottom:"none",borderRadius:"var(--radius-l) var(--radius-l) 0 0",...peekStyle,opacity:0.35}}></div>}
    {count>1&&<div style={{position:"absolute",left:7,right:7,top:-7,height:14,background:"var(--acrylic-bg)",backdropFilter:"var(--acrylic-blur)",WebkitBackdropFilter:"var(--acrylic-blur)",border:"1px solid var(--acrylic-border)",borderBottom:"none",borderRadius:"var(--radius-l) var(--radius-l) 0 0",...peekStyle,opacity:0.65}}></div>}
    <div style={{position:"relative"}}>{children}</div>
    {count>1&&<div style={{display:"flex",justifyContent:"center",marginTop:10}}>
      <div style={{position:"relative",display:"flex",alignItems:"center",gap:6}}>
        <span style={{position:"relative",display:"inline-flex"}}><IconButton label="Previous card" size={28} onClick={onPrev} disabled={index<=0}><svg width="14" height="14" viewBox="0 0 24 24" {...csIcoS}><path d="m15 18-6-6 6-6"/></svg></IconButton>{unreadBefore>0&&<span style={csDot}/>}</span>
        <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>{index+1} / {count}</span>
        <span style={{position:"relative",display:"inline-flex"}}><IconButton label="Next card" size={28} onClick={onNext} disabled={index>=count-1}><svg width="14" height="14" viewBox="0 0 24 24" {...csIcoS}><path d="m9 18 6-6-6-6"/></svg></IconButton>{unreadAfter>0&&<span style={csDot}/>}</span>
        {unread>0&&<span role="status" style={{position:"absolute",left:"100%",marginLeft:"var(--space-2)",whiteSpace:"nowrap"}}><Badge tone="accent" mono>{unread} new</Badge></span>}
      </div>
    </div>}
  </div>;
}
