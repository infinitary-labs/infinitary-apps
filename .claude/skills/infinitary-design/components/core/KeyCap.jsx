import React from "react";
export function KeyCap({children,lit}){
  const kbd={fontSize:"var(--text-sm)",padding:"2px 7px",minWidth:18};
  return <kbd style={{display:"inline-flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-mono)",fontWeight:500,color:lit?"var(--fg-1)":"var(--fg-2)",background:lit?"var(--accent-dim)":"var(--bg-3)",border:lit?"1px solid var(--accent)":"1px solid var(--line-1)",borderBottomWidth:2,borderRadius:"var(--radius-s)",lineHeight:1.5,...kbd}}>{children}</kbd>;
}
