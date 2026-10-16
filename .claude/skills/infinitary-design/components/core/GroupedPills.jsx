import React from "react";
export function GroupedPills({name,htmlName,value,options,onChange,disabled}){
  return <div role="radiogroup" aria-label={name} style={{display:"inline-flex",flexWrap:"wrap",alignItems:"center",gap:"var(--space-1)",padding:3,background:"var(--bg-0)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-pill)",opacity:disabled?0.4:1,pointerEvents:disabled?"none":"auto"}}>
    {options.map((option)=>{
      const checked=option.value===value;
      return <label key={option.value} style={{boxSizing:"border-box",position:"relative",display:"inline-flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-ui)",fontSize:"var(--text-xs)",fontWeight:500,lineHeight:1,height:"var(--space-5)",padding:"0 var(--space-3)",color:checked?"var(--accent)":"var(--fg-3)",background:checked?"var(--accent-dim)":"transparent",border:"1px solid "+(checked?"var(--accent)":"var(--line-1)"),borderRadius:"var(--radius-pill)",cursor:disabled?"default":"pointer",whiteSpace:"nowrap"}}>
        <input type="radio" name={htmlName} value={option.value} checked={checked} disabled={disabled} onChange={()=>{if(!checked&&onChange)onChange(option.value);}} style={{position:"absolute",inset:0,opacity:0,margin:0,cursor:"inherit",appearance:"none"}}/>
        {option.label}
      </label>;
    })}
  </div>;
}
