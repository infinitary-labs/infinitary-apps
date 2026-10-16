import React from "react";
export function Switch({checked,onChange,label,disabled}){
  return <label style={{display:"inline-flex",alignItems:"center",gap:10,cursor:disabled?"default":"pointer",opacity:disabled?0.4:1}}>
    <span onClick={()=>!disabled&&onChange&&onChange(!checked)} role="switch" aria-checked={checked}
      style={{width:36,height:20,borderRadius:"var(--radius-pill)",background:checked?"var(--accent)":"var(--bg-3)",border:"1px solid "+(checked?"transparent":"var(--line-1)"),position:"relative",transition:"background var(--dur-med) var(--ease-out)",flexShrink:0}}>
      <span style={{position:"absolute",top:2,left:checked?17:2,width:14,height:14,borderRadius:"50%",background:checked?"#05070d":"var(--fg-2)",transition:"left var(--dur-med) var(--ease-out),background var(--dur-med) var(--ease-out)"}}></span>
    </span>
    {label&&<span style={{fontSize:"var(--text-base)",color:"var(--fg-1)"}}>{label}</span>}
  </label>;
}
