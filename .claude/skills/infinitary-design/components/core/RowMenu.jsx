import React,{useEffect,useRef,useState} from "react";
import {IconButton} from "./IconButton.jsx";
// The kebab (⋯) at the end of a list row, holding the row's actions so the
// glance path carries data only. Anchored bottom-right, closes on Escape,
// outside click, or a pick. Items: {id,label,onSelect,tone?:"danger",
// trailing?:node} or {separator:true}. Never more than one danger item, and
// it goes last, behind a separator.
const kebab=<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>;
export function RowMenu({label,items,size=28,style}){
  const [open,setOpen]=useState(false);
  const wrap=useRef(null);
  useEffect(()=>{
    if(!open)return;
    const onDown=(e)=>{if(wrap.current&&!wrap.current.contains(e.target))setOpen(false)};
    const onKey=(e)=>{if(e.key==="Escape")setOpen(false)};
    document.addEventListener("pointerdown",onDown);document.addEventListener("keydown",onKey);
    return ()=>{document.removeEventListener("pointerdown",onDown);document.removeEventListener("keydown",onKey)};
  },[open]);
  return <span ref={wrap} style={{position:"relative",flexShrink:0,display:"inline-flex",...style}}>
    <IconButton label={label} size={size} aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen((v)=>!v)}>{kebab}</IconButton>
    {open&&<div role="menu" style={{position:"absolute",right:0,top:size+4,zIndex:4,minWidth:180,background:"var(--bg-2)",border:"1px solid var(--line-2)",borderRadius:"var(--radius-m)",boxShadow:"var(--shadow-2)",padding:6,display:"flex",flexDirection:"column",gap:2}}>
      {items.map((item,i)=>item.separator
        ?<div key={"sep"+i} role="separator" style={{height:1,background:"var(--line-1)",margin:"4px 2px"}}></div>
        :<button key={item.id} type="button" role="menuitem" onClick={()=>{setOpen(false);item.onSelect&&item.onSelect()}} style={{background:"transparent",border:0,textAlign:"left",padding:"7px 10px",borderRadius:"var(--radius-s)",fontFamily:"var(--font-ui)",fontSize:"var(--text-sm)",color:item.tone==="danger"?"var(--danger)":"var(--fg-1)",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,whiteSpace:"nowrap"}}
            onMouseEnter={(e)=>{e.currentTarget.style.background="var(--bg-3)"}} onMouseLeave={(e)=>{e.currentTarget.style.background="transparent"}}>
            <span>{item.label}</span>{item.trailing}
          </button>)}
    </div>}
  </span>;
}
