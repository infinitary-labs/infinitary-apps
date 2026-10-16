import React from "react";
// The Firstmate: a 4D tesseract projection of lines and dots. Animation reflects state.
// idle = near-still drift · listening = rotation freezes, structure breathes with the voice · working = fast double rotation + shimmer + pulsing nodes
const FM_STATES={
  idle:{sa:0.05,sb:0.03,pulse:0.05,glow:0.35,shimmer:0,breath:0,flat:0,heat:0},
  listening:{sa:0.015,sb:0.01,pulse:0.5,glow:1,shimmer:0,breath:0.09,flat:1,heat:0},
  working:{sa:1.15,sb:0.78,pulse:0.9,glow:1,shimmer:0.5,breath:0,flat:0,heat:1}
};
FM_STATES.thinking=FM_STATES.working; // legacy alias — thinking and working are one state
function fmRgba(c,a){c=c.trim();if(c[0]==="#"){const n=parseInt(c.slice(1),16);return "rgba("+(n>>16&255)+","+(n>>8&255)+","+(n&255)+","+a+")";}if(c.indexOf("rgb(")===0)return c.replace("rgb(","rgba(").replace(")",","+a+")");return c;}
function fmRgb(c){c=c.trim();if(c[0]==="#"){const n=parseInt(c.slice(1),16);return [n>>16&255,n>>8&255,n&255];}const m=c.match(/[\d.]+/g);return m?[+m[0],+m[1],+m[2]]:[127,220,255];}
function fmMix(A,B,t){return "rgb("+Math.round(A[0]+(B[0]-A[0])*t)+","+Math.round(A[1]+(B[1]-A[1])*t)+","+Math.round(A[2]+(B[2]-A[2])*t)+")";}
function tesseract(){
  const v=[];for(let i=0;i<16;i++)v.push([i&1?1:-1,i&2?1:-1,i&4?1:-1,i&8?1:-1]);
  const e=[];for(let i=0;i<16;i++)for(let j=i+1;j<16;j++){let d=0;for(let k=0;k<4;k++)if(v[i][k]!==v[j][k])d++;if(d===1)e.push([i,j]);}
  return {v,e};
}
const {v:FM_V,e:FM_E}=tesseract();
// Listening form (TARS-style shapeshift): the 16 vertices reassemble into two concentric hexagons + an inner square — all three are true cycles of the tesseract graph, so the wires simply glide into rings.
const FM_RINGS=[[0,1,5,4,12,8],[9,11,10,14,15,13],[2,3,7,6]];
const FM_FLAT=new Array(16);FM_RINGS.forEach((cyc,ri)=>cyc.forEach((v,k)=>FM_FLAT[v]={ri,k,n:cyc.length}));
const FM_RING_R=[1,0.62,0.3],FM_RING_DIR=[1,-1,1.6]; // radius + spin direction per ring (counter-rotating)
const FM_RINGEDGE=FM_E.map(([p,q])=>{const A=FM_FLAT[p],B=FM_FLAT[q];return A.ri===B.ri&&((A.k+1)%A.n===B.k||(B.k+1)%B.n===A.k);});
export function Firstmate({state="idle",size=280,level=0,kick=0,style}){
  const ref=React.useRef(null);
  const stateRef=React.useRef(state);stateRef.current=state;
  const levelRef=React.useRef(level);levelRef.current=level;
  const kickRef=React.useRef(kick);kickRef.current=kick;
  React.useEffect(()=>{
    const canvas=ref.current,ctx=canvas.getContext("2d");
    const dpr=window.devicePixelRatio||1;
    canvas.width=size*dpr;canvas.height=size*dpr;
    let accent="#7fdcff",dim="#5d6884",hot="#ffa257",accRgb=fmRgb(accent),dimRgb=fmRgb(dim),hotRgb=fmRgb(hot),boost=1,lastRead=0;
    let raf,a=0.4,b=0.9,hs=0,vel=0.5,lastKick=kickRef.current,last=performance.now();
    const cur={sa:0.05,sb:0.03,pulse:0.05,glow:0.35,shimmer:0,breath:0,flat:0,heat:0};
    function frame(now){
      if(now-lastRead>400){ // re-read theme colors so a live theme switch re-paints the character
        const cs=getComputedStyle(canvas);
        accent=(cs.getPropertyValue("--wire-accent")||cs.getPropertyValue("--accent")||accent).trim();
        dim=(cs.getPropertyValue("--wire-dim")||cs.getPropertyValue("--fg-3")||dim).trim();
        hot=(cs.getPropertyValue("--wire-hot")||hot).trim();
        boost=parseFloat(cs.getPropertyValue("--wire-boost"))||1;
        accRgb=fmRgb(accent);dimRgb=fmRgb(dim);hotRgb=fmRgb(hot);
        lastRead=now;
      }
      const dt=Math.min((now-last)/1000,0.05);last=now;
      const t=FM_STATES[stateRef.current]||FM_STATES.idle;
      for(const k in cur)cur[k]+=(t[k]-cur[k])*Math.min(dt*4,1); // ease between states — the shapeshift is this same continuous blend
      // listening spin: default velocity, accelerated by voice level and keystroke kicks, decaying smoothly back
      if(kickRef.current!==lastKick){vel=Math.min(vel+(kickRef.current-lastKick)*1.4,30);lastKick=kickRef.current;}
      vel+=(0.5+(levelRef.current||0)*6-vel)*Math.min(dt*1.5,1);
      a+=cur.sa*dt;b+=cur.sb*dt;hs+=dt*vel*cur.flat;
      const c=size/2;
      // working runs hot: bright wires blend from ice cyan to ember, glow follows; the far side heats too (darker ember) so both ends stay one family
      const briRgb=[accRgb[0]+(hotRgb[0]-accRgb[0])*cur.heat,accRgb[1]+(hotRgb[1]-accRgb[1])*cur.heat,accRgb[2]+(hotRgb[2]-accRgb[2])*cur.heat];
      const dimRgbUse=[dimRgb[0]+(hotRgb[0]*0.55-dimRgb[0])*cur.heat,dimRgb[1]+(hotRgb[1]*0.5-dimRgb[1])*cur.heat,dimRgb[2]+(hotRgb[2]*0.45-dimRgb[2])*cur.heat];
      const glowCol=fmMix(accRgb,hotRgb,cur.heat);
      // listening: slow deep breath + live voice level; other states stay dimensionally steady
      const breathe=1+cur.breath*Math.sin(now/650)+(levelRef.current||0)*cur.breath*1.6;
      const R=size*0.27*breathe;
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,size,size);
      // ambient glow — pulses gently while listening
      const glowA=cur.glow*(0.10+cur.heat*0.16+cur.breath*0.6*(0.5+0.5*Math.sin(now/650)));
      const g=ctx.createRadialGradient(c,c,0,c,c,size/2);
      g.addColorStop(0,fmRgba(glowCol,glowA));g.addColorStop(1,fmRgba(glowCol,0));
      ctx.fillStyle=g;ctx.fillRect(0,0,size,size);
      // rotate xw & yz, project 4D->3D->2D
      const ca=Math.cos(a),sa2=Math.sin(a),cb=Math.cos(b),sb2=Math.sin(b);
      const pts=FM_V.map(([x,y,z,w])=>{
        const x1=x*ca-w*sa2,w1=x*sa2+w*ca;
        const y1=y*cb-z*sb2,z1=y*sb2+z*cb;
        const k4=2.6/(2.6-w1*0.55);
        const X=x1*k4,Y=y1*k4,Z=z1*k4;
        const k3=3.4/(3.4-Z*0.5);
        return [c+X*k3*R*0.5,c+Y*k3*R*0.5,(k4+k3)/2,w1];
      });
      // morph toward the flat listening form: lerp every projected vertex to its ring slot
      const f=cur.flat*cur.flat*(3-2*cur.flat);
      if(f>0.001){
        const Rf=size*0.40*breathe;
        for(let i=0;i<16;i++){
          const F=FM_FLAT[i],ang=FM_RING_DIR[F.ri]*hs+F.k/F.n*Math.PI*2-Math.PI/2;
          const P=pts[i];
          P[0]+=(c+Math.cos(ang)*FM_RING_R[F.ri]*Rf-P[0])*f;
          P[1]+=(c+Math.sin(ang)*FM_RING_R[F.ri]*Rf-P[1])*f;
        }
      }
      ctx.lineWidth=1.4;
      // neon pass: hot wires cast a real glow (canvas shadow) and get a white-hot core
      const neon=cur.heat;
      if(neon>0.02){ctx.shadowColor=fmRgba(fmMix(hotRgb,[255,236,200],0.3),Math.min(1,0.9*neon));ctx.shadowBlur=14*neon*(size/280);}
      for(let i=0;i<FM_E.length;i++){
        const [p,q]=FM_E[i],P=pts[p],Q=pts[q];
        const depth=(P[2]+Q[2])/2-0.9;
        let alpha=Math.max(0.3,Math.min(0.9,0.35+depth*0.5))*boost;
        if(cur.shimmer>0)alpha*=1-cur.shimmer*0.3*(0.5+0.5*Math.sin(now/240+i*2.7)); // gentle, low-frequency shimmer — fast alpha strobing flickers badly under acrylic blur
        // in the flat form only ring edges remain; cross edges (spokes) fade out with the morph
        if(!FM_RINGEDGE[i]){alpha*=1-f;if(alpha<0.02)continue;}
        else alpha+=(Math.min(1,0.85*boost)-alpha)*f;
        // smooth inner/outer blend on w — no discrete color/alpha pop as edges cross w=0
        const m=Math.max(Math.max(0,Math.min(1,0.5+(P[3]+Q[3])*0.35)),f*0.9);
        ctx.strokeStyle=fmMix(dimRgbUse,briRgb,m);ctx.globalAlpha=Math.min(1,alpha*(0.85+0.15*m));
        ctx.beginPath();ctx.moveTo(P[0],P[1]);ctx.lineTo(Q[0],Q[1]);ctx.stroke();
        if(neon>0.02&&m>0.5){ // white-hot filament core on the bright edges
          ctx.globalAlpha=Math.min(1,alpha)*neon*0.85;
          ctx.strokeStyle=fmMix(briRgb,[255,244,224],0.75);
          ctx.lineWidth=0.7;ctx.beginPath();ctx.moveTo(P[0],P[1]);ctx.lineTo(Q[0],Q[1]);ctx.stroke();ctx.lineWidth=1.4;
        }
      }
      for(let i=0;i<pts.length;i++){
        const P=pts[i];
        const pulse=1+cur.pulse*0.6*Math.max(0,Math.sin(now/300+i*0.8));
        const m=Math.max(Math.max(0,Math.min(1,0.5+P[3]*0.6)),f);
        const r=(2.1+0.7*m)*pulse*(size/280);
        ctx.globalAlpha=Math.min(1,Math.max(0.65,Math.min(1,0.6+(P[2]-0.9)*0.5))*boost);
        ctx.fillStyle=fmMix(dimRgbUse,briRgb,Math.max(m,0.35)); // keep far-side dots from dimming into bright foreground lines
        ctx.beginPath();ctx.arc(P[0],P[1],r,0,Math.PI*2);ctx.fill();
        if(neon>0.02&&m>0.4){ // incandescent dot cores
          ctx.globalAlpha=neon;
          ctx.fillStyle=fmMix(briRgb,[255,248,235],0.8);
          ctx.beginPath();ctx.arc(P[0],P[1],r*0.45,0,Math.PI*2);ctx.fill();
        }
      }
      ctx.shadowBlur=0;
      ctx.globalAlpha=1;
      raf=requestAnimationFrame(frame);
    }
    raf=requestAnimationFrame(frame);
    return ()=>cancelAnimationFrame(raf);
  },[size]);
  return <canvas ref={ref} aria-label={"First mate — "+state} style={{width:size,height:size,display:"block",...style}}></canvas>;
}
