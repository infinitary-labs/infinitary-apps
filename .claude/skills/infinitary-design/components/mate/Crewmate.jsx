import React from "react";
// A crewmate: 3D wireframe tetrahedron — the simplest solid, clearly subordinate to the 4D Firstmate.
// Color says the same thing the Firstmate and the now panel say: ember (--wire-hot) while working, ice cyan (--wire-accent) while idle.
// Idle recedes by alpha and a slower spin, never by a second hue.
const s3=1/Math.sqrt(3);
const CM_V=[[s3,s3,s3],[s3,-s3,-s3],[-s3,s3,-s3],[-s3,-s3,s3]];
const CM_E=[[0,1],[0,2],[0,3],[1,2],[1,3],[2,3]];
export function Crewmate({status="idle",size=28,style}){
  const ref=React.useRef(null);
  const statusRef=React.useRef(status);statusRef.current=status;
  React.useEffect(()=>{
    const canvas=ref.current,ctx=canvas.getContext("2d");
    const dpr=window.devicePixelRatio||1;
    canvas.width=size*dpr;canvas.height=size*dpr;
    let hot="#ffa257",accent="#7fdcff",boost=1,lastRead=0;
    let raf,a=Math.random()*6,last=performance.now(),speed=0.1;
    function frame(now){
      if(now-lastRead>400){ // live theme switches re-paint
        const cs=getComputedStyle(canvas);
        hot=(cs.getPropertyValue("--wire-hot")||cs.getPropertyValue("--hot")||hot).trim();
        accent=(cs.getPropertyValue("--wire-accent")||cs.getPropertyValue("--accent")||accent).trim();
        boost=parseFloat(cs.getPropertyValue("--wire-boost"))||1;
        lastRead=now;
      }
      const dt=Math.min((now-last)/1000,0.05);last=now;
      const working=statusRef.current==="working";
      speed+=((working?1.3:0.3)-speed)*Math.min(dt*3,1); // idle keeps a slow visible spin
      a+=speed*dt;
      const c=size/2,R=size*0.4,color=working?hot:accent; // ember while working, cyan while idle
      const ca=Math.cos(a),sa=Math.sin(a),cb=Math.cos(a*0.6),sb=Math.sin(a*0.6);
      ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,size,size);
      const pts=CM_V.map(([x,y,z])=>{
        const x1=x*ca-z*sa,z1=x*sa+z*ca;
        const y1=y*cb-z1*sb,z2=y*sb+z1*cb;
        const k=3/(3-z2);
        return [c+x1*k*R,c+y1*k*R,k];
      });
      ctx.lineWidth=1.4;
      for(const [p,q] of CM_E){
        const P=pts[p],Q=pts[q];
        ctx.strokeStyle=color;ctx.globalAlpha=Math.min(1,Math.max(0.35,Math.min(0.9,0.4+((P[2]+Q[2])/2-0.85)*0.9))*(working?1:0.6)*boost);
        ctx.beginPath();ctx.moveTo(P[0],P[1]);ctx.lineTo(Q[0],Q[1]);ctx.stroke();
      }
      ctx.fillStyle=color;
      for(const P of pts){
        ctx.globalAlpha=Math.min(1,Math.max(0.5,Math.min(1,0.5+(P[2]-0.85)*0.8))*(working?1:0.6)*boost);
        ctx.beginPath();ctx.arc(P[0],P[1],1.2*(size/28),0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=1;
      raf=requestAnimationFrame(frame);
    }
    raf=requestAnimationFrame(frame);
    return ()=>cancelAnimationFrame(raf);
  },[size]);
  return <canvas ref={ref} aria-label={"Crewmate — "+status} style={{width:size,height:size,display:"block",...style}}></canvas>;
}
