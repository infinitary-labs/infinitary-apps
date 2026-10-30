import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, realpathSync, renameSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { RESOURCE_MAX_AGE_MS, type ResourceObservation } from "@shared/resources";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bundleAxiProcess } from "../../../tests/helpers/axiProcessBundle";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { AxiChannel, type TaskShell } from "../axi/channel";
import { hostEnv } from "../hostEnv";
import { forkChildProcess } from "../sql/forkChildProcess";
import { ComputerLoads } from "./computerLoads";
import { LoadLine } from "./loadLine";
import { ProcessAttribution, readProcesses } from "./processResources";
import { processRoots } from "./processRoots";
import { ResourceSampler } from "./resourceSampler";

// Native group cleanup and command polling use the existing two-second cadence.
// The budget covers consecutive poll/cleanup boundaries, channel startup and native handoffs.
vi.setConfig({ testTimeout: 35_000 });

// The ordinary-use Mac reading recorded by SCR-380, also used by placementEngine.test.ts.
// The test does not assert these numbers: it drives admission with a real recorded reading.
const reading: ResourceObservation = {
  epoch: "4f0c2a8e-6b1d-4c3e-9a57-2d8f1e0b7c64",
  sequence: 1,
  status: "sampled",
  sampleMs: 250,
  cpu: { logicalCpus: 10, idleFraction: 0.77 },
  memory: {
    totalBytes: 25_165_824 * 1024,
    freeBytes: 356_672 * 1024,
    purgeableBytes: 335_184 * 1024,
    fileBackedBytes: 6_852_624 * 1024,
  },
};
const bin = resolve(__dirname, "../../../resources/axi-bin");
let entry: string;
const channels: AxiChannel[] = [];
const lines: LoadLine[] = [];
beforeAll(async () => {
  entry = await bundleAxiProcess();
}, 60_000);
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
  for (const line of lines.splice(0)) line.dispose();
});

