// Settings → Intelligence: one flat list of accounts (the Instruments direction, components/core/StatusDot,
// RowMenu, components/quota/QuotaMicroMeter), the Add account foot (components/core/ConnectChips), then
// Firstmate's model and account, Dynamic routing and the Models board (components/quota/ModelsBoard).
// All data is fake; nothing signs in. Dragging pills and the model panel are described in ModelsBoard only.
(()=>{
const NS=window.InfinitaryDesignSystem_94f559;
const {Button,Input,Switch}=NS;
const {StatusDot}=window.StatusDot;
const {RowMenu}=window.RowMenu;
const {QuotaMicroMeter}=window.QuotaMicroMeter;
const {ConnectChips}=window.ConnectChips;
const {SlotBadge}=window.SlotBadge;
const label={fontSize:"var(--text-xs)",fontWeight:500,letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:"var(--fg-3)"};
const box={background:"var(--bg-1)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)"};
const mono={fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"};
const tones={danger:"var(--danger)",warn:"var(--warn)",accent:"var(--accent)",quiet:"var(--fg-3)"};
const select={fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-1)",background:"var(--bg-0)",border:"1px solid var(--line-2)",borderRadius:"var(--radius-s)",padding:"6px 8px"};
const chevron=<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>;
const PROVIDERS=[
  {id:"openai-codex",name:"Codex",authTypes:["oauth"],tier:"subscription",servesFirstmate:true},
  {id:"xai",name:"Grok",authTypes:["oauth"],tier:"subscription",servesFirstmate:true},
  {id:"anthropic-claude",name:"Claude",authTypes:["oauth"],tier:"subscription",servesFirstmate:true},
  {id:"kimi-coding",name:"Kimi Code",authTypes:["oauth","api_key"],tier:"subscription",servesFirstmate:true},
  {id:"openrouter",name:"OpenRouter",authTypes:["oauth","api_key"],tier:"api_key",servesFirstmate:true}
];
const providerOf=(name)=>PROVIDERS.find(p=>p.name===name);
// A window: label, percent left, pace and the linear-pace clock (quota-axi's semantics).
const w=(l,pct,pace,clock)=>({label:l,percentRemaining:pct,pace,clockPercent:clock});
const START_ACCOUNTS=[
  {id:"cx1",provider:"Codex",label:"Personal",sub:"Plus · kun@example.com",enabled:true,pinned:true,windows:[w("session",74,"behind",40),w("weekly",9,"ahead",30)],verdict:{text:"empty in 4h 45m",tone:"danger"}},
  {id:"cx2",provider:"Codex",label:"Work #2",sub:"Pro",enabled:true,windows:[w("session",100,"behind",10),w("weekly",38,"ahead",55)],verdict:{text:"empty in 2d 10h",tone:"warn"}},
  {id:"cx3",provider:"Codex",label:"Old team",sub:"Plus",enabled:false,windows:[w("session",100,"unknown"),w("weekly",91,"behind",20)]},
  {id:"gk1",provider:"Grok",label:"Rejected",sub:"subscription",enabled:true,signIn:true},
  {id:"gk2",provider:"Grok",label:"Team",sub:"SuperGrok Heavy · kun@example.com",enabled:true,windows:[w("monthly credits",40,"on_pace",62)],verdict:{text:"on pace ✓",tone:"accent"}},
  {id:"cl1",provider:"Claude",label:"Personal Max",sub:"Max · kun@example.com",enabled:true,windows:[w("session",68,"on_pace",35),w("weekly",41,"on_pace",60),w("weekly (opus)",55,"on_pace",50)],verdict:{text:"on pace ✓",tone:"accent"}},
  {id:"cl2",provider:"Claude",label:"Work",sub:"Max · kun@example.com",enabled:true,stale:true,windows:[w("session",22,"unknown",60),w("weekly",64,"unknown",40),w("weekly (opus)",70,"unknown",50)],verdict:{text:"as of 3h ago",tone:"warn"}},
  {id:"or1",provider:"OpenRouter",label:"Limited",sub:"API key",enabled:true,note:"Your allowance can't be read right now - the provider asked us to slow down."}
];
const dotFor=(a)=>a.signIn?{tone:"danger",label:"sign in again"}:!a.enabled?{tone:"idle",label:"paused"}:a.stale?{tone:"warn",label:"last reading is old"}:a.note||a.unread?{tone:"ring",label:"no reading yet"}:{tone:"ok",label:"signed in"};

// The Models board's starting placement: every model a pill in each level it is used at.
const MODELS=[
  {id:"fable",provider:"Claude",label:"Claude Fable 5.1"},{id:"opus",provider:"Claude",label:"Claude Opus 5.5"},
  {id:"sonnet",provider:"Claude",label:"Claude Sonnet 5.5"},{id:"haiku",provider:"Claude",label:"Claude Haiku 4.5"},
  {id:"astra",provider:"Codex",label:"GPT-6 Astra"},{id:"sol",provider:"Codex",label:"GPT-6.1 Sol"},
  {id:"luna",provider:"Codex",label:"GPT-6 Luna"},{id:"terra",provider:"Codex",label:"GPT-5.6 Terra"},
  {id:"grok",provider:"Grok",label:"Grok 4.7"},{id:"grok-fast",provider:"Grok",label:"Grok 4.7 Fast"},
  {id:"or-opus",provider:"OpenRouter",label:"Anthropic: Claude Opus Latest",unlisted:true},
  {id:"or-sol",provider:"OpenRouter",label:"OpenAI: GPT Sol Latest",unlisted:true},
  {id:"or-grok",provider:"OpenRouter",label:"xAI: Grok Latest",unlisted:true}
];
const START_LEVELS={premium:["fable","astra"],high:["opus","sol"],medium:["sonnet","sol","grok"],low:["haiku","luna"]};
const LEVELS=["premium","high","medium","low"];
const HINT={premium:"Crew never picks this automatically; your first mate's Auto may fall back to it after high and medium.",high:"Plans, research, reproduction, and work without a verified basis",medium:"Building or fixing from a verified plan, spec, or reproduction",low:"Config, docs, cosmetic chores"};
const EMPTY={premium:"Empty. Work that asks for premium waits until you add a model here or choose to run it lower.",high:"Empty. Hard tasks run on your models for normal tasks.",medium:"Empty. Normal tasks run on your models for hard tasks.",low:"Empty. Simple tasks run on your models for normal tasks."};
const model=(id)=>MODELS.find(m=>m.id===id);
// The provider is dropped where the label already starts with it: "Claude Opus 5.5", "Grok 4.7".
const ModelName=({m})=><span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-sm)",whiteSpace:"nowrap"}}>
  {!m.label.startsWith(m.provider)&&<span style={{color:"var(--fg-3)"}}>{m.provider} </span>}<span style={{color:"var(--fg-1)"}}>{m.label}</span></span>;

function AccountRow({a,first,firstmate,onMenu,onSignIn,renaming,onRename,onCancelRename}){
  const [draft,setDraft]=React.useState(a.label);
  const dot=dotFor(a);
  const items=[
    {id:"prefer",label:a.pinned?"Stop preferring for crew work":"Prefer for crew work",trailing:<span style={{color:"var(--accent)",fontFamily:"var(--font-mono)"}}>✱</span>,onSelect:()=>onMenu("prefer")},
    {id:"rename",label:"Rename",onSelect:()=>onMenu("rename")},
    {id:"pause",label:a.enabled?"Pause":"Resume",onSelect:()=>onMenu("pause")},
    {id:"models",label:"Model slots",onSelect:()=>onMenu("models")},
    {separator:true},
    {id:"disconnect",label:"Disconnect",tone:"danger",onSelect:()=>onMenu("disconnect")}
  ];
  return <div style={{display:"grid",gridTemplateColumns:"6px 84px minmax(150px,0.8fr) minmax(0,1.7fr) 28px",gap:14,alignItems:"center",padding:"9px var(--space-4)",minHeight:50,borderTop:first?0:"1px solid var(--line-1)",opacity:a.enabled?1:0.55}}>
    <StatusDot tone={dot.tone} label={dot.label}/>
    <span style={{fontSize:"var(--text-sm)",fontWeight:500,color:"var(--fg-1)",whiteSpace:"nowrap"}}>{a.provider}</span>
    {renaming?<form style={{display:"flex",gap:6,flexWrap:"wrap",minWidth:0}} onSubmit={(e)=>{e.preventDefault();onRename(draft.trim()||a.label);}}>
      <Input value={draft} onChange={(e)=>setDraft(e.target.value)} placeholder="Account name" autoFocus style={{width:140,padding:"5px 10px",fontSize:"var(--text-sm)"}}/>
      <Button size="sm" type="submit">Save</Button>
      <Button variant="ghost" size="sm" type="button" onClick={onCancelRename}>Cancel</Button>
    </form>
    :<div style={{display:"flex",flexDirection:"column",gap:1,minWidth:0}}>
      <span style={{display:"flex",alignItems:"center",gap:6,fontSize:"var(--text-sm)",color:"var(--fg-1)"}}>
        {a.label}
        {a.pinned&&<span title="Crew work prefers this account" style={{fontFamily:"var(--font-mono)",color:"var(--accent)"}}>✱</span>}
        {firstmate&&<span title="Your first mate runs on this account" style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:"var(--accent)",border:"1px solid var(--line-2)",borderRadius:"var(--radius-s)",padding:"0 6px",lineHeight:1.4}}>first mate</span>}
      </span>
      <span style={mono}>{a.sub}</span>
    </div>}
    <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",columnGap:16,rowGap:4,minWidth:0}}>
      {a.signIn?<>
        <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--danger)"}}>Sign in again to see your allowance.</span>
        <Button variant="secondary" size="sm" onClick={onSignIn}>Sign in</Button>
      </>:a.note?<span style={mono}>{a.note}</span>:<>
        {a.windows.map(win=><QuotaMicroMeter key={win.label} stale={!!a.stale||!a.enabled} {...win}/>)}
        {!a.enabled?<span style={mono}>paused</span>:a.verdict&&<span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:tones[a.verdict.tone]}}>{a.verdict.text}</span>}
      </>}
    </div>
    <RowMenu label={`${a.provider} ${a.label} actions`} items={items}/>
  </div>;
}

