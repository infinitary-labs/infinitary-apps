import React from "react";
import {StatusDot} from "../core/StatusDot.jsx";
// The now panel: what IS, on the right side rail (the activity feed on the
// left says what happened). Minimal by default - a counts line with a
// search icon, then rows for "waiting on you" and "working", and
// the other groups (queued, backlog, done · 7d) collapsed to a count.
// A row is a status dot, the task key in dim mono before the title, and
// nothing after it but, while its computer cannot take work, why (the
// production row's reach words; this mock leaves them out); one dim word
// for a blocked or held row; children indent under their parent. Nothing
// else in the rail: no chips, meters, models, or ages. Clicking a row is a
// pointing gesture (it opens the task's record card, or brings its decision
// card forward); the panel never mutates a task.
const GROUP_LABEL={waiting:"waiting on you",working:"working",queued:"queued",backlog:"backlog",landed:"done · 7d"};
const OPEN_BY_DEFAULT={waiting:true,working:true};
export function NowRow({task,onOpen}){
  const depth=Math.min(task.depth||0,3);
  return <button type="button" onClick={()=>onOpen&&onOpen(task)} title={`${task.key} · ${task.title}`}
    style={{display:"grid",gridTemplateColumns:"6px minmax(0,1fr)",alignItems:"center",columnGap:8,width:"100%",boxSizing:"border-box",
      margin:0,padding:"5px 6px",paddingLeft:6+depth*12,border:"none",borderRadius:"var(--radius-s)",background:"transparent",color:"inherit",font:"inherit",textAlign:"left",cursor:"pointer",
      transition:"background var(--dur-fast) var(--ease-out)"}}
    onMouseEnter={(e)=>{e.currentTarget.style.background="var(--bg-3)";}} onMouseLeave={(e)=>{e.currentTarget.style.background="transparent";}}>
    <StatusDot tone={task.tone||"idle"} label={GROUP_LABEL[task.group]||task.group}/>
    <span style={{fontSize:"var(--text-sm)",color:task.group==="waiting"?"var(--fg-1)":"var(--fg-2)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",lineHeight:"var(--leading-body)"}}>
      <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>{task.key} </span>{task.title}{task.word&&<span style={{color:"var(--fg-3)"}}> · {task.word}</span>}
    </span>
  </button>;
}
export function NowGroup({group,rows,open,onToggle,onOpen}){
  if(!rows.length)return null;
  const collapsible=!OPEN_BY_DEFAULT[group];
  return <div data-now-group={group} style={{display:"flex",flexDirection:"column",gap:2}}>
    <button type="button" onClick={collapsible?onToggle:undefined} aria-expanded={collapsible?open:undefined}
      style={{display:"flex",alignItems:"center",gap:8,margin:0,padding:"4px 6px",border:"none",background:"transparent",color:"inherit",font:"inherit",textAlign:"left",cursor:collapsible?"pointer":"default"}}>
      <span style={{fontSize:"var(--text-xs)",fontWeight:500,letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:"var(--fg-3)"}}>{GROUP_LABEL[group]}</span>
      {collapsible&&<span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>{rows.length}</span>}
      {collapsible&&<span aria-hidden="true" style={{marginLeft:"auto",display:"inline-flex",alignItems:"center",color:"var(--fg-2)",transform:open?"none":"rotate(180deg)",transition:"transform var(--dur-fast) var(--ease-out)"}}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>}
    </button>
    {(open||!collapsible)&&rows.map((task)=><NowRow key={task.id} task={task} onOpen={onOpen}/>)}
  </div>;
}
export function NowPanel({counts={waiting:0,working:0},groups={},projects=[],onOpen,style}){
  const [filterOpen,setFilterOpen]=React.useState(false);
  const [query,setQuery]=React.useState("");
  const [project,setProject]=React.useState(null);
  const [open,setOpen]=React.useState({});
  const q=query.trim().toLowerCase();
  const keep=(t)=>(!project||t.projectId===project)&&(!q||t.title.toLowerCase().includes(q)||t.key.toLowerCase().includes(q));
  // Closing the filter lets go of its words and project, so every task shows again.
  const closeFilter=()=>{setFilterOpen(false);setQuery("");setProject(null);};
  // Esc empties the words, then a second Esc closes the filter.
  const onFilterKey=(e)=>{if(e.key!=="Escape")return;e.preventDefault();if(query)setQuery("");else closeFilter();};
  return <div data-now-panel="" style={{display:"flex",flexDirection:"column",gap:"var(--space-2)",minHeight:0,...style}}>
    <div style={{display:"flex",flexWrap:"wrap",alignItems:"baseline",gap:"2px 8px",padding:"0 6px"}}>
      <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:counts.waiting>0?"var(--fg-1)":"var(--fg-3)",whiteSpace:"nowrap"}}>{counts.waiting} waiting on you</span>
      <span style={{color:"var(--fg-3)"}}>·</span>
      <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-2)",whiteSpace:"nowrap"}}>{counts.working} working</span>
      <button type="button" onClick={()=>filterOpen?closeFilter():setFilterOpen(true)} aria-expanded={filterOpen} aria-label="Search tasks" title="Search tasks"
        style={{marginLeft:"auto",flexShrink:0,display:"inline-flex",alignItems:"center",justifyContent:"center",width:24,height:24,padding:0,border:"none",borderRadius:"var(--radius-pill)",background:"transparent",color:filterOpen?"var(--fg-2)":"var(--fg-3)",cursor:"pointer"}}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </button>
    </div>
    {filterOpen&&<div onKeyDown={onFilterKey} style={{display:"flex",flexDirection:"column",gap:6,padding:"18px 18px 10px"}}>
      <div style={{display:"flex",alignItems:"center",gap:6}}>
        <input value={query} onChange={(e)=>setQuery(e.target.value)} placeholder="key or title" aria-label="Filter tasks"
          style={{flex:1,minWidth:0,fontFamily:"var(--font-ui)",fontSize:"var(--text-sm)",color:"var(--fg-1)",background:"var(--surface-input)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)",padding:"4px 8px",outline:"none"}}/>
        {/* Close search: the app's IconButton, labelled with its key, Esc. */}
        <button type="button" onClick={closeFilter} aria-label="Close search" aria-keyshortcuts="Escape"
          style={{flexShrink:0,display:"inline-flex",alignItems:"center",justifyContent:"center",width:24,height:24,padding:0,border:"none",borderRadius:"var(--radius-pill)",background:"transparent",color:"var(--fg-3)",cursor:"pointer"}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>
      {/* Chips keep project.key as the filter handle; row chrome uses projectName. */}
      {projects.length>1&&<div style={{display:"flex",flexWrap:"wrap",gap:4}}>
        {[{id:null,key:"all"},...projects].map((p)=><button key={p.id||"all"} type="button" onClick={()=>setProject(p.id)} aria-pressed={project===p.id}
          style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:project===p.id?"var(--fg-1)":"var(--fg-3)",background:project===p.id?"var(--bg-3)":"transparent",border:"1px solid var(--line-1)",borderRadius:"var(--radius-pill)",padding:"1px 8px",cursor:"pointer"}}>{p.key}</button>)}
      </div>}
    </div>}
    <div style={{display:"flex",flexDirection:"column",gap:"var(--space-1)",overflowY:"auto",minHeight:0}}>
      {["waiting","working","queued","backlog","landed"].map((g)=><NowGroup key={g} group={g} rows={(groups[g]||[]).filter(keep)} open={!!open[g]} onToggle={()=>setOpen({...open,[g]:!open[g]})} onOpen={onOpen}/>)}
    </div>
  </div>;
}
