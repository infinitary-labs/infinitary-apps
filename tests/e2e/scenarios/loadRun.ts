import { LOAD_COMMAND } from "../../../src/shared/load";
import type { Scenario } from "../mockProvider";

export const LOAD_RUN_MARKER = "wait for capacity for my heavy run";
export const LOAD_RUN_READY = ".load-run-ready";
export const LOAD_RUN_RELEASE = ".load-run-release";
export const LOAD_RUN_DEMAND = { cpu: 0.25, memoryBytes: 64 * 1024 ** 2 };

/** INF-1621 piece 2: a real program starts only after the task's declared run is admitted. */
export const loadRun: Scenario =
  () =>
  ({ isFirstmate, wantsStream, latestUserTail, hasToolResults }) => {
    if (isFirstmate || !wantsStream || hasToolResults || !latestUserTail.includes(LOAD_RUN_MARKER))
      return undefined;
    const program = `const fs=require('node:fs');const watch=fs.watch('.',(_,file)=>{if(file===${JSON.stringify(LOAD_RUN_RELEASE)})watch.close()});fs.writeFileSync(${JSON.stringify(LOAD_RUN_READY)},'admitted');if(fs.existsSync(${JSON.stringify(LOAD_RUN_RELEASE)}))watch.close();console.log('admitted')`;
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
