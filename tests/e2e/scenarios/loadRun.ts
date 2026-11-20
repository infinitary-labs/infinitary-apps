import { LOAD_COMMAND } from "../../../src/shared/load";
import type { Scenario } from "../mockProvider";

export const LOAD_RUN_MARKER = "wait for capacity for my heavy run";
export const LOAD_RUN_READY = ".load-run-ready";
export const LOAD_RUN_RELEASE = ".load-run-release";
export const LOAD_RUN_DEMAND = { cpu: 0.25, memoryBytes: 64 * 1024 ** 2 };

/**
 * INF-1621 piece 2: a real program starts only after the task's declared run is admitted.
 * The program looks at the release file itself through Node's stat polling (`fs.watchFile`).
 * A directory watch (`fs.watch`) rides macOS's file events, which reach the program seconds late
 * or never, so on a Mac the declared run outlived its release (INF-2633).
 */
export const loadRun: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream || hasToolResults || !latestUserTail.includes(LOAD_RUN_MARKER))
      return undefined;
    const release = JSON.stringify(LOAD_RUN_RELEASE);
    const program = `const fs=require('node:fs');const release=()=>fs.unwatchFile(${release});fs.watchFile(${release},{interval:50},(now)=>{if(now.isFile())release()});fs.writeFileSync(${JSON.stringify(LOAD_RUN_READY)},'admitted');if(fs.existsSync(${release}))release();console.log('admitted')`;
    return {
      calls: [
        {
          name: "bash",
          args: {
            command: `${LOAD_COMMAND} run --processors ${LOAD_RUN_DEMAND.cpu} --memory-mib ${LOAD_RUN_DEMAND.memoryBytes / 1024 ** 2} -- node -e ${JSON.stringify(program)}`,
            background: true,
            description: "Run the declared program after capacity is available",
          },
        },
      ],
    };
  };
