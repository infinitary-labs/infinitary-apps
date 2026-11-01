import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { PhoneProxyLaunch } from "./phoneProxyLaunches.ts";

/** Host `ps` readings: comm, never arguments or environment, so sign-ins stay out. */
export type PhoneProcess = { pid: number; parent: number; started: string; executable: string };
export function phoneProcessTable(text: string): PhoneProcess[] {
  return text.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(line);
    return row
      ? [{ pid: Number(row[1]), parent: Number(row[2]), started: row[3]!, executable: row[4]! }]
      : [];
  });
}
export type PhoneWebProcess = {
  app: number;
  pid: number;
  kind: "WebContent" | "GPU";
  /** Native compact-log time, in the same local zone as host ps's lstart. */
  observedAt: string;
  request?: string;
};
type ProcessReader = (pids: number[]) => Promise<PhoneProcess[]>;
type PhoneLaunchOwner = { simulator: string; manager: PhoneProcess; launcher: PhoneProcess };
const sameProcess = (a: PhoneProcess, b: PhoneProcess | undefined) =>
  !!b &&
  a.pid === b.pid &&
  a.parent === b.parent &&
  a.started === b.started &&
  a.executable === b.executable;

/** Establish the simulator manager before XCTest starts, when simctl can still spawn.
 * Subsequent ownership checks use only host process metadata and cannot queue a
 * command behind the simulator launch whose stack we need.
 */
