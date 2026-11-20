import React from "react";
// whiteSpace nowrap + flexShrink 0: a button label never wraps or gets crushed
// by a cramped flex row - the row's flexible content gives way instead.
const base={fontFamily:"var(--font-ui)",fontSize:"var(--text-base)",fontWeight:500,borderRadius:"var(--radius-m)",cursor:"pointer",display:"inline-flex",alignItems:"center",gap:8,border:"1px solid transparent",transition:"background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out),opacity var(--dur-fast) var(--ease-out)",lineHeight:1,whiteSpace:"nowrap",flexShrink:0};
const variants={
  primary:{background:"var(--accent)",color:"#05070d",borderColor:"transparent"},
  secondary:{background:"transparent",color:"var(--fg-1)",borderColor:"var(--line-2)"},
  ghost:{background:"transparent",color:"var(--fg-2)",borderColor:"transparent"},
  danger:{background:"transparent",color:"var(--danger)",borderColor:"var(--danger)"}
};
const sizes={sm:{padding:"6px 12px",fontSize:"var(--text-sm)"},md:{padding:"9px 16px"},lg:{padding:"12px 22px",fontSize:"var(--text-md)"}};
// `off`: cannot be pressed for the reason `note` gives - dimmed, still a Tab stop, a press does nothing.
export function Button({variant="primary",size="md",disabled,pending,pendingLabel="Working...",off,note,icon,children,style,onClick,...rest}){
  const [hover,setHover]=React.useState(false);
  const unavailable=disabled||pending;
  const hoverStyle=hover&&!unavailable&&!off?(variant==="primary"?{background:"var(--accent-strong)"}:variant==="danger"?{background:"var(--danger-dim)"}:{background:"var(--bg-3)",color:"var(--fg-1)"}):{};
  return <button disabled={unavailable} aria-busy={pending||undefined} aria-disabled={off||undefined} aria-description={note} onClick={off?undefined:onClick} onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)}
    style={{...base,...variants[variant],...sizes[size],...(unavailable||off?{opacity:0.4,cursor:"default"}:{}),...hoverStyle,...style,...(pending?{transition:"none"}:{})}} {...rest}>
    {icon}{pending===undefined?children:<span style={{display:"grid"}}>
      <span aria-hidden={pending||undefined} style={{gridArea:"1 / 1",visibility:pending?"hidden":"visible"}}>{children}</span>
      <span aria-hidden={!pending||undefined} style={{gridArea:"1 / 1",visibility:pending?"visible":"hidden"}}>{pendingLabel}</span>
    </span>}
  </button>;
}
