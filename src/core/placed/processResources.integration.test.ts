import { once } from "node:events";
import { watch, writeFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { attributedClaudeProcess } from "../claude/processResources";
import { hostEnv } from "../hostEnv";
import { JobManager } from "../jobs/jobManager";
import {
  ProcessAttribution,
  type ProcessReading,
  processResources,
  readProcesses,
} from "./processResources";
import { processRoots } from "./processRoots";
import { type ProcessWindow, ResourceSampler } from "./resourceSampler";

// Measured live case: 0.77 s on the Mac mini; a 5 s budget covers five times that reading.
vi.setConfig({ testTimeout: 5_000 });

/** INF-1621: a task's real shell and Claude-style client remain visible without a screen. No sign-in or real client. */
describe("live task process observation", () => {
  it("attributes a shell job and a client process, then releases both roots when they exit", async () => {
    const dir = scratchDir("infinitary-process-shares-");
    const ready = join(dir, "ready");
    const finish = join(dir, "finish");
    const changed = watch(dir);
    const started = new Promise<void>((resolve) =>
      changed.on("change", (_event, file) => {
        if (file === "ready") resolve();
      }),
    );
    let ended!: () => void;
    const exit = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const jobs = new JobManager({ onExit: () => ended() });
    // The child stays alive until the parent writes finish, rather than timing a read against a sleep.
    const program = `const fs=require('node:fs');const memory=Buffer.alloc(4*1024*1024,1);const watcher=fs.watch(${JSON.stringify(dir)},(_,file)=>{if(file==='finish'){console.log(memory.length);watcher.close()}});fs.writeFileSync(${JSON.stringify(ready)},'ready')`;
    const expectedLog = "压力";
    let logged = "";
    let finishLog = () => {};
    const decodedLog = new Promise<void>((resolve) => {
      finishLog = resolve;
    });
    const client = attributedClaudeProcess("client", (data) => {
      logged += data;
      if (logged === expectedLog) finishLog();
    })({
      command: process.execPath,
      args: [
        "-e",
        `const bytes=Buffer.from(${JSON.stringify(expectedLog)});process.stderr.write(bytes.subarray(0,2));setImmediate(()=>process.stderr.write(bytes.subarray(2)));process.stdin.resume();process.stdin.once('data',()=>{const hash=require('node:crypto').createHash;const start=process.cpuUsage();while(process.cpuUsage(start).user+process.cpuUsage(start).system<100000){hash('sha256').update('resource observation fixture').digest()}console.log('worked')});console.log('ready')`,
      ],
      env: hostEnv(),
      signal: new AbortController().signal,
    });
    const clientExit = new Promise<void>((resolve) => client.once("exit", () => resolve()));
    try {
      await once(client.stdout, "data");
      await decodedLog;
      expect(logged).toBe(expectedLog);
      await jobs.run({
        ownerId: "shell",
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(program)}`,
        cwd: dir,
        background: true,
      });
      await started;
      const before = performance.now();
      const windows: { processes: ProcessReading[] | null; window?: ProcessWindow }[] = [];
      const sampler = new ResourceSampler({
        processes: readProcesses,
        memory: () => ({ totalBytes: totalmem(), freeBytes: freemem() }),
        observed: (_observation, processes, _started, window) =>
          windows.push({ processes, window }),
      });
      const observation = await sampler.read();
      console.info(
        "Live process observation",
        JSON.stringify({ durationMs: performance.now() - before, observation }),
      );
      expect(observation.status).toBe("sampled");
      if (observation.status !== "sampled" || observation.processes?.status !== "sampled")
        throw new Error("Process observation unavailable");
      for (const id of ["shell", "client"]) {
        const task = observation.processes.tasks.find((task) => task.taskId === id);
        expect(task?.processCount).toBeGreaterThan(0);
        expect(task?.residentBytes).toBeGreaterThan(0);
        expect(task?.cpuCores).toBeTypeOf("number");
      }
      // The client does a bounded amount of real hashing, measured by its own CPU clock,
      // between two OS reads; no wall-time throughput or machine-speed promise.
      const beforeWork = await readProcesses();
      const workStart = performance.now();
      const worked = once(client.stdout, "data");
      client.stdin.write("work\n");
      await worked;
      const afterWork = await readProcesses();
      if (!beforeWork || !afterWork) throw new Error("Work readings unavailable");
      const measured = processResources(
        beforeWork,
        afterWork,
        new ProcessAttribution().owners(afterWork, processRoots.read()),
        performance.now() - workStart,
      );
      if (measured.status !== "sampled") throw new Error("Work use unavailable");
      console.info("Measured hashing work", JSON.stringify(measured.tasks));
      expect(measured.tasks.find((task) => task.taskId === "client")?.cpuCores).toBeGreaterThan(0);
      // INF-1685: a refresh reuses the preceding real process endpoint, including
      // the hashing work between reads rather than only a new quarter-second slice.
      const refreshed = await sampler.read();
      expect(refreshed.status).toBe("sampled");
      expect(windows[1]?.window?.first).toBe(windows[0]?.processes);
      if (refreshed.status !== "sampled" || refreshed.processes?.status !== "sampled")
        throw new Error("Refreshed process observation unavailable");
      expect(
        refreshed.processes.tasks.find((task) => task.taskId === "client")?.cpuCores,
      ).toBeGreaterThan(0);
      console.info("Full-interval refresh proof", JSON.stringify(refreshed));
    } finally {
      changed.close();
      writeFileSync(finish, "done");
      client.stdin.end();
      await Promise.all([exit, clientExit]);
    }
    expect([...processRoots.read().values()]).not.toContain("shell");
    expect([...processRoots.read().values()]).not.toContain("client");
  });
});