function run(
  shell: TaskShell,
  dir: string,
  argv: string[],
  demand = { processors: "4", memoryMiB: "4096" },
): {
  child: ChildProcessWithoutNullStreams;
  output: () => string;
  errors: () => string;
  ended: Promise<number | null>;
} {
  const child = spawn(
    join(bin, "infinitary-load-axi"),
    ["run", "--processors", demand.processors, "--memory-mib", demand.memoryMiB, "--", ...argv],
    {
      cwd: dir,
      // Starting the app inside an unrelated wrapped program must not make a new task nested.
      env: hostEnv({
        INFINITARY_LOAD_HOLD: "ca5b9ada-aff3-452b-a4ce-a7cd92324237",
        ...shell.env,
        LOAD_FIXTURE_VALUE: "original environment",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  return {
    child,
    output: () => output,
    errors: () => errors,
    ended: once(child, "exit").then(([code]) => code as number | null),
  };
}

/**
 * INF-1621 piece 2: only admission waits; running work keeps its streams and exits itself.
 * Fixture: real native wrappers, task channel and command processes; the recorded ordinary-use
 * Mac reading above, with explicitly supplied pressure states (no real memory pressure).
 * Failure: an early grant, group leak, lost stdin/environment/argv, changed exit code or a
 * pressure action stopping the admitted program fails at this process/command boundary.
 */
describe("the declared heavy-run line through its native command", () => {
  it("starts a lone group on a busy CPU, queues another, and keeps running through pressure", async () => {
    const dir = scratchDir("infinitary-load-command-");
    const line = new LoadLine({ stateFile: join(dir, "load.json") });
    lines.push(line);
    // INF-1685 direction A: replay the recorded fully busy CPU state from placementCpu.ts.
    line.observe({ ...reading, cpu: { ...reading.cpu, idleFraction: 0 } }, null);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const program = `console.log(JSON.stringify({ready:true,cwd:process.cwd(),value:process.env.LOAD_FIXTURE_VALUE,args:process.argv.slice(1)}));process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{if(data.trim()==='finish'){process.exitCode=7;process.stdin.pause()}else console.log(data.trim())});process.stdin.on('end',()=>{process.exitCode=7})`;
    const first = run(channel.grant("first", { load: line.forTask("first") }), dir, [
      process.execPath,
      "-e",
      program,
      "literal --help",
      "two words",
    ]);
    let second: ReturnType<typeof run> | undefined;
    try {
      await expect.poll(first.output).toContain('"ready":true');
      expect(JSON.parse(first.output().trim())).toEqual({
        ready: true,
        cwd: realpathSync(dir),
        value: "original environment",
        args: ["literal --help", "two words"],
      });
      second = run(channel.grant("second", { load: line.forTask("second") }), dir, [
        process.execPath,
        "-e",
        program,
      ]);
      await expect
        .poll(() => line.snapshot().runs.map((row) => [row.taskId, row.state, row.ahead]))
        .toEqual([
          ["first", "running", 0],
          ["second", "waiting", 1],
        ]);
      expect(second.output()).toBe("");
      line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "warning" } }, null);
      first.child.stdin.write("still running\n");
      await expect.poll(first.output).toContain("still running");
      first.child.stdin.end("finish\n");
      expect(await first.ended).toBe(7);
      await expect
        .poll(() => line.snapshot().runs.map((row) => [row.taskId, row.state, row.reason]))
        .toEqual([["second", "waiting", "pressure"]]);
      expect(second.output()).toBe("");
      line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "normal" } }, null);
      await expect.poll(second.output).toContain('"ready":true');
      second.child.stdin.end("finish\n");
      expect(await second.ended).toBe(7);
      await expect.poll(() => line.snapshot().runs).toEqual([]);
      console.info(
        "Load command proof",
        JSON.stringify({
          first: first.output(),
          second: second.output(),
          waiting: second.errors(),
          remaining: line.snapshot(),
        }),
      );
    } finally {
      // Close the disposable fixtures' input, not their process groups.
      first.child.stdin.end("finish\n");
      second?.child.stdin.end("finish\n");
      channel.close();
      await first.ended;
      if (second) await second.ended;
    }
  });

  // INF-1978: a transient unreadable process table must not end a queued check.
  // Keep the real wrapper and its live identity; fault only the OS reader's null result.
  it("keeps a queued command waiting through an unreadable identity check, then starts it once", async () => {
    const dir = scratchDir("infinitary-load-unreadable-");
    let unavailable = false;
    const line = new LoadLine({
      stateFile: join(dir, "load.json"),
      processes: async () => (unavailable ? null : readProcesses()),
    });
    lines.push(line);
    line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "warning" } }, null);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const waiting = run(channel.grant("unreadable", { load: line.forTask("unreadable") }), dir, [
      process.execPath,
      "-e",
      "console.log('requested check started')",
    ]);
    try {
      await expect.poll(waiting.errors).toContain("reason: pressure");
      const hold = line.snapshot().runs[0]?.id;
      unavailable = true;
      // Admission may advance independently while this caller cannot be verified.
      // It must not execute on that saved grant alone, or lose its place and exit.
      line.observe(reading, null);
      await expect.poll(waiting.errors).toContain("reason: unavailable");
      expect(waiting.child.exitCode).toBeNull();
      expect(waiting.output()).toBe("");
      expect(line.snapshot().runs[0]?.id).toBe(hold);
      unavailable = false;
      expect(await waiting.ended).toBe(0);
      expect(waiting.output()).toBe("requested check started\n");
      await expect.poll(() => line.snapshot().runs).toEqual([]);
      console.info(
        "Unreadable identity recovery proof",
        JSON.stringify({
          waiting: waiting.errors(),
          output: waiting.output(),
          remaining: line.snapshot(),
        }),
      );
    } finally {
      channel.close();
      await waiting.ended;
    }
  });

  it("holds a surviving group after its leader exits and restores that hold after app restart", async () => {
    const dir = scratchDir("infinitary-load-descendant-");
    const stateFile = join(dir, "load.json");
    let port: number | undefined;
    let line = new LoadLine({ stateFile });
    lines.push(line);
    line.observe(reading, null);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const descendant = `const server=require('node:net').createServer(c=>{c.on('data',()=>{c.end();server.close()})});server.listen(0,'127.0.0.1',()=>process.send({pid:process.pid,port:server.address().port}));`;
    const parent = `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','inherit','inherit','ipc']});c.once('message',m=>{console.log(JSON.stringify(m));c.disconnect();c.unref()});`;
    const first = run(channel.grant("surviving", { load: line.forTask("surviving") }), dir, [
      process.execPath,
      "-e",
      parent,
    ]);
    let second: ReturnType<typeof run> | undefined;
    let stopped = false;
    const stopDescendant = async () => {
      if (stopped || port === undefined) return;
      const client = createConnection({ port, host: "127.0.0.1" });
      await once(client, "connect");
      client.end("stop");
      await once(client, "close");
      stopped = true;
    };
    try {
      expect(await first.ended).toBe(0);
      const ready = JSON.parse(first.output().trim()) as { pid: number; port: number };
      const { pid } = ready;
      port = ready.port;
      expect(line.snapshot().runs.map((run) => run.state)).toEqual(["running"]);
      line.dispose();
      line = new LoadLine({ stateFile });
      lines.push(line);
      const processes = await readProcesses();
      expect(processes?.some((row) => row.pid === pid)).toBe(true);
      line.observe(reading, processes);
      expect(
        new ProcessAttribution()
          .owners(processes ?? [], processRoots.read(), processRoots.readGroups())
          .get(pid),
      ).toBe("surviving");
      second = run(channel.grant("following", { load: line.forTask("following") }), dir, [
        process.execPath,
        "-e",
        "console.log('following admitted')",
      ]);
      await expect
        .poll(() => line.snapshot().runs.map((run) => [run.taskId, run.state]))
        .toEqual([
          ["surviving", "running"],
          ["following", "waiting"],
        ]);
      expect(second.output()).toBe("");
      await stopDescendant();
      expect(await second.ended).toBe(0);
      expect(second.output()).toContain("following admitted");
      await expect.poll(() => line.snapshot().runs).toEqual([]);
      console.info(
        "Group lifetime proof",
        JSON.stringify({
          leaderExit: 0,
          retainedAfterRestart: true,
          descendantAttributed: true,
          following: second.output(),
          remaining: line.snapshot(),
        }),
      );
    } finally {
      channel.close();
      await stopDescendant();
      await first.ended;
      if (second) await second.ended;
    }
  });

  it("keeps unknown and stale readings closed, preserves FIFO, and removes a revoked waiting command", async () => {
    const dir = scratchDir("infinitary-load-waiting-");
    let now = 0;
    const line = new LoadLine({ stateFile: join(dir, "load.json"), now: () => now });
    lines.push(line);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const blockedShell = channel.grant("blocked", { load: line.forTask("blocked") });
    const blocked = run(
      blockedShell,
      dir,
      [process.execPath, "-e", "console.log('should not run')"],
      {
        processors: "4",
        memoryMiB: String((reading.memory.totalBytes / 1024 ** 2) * 2),
      },
    );
    let following: ReturnType<typeof run> | undefined;
    try {
      await expect.poll(() => line.snapshot().runs.map((run) => run.taskId)).toEqual(["blocked"]);
      following = run(channel.grant("following", { load: line.forTask("following") }), dir, [
        process.execPath,
        "-e",
        "console.log('following admitted')",
      ]);
      await expect.poll(() => line.snapshot().runs.length).toBe(2);
      expect(line.snapshot().runs.every((run) => run.reason === "unavailable")).toBe(true);
      expect(blocked.output() + following.output()).toBe("");
      line.observe(reading, null);
      expect(line.snapshot().runs.map((run) => run.state)).toEqual(["waiting", "waiting"]);
      now = RESOURCE_MAX_AGE_MS + 1;
      channel.revoke("blocked");
      expect(await blocked.ended).not.toBe(0);
      await expect
        .poll(() => line.snapshot().runs.map((run) => [run.taskId, run.reason]))
        .toEqual([["following", "unavailable"]]);
      expect(following.output()).toBe("");
      line.observe({ ...reading, memory: { ...reading.memory, memoryPressure: "critical" } }, null);
      expect(line.snapshot().runs[0]?.reason).toBe("pressure");
      now += RESOURCE_MAX_AGE_MS + 1;
      expect(line.snapshot().runs[0]?.reason).toBe("unavailable");
      line.observe(reading, null);
      expect(await following.ended).toBe(0);
      expect(following.output()).toContain("following admitted");
      await expect.poll(() => line.snapshot().runs).toEqual([]);
    } finally {
      channel.close();
      await Promise.all([blocked.ended, following?.ended]);
    }
  });

  it("refuses admission after a failed state write without hiding held runs or failing measured Use", async () => {
    const dir = scratchDir("infinitary-load-store-");
    const stateFile = join(dir, "load.json");
    const line = new LoadLine({ stateFile });
    lines.push(line);
    const reader = new ComputerLoads({
      local: line,
      overrides: () => [],
      work: {
        ask: async () => {
          throw new Error("No work computer");
        },
        inReach: () => false,
        version: () => undefined,
        onWorkDevice: () => () => {},
      },
    });
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const waiting = run(channel.grant("store", { load: line.forTask("store") }), dir, [
      process.execPath,
      "-e",
      "console.log('should not run')",
    ]);
    try {
      await expect.poll(() => line.snapshot().runs.map((run) => run.state)).toEqual(["waiting"]);
      const before = reader.read(null);
      renameSync(stateFile, join(dir, "before.json"));
      mkdirSync(stateFile); // A real failed atomic replacement, confined to this disposable store.
      expect(() => line.observe(reading, null)).not.toThrow();
      expect(reader.read(null)).toEqual({ ...before, status: "unknown" });
      const sampler = new ResourceSampler({
        memory: () => reading.memory,
        processes: readProcesses,
        observed: (observation, processes, started, window) =>
          line.observe(observation, processes, started, window),
      });
      expect((await sampler.read()).status).toBe("sampled");
      expect(await waiting.ended).not.toBe(0);
      expect(waiting.output()).toBe("");
      expect(waiting.errors()).toContain("holds could not be kept");
    } finally {
      reader.dispose();
      channel.close();
      await waiting.ended;
    }
  });

  it("reuses a nested hold, refuses a larger nested demand, and obeys only a recorded override", async () => {
    const dir = scratchDir("infinitary-load-nested-");
    const overrides = new Set<string>();
    const line = new LoadLine({
      stateFile: join(dir, "load.json"),
      overridden: (task) => overrides.has(task),
    });
    lines.push(line);
    const channel = await AxiChannel.open({
      spawner: forkChildProcess(entry),
      binDir: bin,
      version: "9.9.9-test",
      keysDir: join(dir, "keys"),
    });
    channels.push(channel);
    const nested = join(bin, "infinitary-load-axi");
    const program = `const {spawnSync}=require('node:child_process');const run=n=>spawnSync(${JSON.stringify(nested)},['run','--processors',n,'--memory-mib','4096','--',process.execPath,'-e','console.log("nested admitted")'],{encoding:'utf8'});const same=run('4'),larger=run('5');console.log(JSON.stringify({same:{status:same.status,stdout:same.stdout},larger:{status:larger.status,stderr:larger.stderr}}));process.stdin.resume();process.stdin.on('data',()=>process.stdin.pause());`;
    const first = run(channel.grant("nested", { load: line.forTask("nested") }), dir, [
      process.execPath,
      "-e",
      program,
    ]);
    try {
      await expect.poll(() => line.snapshot().runs.map((run) => run.state)).toEqual(["waiting"]);
      expect(first.output()).toBe("");
      overrides.add("nested");
      line.reconsider();
      await expect.poll(first.output).toContain('"same"');
      const result = JSON.parse(first.output().trim());
      expect(result.same).toEqual({ status: 0, stdout: "nested admitted\n" });
      expect(result.larger.status).not.toBe(0);
      expect(result.larger.stderr).toContain("outer run declared less");
      expect(line.snapshot().runs.map((run) => [run.taskId, run.state])).toEqual([
        ["nested", "running"],
      ]);
      first.child.stdin.end("finish\n");
      expect(await first.ended).toBe(0);
      await expect.poll(() => line.snapshot().runs).toEqual([]);
    } finally {
      first.child.stdin.end("finish\n");
      channel.close();
      await first.ended;
    }
  });
});