function SettingRow({title,description,control}){
  return <div style={{...box,display:"flex",alignItems:"center",justifyContent:"space-between",gap:16,padding:"14px 18px"}}>
    <div style={{minWidth:0}}>
      <div style={{fontSize:"var(--text-base)",color:"var(--fg-1)",fontWeight:500}}>{title}</div>
      <div style={{fontSize:"var(--text-sm)",color:"var(--fg-3)"}}>{description}</div>
    </div>
    {control}
  </div>;
}

// Firstmate's own model, and beside it the account it answers on when two or more of that provider's can.
function FirstmateModelRow({accounts,chosen,onChoose}){
  const [modelId,setModelId]=React.useState("auto");
  const [byName,setByName]=React.useState(false);
  const [name,setName]=React.useState("");
  const listed=MODELS.filter(m=>!m.unlisted);
  const provider=modelId==="auto"?"Codex":modelId.startsWith("name:")?null:model(modelId).provider;
  const choices=accounts.filter(a=>a.provider===provider);
  const able=choices.filter(a=>a.enabled&&!a.signIn);
  const withAccount=able.length>=2;
  return <SettingRow title={withAccount?"First mate model and account":"First mate model"}
    description={withAccount?`The model your first mate itself answers with, and the ${provider} account it answers on; crew work keeps its own preferred account. Auto tries your models for hard tasks, then normal, premium, then simple, across your subscriptions; a change applies at the next idle moment.`
      :"The model your first mate itself answers with. Auto tries your models for hard tasks, then normal, premium, then simple, across your subscriptions; a change applies at the next idle moment."}
    control={<span style={{display:"flex",gap:8,flexShrink:0}}>
      {byName?<span><Input mono list="mock-unlisted-models" aria-label="First mate model by name" placeholder="Find a model by name" autoFocus value={name} style={{width:220,padding:"6px 10px",fontSize:"var(--text-xs)"}}
          onChange={(e)=>setName(e.target.value)}
          onKeyDown={(e)=>{if(e.key==="Escape"){setByName(false);}if(e.key==="Enter"&&name.trim()){setModelId("name:"+name.trim());setByName(false);}}}/>
        <datalist id="mock-unlisted-models">{MODELS.filter(m=>m.unlisted).map(m=><option key={m.id} value={m.label}/>)}</datalist></span>
      :<select aria-label="First mate model" style={{...select,width:214}} value={modelId} onChange={(e)=>{if(e.target.value==="by-name"){setByName(true);setName("");}else setModelId(e.target.value);}}>
        <option value="auto">Auto (from subscriptions)</option>
        {modelId.startsWith("name:")&&<option value={modelId}>{modelId.slice(5)}</option>}
        {listed.map(m=><option key={m.id} value={m.id}>{m.label.startsWith(m.provider)?m.label:`${m.provider} ${m.label}`}</option>)}
        <option value="by-name">Another model by name…</option>
      </select>}
      {withAccount&&<select aria-label="First mate account" style={{...select,width:128}} value={chosen??""} onChange={(e)=>onChoose(e.target.value)}>
        {!chosen&&<option value="">Not chosen yet</option>}
        {choices.map(a=><option key={a.id} value={a.id} disabled={!a.enabled||a.signIn}>{a.label}{!a.enabled?" · paused":a.signIn?" · sign in again":""}</option>)}
      </select>}
    </span>}/>;
}

