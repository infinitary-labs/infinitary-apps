const NS=window.InfinitaryDesignSystem_94f559;
const {Firstmate,Crewmate,CrewStrip,ActivityFeed,VoiceInput,ResponseCard,CardStack,Button,IconButton,Badge,Switch,QuotaMeter,SubscriptionCard,MachineRow,Input,KeyCap}=NS;
const appIcoS={fill:"none",stroke:"currentColor",strokeWidth:1.5,strokeLinecap:"round",strokeLinejoin:"round"};
const AppIco={
  gear:<svg width="16" height="16" viewBox="0 0 24 24" {...appIcoS}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>,
  back:<svg width="16" height="16" viewBox="0 0 24 24" {...appIcoS}><path d="m15 18-6-6 6-6"/></svg>,
  sun:<svg width="15" height="15" viewBox="0 0 24 24" {...appIcoS}><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
};
const DEMO_CARDS=[
  {kind:"decision",title:"Two ways to fix the flaky test",meta:"just now · crewmate 4",body:"The retry helper races a 50ms timer. Awaiting the job queue removes the race entirely; mocking the clock is faster but leaves the race in production code.",actions:["Mock the clock","Await the queue"]},
  {kind:"note",title:"Refactor finished",meta:"2m ago · atlas",body:"14 files changed, tests green. Two snapshots updated; nothing else moved.",actions:[]},
  {kind:"attention",title:"Claude (Personal) needs you to sign in again.",meta:"claude",body:"Your first mate cannot use this subscription until you sign in again.",actions:["Sign in"]}
];
const now=Date.now();
const DEMO_EVENTS=[
  {time:now-1140000,kind:"spawn",text:"crewmate spawned — refactor auth middleware"},
  {time:now-960000,kind:"report",text:"auth tests green on atlas"},
  {time:now-840000,kind:"done",text:"crewmate decommissioned — auth middleware landed"},
  {time:now-720000,kind:"report",text:"test matrix green across 3 machines"},
  {time:now-540000,kind:"done",text:"crewmate decommissioned — lint sweep complete"},
  {time:now-420000,kind:"spawn",text:"crewmate spawned — typecheck the settings tree"},
  {time:now-300000,kind:"report",text:"no new type errors"},
  {time:now-180000,kind:"spawn",text:"crewmate spawned — investigate flaky CI job"},
  {time:now-120000,kind:"report",text:"flake isolated to retry helper"},
  {time:now-60000,kind:"report",text:"found root cause: race in retry helper"},
  {time:now-30000,kind:"done",text:"crewmate decommissioned — flake fix up for review"},
  {time:now,kind:"spawn",text:"crewmate spawned — widen the home activity feed"}
];
function TopBar({view,onSettings,onBack,theme,onTheme,working}){
  return <div style={{position:"absolute",top:0,left:0,right:0,height:52,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 16px",WebkitAppRegion:"drag"}}>
    <div style={{display:"flex",alignItems:"center",gap:10}}>
      {view==="settings"?<IconButton label="Back" onClick={onBack}>{AppIco.back}</IconButton>
        :<span style={{fontSize:"var(--text-sm)",fontWeight:500,color:"var(--fg-3)",letterSpacing:"var(--tracking-display)"}}>Infinitary</span>}
      {view==="settings"&&<span style={{fontSize:"var(--text-base)",color:"var(--fg-1)",fontWeight:500}}>Settings</span>}
    </div>
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      {view!=="settings"&&<IconButton label="Settings" onClick={onSettings}>{AppIco.gear}</IconButton>}
    </div>
  </div>;
}
function HomeScreen({phase,setPhase,cardIdx,setCardIdx,dismiss}){
  const working=phase==="working"||phase==="thinking";
  const showCards=phase==="working";
  const [typing,setTyping]=React.useState(false);
  const [text,setText]=React.useState("");
  const [kick,setKick]=React.useState(0);
  const listening=phase==="recording"||(typing&&text.length>0);
  const card=DEMO_CARDS[cardIdx];
  const timerRef=React.useRef(null);
  React.useEffect(()=>()=>clearTimeout(timerRef.current),[]);
  // The input grows upward from its pinned bottom; its growth is published as --prompt-rise and the
  // Firstmate and the card lift by half of it (components/voice/VoiceInput.prompt.md, "The stage lifts").
  const promptRef=React.useRef(null);
  React.useEffect(()=>{
    const el=promptRef.current;if(!el)return;
    const root=document.documentElement;
    const ro=new ResizeObserver(()=>{
      const shell=el.firstElementChild;if(!shell)return;
      const rise=Math.max(0,shell.getBoundingClientRect().height-parseFloat(getComputedStyle(shell).minHeight));
      root.style.setProperty("--prompt-rise",rise+"px");
    });
    ro.observe(el);
    return ()=>{ro.disconnect();root.style.removeProperty("--prompt-rise");};
  },[]);
  const lift="calc(50% - 60px - var(--prompt-rise, 0px) / 2)";
  const liftEase="top var(--dur-fast) var(--ease-out)";
  const submit=()=>{setText("");setPhase("thinking");setCardIdx(0);clearTimeout(timerRef.current);timerRef.current=setTimeout(()=>setPhase("working"),5000);};
  // Vertical geometry: the input is pinned by its bottom; the Firstmate layer and card layer lift by half its growth.
  return <div data-screen-label={showCards?"Working":listening?"Listening":"Null state"} style={{position:"absolute",inset:0}}>
    {/* Firstmate stays put in the back — cards float in front; when the stack empties he's revealed again */}
    <div style={{position:"absolute",left:"50%",top:lift,transform:"translate(-50%,-50%)",opacity:showCards?0.45:1,filter:showCards?"blur(3px)":"none",transition:"opacity var(--dur-slow) var(--ease-out),filter var(--dur-slow) var(--ease-out),"+liftEase}}>
      <Firstmate state={listening?"listening":working?"working":"idle"} size={300} level={phase==="recording"?0.6:0} kick={kick}/>
    </div>
    {showCards&&<div style={{position:"absolute",left:"50%",top:lift,transform:"translate(-50%,-50%)",transition:liftEase}}>
      <CardStack index={cardIdx} count={DEMO_CARDS.length} width={560}
        onPrev={()=>setCardIdx(Math.max(0,cardIdx-1))} onNext={()=>setCardIdx(Math.min(DEMO_CARDS.length-1,cardIdx+1))}>
        <ResponseCard kind={card.kind} title={card.title} meta={card.meta} onClose={dismiss}
          actions={card.actions.length>0?card.actions.map((a,i)=><Button key={a} variant={i===card.actions.length-1?"primary":"secondary"} onClick={dismiss}>{a}</Button>):undefined}>
          {card.body}
        </ResponseCard>
      </CardStack>
    </div>}
    <div ref={promptRef} style={{position:"absolute",left:"50%",bottom:96,transform:"translateX(-50%)",display:"flex",flexDirection:"column",alignItems:"center",gap:10}}>
      <VoiceInput mode={phase==="recording"?"recording":"idle"} width={560} level={0.6}
        value={text} onChange={(e)=>setText(e.target.value)}
        onFocusChange={setTyping} onKeystroke={()=>setKick(k=>k+1)}
        onAbandon={()=>setPhase(working?"working":"idle")}
        onAccept={()=>setPhase(working?"working":"idle")}
        onSubmit={submit}/>
    </div>
  </div>;
}
function App(){
  const [theme,setTheme]=React.useState("dark");
  const [view,setView]=React.useState("home");
  const [phase,setPhase]=React.useState("idle");
  const [cardIdx,setCardIdx]=React.useState(0);
  React.useEffect(()=>{document.body.dataset.theme=theme;},[theme]);
  React.useEffect(()=>{
    const h=(e)=>{
      if(e.key==="Escape"&&phase==="recording"){setPhase("idle");return;}
      if(e.key==="Alt"&&e.location===2&&phase!=="recording"&&view==="home"){e.preventDefault();setPhase("recording");}
    };
    window.addEventListener("keydown",h);return ()=>window.removeEventListener("keydown",h);
  },[phase,view]);
  const working=phase==="working"||phase==="thinking";
  return <div style={{position:"absolute",inset:0,background:"var(--bg-0)",overflow:"hidden",fontFamily:"var(--font-ui)"}}>
    {view==="home"&&<HomeScreen phase={phase} setPhase={setPhase} cardIdx={cardIdx} setCardIdx={setCardIdx} dismiss={()=>setPhase("idle")}/>}
    {view==="settings"&&<window.FM_SettingsScreen theme={theme} onTheme={()=>setTheme(theme==="dark"?"light":"dark")}/>}
    <TopBar view={view} working={working&&view==="home"} theme={theme} onTheme={()=>setTheme(theme==="dark"?"light":"dark")} onSettings={()=>setView("settings")} onBack={()=>setView("home")}/>
    {view==="home"&&<div style={{position:"absolute",left:16,bottom:14,display:"flex",flexDirection:"column",alignItems:"flex-start",gap:8}}>
      {working&&ActivityFeed&&<ActivityFeed events={DEMO_EVENTS} style={{maxWidth:"calc(50vw - 320px)",height:"33vh"}}/>}
      <CrewStrip working={working?3:0} idle={working?5:8}/>
    </div>}
  </div>;
}
window.FM_App=App;
