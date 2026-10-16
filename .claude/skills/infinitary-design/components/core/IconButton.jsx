import React from "react";
export function IconButton({label,size=32,tone="neutral",disabled,children,style,...rest}){
  const [hover,setHover]=React.useState(false);
  const tones={neutral:{color:"var(--fg-2)"},accent:{color:"var(--accent)"},danger:{color:"var(--danger)"},ok:{color:"var(--ok)"}};
  return <button aria-label={label} title={label} disabled={disabled} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
    style={{width:size,height:size,display:"inline-flex",alignItems:"center",justifyContent:"center",borderRadius:"var(--radius-pill)",border:"1px solid transparent",background:hover&&!disabled?"var(--bg-3)":"transparent",cursor:disabled?"default":"pointer",opacity:disabled?0.4:1,transition:"background var(--dur-fast) var(--ease-out)",...tones[tone],...style}} {...rest}>
    {children}
  </button>;
}
