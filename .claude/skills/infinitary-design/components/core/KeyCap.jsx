import React from "react";
export function KeyCap({children}){
  const kbd={fontSize:"var(--text-sm)",padding:"2px 7px",minWidth:18};
  return <kbd style={{display:"inline-flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-mono)",fontWeight:500,color:"var(--fg-2)",background:"var(--bg-3)",border:"1px solid var(--line-1)",borderBottomWidth:2,borderRadius:"var(--radius-s)",lineHeight:1.5,...kbd}}>{children}</kbd>;
}
