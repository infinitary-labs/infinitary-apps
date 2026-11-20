import React from "react";
// The body of a task's record card (ResponseCard kind="record"): a view of
// one task, opened by clicking a row of the now panel. Sections in this
// order, each under a micro label, absent when empty: goal · the captain's
// words verbatim · graph (parent, blocked by, blocks, filed) · timeline tail
// with "earlier · N more", where a report's line opens to its whole text ·
// delivery · crew. No inline
// editing; the host's footer is the action bar (Drop task at its left edge,
// Start, Continue or Show the card at its right - see TaskRecord.prompt.md), and
// judgment calls stay on cards.
// Every other write happens by talking to Firstmate while the card is open,
// which is what points the turn at this task.
function clock(at){const d=new Date(at);const p=(n)=>String(n).padStart(2,"0");return p(d.getHours())+":"+p(d.getMinutes());}
const label={fontSize:"var(--text-xs)",fontWeight:500,letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:"var(--fg-3)",margin:"0 0 var(--space-1)"};
const mono={fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"};
function Section({title,children}){
  if(children==null||children===false)return null;
  return <section style={{marginBottom:"var(--space-3)"}}><h3 style={label}>{title}</h3>{children}</section>;
}
export function TaskRecord({record,timelineTail=8}){
  const r=record;
  const graph=[];
  if(r.parent)graph.push(["parent",[r.parent]]);
  if(r.blockedBy&&r.blockedBy.length)graph.push(["blocked by",r.blockedBy]);
  if(r.blocks&&r.blocks.length)graph.push(["blocks",r.blocks]);
  if(r.children&&r.children.total>0)graph.push(["filed",[`${r.children.closed} of ${r.children.total} closed`]]);
  const events=r.events||[];
  const tail=events.slice(-timelineTail);
  const earlier=events.length-tail.length;
  return <div data-task-record="" style={{fontSize:"var(--text-base)",color:"var(--fg-2)",lineHeight:"var(--leading-body)"}}>
    <Section title="goal">{r.goal&&<p style={{margin:0,color:"var(--fg-1)"}}>{r.goal}</p>}</Section>
    <Section title="captain's words">{r.userWords&&<blockquote style={{margin:0,paddingLeft:"var(--space-3)",borderLeft:"1px solid var(--line-1)",whiteSpace:"pre-wrap"}}>{r.userWords}</blockquote>}</Section>
    <Section title="graph">{graph.length>0&&<dl style={{margin:0,display:"grid",gridTemplateColumns:"auto 1fr",columnGap:"var(--space-3)",rowGap:2}}>
      {graph.map(([k,v])=><React.Fragment key={k}><dt style={{color:"var(--fg-3)",fontSize:"var(--text-sm)"}}>{k}</dt><dd style={{margin:0,...mono,color:"var(--fg-2)"}}>{v.join("  ")}</dd></React.Fragment>)}
    </dl>}</Section>
    <Section title="timeline">{tail.length>0&&<div style={{display:"flex",flexDirection:"column",gap:4}}>
      {earlier>0&&<span style={mono}>earlier · {earlier} more</span>}
      {tail.map((e)=>{
        const line=<><span style={mono}>{clock(e.at)}</span><span style={{fontSize:"var(--text-sm)"}}>{e.text}</span></>;
        const grid={display:"grid",gridTemplateColumns:"38px 1fr",columnGap:8};
        if(!e.report||e.report.trim()===e.text.trim())return <div key={e.id} style={grid}>{line}</div>;
        return <details key={e.id}><summary style={{...grid,cursor:"pointer",listStyle:"none"}}>{line}</summary><p style={{margin:"var(--space-1) 0 0 46px",whiteSpace:"pre-wrap",fontSize:"var(--text-sm)"}}>{e.report}</p></details>;
      })}
    </div>}</Section>
    <Section title="delivery">{r.delivery&&<div style={{display:"flex",flexWrap:"wrap",gap:"var(--space-2)",...mono,color:"var(--fg-2)"}}>
      <span>{r.delivery.mode}</span>
      {r.delivery.prUrl&&<a href={r.delivery.prUrl} style={{color:"var(--accent)"}}>{r.delivery.prUrl}</a>}
      {r.delivery.ci&&<span>ci {r.delivery.ci}</span>}
      {r.delivery.landedMode&&<span>landed by {r.delivery.landedMode}</span>}
    </div>}</Section>
    <Section title="crew">{(r.assignee||r.branch)&&<div style={{display:"flex",flexWrap:"wrap",gap:"var(--space-2)",...mono,color:"var(--fg-2)"}}>
      {r.assignee&&<span>{r.assignee}</span>}
      {r.model&&<span>{r.model}</span>}
      {r.branch&&<span>{r.branch}</span>}
    </div>}</Section>
  </div>;
}
