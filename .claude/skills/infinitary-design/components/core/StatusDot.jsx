import React from "react";
// One 6px dot per list row in place of a status Badge: the calm way to say
// "signed in" eleven times on one screen. Filled ok = signed in with a
// reading; ring (hollow) = signed in with no reading yet; warn = a stale
// last-known-good; danger = sign in again; idle = paused; busy = work in
// flight on this row (ember, the working crewmate's heat: a personal panel
// a task is still building); captain = the captain's own hold on this row
// (violet: a task's browser while he has control of it).
const fills={ok:"var(--ok)",warn:"var(--warn)",danger:"var(--danger)",idle:"var(--idle)",busy:"var(--hot)",captain:"var(--captain)"};
export function StatusDot({tone="ring",label,style}){
  const ring=tone==="ring";
  return <span role="img" aria-label={label} title={label} style={{display:"inline-block",width:6,height:6,borderRadius:"50%",flexShrink:0,boxSizing:"border-box",background:ring?"transparent":fills[tone]||fills.idle,border:ring?"1px solid var(--fg-2)":"none",...style}}></span>;
}
