// Settings → Projects (components/projects/): where your projects live, then one list box: a row per
// project that opens to its settings and says only how it differs from a new project, Add project, and
// the projects folder on one line under it. All data is fake; nothing is cloned or created.
(()=>{
const NS=window.InfinitaryDesignSystem_94f559;
const {Button,Input,Switch,Badge}=NS;
const {GroupedPills}=window.GroupedPills;
const {StatusDot}=window.StatusDot;
const {RowMenu}=window.RowMenu;
const {ConnectChips}=window.ConnectChips;
const label={fontSize:"var(--text-xs)",fontWeight:500,letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:"var(--fg-3)"};
const intro={fontSize:"var(--text-sm)",color:"var(--fg-3)",margin:"6px 0 14px"};
const box={background:"var(--bg-1)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)"};
const foot={display:"flex",alignItems:"center",flexWrap:"wrap",gap:10,padding:"12px 18px",borderTop:"1px solid var(--line-1)"};
const mono={fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"};
const quiet={fontSize:"var(--text-sm)",color:"var(--fg-3)"};
const plus=<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14M12 5v14"/></svg>;
const chevron=<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>;
const GITHUB={id:"github.com",name:"GitHub",authTypes:["oauth"],tier:"subscription",servesFirstmate:true};
const DEFAULT_FOLDER="~/Library/Application Support/infinitary/fleet";
const DELIVERY=[{value:"direct-pr",label:"pull requests"},{value:"local-only",label:"local merge"}];
const CARE=[{value:"quick",label:"Quick"},{value:"standard",label:"Default"},{value:"reviewed",label:"Careful"}];
const autonomyWords=(p)=>p.autonomy?"Merges on its own":"Asks first";
const inFolder=(p,folder)=>p.path===folder||p.path.startsWith(`${folder}/`);
// What a closed row says after the name: only what differs from a new project.
const rowWords=(p,folder)=>p.personal?["builds in place"]:[
  !inFolder(p,folder)&&"linked",
  p.delivery==="local-only"&&"local merge",
  p.autonomy&&"merges on its own",
  p.rigor==="quick"&&"Quick care",
  p.rigor==="reviewed"&&"Careful care",
].filter(Boolean);
const REPOS=[{name:"octo/website",added:true},{name:"octo/notes",private:true},{name:"octo/design-site"}];

// Where your projects live (components/projects/ForgeRow): optional, and it reads as optional.
function WhereProjectsLive({signedIn,onSignedIn}){
  const [flow,setFlow]=React.useState(false);
  return <div style={{marginBottom:28}}>
    <div style={label}>Where your projects live</div>
    <div style={intro}>Optional. Sign in once and your first mate can clone your projects and merge changes for you; projects kept on this computer need no sign-in.</div>
    <div style={box}>
      {signedIn?<div style={{display:"grid",gridTemplateColumns:"14px 120px 1fr auto",alignItems:"center",gap:12,padding:"12px 18px"}}>
        <StatusDot tone="ok" label="signed in"/>
        <span style={{fontSize:"var(--text-base)",fontWeight:500,color:"var(--fg-1)"}}>GitHub</span>
        <span style={{display:"flex",alignItems:"center",gap:10,minWidth:0}}><Badge tone="ok">signed in</Badge><span style={mono}>as octo · 3 projects here</span></span>
        <RowMenu label="GitHub actions" items={[{id:"sign-out",label:"Sign out",tone:"danger",onSelect:()=>onSignedIn(false)}]}/>
      </div>
      :<div style={{...quiet,padding:"14px 18px"}}>Projects kept on this computer need no sign-in.</div>}
      {!signedIn&&<div style={foot}>
        <ConnectChips providers={[GITHUB]} variant="foot" busyProviderId={flow?GITHUB.id:null} onConnect={()=>setFlow(true)}/>
      </div>}
      {!signedIn&&flow&&<div style={{padding:"0 18px 14px",display:"flex",flexDirection:"column",gap:10}}>
        <div style={{display:"flex",alignItems:"center",gap:10,fontSize:"var(--text-sm)",color:"var(--fg-2)"}}>
          Enter this code on GitHub:
          <code style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-sm)",letterSpacing:"0.12em",color:"var(--fg-1)",background:"var(--bg-3)",borderRadius:"var(--radius-s)",padding:"3px 8px"}}>WDJB-MJHT</code>
          <Button variant="secondary" size="sm">Copy code</Button>
        </div>
        <div style={{display:"flex",gap:8}}>
          <Button size="sm" onClick={()=>{setFlow(false);onSignedIn(true);}}>Open GitHub</Button>
          <Button variant="ghost" size="sm" onClick={()=>setFlow(false)}>Cancel</Button>
        </div>
      </div>}
    </div>
  </div>;
}

// Projects folder (components/projects/ProjectsFolder): one line under Add project.
function ProjectsFolderLine({folder,setFolder}){
  const custom=folder!==DEFAULT_FOLDER;
  return <div style={{display:"flex",alignItems:"center",gap:8,padding:"0 18px 14px",minWidth:0,fontSize:"var(--text-sm)"}}>
    <span style={{color:"var(--fg-3)",whiteSpace:"nowrap"}}>New projects go in</span>
    <span title={folder} style={{...mono,color:"var(--fg-2)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>{folder}</span>
    {!custom&&<span style={{...mono}}>default</span>}
    <Button variant="ghost" size="sm" onClick={()=>setFolder("~/code")}>Choose folder</Button>
    {custom&&<Button variant="ghost" size="sm" onClick={()=>setFolder(DEFAULT_FOLDER)}>Use default</Button>}
  </div>;
}

function PolicyRow({title,description,control}){
  return <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"10px 0",borderTop:"1px solid var(--line-1)",flexWrap:"wrap"}}>
    <div style={{minWidth:0}}>
      <div style={{fontSize:"var(--text-sm)",fontWeight:500,color:"var(--fg-1)"}}>{title}</div>
      <div style={{fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>{description}</div>
    </div>
    {control}
  </div>;
}

// Remove project (components/projects/RemoveProject): one question in place, Cancel first.
function RemoveLine({project,onRemove}){
  const [asking,setAsking]=React.useState(false);
  const cancel=React.useRef(null);
  React.useEffect(()=>{if(asking&&cancel.current)cancel.current.querySelector("button").focus();},[asking]);
  return <PolicyRow title="Remove project"
    description={asking?`Remove ${project.name}? Its folder stays at ${project.path}, and its finished tasks stay readable.`:"Takes it off this list. Its folder and finished tasks stay."}
    control={asking
      ?<span ref={cancel} style={{display:"flex",gap:8}}><Button variant="secondary" size="sm" onClick={()=>setAsking(false)}>Cancel</Button><Button variant="danger" size="sm" onClick={onRemove}>Remove</Button></span>
      :<Button variant="danger" size="sm" aria-label={`Remove ${project.name}`} onClick={()=>setAsking(true)}>Remove</Button>}/>;
}

// One project: a row that opens to where its changes go, whether it asks before merging, and its care.
function ProjectRow({project,folder,open,onToggle,onPatch,onRemove}){
  const p=project;
  const words=rowWords(p,folder);
  return <div style={{borderBottom:"1px solid var(--line-1)"}}>
    <button type="button" aria-expanded={open} onClick={onToggle} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,width:"100%",padding:"12px 18px",background:"transparent",border:"none",cursor:"pointer",textAlign:"left",color:"inherit",font:"inherit"}}>
      <span style={{display:"flex",alignItems:"baseline",gap:12,minWidth:0}}>
        <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-sm)",color:"var(--fg-1)",whiteSpace:"nowrap"}}>{p.name}</span>
        {words.length>0&&<span style={{...mono,whiteSpace:"nowrap"}}>{words.join(" · ")}</span>}
        {!p.personal&&!inFolder(p,folder)&&<span style={{...mono,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0}}>{p.path}</span>}
      </span>
      <span style={{display:"flex",alignItems:"center",gap:8,flexShrink:0}}>
        <span style={{display:"inline-flex",color:"var(--fg-3)",transform:open?"rotate(180deg)":"none",transition:"transform var(--dur-fast) var(--ease-out)"}}>{chevron}</span>
      </span>
    </button>
    {open&&<div style={{padding:"0 18px 12px"}}>
      <PolicyRow title={p.personal?"Workspace":"Where changes go"}
        description={p.personal?"Builds in place: no working copy and no pull request.":"Offered as a pull request where the project lives, or merged locally with no pull request."}
        control={p.personal?<span style={quiet}>builds in place</span>
          :<GroupedPills name="Where changes go" htmlName={`delivery-${p.id}`} value={p.delivery} options={DELIVERY} onChange={(delivery)=>onPatch({delivery})}/>}/>
      <PolicyRow title="Ask before merging"
        description={p.personal?"Builds in place. Work that passes the checks is written as soon as it is done.":p.autonomy?"Work that passes the checks may merge without asking you.":"Finished work waits for your word."}
        control={p.personal?<span style={quiet}>{autonomyWords(p)}</span>
          :<span style={{display:"flex",alignItems:"center",gap:10}}><span style={{fontSize:"var(--text-base)",color:"var(--fg-1)"}}>{autonomyWords(p)}</span><Switch checked={!p.autonomy} onChange={(asksFirst)=>onPatch({autonomy:!asksFirst})}/></span>}/>
      <PolicyRow title="Care"
        description={p.personal?"Nothing here passes through a gate.":"The standing care for every task here."}
        control={p.personal?<span style={quiet}>none</span>
          :<GroupedPills name="Care" htmlName={`rigor-${p.id}`} value={p.rigor} options={CARE} onChange={(rigor)=>onPatch({rigor})}/>}/>
      {!p.personal&&p.delivery==="local-only"&&p.rigor==="reviewed"&&<div style={{fontSize:"var(--text-xs)",color:"var(--warn)",paddingTop:6,borderTop:"1px solid var(--line-1)"}}>Changes that merge locally are done carefully, without a review - there is no pull request to look at.</div>}
      {!p.personal&&<RemoveLine project={p} onRemove={onRemove}/>}
    </div>}
  </div>;
}

// Add project (components/projects/AddProject): chips, and a form below the same row, never a modal.
function AddProjectRow({folder,signedIn,onAdd}){
  const [form,setForm]=React.useState(null);
  const [name,setName]=React.useState("");
  const [search,setSearch]=React.useState("");
  const [link,setLink]=React.useState("");
  const [taskKey,setTaskKey]=React.useState("");
  const [added,setAdded]=React.useState(new Set(REPOS.filter(r=>r.added).map(r=>r.name)));
  const chip=(text,onClick)=><Button variant="secondary" size="sm" icon={plus} style={{borderRadius:"var(--radius-pill)"}} onClick={onClick}>{text}</Button>;
  const formLabel={display:"block",fontSize:"var(--text-sm)",color:"var(--fg-2)",marginBottom:8};
  const clone=(full)=>{setAdded(s=>new Set([...s,full]));onAdd({name:full.split("/")[1],path:`${folder}/${full.split("/")[1]}`,setup:"cloned",lives:"on GitHub",delivery:"direct-pr",autonomy:false,rigor:"standard"});};
  return <div>
    <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:10,padding:"12px 18px"}}>
      <span style={label}>Add project</span>
      {chip("Folder on this computer",()=>{setForm(null);onAdd({name:"notes",path:"~/code/notes",setup:"linked",delivery:"local-only",autonomy:false,rigor:"standard"});})}
      {chip("GitHub repo",()=>setForm("repo"))}
      {chip("New project",()=>setForm("new"))}
      <label style={{display:"flex",alignItems:"center",gap:8,marginLeft:"auto",fontSize:"var(--text-sm)",color:"var(--fg-2)"}}>Task key
        <Input mono value={taskKey} placeholder="From its name" onChange={(e)=>setTaskKey(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,4))} style={{width:"calc(13ch + 26px)",padding:"6px 12px",fontSize:"var(--text-sm)"}}/>
      </label>
    </div>
    {taskKey&&<p style={{...quiet,margin:"0 18px 12px"}}>Tasks in the next project you add are numbered {taskKey}-1, {taskKey}-2 and so on.</p>}
    {form&&<div style={{padding:"12px 18px 14px",borderTop:"1px solid var(--line-1)"}}>
      {form==="new"&&<form onSubmit={(e)=>{e.preventDefault();if(!name.trim())return;onAdd({name:name.trim(),path:`${folder}/${name.trim()}`,setup:"created",delivery:"local-only",autonomy:false,rigor:"standard"});setName("");setForm(null);}}>
        <label htmlFor="mock-new-project" style={formLabel}>Name</label>
        <div style={{display:"flex",gap:8}}>
          <Input id="mock-new-project" mono value={name} onChange={(e)=>setName(e.target.value)} style={{flex:1}}/>
          <Button type="submit" size="sm" disabled={!name.trim()}>Start project</Button>
        </div>
        <p style={{...quiet,margin:"8px 0 0"}}>An empty project in {folder}. Its changes merge on this computer; you can change that in its row.</p>
      </form>}
      {form==="repo"&&<div>
        {signedIn&&<div style={{marginBottom:12}}>
          <p style={{...formLabel,margin:"0 0 8px"}}>Your GitHub repos</p>
          <Input aria-label="Find a repo" placeholder="Find a repo" value={search} onChange={(e)=>setSearch(e.target.value)}/>
          {REPOS.filter(r=>r.name.includes(search.toLowerCase())).map(r=><div key={r.name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:8,padding:"8px 0",borderBottom:"1px solid var(--line-1)"}}>
            <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-sm)",color:"var(--fg-1)"}}>{r.name}{r.private&&<span style={{fontFamily:"var(--font-ui)",color:"var(--fg-3)"}}> · private</span>}</span>
            {added.has(r.name)?<span style={quiet}>added</span>:<Button variant="secondary" size="sm" onClick={()=>clone(r.name)}>Add</Button>}
          </div>)}
        </div>}
        <form onSubmit={(e)=>{e.preventDefault();const m=link.trim().match(/github\.com\/([^/]+\/[^/]+)/);if(m){clone(m[1]);setLink("");}}}>
          <label htmlFor="mock-project-link" style={formLabel}>{signedIn?"Or paste a":"Paste a"} GitHub link</label>
          <div style={{display:"flex",gap:8}}>
            <Input id="mock-project-link" mono placeholder="https://github.com/owner/project" value={link} onChange={(e)=>setLink(e.target.value)} style={{flex:1}}/>
            <Button type="submit" size="sm" disabled={!link.trim()}>Add</Button>
          </div>
        </form>
      </div>}
      <div style={{display:"flex",justifyContent:"flex-end",marginTop:8}}><Button variant="ghost" size="sm" onClick={()=>setForm(null)}>Close</Button></div>
    </div>}
  </div>;
}