export async function phoneLaunchOwner(
  simulator: string,
  services: string,
  processes: ProcessReader,
): Promise<PhoneLaunchOwner> {
  const pid = Number(/^(\d+)\s+\S+\s+com\.apple\.runningboardd\s*$/m.exec(services)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("The owned simulator has no RunningBoard PID");
  const first = (await processes([pid])).find((process) => process.pid === pid);
  if (!first || !first.executable.endsWith("/runningboardd"))
    throw new Error("The simulator manager is not RunningBoard");
  const current = await processes([pid, first.parent]);
  const launcher = current.find((process) => process.pid === first.parent);
  if (
    !sameProcess(
      first,
      current.find((process) => process.pid === pid),
    ) ||
    !launcher ||
    basename(launcher.executable) !== "launchd_sim"
  )
    throw new Error("The simulator manager or its launchd parent changed during discovery");
  return { simulator, manager: first, launcher };
}

/** Confirm the same isolated simulator processes from host metadata alone.
 * A launchctl command issued now can block behind the very launch being sampled.
 */
export async function phoneLaunchProcesses(
  owner: PhoneLaunchOwner,
  pid: number,
  processes: ProcessReader,
): Promise<PhoneProcess[]> {
  const current = await processes([pid, owner.manager.pid, owner.launcher.pid]);
  const app = current.find((process) => process.pid === pid);
  if (
    !app ||
    app.parent !== owner.launcher.pid ||
    !app.executable.includes(`/CoreSimulator/Devices/${owner.simulator}/`) ||
    !app.executable.endsWith("/Infinitary.app/Infinitary") ||
    !sameProcess(
      owner.manager,
      current.find((process) => process.pid === owner.manager.pid),
    ) ||
    !sameProcess(
      owner.launcher,
      current.find((process) => process.pid === owner.launcher.pid),
    )
  )
    throw new Error("The request no longer belongs to the owned app and simulator processes");
  return [app, owner.manager, owner.launcher];
}

/** A rendering fault names its WebContent PID; native launch/running readings
 * bind GPU PIDs to that app. Confirm their simulator parent, executable and birth
 * time, then re-read identities before sampling. Missing/exited children do not
 * prevent the remaining owned processes from being captured.
 */
export async function phoneRenderProcesses(
  owner: PhoneLaunchOwner,
  pid: number,
  extensions: PhoneWebProcess[],
  processes: ProcessReader,
): Promise<{ targets: PhoneProcess[]; unavailable: string[] }> {
  const ids = [
    ...new Set([pid, owner.manager.pid, owner.launcher.pid, ...extensions.map((p) => p.pid)]),
  ];
  const current = await processes(ids);
  const base = await phoneLaunchProcesses(owner, pid, async () => current);
  const app = base[0]!;
  const unavailable: string[] = [];
  const candidates: PhoneProcess[] = [];
  for (const witness of extensions) {
    const process = current.find((p) => p.pid === witness.pid);
    const born = Date.parse(process?.started ?? "");
    if (
      witness.app !== pid ||
      !process ||
      process.parent !== owner.launcher.pid ||
      basename(process.executable) !== `com.apple.WebKit.${witness.kind}` ||
      !Number.isFinite(born) ||
      born < Date.parse(app.started) ||
      !(born <= Date.parse(witness.observedAt))
    ) {
      unavailable.push(
        `${witness.kind} PID ${witness.pid}: absent, replaced, or not owned by this app and simulator.`,
      );
    } else candidates.push(process);
  }
  if (!extensions.some((p) => p.kind === "GPU"))
    unavailable.push("No GPU PID was observed for this app.");
  const confirmed = await processes([...base, ...candidates].map((p) => p.pid));
  if (
    base.some(
      (p) =>
        !sameProcess(
          p,
          confirmed.find((now) => now.pid === p.pid),
        ),
    )
  )
    throw new Error("The owned app or simulator changed during the rendering-fault lookup");
  const children = candidates.filter((p) => {
    if (
      sameProcess(
        p,
        confirmed.find((now) => now.pid === p.pid),
      )
    )
      return true;
    unavailable.push(`PID ${p.pid}: exited or changed identity during the rendering-fault lookup.`);
    return false;
  });
  return { targets: [...children, ...base], unavailable };
}

/** INF-1936: a launcher-file spawn binds this child to the app and simulator.
 * The second-resolution host birth time must match the native spawn second.
 * The child may already have execed its intended target while the launcher still
 * reports xpcproxy; retain that actual executable rather than guessing its phase.
 */
export async function phoneProxyProcess(
  owner: PhoneLaunchOwner,
  launch: PhoneProxyLaunch,
  processes: ProcessReader,
): Promise<PhoneProcess> {
  const current = await processes([launch.app, launch.pid, owner.manager.pid, owner.launcher.pid]);
  const base = await phoneLaunchProcesses(owner, launch.app, async () => current);
  const child = current.find((p) => p.pid === launch.pid);
  const born = Date.parse(child?.started ?? "");
  const spawned = Date.parse(launch.at);
  if (
    !child ||
    child.parent !== owner.launcher.pid ||
    !["xpcproxy_sim", `com.apple.WebKit.${launch.kind}`].includes(basename(child.executable)) ||
    !Number.isFinite(born) ||
    !Number.isFinite(spawned) ||
    born < Date.parse(base[0]!.started) ||
    Math.floor(born / 1000) !== Math.floor(spawned / 1000)
  )
    throw new Error("The proxy child is absent, replaced, or not owned by this app and simulator");
  const confirmed = await processes([...base, child].map((p) => p.pid));
  if (
    [...base, child].some(
      (p) =>
        !sameProcess(
          p,
          confirmed.find((now) => now.pid === p.pid),
        ),
    )
  )
    throw new Error("The proxy child, app or simulator changed during discovery");
  return child;
}

/** INF-1066: capture the missing blocking stack on the real UIKit fault, not after
 * the typing wait has expired. One capture per owned part; never another process,
 * a tap retry, or a new readiness condition. Cleanup joins the sampler.
 */
export function capturePhoneKeyboardTimeout({
  evidence,
  currentPid,
  sample,
}: {
  evidence: string;
  currentPid(): Promise<number>;
  sample(pid: number, destination: string): Promise<void>;
}) {
  let capture: Promise<void> | undefined;
  let closed = false;
  const status = join(evidence, "keyboard-timeout-capture.log");
  return {
    receive(line: string) {
      if (closed || capture) return;
      // The compact reading comes only from this part's simulator log stream.
      const fault =
        /\bInfinitary\[(\d+):[^\]]+\] \[com\.apple\.UIKit:KeyboardTaskQueue\].* Keyboard queue task timeout detected$/.exec(
          line,
        );
      if (!fault) return;
      const pid = Number(fault[1]);
      const observed = `Observed at ${new Date().toISOString()}\n${line}\n`;
      let started = "";
      writeFileSync(status, observed);
      capture = (async () => {
        if ((await currentPid()) !== pid)
          throw new Error(
            "The fault's app no longer owns that PID on this simulator; no process was sampled",
          );
        started = `Sampling began at ${new Date().toISOString()}\n`;
        writeFileSync(status, observed + started);
        await sample(pid, join(evidence, "keyboard-timeout-stack.log"));
        writeFileSync(
          status,
          `${observed}${started}Completed owned app stack capture at ${new Date().toISOString()}\n`,
        );
      })().catch((error: unknown) => {
        writeFileSync(
          status,
          `${observed}${started}Stack capture failed: ${String(error)}\nNo retry was made.\n`,
        );
      });
    },
    async close() {
      closed = true;
      await capture;
      if (!capture)
        writeFileSync(
          status,
          "No UIKit keyboard-queue timeout was observed; no stack capture or reproduction is claimed.\n",
        );
    },
  };
}
