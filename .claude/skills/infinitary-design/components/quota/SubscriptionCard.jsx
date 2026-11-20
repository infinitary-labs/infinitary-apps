import React from "react";
import {QuotaMeter} from "./QuotaMeter.jsx";
import {SlotBadge} from "./SlotBadge.jsx";
import {Badge} from "../core/Badge.jsx";
export function SubscriptionCard({provider,plan,account,status="fresh",windows=[],models=[],onToggleModel,width=340,style}){
  const stateTone=status==="fresh"?"ok":status==="stale"?"warn":"danger";
  const stateLabel=status==="fresh"?"live":status==="stale"?"stale":status.replace("_"," ");
  return <div style={{width,boxSizing:"border-box",background:"var(--surface-card)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-l)",boxShadow:"var(--shadow-2)",padding:"18px 20px",display:"flex",flexDirection:"column",gap:14,...style}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
      <div style={{display:"flex",flexDirection:"column",gap:2,minWidth:0}}>
        <span style={{fontSize:"var(--text-md)",fontWeight:600,color:"var(--fg-1)"}}>{provider}</span>
        <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{plan}{account?" · "+account:""}</span>
      </div>
      <Badge tone={stateTone} dot mono>{stateLabel}</Badge>
    </div>
    {windows.length>0&&<div style={{display:"flex",flexDirection:"column",gap:10}}>
      {windows.map((w,i)=><QuotaMeter key={i} {...w}/>)}
    </div>}
    {models.length>0&&<div style={{display:"flex",flexDirection:"column",gap:6,borderTop:"1px solid var(--line-1)",paddingTop:12}}>
      {models.map((m,i)=><div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10}}>
        {onToggleModel
          ?<button type="button" onClick={()=>onToggleModel(m.label)} title={m.override?"Unpin model":"Pin model"} style={{background:"transparent",border:"none",padding:0,cursor:"pointer",fontFamily:"var(--font-mono)",fontSize:"var(--text-sm)",color:m.override?"var(--accent)":"var(--fg-2)"}}>{m.label}{m.override?" ✱":""}</button>
          :<span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-sm)",color:m.override?"var(--accent)":"var(--fg-2)"}}>{m.label}{m.override?" ✱":""}</span>}
        <SlotBadge slot={m.slot}/>
      </div>)}
    </div>}
  </div>;
}
