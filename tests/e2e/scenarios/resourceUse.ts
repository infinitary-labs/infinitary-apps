import type { Scenario } from "../mockProvider";

export const RESOURCE_USE_MARKER = "observe my background job";
export const RESOURCE_USE_READY = ".resource-use-ready";
export const RESOURCE_USE_RELEASE = ".resource-use-release";

/** INF-1621: real resident memory and process lifetime, ended by a file rather than a timed sleep. */
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
    const program = `const fs=require('node:fs');const memory=Buffer.alloc(4*1024*1024,1);const watch=fs.watch('.',(_,file)=>{if(file===${JSON.stringify(RESOURCE_USE_RELEASE)}){console.log(memory.length);watch.close()}});fs.writeFileSync(${JSON.stringify(RESOURCE_USE_READY)},'ready');if(fs.existsSync(${JSON.stringify(RESOURCE_USE_RELEASE)})){watch.close()}console.log('observing')`;
    return {
      calls: [
        { name: "bash", args: { command: `node -e ${JSON.stringify(program)}`, background: true } },
      ],
    };
  };
