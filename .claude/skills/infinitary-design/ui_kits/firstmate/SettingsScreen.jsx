const NS2=window.InfinitaryDesignSystem_94f559;
const {Button,Input,Switch,KeyCap,MachineRow}=NS2;
const {GroupedPills}=window.GroupedPills;
// Settings → Devices (components/devices/DevicesTab.prompt.md). The link and commands are fake and drawn from memory only.
const KEY="Vq3oP8h1sLx0w2yT6mZkNcE4rB7aJ9dGfQ5uHi3KeAo";
const LINK=`infinitary://join?as=mac&at=192.168.1.20:47623&key=${KEY}&code=…`;
const PANELS={
  link:{label:"New link",say:"Paste this link into Infinitary on your other computer, at its first launch.",text:LINK,copy:"Copy link",joined:"iMac joined. It can control your first mate and run its work.",
    add:{id:"imac",name:"iMac",detail:"a computer · joined today 15:20 · seen just now",summary:"Controlling your first mate now · Runs no project yet · No sign-ins yet"}},
  mac:{label:"New command · another computer",say:"Run this once in Terminal on the other computer, as the user who should run its work. It gets Infinitary from this computer, so both need the same network.",
    text:`curl -fsSk --pinnedpubkey 'sha256//${KEY}=' https://192.168.1.20:47623/work | sh -s '${LINK}'`,copy:"Copy command",joined:"Mac mini joined. It has git and Claude Code, and no sign-ins yet.",
    add:{id:"mini",name:"Mac mini",detail:"a computer · joined today 15:22 · seen just now",summary:"Runs no project yet · No sign-ins yet"}},
  user:{label:"New command · running as another user",say:"Log in as the user who should run the work, and run this once in Terminal. Switch back when it says it joined.",
    text:`'/Applications/Infinitary.app/Contents/MacOS/Infinitary' 'work' 'join' 'infinitary://join?as=user&at=127.0.0.1:47623&key=${KEY}&code=…'`,copy:"Copy command",joined:"Running as Builder is set up. It runs work only, and has no sign-ins yet.",
    add:{id:"builder",name:"Running as Builder",detail:"another user on this computer · runs work only, while Builder is logged in · seen just now",summary:"Runs no project yet · No sign-ins yet"}}
};
const ADDRESSES=[{value:"192.168.1.20",kind:"this network"},{value:"100.101.7.3",kind:"private network"}];
const THIS_MAC={id:"here",name:"This computer",detail:"MacBook Pro · your first mate lives here",summary:"Runs website, api and notes · Signed in to Codex, Claude and GitHub",state:"1 task",busy:true};
function SectionLabel({children}){return <div style={{fontSize:"var(--text-xs)",fontWeight:500,letterSpacing:"var(--tracking-label)",textTransform:"uppercase",color:"var(--fg-3)",marginBottom:14}}>{children}</div>;}
const box={background:"var(--bg-1)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)"};
const boxRow={display:"flex",alignItems:"center",gap:14,padding:"14px 18px",borderTop:"1px solid var(--line-1)"};
const mono={fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"};
const chip={display:"inline-flex",alignItems:"center",gap:6,padding:"4px 12px",border:"1px solid var(--line-2)",borderRadius:"var(--radius-pill)",background:"var(--bg-1)",color:"var(--fg-1)",fontFamily:"var(--font-ui)",fontSize:"var(--text-sm)",cursor:"pointer"};
function Dot({tone}){return <span style={{width:7,height:7,borderRadius:"50%",flexShrink:0,background:tone==="ok"?"var(--ok)":"var(--idle)",boxShadow:tone==="ok"?"0 0 8px var(--ok)":"none"}}></span>;}
function DevicesTab(){
  const [devices,setDevices]=React.useState([{id:"air",name:"MacBook Air",detail:"a computer · joined today 14:06 · seen just now",summary:"Controlling your first mate now · Runs no project yet · No sign-ins yet"}]);
  const [removing,setRemoving]=React.useState(null);
  const [panel,setPanel]=React.useState(null);
  const [choosing,setChoosing]=React.useState(null);
  const [copied,setCopied]=React.useState(false);
  const [address,setAddress]=React.useState(ADDRESSES[0].value);
  const [remote,setRemote]=React.useState("sam@mini.local");
  React.useEffect(()=>{
    if(!panel||panel.state!=="open")return;
    if(panel.left===0){setPanel({...panel,state:"expired"});return;}
    const tick=setTimeout(()=>setPanel({...panel,left:panel.left-1}),1000);
    return ()=>clearTimeout(tick);
  },[panel]);
  const mmss=(n)=>`${Math.floor(n/60)}:${String(n%60).padStart(2,"0")}`;
  const add=(d)=>setDevices(list=>list.some(x=>x.id===d.id)?list:d.id==="builder"?[d,...list]:[...list,d]);
  const open=(kind)=>{setChoosing(null);setCopied(false);setPanel({kind,state:"open",left:600});};
  const joinMock=()=>{setPanel({...panel,state:"joined"});add(PANELS[panel.kind].add);};
  const addByAddress=()=>{
    setChoosing(null);
    add({id:"mini",name:"Mac mini",tone:"idle",detail:"a computer",summary:`Reaching ${remote} with your SSH key…`});
    setTimeout(()=>setDevices(list=>list.map(x=>x.id==="mini"?{id:"mini",name:"Mac mini",detail:`a computer · ${remote} · seen just now`,summary:"Runs no project yet · No sign-ins yet"}:x)),1200);
  };
  const p=panel&&PANELS[panel.kind];
  const rows=[THIS_MAC,...devices];
  return <div>
    {p&&panel.state==="open"&&<div style={{...box,borderColor:"var(--accent)",padding:"14px 18px",marginBottom:24}}>
      <SectionLabel>{p.label}</SectionLabel>
      <div style={{fontSize:"var(--text-sm)",color:"var(--fg-2)",margin:"-6px 0 10px"}}>{p.say}</div>
      <div style={{display:"flex",gap:10,alignItems:"center"}}>
        <code style={{...mono,color:"var(--fg-1)",flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",background:"var(--bg-0)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-s)",padding:"7px 10px"}}>{p.text}</code>
        <Button size="sm" onClick={()=>{setCopied(true);setTimeout(()=>setCopied(false),1500);}}>{copied?"Copied":p.copy}</Button>
      </div>
      <div style={{display:"flex",gap:12,alignItems:"center",marginTop:10}}>
        <span style={mono}>works once · {mmss(panel.left)} left</span>
        <Button variant="ghost" size="sm" onClick={()=>setPanel(null)}>Stop it</Button>
        <span style={{flex:1}}></span>
        <Button variant="secondary" size="sm" onClick={joinMock}>Mock: it joins</Button>
      </div>
    </div>}
    {p&&panel.state==="joined"&&<div style={{...box,borderColor:"var(--line-2)",padding:"14px 18px",marginBottom:24,display:"flex",alignItems:"center",gap:10}}>
      <Dot tone="ok"/><div style={{flex:1}}><div style={{color:"var(--fg-1)"}}>{p.joined}</div><div style={{fontSize:"var(--text-sm)",color:"var(--fg-2)"}}>Give it a project in Projects when you want it to run work.</div></div>
      <Button variant="ghost" size="sm" onClick={()=>setPanel(null)}>Done</Button>
    </div>}
    {p&&panel.state==="expired"&&<div style={{...box,borderColor:"var(--line-2)",padding:"14px 18px",marginBottom:24,display:"flex",alignItems:"center",gap:10}}>
      <div style={{flex:1}}><div style={{color:"var(--fg-1)"}}>{panel.kind==="link"?"The link expired before any computer used it.":"The command expired before any computer used it."}</div><div style={{fontSize:"var(--text-sm)",color:"var(--fg-2)"}}>Make a new one when the other computer is ready.</div></div>
      <Button variant="secondary" size="sm" onClick={()=>open(panel.kind)}>Make a new one</Button>
    </div>}
    <SectionLabel>Your devices</SectionLabel>
    <div style={{fontSize:"var(--text-sm)",color:"var(--fg-2)",margin:"-6px 0 12px"}}>Your first mate lives on this computer. From any computer you add you can control it, and any computer you add can run a project’s work. Running as another user on this computer runs work, and your first mate can move there. Like every user here, it can read files in your home folder.</div>
    <div style={{...box,marginBottom:28}}>
      {rows.map((d,i)=>{
        const edge=i===0?{}:{borderTop:"1px solid var(--line-1)"};
        if(removing===d.id)return <div key={d.id} style={{...boxRow,...(i===0?{borderTop:"none"}:{})}}>
          <Dot tone="ok"/>
          <div style={{flex:1}}><div style={{fontSize:"var(--text-sm)",color:"var(--fg-1)"}}>Remove {d.name}? It is cut off at once.</div><div style={{fontSize:"var(--text-sm)",color:"var(--fg-2)"}}>To come back, it needs a new link.</div></div>
          <Button variant="ghost" size="sm" onClick={()=>setRemoving(null)}>Keep it</Button>
          <Button variant="danger" size="sm" onClick={()=>{setDevices(list=>list.filter(x=>x.id!==d.id));setRemoving(null);}}>Remove</Button>
        </div>;
        return <MachineRow key={d.id} style={edge} name={d.name} detail={d.detail} summary={d.summary} state={d.state} busy={d.busy} tone={d.tone||"ok"}
          action={d.id==="here"||d.tone==="idle"?null:<Button variant="secondary" size="sm" onClick={()=>setRemoving(d.id)}>Remove</Button>}/>;
      })}
      <div style={boxRow}>
        <span style={{...mono,letterSpacing:"var(--tracking-label)",textTransform:"uppercase"}}>Add</span>
        <button type="button" onClick={()=>setChoosing("how")} style={chip}><span aria-hidden="true" style={{color:"var(--fg-3)"}}>+</span>A computer</button>
        <button type="button" onClick={()=>open("user")} style={chip}><span aria-hidden="true" style={{color:"var(--fg-3)"}}>+</span>Running as another user</button>
      </div>
      {choosing==="how"&&<div style={{...boxRow,display:"block"}}>
        <div style={{fontSize:"var(--text-base)",color:"var(--fg-1)",fontWeight:500}}>How do you want to add it?</div>
        <div style={{fontSize:"var(--text-sm)",color:"var(--fg-2)",marginBottom:10}}>Each way adds the same kind of computer. Pick the one that suits it.</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <Button variant="secondary" size="sm" onClick={()=>open("link")}>Paste a link into Infinitary there</Button>
          <Button variant="secondary" size="sm" onClick={()=>open("mac")}>Run a command there</Button>
          <Button variant="secondary" size="sm" onClick={()=>setChoosing("address")}>By its address</Button>
          <Button variant="ghost" size="sm" onClick={()=>setChoosing(null)}>Cancel</Button>
        </div>
      </div>}
      {choosing==="address"&&<div style={{...boxRow,display:"block"}}>
        <div style={{fontSize:"var(--text-base)",color:"var(--fg-1)",fontWeight:500}}>The other computer’s address</div>
        <div style={{fontSize:"var(--text-sm)",color:"var(--fg-2)",marginBottom:10}}>The one you use with SSH. Remote Login must be on there.</div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <Input mono placeholder="you@mini.local" value={remote} onChange={e=>setRemote(e.target.value)} style={{flex:1}}/>
          <Button size="sm" onClick={addByAddress}>Add it</Button>
          <Button variant="ghost" size="sm" onClick={()=>setChoosing(null)}>Cancel</Button>
        </div>
      </div>}
    </div>
    <SectionLabel>How other devices find this computer</SectionLabel>
    <div style={box}>
      <div style={{...boxRow}}>
        <span className="fm-dot" data-tone="ok"/>
        <span style={{flex:1}}>
          <div style={{fontWeight:500}}>On this network</div>
          <div style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>192.168.4.48 · kuns-macbook-pro.local</div>
          <div style={{fontSize:"var(--text-sm)",color:"var(--fg-2)"}}>Computers on the same Wi-Fi or cable network.</div>
        </span>
        <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>ready</span>
      </div>
      <div style={{...boxRow,borderTop:"1px solid var(--line-1)"}}>
        <span className="fm-dot" data-tone="ok"/>
        <span style={{flex:1}}>
          <div style={{fontWeight:500}}>On your private network</div>
          <div style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>100.102.217.78</div>
          <div style={{fontSize:"var(--text-sm)",color:"var(--fg-2)"}}>Computers on the same private network, wherever they are.</div>
        </span>
        <span style={{fontFamily:"var(--font-mono)",fontSize:"var(--text-xs)",color:"var(--fg-3)"}}>ready</span>
      </div>
      <div style={{padding:"12px 18px",borderTop:"1px solid var(--line-1)",fontSize:"var(--text-sm)",color:"var(--fg-2)"}}>
        A link or command carries every way at once. The other computer uses whichever one answers, so there is nothing to choose here.
        <div style={{display:"flex",gap:8,marginTop:10}}>
          <Button size="sm" variant="secondary">Copy a link</Button>
          <Button size="sm" variant="secondary">Copy a command</Button>
        </div>
      </div>
    </div>
  </div>;
}
function SettingsScreen({theme,onTheme}){
  const [tab,setTab]=React.useState("general");
  const [wash,setWash]=React.useState(0);
  const [modelNames,setModelNames]=React.useState(true);
  const [dictation,setDictation]=React.useState(true);
  const [dictationKey,setDictationKey]=React.useState("right ⌥");
  const [pickingKey,setPickingKey]=React.useState(false);
  React.useEffect(()=>{
    if(!pickingKey)return;
    const pick=(event)=>{
      event.preventDefault();event.stopImmediatePropagation();
      if(event.key==="Escape"){setPickingKey(false);return;}
      const label={AltRight:"right ⌥",MetaRight:"right ⌘",ControlRight:"right ⌃"}[event.code];
      if(label){setDictationKey(label);setPickingKey(false);}
    };
    window.addEventListener("keydown",pick,true);
    return ()=>window.removeEventListener("keydown",pick,true);
  },[pickingKey]);
  const [loginStart,setLoginStart]=React.useState(true);
  const [dock,setDock]=React.useState(false);
  return <div data-screen-label="Settings" style={{position:"absolute",inset:0,paddingTop:64,display:"flex",justifyContent:"center",overflowY:"auto"}}>
    <div style={{width:960,maxWidth:"100%",boxSizing:"border-box",padding:"8px 20px 48px",display:"flex",alignItems:"flex-start",gap:32}}>
      {/* The tab column (components/core/SettingsTabs.prompt.md). */}
      <div role="tablist" aria-orientation="vertical" style={{position:"sticky",top:0,flex:"0 0 168px",display:"flex",flexDirection:"column",gap:2}}>
        {[["general","General"],["appearance","Appearance"],["projects","Projects"],["intelligence","Intelligence"],["devices","Devices"]].map(([id,label])=>
          <button key={id} role="tab" aria-selected={tab===id} onClick={()=>setTab(id)} style={{position:"relative",display:"flex",alignItems:"center",height:32,padding:"var(--space-2) var(--space-3)",border:"none",borderRadius:"var(--radius-s)",background:tab===id?"var(--bg-2)":"transparent",cursor:"pointer",fontFamily:"var(--font-ui)",fontSize:"var(--text-base)",fontWeight:500,color:tab===id?"var(--fg-1)":"var(--fg-3)",textAlign:"left"}}>
            {tab===id&&<span aria-hidden="true" style={{position:"absolute",top:6,bottom:6,left:0,width:2,borderRadius:1,background:"var(--accent)"}}/>}
            {label}
          </button>)}
      </div>
      <div style={{flex:"1 1 0",minWidth:0,maxWidth:720}}>
      {tab==="general"&&<div>
        <SectionLabel>General</SectionLabel>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",background:"var(--bg-1)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)"}}>
            <div>
              <div style={{fontSize:"var(--text-base)",color:"var(--fg-1)",fontWeight:500}}>Start at login</div>
              <div style={{fontSize:"var(--text-sm)",color:"var(--fg-3)"}}>Launch Infinitary when you sign in.</div>
            </div>
            <Switch checked={loginStart} onChange={setLoginStart}/>
          </div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",background:"var(--bg-1)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)"}}>
            <div>
              <div style={{fontSize:"var(--text-base)",color:"var(--fg-1)",fontWeight:500}}>Show in dock</div>
              <div style={{fontSize:"var(--text-sm)",color:"var(--fg-3)"}}>Off keeps Infinitary in the menu bar only.</div>
            </div>
            <Switch checked={dock} onChange={setDock}/>
          </div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",background:"var(--bg-1)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)"}}>
            <div>
              <div style={{fontSize:"var(--text-base)",color:"var(--fg-1)",fontWeight:500}}>Dictation</div>
              <div style={{fontSize:"var(--text-sm)",color:"var(--fg-3)"}}>{pickingKey?`Press right ⌥, right ⌘ or right ⌃ to hold for dictation. Esc keeps ${dictationKey}.`:"Press or hold the key to talk instead of typing, transcribed on this computer. Off leaves the key and the microphone to other apps."}</div>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:"var(--space-3)",flexShrink:0}}>
              <Button variant="secondary" size="sm" disabled={!dictation} onClick={()=>setPickingKey(true)}>{pickingKey?"press a key…":<>right <KeyCap size="sm">{dictationKey.slice(-1)}</KeyCap></>}</Button>
              <Switch checked={dictation} onChange={(enabled)=>{setDictation(enabled);setPickingKey(false);}}/>
            </div>
          </div>
        </div>
      </div>}
      {tab==="appearance"&&<div>
        <SectionLabel>Appearance</SectionLabel>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",background:"var(--bg-1)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)"}}>
            <div>
              <div style={{fontSize:"var(--text-base)",color:"var(--fg-1)",fontWeight:500}}>Theme</div>
              <div style={{fontSize:"var(--text-sm)",color:"var(--fg-3)"}}>Deep-space dark, or daylight light.</div>
            </div>
            <GroupedPills name="Theme" htmlName="theme" value={theme} options={[{value:"dark",label:"Dark"},{value:"light",label:"Light"}]} onChange={v=>{if(v!==theme)onTheme();}}/>
          </div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",background:"var(--bg-1)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)"}}>
            <div><div style={{fontSize:"var(--text-base)",color:"var(--fg-1)",fontWeight:500}}>Window wash</div><div style={{fontSize:"var(--text-sm)",color:"var(--fg-3)"}}>How much of the theme color covers the blurred background. 0% is the default.</div></div>
            <label><input aria-label="Window wash" type="range" min={0} max={100} value={wash} onChange={e=>setWash(Number(e.target.value))}/><span style={{fontFamily:"var(--font-mono)"}}>{wash}%</span></label>
          </div>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"14px 18px",background:"var(--bg-1)",border:"1px solid var(--line-1)",borderRadius:"var(--radius-m)"}}>
            <div><div style={{fontSize:"var(--text-base)",color:"var(--fg-1)",fontWeight:500}}>Crew model names</div><div style={{fontSize:"var(--text-sm)",color:"var(--fg-3)"}}>Show model names while crewmates use only one orbit.</div></div>
            <Switch checked={modelNames} onChange={setModelNames}/>
          </div>
        </div>
      </div>}
      {tab==="projects"&&<window.FM_ProjectsTab/>}
      {tab==="intelligence"&&<window.FM_IntelligenceTab/>}
      {tab==="devices"&&<DevicesTab/>}
      </div>
    </div>
  </div>;
}
window.FM_SettingsScreen=SettingsScreen;
