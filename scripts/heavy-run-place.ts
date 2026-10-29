import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { Socket } from "node:net";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { LOAD_COMMAND } from "../src/shared/load.ts";
import { type CrewPlaceKind, takeCrewPlace } from "./crew-place.ts";

/** INF-1621 piece 3 (INF-1664): a local heavy run declares its needs in the
 * load line of the computer it runs on (docs/heavy-runs.md) and holds them
 * until it ends. The captain's "Add the fallback, no alpha needed": a shell
 * whose app has no line asks the Mac mini's crew place service exactly as
 * before (scripts/crew-place.ts). The run says which path it took.
 */
export type HeavyRunPlace = { close(): void };

/** What each kind declares: the shares the Mac mini's crew places reserve for it
 * (dotfiles-private home-manager/mac-home.nix, sized from DOP-113's measured runs).
 */
export const HEAVY_RUN_NEEDS: Record<CrewPlaceKind, { processors: number; memoryMib: number }> = {
  phone: { processors: 4, memoryMib: 8192 },
  journeys: { processors: 4, memoryMib: 4096 },
};

/** What a run says about the path it took. */
export const heavyRunWords = {
  asking: (kind: CrewPlaceKind) =>
    `Asking this computer's load line for ${HEAVY_RUN_NEEDS[kind].processors} processors and ${HEAVY_RUN_NEEDS[kind].memoryMib} MiB (${LOAD_COMMAND}).`,
  admitted: (kind: CrewPlaceKind) =>
    `Admitted by this computer's load line; holding ${HEAVY_RUN_NEEDS[kind].processors} processors and ${HEAVY_RUN_NEEDS[kind].memoryMib} MiB until this run ends.`,
  borrowed: (place: string) => `This run rides borrowed place ${place}; asking neither the load line nor a crew place.`,
  noLine: `${LOAD_COMMAND} is not available in this shell; asking the Mac mini's crew place service instead.`,
};

/** Runs the load command and outlives the gate. However the gate ends, even
 * stopped with its whole process group, its end closes this input: a run still
 * waiting then leaves the line instead of holding its place until admitted.
 */
// A POSIX shell may replace a background list's stdin with /dev/null before
// applying its redirects. Keep the gate's pipe on fd 3 so dash can restore it.
const SUPERVISE = `exec 3<&0
"$@" <&3 3<&- &
run=$!
(cat; for group in $(pgrep -P "$run"); do kill -TERM "-$group"; done) <&3 3<&- >/dev/null 2>&1 &
watch=$!
exec 3<&-
wait "$run"
status=$?
kill "$watch" 2>/dev/null
exit "$status"`;

/** The admitted program: it names its hold, then lives until the gate's input closes. */
const HOLD = `printf '%s\\n' "$INFINITARY_LOAD_HOLD"; exec cat >/dev/null`;

function onPath(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const command = join(dir, LOAD_COMMAND);
    try {
      accessSync(command, constants.X_OK);
      return command;
    } catch {}
  }
  return undefined;
}

/** The task's line answers a bare read of its declared runs. Like the command's
 * own wrapper, the short request answers itself rather than wait as a shell's job.
 */
function lineAnswers(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(command, [], {
      env: {
        ...env,
        INFINITARY_SHELL_CAP_MS: "",
        FM3000_SHELL_CAP_MS: "", // the older name still reads as this limit
        INFINITARY_SHELL_ID: "",
      },
      stdio: "ignore",
    });
    child.once("error", () => done(false));
    child.once("exit", (code) => done(code === 0));
  });
}

function takeLine(
  command: string,
  kind: CrewPlaceKind,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
): Promise<HeavyRunPlace> {
  const { processors, memoryMib } = HEAVY_RUN_NEEDS[kind];
  log(heavyRunWords.asking(kind));
  const child = spawn(
    "/bin/sh",
    ["-c", SUPERVISE, "sh", command, "run", "--processors", `${processors}`, "--memory-mib", `${memoryMib}`, "--", "/bin/sh", "-c", HOLD],
    // Inside a run the caller already declared, the hold stays in that run's
    // group, where the app checks the outer declaration covers this one.
    { env, stdio: ["pipe", "pipe", "pipe"], detached: !env.INFINITARY_LOAD_HOLD },
  );
  // The command prints where the run stands in line on its error output.
  let told = "";
  createInterface({ input: child.stderr }).on("line", (line) => {
    told += `${line}\n`;
    log(line);
  });
  return new Promise((done, reject) => {
    child.once("error", reject);
    createInterface({ input: child.stdout }).once("line", () => {
      log(heavyRunWords.admitted(kind));
      // From here the gate's own work keeps it alive, and its end ends the hold.
      child.unref();
      for (const stream of [child.stdin, child.stdout, child.stderr]) (stream as unknown as Socket).unref();
      done({ close: () => child.stdin.destroy() });
    });
    child.once("close", (code) => {
      child.stdin.destroy();
      reject(new Error(`This computer's load line did not admit this run (exit ${code}).\n${told.trimEnd()}`));
    });
  });
}

/** Waits for a place for a local heavy run and holds it until close() or this
 * process ends. In CI the job already holds its runner's place and asks nothing.
 */
export async function takeHeavyRunPlace(
  kind: CrewPlaceKind,
  label: string,
  options: Parameters<typeof takeCrewPlace>[2] = {},
): Promise<HeavyRunPlace> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.error(line));
  if (env.BORROWED_PLACE) {
    log(heavyRunWords.borrowed(env.BORROWED_PLACE));
    return { close() {} };
  }
  if (env.CI) return { close() {} };
  const command = onPath(env);
  if (command && (await lineAnswers(command, env))) return takeLine(command, kind, env, log);
  log(heavyRunWords.noLine);
  return takeCrewPlace(kind, label, { ...options, env, log });
}
