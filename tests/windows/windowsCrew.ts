import type { Scenario } from "../e2e/mockProvider";
import type { ScriptedCall } from "../helpers/scriptedCalls";

/**
 * The crewmate the Windows installer check scripts (docs/windows.md, "The
 * checks"): on a small Node project it runs git status, pnpm install, one
 * test file and a build in Git Bash, runs a task command, then starts a
 * background job whose program starts a child of its own, and ends its turn
 * with the job still running. Each command prints its step's mark only
 * when it succeeded; the mark is split by quotes in the command, so a
 * request carries it only in a command's output.
 */

export const WINDOWS_CREW_MARKER = "check the crew on Windows";

/** The file the background job writes its own and its child's process numbers to. */
export const JOB_PIDS_FILE = "job-pids.txt";

export const WINDOWS_CREW_STEPS = [
  { id: "git-status", command: "git status --short --branch" },
  { id: "pnpm-install", command: "pnpm install" },
  { id: "test-file", command: "pnpm exec node --test test/sum.test.mjs" },
  { id: "build", command: "pnpm build" },
  { id: "task-command", command: "infinitary-stops-axi" },
] as const;

export const stepMark = (id: string) => `WINDOWS-STEP-${id}`;

/** The job: a program that starts a child, writes both numbers, and runs until stopped. */
const JOB = `node -e "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync('${JOB_PIDS_FILE}',process.pid+' '+c.pid);setInterval(()=>{},1000)"`;

export const windowsCrew: Scenario = () => (request) => {
  const { isFirstmate, wantsStream, body } = request;
  if (isFirstmate || !wantsStream || !body.includes(WINDOWS_CREW_MARKER)) return undefined;
  for (const step of WINDOWS_CREW_STEPS) {
    if (body.includes(stepMark(step.id))) continue;
    const command = `${step.command} && echo WINDOWS-STEP-"${step.id}"`;
    // Asked once already (the request holds the command's quoted mark) and
    // no mark came back: the step failed; stop there.
    if (body.includes(`WINDOWS-STEP-\\"${step.id}`)) return { text: `The ${step.id} step failed.` };
    const call: ScriptedCall = { name: "bash", args: { command } };
    return { calls: [call] };
  }
  if (!body.includes(JOB_PIDS_FILE)) {
    const call: ScriptedCall = { name: "bash", args: { command: JOB, background: true } };
    return { calls: [call] };
  }
  return undefined;
};
