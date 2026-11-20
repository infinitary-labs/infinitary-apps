import type { Scenario } from "../mockProvider";

export const RESOURCE_USE_MARKER = "observe my background job";
export const RESOURCE_USE_READY = ".resource-use-ready";
export const RESOURCE_USE_RELEASE = ".resource-use-release";

/**
 * INF-1621: real resident memory and process lifetime, ended by a file rather than a timed sleep.
 * The job looks at the release file itself through Node's stat polling (`fs.watchFile`).
 * A directory watch (`fs.watch`) rides macOS's file events, which reach the job seconds late or
 * never, so on a Mac the job outlived its release and the record kept its process (INF-2633).
 */
export const resourceUse: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (
      isFirstmate ||
      !wantsStream ||
      hasToolResults ||
      !latestUserTail.includes(RESOURCE_USE_MARKER)
    )
      return undefined;
    const release = JSON.stringify(RESOURCE_USE_RELEASE);
    const program = `const fs=require('node:fs');const memory=Buffer.alloc(4*1024*1024,1);const release=()=>{fs.unwatchFile(${release});console.log(memory.length)};fs.watchFile(${release},{interval:50},(now)=>{if(now.isFile())release()});fs.writeFileSync(${JSON.stringify(RESOURCE_USE_READY)},'ready');if(fs.existsSync(${release}))release();console.log('observing')`;
    return {
      calls: [
        { name: "bash", args: { command: `node -e ${JSON.stringify(program)}`, background: true } },
      ],
    };
  };