function ProjectsTab(){
  const [signedIn,setSignedIn]=React.useState(true);
  const [folder,setFolder]=React.useState(DEFAULT_FOLDER);
  const [projects,setProjects]=React.useState([
    {id:"website",name:"website",path:`${DEFAULT_FOLDER}/website`,setup:"cloned",lives:"on GitHub",delivery:"direct-pr",autonomy:false,rigor:"standard"},
    {id:"api",name:"api",path:"~/code/api",setup:"linked",delivery:"local-only",autonomy:true,rigor:"quick"},
    {id:"personal",name:"personal",path:`${DEFAULT_FOLDER}/personal`,setup:"created",personal:true,autonomy:true}
  ]);
  const [openId,setOpenId]=React.useState("website");
  const patch=(id,changes)=>setProjects(list=>list.map(p=>p.id===id?{...p,...changes}:p));
  const add=(project)=>{
    const existing=projects.find(p=>p.name===project.name);
    if(existing){setOpenId(existing.id);return;}
    const id=project.name;
    setProjects(list=>[...list,{...project,id}]);setOpenId(id);
  };
  return <div>
    <WhereProjectsLive signedIn={signedIn} onSignedIn={setSignedIn}/>
    <div style={label}>Projects</div>
    <div style={intro}>Add a project here or ask your first mate, and open one to change how it works. A row says only what is set differently from a new project, which is offered as pull requests where it lives, waits for your word before merging, takes Default care and runs on a computer chosen automatically.</div>
    <div style={{...box,overflow:"hidden"}}>
      {projects.map(p=><ProjectRow key={p.id} project={p} folder={folder} open={openId===p.id}
        onToggle={()=>setOpenId(id=>id===p.id?null:p.id)}
        onPatch={(changes)=>patch(p.id,changes)}
        onRemove={()=>{setProjects(list=>list.filter(x=>x.id!==p.id));setOpenId(null);}}/>)}
      <AddProjectRow folder={folder} signedIn={signedIn} onAdd={add}/>
      <ProjectsFolderLine folder={folder} setFolder={setFolder}/>
    </div>
  </div>;
}
window.FM_ProjectsTab=ProjectsTab;
})();