// Add model: a search over listed models, then by name what the subscriptions serve beyond them.
function AddModelPicker({level,levels,listed:isListed,onPick}){
  const [q,setQ]=React.useState("");
  const match=(m)=>`${m.provider} ${m.label}`.toLowerCase().includes(q.trim().toLowerCase());
  const where=(m)=>LEVELS.filter(l=>levels[l].includes(m.id)).join(", ")||"not in use";
  const listed=MODELS.filter(m=>isListed(m)&&!levels[level].includes(m.id)&&match(m));
  const more=q.trim()?MODELS.filter(m=>!isListed(m)&&match(m)).slice(0,12):[];
  const row=(m)=><button key={m.id} type="button" onClick={()=>onPick(m.id)} style={{display:"flex",alignItems:"center",gap:10,width:"100%",background:"transparent",border:0,borderRadius:"var(--radius-s)",padding:"6px 8px",cursor:"pointer",textAlign:"left"}}
    onMouseEnter={(e)=>{e.currentTarget.style.background="var(--bg-3)";}} onMouseLeave={(e)=>{e.currentTarget.style.background="transparent";}}>
    <ModelName m={m}/><span style={{...mono,marginLeft:"auto"}}>{where(m)}</span></button>;
  return <div style={{display:"flex",flexDirection:"column",gap:6,marginTop:8}}>
    <Input mono placeholder="Find a model by name" autoFocus value={q} onChange={(e)=>setQ(e.target.value)} style={{padding:"6px 10px",fontSize:"var(--text-sm)"}}/>
    {listed.map(row)}
    {more.length>0&&<><span style={{...label,marginTop:4}}>More from your subscriptions</span>{more.map(row)}</>}
    {listed.length===0&&more.length===0&&<span style={{fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>No model by that name</span>}
  </div>;
}

function Pill({m,onRemove,removeLabel}){
  return <span style={{display:"inline-flex",alignItems:"center",border:"1px solid var(--line-2)",borderRadius:"var(--radius-pill)",background:"var(--bg-1)",overflow:"hidden"}}>
    <span style={{padding:"5px 10px"}}><ModelName m={m}/></span>
    {onRemove&&<button type="button" aria-label={removeLabel} title={removeLabel} onClick={onRemove} style={{alignSelf:"stretch",background:"transparent",border:0,borderLeft:"1px solid var(--line-1)",color:"var(--fg-3)",cursor:"pointer",padding:"0 8px",fontSize:"var(--text-sm)"}}>×</button>}
  </span>;
}

function ModelsBoard({open,onToggle,levels,setLevels,onReset}){
  const [adding,setAdding]=React.useState(null);
  const [kept,setKept]=React.useState([]);
  const isListed=(m)=>!m.unlisted||kept.includes(m.id);
  const [decision,setDecision]=React.useState(null);
  const [pickingDecision,setPickingDecision]=React.useState(false);
  const placed=new Set(LEVELS.flatMap(l=>levels[l]));
  const notInUse=MODELS.filter(m=>isListed(m)&&!placed.has(m.id));
  const count=(l)=>levels[l].length;
  const summary=`premium ${count("premium")} · high ${count("high")} · medium ${count("medium")} · low ${count("low")} · ${notInUse.length} not in use · decisions ${decision?model(decision).label:"auto"}`;
  const lane={background:"var(--bg-2)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)",padding:"10px 12px",display:"flex",flexDirection:"column",gap:8,minWidth:0};
  const place=(level,id)=>{setLevels({...levels,[level]:[...levels[level],id]});setKept(k=>k.includes(id)?k:[...k,id]);setAdding(null);};
  return <div data-mock-models style={{...box,overflow:"hidden"}}>
    <button type="button" aria-expanded={open} onClick={onToggle} style={{display:"flex",alignItems:"center",gap:12,width:"100%",padding:"12px 18px",background:"transparent",border:0,cursor:"pointer",textAlign:"left",color:"inherit",font:"inherit"}}>
      <span style={{fontSize:"var(--text-base)",fontWeight:500,color:"var(--fg-1)"}}>Models</span>
      <span style={{...mono,flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{summary}</span>
      <span style={{display:"inline-flex",color:"var(--fg-3)",transform:open?"rotate(180deg)":"none",transition:"transform var(--dur-fast) var(--ease-out)"}}>{chevron}</span>
    </button>
    {open&&<div style={{padding:"0 18px 14px",display:"flex",flexDirection:"column",gap:10}}>
      <div style={{fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>Drag a model to another level to move it. Hold ⌥ as you drop to use it at both. Or choose it to pick its levels.</div>
      {LEVELS.map(l=><div key={l} style={lane}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <SlotBadge slot={l}/><span style={{fontSize:"var(--text-xs)",color:"var(--fg-3)",flex:1}}>{HINT[l]}</span>
          <Button variant="ghost" size="sm" onClick={()=>setAdding(adding===l?null:l)}>Add model</Button>
        </div>
        {levels[l].length?<div style={{display:"flex",flexWrap:"wrap",gap:8}}>
          {levels[l].map(id=><Pill key={id} m={model(id)} removeLabel={`Remove ${model(id).label} from ${l}`} onRemove={()=>setLevels({...levels,[l]:levels[l].filter(x=>x!==id)})}/>)}
        </div>:<span style={{fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>{EMPTY[l]}</span>}
        {adding===l&&<AddModelPicker level={l} levels={levels} listed={isListed} onPick={(id)=>place(l,id)}/>}
      </div>)}
      <div style={lane}>
        <div style={{display:"flex",alignItems:"center",gap:10}}><span style={label}>Not in use</span><span style={{fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>Never picked on their own. Drag one to a level to place it.</span></div>
        {notInUse.length?<div style={{display:"flex",flexWrap:"wrap",gap:8}}>{notInUse.map(m=><Pill key={m.id} m={m}/>)}</div>
          :<span style={{fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>Every model shown is in a level. Find more from your subscriptions by name under Add model.</span>}
      </div>
      <div style={lane}>
        <div style={{display:"flex",alignItems:"center",gap:10}}><span style={label}>Decisions</span><span style={{fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>Efficient decision making</span></div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <StatusDot tone={decision?"ok":"ring"} label={decision?"on":"auto"}/>
          {pickingDecision?<select aria-label="Choose the model that answers decisions" style={{...select,flex:1}} value={decision??""} onChange={(e)=>{setDecision(e.target.value||null);setPickingDecision(false);}}>
            <option value="">Choose</option>{MODELS.filter(m=>placed.has(m.id)).map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
          </select>:<span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-sm)",color:"var(--fg-2)",flex:1}}>{decision?model(decision).label:"auto · your cheapest slotted model"}</span>}
          <RowMenu label="Decision model actions" size={24} items={[...(decision?[{id:"auto",label:"Use auto",onSelect:()=>setDecision(null)}]:[]),{id:"specific",label:"Use a specific model",onSelect:()=>setPickingDecision(v=>!v)}]}/>
        </div>
      </div>
      <div><Button variant="ghost" size="sm" onClick={onReset}>Reset to starting levels</Button></div>
    </div>}
  </div>;
}

function IntelligenceTab(){
  const [accounts,setAccounts]=React.useState(START_ACCOUNTS);
  const [firstmateAccount,setFirstmateAccount]=React.useState("cx1");
  const [renaming,setRenaming]=React.useState(null);
  const [busy,setBusy]=React.useState(null);
  const [asking,setAsking]=React.useState(null);
  const [routing,setRouting]=React.useState(true);
  const [modelsOpen,setModelsOpen]=React.useState(true);
  const [levels,setLevels]=React.useState(START_LEVELS);
  const update=(id,change)=>setAccounts(list=>list.map(a=>a.id===id?{...a,...change(a)}:a));
  const menu=(a,action)=>{
    if(action==="prefer")setAccounts(list=>list.map(x=>x.provider!==a.provider?x:{...x,pinned:x.id===a.id?!a.pinned:false}));
    if(action==="rename")setRenaming(a.id);
    if(action==="pause")update(a.id,(x)=>({enabled:!x.enabled}));
    if(action==="models"){setModelsOpen(true);setTimeout(()=>document.querySelector("[data-mock-models]")?.scrollIntoView({behavior:"smooth",block:"start"}),0);}
    if(action==="disconnect"){setAccounts(list=>list.filter(x=>x.id!==a.id));if(firstmateAccount===a.id)setFirstmateAccount(null);}
  };
  // A new account is signed in with no reading yet: a hollow dot, and every window "–", never 0.
  const connect=(p)=>{
    setAsking(null);setBusy(p.id);
    setTimeout(()=>{
      setBusy(null);
      const n=accounts.filter(a=>a.provider===p.name).length+1;
      setAccounts(list=>[...list,{id:`${p.id}-${Date.now()}`,provider:p.name,label:n>1?`Account ${n}`:"Personal",sub:p.tier==="api_key"?"API key":"subscription",enabled:true,unread:true,windows:[{label:"session",pace:"unknown"},{label:"weekly",pace:"unknown"}]}]);
    },1200);
  };
  const ordered=PROVIDERS.flatMap(p=>accounts.filter(a=>a.provider===p.name));
  return <div>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
      <span style={label}>AI subscriptions</span>
      <span style={{display:"flex",alignItems:"center",gap:12}}><span style={mono}>as of 15:33</span><Button variant="ghost" size="sm">Refresh</Button></span>
    </div>
    <div style={{...box,overflow:"visible"}}>
      <div>
        {ordered.map((a,i)=><AccountRow key={a.id} a={a} first={i===0} firstmate={firstmateAccount===a.id}
          renaming={renaming===a.id} onRename={(next)=>{update(a.id,()=>({label:next}));setRenaming(null);}} onCancelRename={()=>setRenaming(null)}
          onMenu={(action)=>menu(a,action)}
          onSignIn={()=>update(a.id,()=>({signIn:false,windows:[w("session",100,"behind",5),w("weekly",86,"behind",20)],verdict:{text:"on pace ✓",tone:"accent"}}))}/>)}
      </div>
      <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:10,padding:"10px var(--space-4)",borderTop:"1px solid var(--line-1)"}}>
        <span style={label}>Add account</span>
        <ConnectChips providers={PROVIDERS} accounts={accounts.map(a=>({providerId:providerOf(a.provider).id}))} busyProviderId={busy} variant="foot"
          onConnect={(p)=>p.authTypes.length>1?setAsking(p):connect(p)}/>
      </div>
      {asking&&<div style={{padding:"0 var(--space-4) 12px",display:"flex",flexDirection:"column",gap:8}}>
        <span style={{fontSize:"var(--text-sm)",color:"var(--fg-2)"}}>How do you want to connect {asking.name}?</span>
        <span style={{display:"flex",gap:8}}>
          <Button variant="secondary" size="sm" onClick={()=>connect(asking)}>Sign in with your browser</Button>
          <Button variant="secondary" size="sm" onClick={()=>connect(asking)}>API key</Button>
          <Button variant="ghost" size="sm" onClick={()=>setAsking(null)}>Cancel</Button>
        </span>
      </div>}
    </div>
    <div style={{display:"flex",flexDirection:"column",gap:"var(--space-5)",marginTop:"var(--space-5)"}}>
      <FirstmateModelRow accounts={accounts} chosen={firstmateAccount} onChoose={setFirstmateAccount}/>
      <SettingRow title="Dynamic routing" description="Send work to the slot the work's shape calls for, then to the model with the most of its plan's allowance left. A model set to always use ✱ wins."
        control={<Switch checked={routing} onChange={setRouting}/>}/>
      <ModelsBoard open={modelsOpen} onToggle={()=>setModelsOpen(v=>!v)} levels={levels} setLevels={setLevels} onReset={()=>setLevels(START_LEVELS)}/>
    </div>
  </div>;
}
window.FM_IntelligenceTab=IntelligenceTab;
})();
