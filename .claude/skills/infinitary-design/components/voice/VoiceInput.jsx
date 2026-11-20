import React from "react";
import {IconButton} from "../core/IconButton.jsx";
import {KeyCap} from "../core/KeyCap.jsx";
const vicoS={fill:"none",stroke:"currentColor",strokeWidth:1.5,strokeLinecap:"round",strokeLinejoin:"round"};
const VIco={
  x:<svg width="16" height="16" viewBox="0 0 24 24" {...vicoS}><path d="M18 6 6 18M6 6l12 12"/></svg>,
  check:<svg width="16" height="16" viewBox="0 0 24 24" {...vicoS}><path d="M20 6 9 17l-5-5"/></svg>,
  up:<svg width="16" height="16" viewBox="0 0 24 24" {...vicoS}><path d="m5 12 7-7 7 7M12 19V5"/></svg>
};
function Waveform({level=0.6,height=28}){
  const ref=React.useRef(null);
  const levelRef=React.useRef(level);levelRef.current=level;
  React.useEffect(()=>{
    const canvas=ref.current,ctx=canvas.getContext("2d");
    const dpr=window.devicePixelRatio||1;
    let raf,w=0,accent="#7fdcff",lastRead=0;
    function frame(now){
      if(now-lastRead>400){accent=(getComputedStyle(canvas).getPropertyValue("--accent")||accent).trim();lastRead=now;}
      const cw=canvas.clientWidth;
      if(cw!==w){w=cw;canvas.width=w*dpr;canvas.height=height*dpr;}
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,height);
      const n=Math.floor(w/5);
      ctx.fillStyle=accent;
      for(let i=0;i<n;i++){
        const ph=now/180+i*0.9;
        const env=Math.exp(-Math.pow((i-n/2)/(n/2.6),2)); // taper at both ends
        const h=Math.max(2,(Math.sin(ph)*0.5+0.5)*(0.3+0.7*levelRef.current)*height*env);
        ctx.globalAlpha=0.4+0.6*env;
        ctx.fillRect(i*5,(height-h)/2,2.5,h);
      }
      raf=requestAnimationFrame(frame);
    }
    raf=requestAnimationFrame(frame);
    return ()=>cancelAnimationFrame(raf);
  },[height]);
  return <canvas ref={ref} style={{width:"100%",height,display:"block"}}></canvas>;
}
// An odd number of ``` fence lines before the caret: Enter adds a line there.
function insideOpenFence(text,caret){
  return text.slice(0,caret).split("\n").filter((line)=>/^[ \t]*```/.test(line)).length%2===1;
}
const MAX_LINES=8;
// The mock of the app's composer (the app's src/renderer/src/design/voice/VoiceInput.tsx is the reference):
// a pill at one line, growing upward to 8 lines with the radius held at --prompt-radius; the foot row
// (hint + send) appears once the draft is multi-line, and recording keeps the draft on screen.
export function VoiceInput({mode="idle",keybindHint="type, or press/hold right ⌥ to talk",disabled=false,value="",onChange,level=0.6,onActivate,onAbandon,onAccept,onSubmit,onFocusChange,onKeystroke,width=560,style}){
  const [focus,setFocus]=React.useState(false);
  const [wrapped,setWrapped]=React.useState(false);
  const [fence,setFence]=React.useState(false);
  const ref=React.useRef(null);
  const recording=mode==="recording";
  const sendable=Boolean(value&&value.trim());
  const multiLine=value.includes("\n")||wrapped;
  const foot=multiLine||recording;
  const showText=!(recording&&!value);
  React.useLayoutEffect(()=>{
    const el=ref.current;if(!el)return;
    const line=parseFloat(getComputedStyle(el).lineHeight)||24.8;
    el.style.height="auto";
    const content=value?el.scrollHeight:line;
    el.style.height=Math.max(line,Math.min(content,MAX_LINES*line))+"px";
    el.style.overflowY=content>MAX_LINES*line?"auto":"hidden";
    setWrapped(content>line*1.5);
  },[value,width,foot]);
  const shell={display:"flex",flexDirection:"column",width,boxSizing:"border-box",minHeight:"var(--prompt-height)",padding:"0 10px",borderRadius:"var(--prompt-radius)",background:"transparent",border:"1px solid "+(recording||focus?"var(--line-2)":"var(--line-1)"),boxShadow:recording?"var(--glow-accent)":focus?"var(--focus-ring)":"var(--shadow-1)",opacity:disabled?0.45:1,transition:"border-color var(--dur-med) var(--ease-out),box-shadow var(--dur-med) var(--ease-out),opacity var(--dur-slow) var(--ease-out)",...style};
  const send=<IconButton label="Submit" tone="accent" onClick={onSubmit} style={{background:"var(--accent-dim)",flexShrink:0}}>{VIco.up}</IconButton>;
  const keys=(e)=>{
    if(e.key!=="Enter"){onKeystroke&&onKeystroke();return;}
    e.preventDefault();
    if(e.nativeEvent.isComposing||e.keyCode===229||recording)return;
    const el=e.currentTarget;
    const newline=!(e.metaKey||e.ctrlKey)&&(e.shiftKey||e.altKey||insideOpenFence(el.value,el.selectionStart));
    if(newline){el.setRangeText("\n",el.selectionStart,el.selectionEnd,"end");onChange&&onChange({target:el});return;}
    if(sendable&&onSubmit)onSubmit();
  };
  // Plain click focuses the input for typing; voice activation is keybind-only (onActivate is wired by the host to the key, not to click).
  // Disabled (the first-launch gate): no typing, no submit; the stage's caption says what to do.
  return <div style={shell}>
    {showText&&<div style={{display:"flex",alignItems:"center",gap:10,flex:"1 0 auto",padding:"12px 0"}}>
      <textarea ref={ref} rows={1} value={value} disabled={disabled} readOnly={recording} onChange={onChange}
        onFocus={()=>{setFocus(true);onFocusChange&&onFocusChange(true);}} onBlur={()=>{setFocus(false);onFocusChange&&onFocusChange(false);}}
        onKeyDown={keys} onSelect={(e)=>setFence(insideOpenFence(e.currentTarget.value,e.currentTarget.selectionStart))} placeholder={keybindHint}
        style={{flex:1,minWidth:0,resize:"none",background:"transparent",border:"none",outline:"none",fontFamily:"var(--font-ui)",fontSize:"var(--text-md)",lineHeight:"var(--leading-body)",color:"var(--fg-1)",padding:"0 8px",paddingRight:foot?50:8,opacity:recording?0.55:1}}/>
      {!foot&&sendable&&!disabled?send:null}
    </div>}
    {foot&&<div style={{display:"flex",alignItems:"center",gap:10,paddingBottom:recording&&!showText?0:8,minHeight:recording&&!showText?50:undefined}}>
      {recording?<>
        <IconButton label="Abandon" tone="danger" onClick={onAbandon}>{VIco.x}</IconButton>
        <div style={{flex:1,minWidth:0}}><Waveform level={level}/></div>
        <IconButton label="Accept" tone="ok" onClick={onAccept}>{VIco.check}</IconButton>
        {send}
      </>:<>
        <span style={{flex:1,display:"flex",alignItems:"center",gap:4,padding:"0 8px",fontSize:"var(--text-sm)",color:"var(--fg-3)"}}>
          {fence?<>in a code block <KeyCap>⏎</KeyCap> adds a line · <KeyCap>⌘⏎</KeyCap> sends</>:<><KeyCap>⏎</KeyCap> send · <KeyCap>⇧⏎</KeyCap> new line</>}
        </span>
        {sendable&&!disabled?send:null}
      </>}
    </div>}
  </div>;
}
