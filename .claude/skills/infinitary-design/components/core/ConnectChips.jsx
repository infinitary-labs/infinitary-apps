import React from "react";
const plus=<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M5 12h14M12 5v14"/></svg>;
const label={fontSize:"var(--text-xs)",fontWeight:500,letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:"var(--fg-3)",marginRight:2};
export function ConnectChips({providers,accounts=[],busyProviderId=null,variant="foot",onConnect,style}){
  const stage=variant==="stage";
  const connected=new Map();for(const a of accounts){if(!connected.has(a.providerId))connected.set(a.providerId,a);}
  const chip=(p)=>{
    const account=connected.get(p.id);
    if(stage&&account){
      // Cannot answer yet: the hollow ring and why ("install Claude Code first", "not signed in").
      const note=p.unavailable?p.unavailable.note:(account.connected===false?"not signed in":null);
      return <span key={p.id} title={note?(p.unavailable?p.unavailable.detail:`${p.name} is not signed in on this computer yet.`):`${p.name} is connected`} style={{display:"inline-flex",alignItems:"center",gap:8,fontSize:"var(--text-sm)",color:"var(--fg-2)",padding:"4px 2px"}}>
        <span style={note?{width:7,height:7,borderRadius:"var(--radius-pill)",boxSizing:"border-box",background:"transparent",border:"1px solid var(--fg-2)"}:{width:7,height:7,borderRadius:"var(--radius-pill)",background:"var(--ok)",boxShadow:"0 0 8px var(--accent-glow)"}}/>
        <b style={{color:"var(--fg-1)",fontWeight:500}}>{p.name}</b><span>{account.label}</span>
        {note&&<span style={{fontFamily:"var(--font-mono)",color:"var(--fg-3)"}}>{note}</span>}
      </span>;
    }
    const busy=busyProviderId===p.id;
    const taken=p.id==="anthropic-claude"&&!!account;
    return <button key={p.id} type="button" disabled={busy||p.authTypes.length===0||taken} onClick={()=>onConnect&&onConnect(p)}
      title={taken?"Claude uses the login on this computer":account?`Add another ${p.name} account`:`Connect ${p.name}`}
      style={{display:"inline-flex",alignItems:"center",gap:5,background:stage?"var(--bg-1)":"transparent",border:"1px solid var(--line-1)",borderRadius:"var(--radius-pill)",padding:stage?"4px 12px 4px 9px":"3px 10px",fontFamily:"var(--font-ui)",fontSize:stage?"var(--text-sm)":"var(--text-xs)",color:p.servesFirstmate?(stage?"var(--fg-1)":"var(--fg-2)"):"var(--fg-3)",cursor:"pointer",whiteSpace:"nowrap",opacity:(busy||taken)?0.5:1}}>
      {plus}<span>{busy?"Connecting...":p.name}</span>
      {p.tier!=="subscription"&&<span style={{fontFamily:"var(--font-mono)",color:"var(--fg-3)"}}>API key</span>}
    </button>;
  };
  const first=providers.filter((p)=>p.servesFirstmate),crew=providers.filter((p)=>!p.servesFirstmate);
  return <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",justifyContent:stage?"center":"flex-start",gap:stage?8:6,minWidth:0,...style}}>
    {first.map(chip)}
    {crew.length>0&&<>{first.length>0&&<span style={{width:1,height:16,background:"var(--line-1)",margin:"0 4px"}}/>}<span style={label}>crew only</span>{crew.map(chip)}</>}
  </div>;
}
