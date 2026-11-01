/** INF-1936: one diagnostic observer outside the phone runner's high-volume log consumer.
 * It starts both sides' samplers before XCTest, independently of process lookups.
 * This is observation only: it changes no native test, deadline, retry or readiness condition.
 */
import { type ChildProcess, fork, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { phoneGuestLaunches } from "../tests/helpers/phoneGuestLaunches.ts";
import { observePhoneLog } from "../tests/helpers/phoneLogs.ts";
import { observePhoneLauncherLog, phoneLauncherLogSource, phoneSimulatorLogDirectory } from "../tests/helpers/phoneLauncherLog.ts";
import { observePhoneLookupWait, phoneDiagnosticSampleIntervalMs, phoneDiagnosticSampleSeconds } from "../tests/helpers/phoneLookupWait.ts";
import { keepPhoneDiagnostic } from "./phone-checks.ts";
import { phoneLaunchOwner, phoneLaunchProcesses, phoneProcessTable, phoneProxyProcess } from "../tests/helpers/phoneStacks.ts";
import { observePhoneProxyLaunches } from "../tests/helpers/phoneProxyLaunches.ts";

type Owner = Awaited<ReturnType<typeof phoneLaunchOwner>>;
type Configuration = {
  owner: Owner;
  evidence: string;
  // The runner supplies its existing XCTest allowance, not a new test timeout.
  sampleSeconds: number;
  // Supplied by the runner's hostEnv(), including its disposable HOME.
  env: NodeJS.ProcessEnv;
};

export async function startPhoneGuestObserver(configuration: Configuration, children: Set<ChildProcess>) {
  mkdirSync(configuration.evidence, { recursive: true });
  const output = createWriteStream(join(configuration.evidence, "worker.log"));
  const written = new Promise<void>((resolve, reject) => {
    output.once("finish", resolve); output.once("error", reject);
  });
  void written.catch(() => {});
  const child = fork(fileURLToPath(import.meta.url), ["guest-observer"], {
    env: configuration.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  child.stdout?.on("data", (data: Buffer) => output.write(data));
  child.stderr?.on("data", (data: Buffer) => output.write(data));
  const exited = new Promise<void>((resolve) => child.once("close", () => {
    children.delete(child); output.end(); resolve();
  }));
  let stopSent = false;
  const stop = () => {
    if (stopSent) return;
    stopSent = true;
    if (child.connected) child.send({ kind: "stop" });
  };
  const close = async () => {
    stop();
    await exited;
    await written;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("message", (message) => {
        if (typeof message === "object" && message !== null && "kind" in message && message.kind === "ready") resolve();
      });
      child.once("error", reject);
      child.once("close", () => reject(new Error("The guest observer stopped before it was ready")));
      child.send(configuration);
    });
    return { close, stop };
  } catch (error) {
    await keepPhoneDiagnostic("Guest observer startup cleanup", close);
    throw error;
  }
}

async function observeGuest(configuration: Configuration) {
  const { owner, evidence, sampleSeconds, env } = configuration;
  const children = new Set<ChildProcess>();
  const timeline = createWriteStream(join(evidence, "events.log"));
  const timelineWritten = new Promise<void>((resolve, reject) => {
    timeline.once("finish", resolve); timeline.once("error", reject);
  });
  void timelineWritten.catch(() => {});
  const record = (event: string, detail: Record<string, unknown> = {}) => {
    timeline.write(JSON.stringify({ at: new Date().toISOString(), monotonicMs: performance.now(), event, ...detail }) + "\n");
    if (event === "launcher-log-error") proxyWatch.stop();
  };
  let stopping = false;
  let stopped!: () => void;
  const stopRequested = new Promise<void>((resolve) => { stopped = resolve; });
  const stop = () => {
    stopping = true; stopped();
    stopSamplers("The observer was asked to stop");
    stopProxies();
    lookupWatch?.cancel();
    void launcherLog?.close().catch((error: unknown) => record("launcher-log-error", { error: String(error) }));
    for (const child of children) if (!isSampler(child)) child.kill("SIGTERM");
  };
  process.on("message", (message) => {
    if (typeof message === "object" && message !== null && "kind" in message && message.kind === "stop") stop();
  });
  process.once("disconnect", stop);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let number = 0;
  const run = (name: string, command: string, args: string[], onOutput?: (text: string) => void) => {
    if (stopping) throw new Error("The guest observer is stopping");
    const id = `${++number}-${name}`;
    record("spawn-call", { id, command, args });
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    record("spawn-return", { id, pid: child.pid });
    children.add(child);
    let output = "";
    let first = true;
    const receive = (pipe: string, data: Buffer) => {
      if (first) { first = false; record("first-output", { id, pipe, bytes: data.length }); }
      output += data.toString();
      onOutput?.(data.toString());
    };
    child.stdout.on("data", (data: Buffer) => receive("stdout", data));
    child.stderr.on("data", (data: Buffer) => receive("stderr", data));
    const readers = (["stdout", "stderr"] as const).map((pipe) => {
      const reader = createInterface({ input: child[pipe] });
      reader.on("line", (line) => record("output-line", { id, pipe, line }));
      return reader;
    });
    child.once("spawn", () => record("spawn", { id, pid: child.pid }));
    let problem: Error | undefined;
    child.once("error", (error) => { problem = error; record("error", { id, error: String(error) }); });
    child.once("exit", (code, signal) => record("exit", { id, code, signal }));
    const result = new Promise<{ output: string; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("close", (code, signal) => {
        record("close", { id, code, signal });
        for (const reader of readers) reader.close();
        children.delete(child);
        const path = join(evidence, `${id}.log`);
        record("file-write-start", { id, path });
        void writeFile(path, output).then(() => {
          record("file-write-end", { id, path });
          if (problem) reject(problem);
          else resolve({ output, code, signal });
        }, (error: unknown) => {
          record("file-write-error", { id, error: String(error) }); reject(error);
        });
      });
    });
    return { child, result };
  };
  const processes = (name: string) => async (pids: number[]) => {
    const command = run(name, "/bin/ps", ["-p", pids.join(","), "-o", "pid=,ppid=,lstart=,comm="]);
    if (name === "lookup") lookupWatch = observePhoneLookupWait(command.child, async (pid) => {
      // ps is setuid: retain the wait witness, never attempt unprivileged sampling.
      // The proposed guest-wide kernel capture will include this child too.
      record("lookup-stalled", { pid, capture: "Guest-wide kernel capture requires approval" });
    });
    const result = await command.result;
    if (result.code !== 0) throw new Error(`Process lookup exited ${result.code} (${result.signal})`);
    return phoneProcessTable(result.output);
  };
  const assessSample = async (path: string, role: string) => {
    try {
      const text = await readFile(path, "utf8");
      // A command's success is not a stack. Empty graphs remain missing evidence.
      const graph = text.split("Call graph:")[1]?.split("Total number in stack")[0] ?? "";
      record("sample-evidence", { role, path, hasThreadSamples: /^\s+\d+ Thread_/m.test(graph) });
    } catch (error) { record("sample-evidence", { role, path, hasThreadSamples: false, error: String(error) }); }
  };
  let log: Awaited<ReturnType<typeof observePhoneLog>> | undefined;
  let launcherLog: Awaited<ReturnType<typeof observePhoneLauncherLog>> | undefined;
  let lookupWatch: ReturnType<typeof observePhoneLookupWait> | undefined;
  const samples: { role: string; path: string; command: ReturnType<typeof run> }[] = [];
  const proxySamplers = new Set<ChildProcess>();
  const isSampler = (child: ChildProcess) => proxySamplers.has(child) || samples.some((sample) => child === sample.command.child);
  let samplersStopped = false;
  const stopSamplers = (reason: string) => {
    if (samplersStopped) return;
    samplersStopped = true;
    for (const sample of samples) {
      record("sampler-stop-requested", { role: sample.role, reason });
      sample.command.child.kill("SIGINT");
    }
  };
  let lookup: Promise<void> | undefined;
  let requested: { id: string; app: number } | undefined;
  const launches = phoneGuestLaunches(owner.manager.pid);
  const proxyWatch = observePhoneProxyLaunches(async (launch, isPending) => {
    if (stopping || !isPending()) return;
    const role = `proxy-${launch.app}-${launch.kind}-${launch.id}-${launch.pid}`;
    record("proxy-capture-triggered", { launch });
    try {
      const target = await phoneProxyProcess(owner, launch, processes("proxy-lookup"));
      if (stopping || !isPending()) {
        record("proxy-capture-cancelled", { launch, reason: "The launch ended or observation stopped during ownership lookup" });
        return;
      }
      record("proxy-target-verified", { launch, target });
      const path = join(evidence, `${role}-sample.log`);
      const command = run(`${role}-sampler`, "/usr/bin/sample", [String(target.pid), String(phoneDiagnosticSampleSeconds), String(phoneDiagnosticSampleIntervalMs), "-mayDie", "-file", path]);
      proxySamplers.add(command.child);
      try {
        const result = await command.result;
        record("proxy-sample-result", { launch, code: result.code, signal: result.signal });
        await assessSample(path, role);
      } finally { proxySamplers.delete(command.child); }
    } catch (error) { record("proxy-capture-error", { launch, error: String(error) }); }
  });
  const stopProxies = () => {
    proxyWatch.stop();
    for (const child of proxySamplers) child.kill("SIGINT");
  };
  // One existing observation allowance, not a fresh allowance for each later child.
  const proxyAllowance = setTimeout(() => {
    record("proxy-capture-allowance-ended");
    stopProxies();
  }, sampleSeconds * 1000);
  try {
    record("observer-start", { pid: process.pid, simulator: owner.simulator, owner });
    // Reuse the established ownership contract before attaching. The sampler then
    // holds this process, rather than resolving its PID after the fault starts.
    const current = await phoneLaunchOwner(owner.simulator,
      `${owner.manager.pid}\t0\tcom.apple.runningboardd\n`, processes("preflight"));
    if (!isDeepStrictEqual(current, owner)) throw new Error("The preflight process identities changed");
    if (stopping) return;
    const deviceListing = await run("simulator-log-directory", "xcrun", ["simctl", "list", "devices", "--json"]).result;
    if (deviceListing.code !== 0) throw new Error("The owned simulator's log directory could not be read");
    const directory = phoneSimulatorLogDirectory(owner.simulator, deviceListing.output);
    const descriptors = await run("launcher-files", "/usr/sbin/lsof", ["-nP", "-a", "-p", String(owner.launcher.pid), "-F", "pftanDi"]).result;
    if (descriptors.code !== 0) throw new Error("The owned launcher's log descriptors could not be read");
    const source = phoneLauncherLogSource(owner.launcher.pid, directory, descriptors.output);
    launcherLog = await observePhoneLauncherLog({ directory: source.directory, source, destination: join(evidence, "launcher-native.log"), seconds: sampleSeconds, record,
      onLine: (line) => {
        const reading = proxyWatch.receive(line);
        if (reading) record("proxy-launch-observed", { reading, nativeLine: line });
      },
    });
    if (stopping) return;
    // Attach both verified processes before the journey, not after a fault-time
    // lookup. Neither the interval nor the existing capture allowance increases.
    await Promise.all(([["runningboard", owner.manager], ["launcher", owner.launcher]] as const).map(async ([role, target]) => {
      let sampleReady!: () => void;
      const ready = new Promise<void>((resolve) => { sampleReady = resolve; });
      let output = "";
      const path = join(evidence, `${role}-sample.log`);
      const command = run(`${role}-sampler`, "/usr/bin/sample", [String(target.pid), String(sampleSeconds), "100", "-mayDie", "-file", path], (text) => {
        output += text;
        if (output.includes("Sampling process")) sampleReady();
      });
      samples.push({ role, path, command });
      await Promise.race([ready, command.result.then(() => { throw new Error(`The ${role} sampler stopped before readiness`); })]);
      record("sampler-ready", { role, pid: command.child.pid, target: target.pid });
    }));
    log = await observePhoneLog({ device: owner.simulator, env, evidence, children,
      predicate: `((process == "Infinitary" OR process == "runningboardd") AND (eventMessage CONTAINS "WebKit" OR eventMessage CONTAINS "launch request")) OR (process == "launchd_sim" AND processIdentifier == ${owner.launcher.pid})`,
      onLine: (line) => {
        if (stopping) return;
        const reading = launches.receive(line);
        if (!reading) return;
        const { kind, launch, completed } = reading;
        record(`launch-${kind}-observed`, { id: launch.id, app: launch.app, nativeLine: line });
        if (completed) {
          record("launch-completed", { launch, ...completed });
          // Keep the prestarted stack window open for later delays as well.
          // Native result and the unchanged sample allowance remain the boundaries.
        }
        if (!requested && kind === "request") {
          requested = { id: launch.id, app: launch.app };
          lookup = (async () => {
            record("lookup-start", { ...requested });
            const targets = await phoneLaunchProcesses(owner, requested!.app, processes("lookup"));
            record("lookup-end", { targets });
            if (stopping) return;
            const app = targets.find((target) => target.pid === requested!.app);
            if (!app) throw new Error("The lookup did not return the owned app");
            const path = join(evidence, "app-sample.log");
            await run("app-sampler", "/usr/bin/sample", [String(app.pid), "1", "1", "-mayDie", "-file", path]).result;
            await assessSample(path, "app");
          })().catch((error: unknown) => record("lookup-error", { error: String(error) }));
        }
      },
    });
    record("observer-ready");
    process.send?.({ kind: "ready" });
    await stopRequested;
  } finally {
    record("observer-stopping");
    stopping = true;
    clearTimeout(proxyAllowance);
    stopProxies();
    stopSamplers("The journey ended or its observer stopped");
    lookupWatch?.cancel();
    await launcherLog?.close().catch((error: unknown) => record("launcher-log-error", { error: String(error) }));
    // Interrupt only this observer's children. Join their pipes and writes before
    // the parent deletes the disposable simulator or collects these artifacts.
    for (const child of children) if (!isSampler(child)) child.kill("SIGTERM");
    const report = (message: string) => record("diagnostic-close-error", { message });
    await keepPhoneDiagnostic("Native log", () => log?.close(), report);
    await keepPhoneDiagnostic("Lookup", () => lookup, report);
    await keepPhoneDiagnostic("Proxy observations", () => proxyWatch.close(), report);
    await keepPhoneDiagnostic("Lookup observation", () => lookupWatch?.close(), report);
    await Promise.all(samples.map(async ({ role, path, command }) => {
      await command.result.catch((error: unknown) => record("sampler-error", { role, error: String(error) }));
      await assessSample(path, role);
    }));
    record("observer-closed", { requested: requested ?? null });
    timeline.end();
    await timelineWritten;
    if (process.connected) process.disconnect();
  }
}

if (process.argv[2] === "guest-observer") {
  process.once("message", (configuration: Configuration) => {
    void observeGuest(configuration).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    });
  });
}
