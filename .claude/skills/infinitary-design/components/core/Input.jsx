import React from "react";
export function Input({placeholder,value,onChange,mono,size="md",style,...rest}){
  const [focus,setFocus]=React.useState(false);
  const pad=size==="lg"?"14px 20px":"9px 14px";
  return <input placeholder={placeholder} value={value} onChange={onChange} onFocus={()=>setFocus(true)} onBlur={()=>setFocus(false)}
    style={{fontFamily:mono?"var(--font-mono)":"var(--font-ui)",fontSize:size==="lg"?"var(--text-md)":"var(--text-base)",color:"var(--fg-1)",background:"var(--surface-input)",border:"1px solid "+(focus?"var(--line-2)":"var(--line-1)"),borderRadius:"var(--radius-m)",padding:pad,outline:"none",boxShadow:focus?"var(--focus-ring)":"none",transition:"border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)",width:"100%",boxSizing:"border-box",...style}} {...rest}/>;
}
