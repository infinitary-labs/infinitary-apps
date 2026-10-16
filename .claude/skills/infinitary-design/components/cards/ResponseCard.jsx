import React from "react";
import {Badge} from "../core/Badge.jsx";
import {IconButton} from "../core/IconButton.jsx";
// The chip is DERIVED, never declared: a card with actions is a decision, one without a note,
// one the app itself raised (a provider needs sign in, Firstmate is down) an attention.
// `record` is a task's record (no card actions; its
// footer is the host's lifecycle toggles, TaskRecord.prompt.md).
const cardKinds={decision:{label:"Decision",tone:"accent"},note:{label:"Note",tone:"neutral"},attention:{label:"Attention",tone:"danger"},record:{label:"Task",tone:"neutral"}};
const closeIco=<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>;
export function ResponseCard({kind="note",title,meta,actions,onClose,children,width=560,minHeight=340,style}){
  const k=cardKinds[kind]||cardKinds.note;
  return <div style={{width,minHeight,boxSizing:"border-box",display:"flex",flexDirection:"column",background:"var(--acrylic-bg)",backdropFilter:"var(--acrylic-blur)",WebkitBackdropFilter:"var(--acrylic-blur)",border:"1px solid var(--acrylic-border)",borderRadius:"var(--radius-l)",boxShadow:"var(--acrylic-shadow)",overflow:"hidden",...style}}>
    {/* A long meta line (crewmate ref carrying a repo name) truncates with an
        ellipsis instead of wrapping the card header. */}
    <div style={{display:"flex",alignItems:"center",gap:10,padding:"14px 12px 0 20px"}}>
      <Badge tone={k.tone} dot style={{flexShrink:0}}>{k.label}</Badge>
      {meta&&<span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",minWidth:0,flex:1}}>{meta}</span>}
      <IconButton label="Close" onClick={onClose} style={{marginLeft:"auto",flexShrink:0}}>{closeIco}</IconButton>
    </div>
    {title&&<div style={{padding:"10px 20px 0",fontSize:"var(--text-lg)",fontWeight:500,letterSpacing:"var(--tracking-display)",color:"var(--fg-1)",lineHeight:"var(--leading-tight)"}}>{title}</div>}
    <div style={{flex:1,padding:"12px 20px 18px",fontSize:"var(--text-base)",color:"var(--fg-2)",lineHeight:"var(--leading-body)"}}>{children}</div>
    {actions&&<div style={{display:"flex",flexWrap:"wrap",justifyContent:"flex-end",gap:"var(--space-2)",rowGap:"var(--space-2)",padding:"var(--space-3) 16px 16px"}}>{actions}</div>}
  </div>;
}
