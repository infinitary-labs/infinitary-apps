// Voice regression measured by FI3-1054: seven budgets on the threads and
// processes that draw the window, while the real model transcribes.
// Needs the real 1.6 GB model: INFINITARY_VOICE_MODEL_DIR=<.../models/whisper-large-v3-turbo>.
// macOS only (reads process footprints with `footprint`).
import { execFileSync } from "node:child_process";
import { createReadStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { voiceSettled } from "./dictation";
import { launchApp } from "./launch";
import { GRADES_BUDGETS, measured, PERF_TAG } from "./perf";
import { promptInput } from "./prompt";
import { MAC_ONLY_TAG } from "./tags";

const MODEL_DIR = process.env.INFINITARY_VOICE_MODEL_DIR ?? "";
/** One 60 Hz frame: the longest a task may hold the thread that presents the window. */
const FRAME_MS = 16;
const FOOTPRINT_GROWTH_MB = 500;
const MAIN_BUSY_MS = 300;

test.setTimeout(300_000);
test.skip(!MODEL_DIR || process.platform !== "darwin", "needs the voice model and macOS");

function footprintMB(pid: number): number {
  const out = execFileSync("footprint", ["-p", String(pid), "-f", "bytes"], { encoding: "utf8" });
  return Number(/Footprint: (\d+) B/.exec(out)?.[1] ?? Number.NaN) / 1024 / 1024;
}

type Slice = { name: string; ts: number; dur: number };

/** CrGpuMain and CrBrowserMain slices and the renderer's key dispatches from a Chromium trace. */
async function readTrace(path: string) {
  const threads = new Map<string, string>();
  const procs = new Map<number, string>();
  const gpu: Array<Slice & { key: string }> = [];
  const keys: Array<{ type: string; ts: number }> = [];
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (let line of lines) {
    if (!line.startsWith('{"')) continue;
    if (line.endsWith(",")) line = line.slice(0, -1);
    let e: {
      ph: string;
      name: string;
      pid: number;
      tid: number;
      ts: number;
      dur?: number;
      args?: { name?: string; data?: { type?: string } };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.ph === "M" && e.name === "thread_name")
      threads.set(`${e.pid}:${e.tid}`, e.args?.name ?? "");
    if (e.ph === "M" && e.name === "process_name") procs.set(e.pid, e.args?.name ?? "");
    if (e.ph !== "X") continue;
    if (e.name === "EventDispatch" && /^key(down|up)$/.test(e.args?.data?.type ?? ""))
      keys.push({ type: e.args?.data?.type ?? "", ts: e.ts });
    if (e.name === "ThreadControllerImpl::RunTask" || e.name === "WebGPU")
      gpu.push({ key: `${e.pid}:${e.tid}`, name: e.name, ts: e.ts, dur: e.dur ?? 0 });
  }
  const isGpuMain = (key: string) =>
    threads.get(key) === "CrGpuMain" && procs.get(Number(key.split(":")[0])) === "GPU Process";
  const isBrowserMain = (key: string) => threads.get(key) === "CrBrowserMain";
  return {
    gpuMain: gpu.filter((s) => isGpuMain(s.key)),
    browserMain: gpu.filter(
      (s) => isBrowserMain(s.key) && s.name === "ThreadControllerImpl::RunTask",
    ),
    keys: keys.sort((a, b) => a.ts - b.ts),
  };
}

const TRACE = {
  included_categories: [
    "toplevel",
    "gpu",
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
  ],
  excluded_categories: ["*"],
};

/** Total time of the outermost tasks in a list of (possibly nested) slices. */
function busyMs(slices: Slice[]): number {
  let total = 0;
  let end = -1;
  for (const s of [...slices].sort((a, b) => a.ts - b.ts)) {
    if (s.ts >= end) {
      total += s.dur;
      end = s.ts + s.dur;
    }
  }
  return total / 1000;
}

test("starting and ending voice input leaves the window thread free", {
  tag: [PERF_TAG, MAC_ONLY_TAG],
}, async () => {
  const userDataDir = scratchDir("infinitary-voice-freeze-");
  mkdirSync(join(userDataDir, "models"), { recursive: true });
  execFileSync("cp", ["-cR", MODEL_DIR, join(userDataDir, "models", "whisper-large-v3-turbo")]);
  const traceDir = test.info().outputPath("chromium");
  mkdirSync(traceDir, { recursive: true });
  // The fake device's beep is not silence, so every release runs a full Whisper pass,
  // in the app's own voice helper on this Mac's speech library.
  const launched = await launchApp({
    withMockProvider: true,
    userDataDir,
    useAppVoiceHelper: true,
  });
  const { app, page } = launched;
  try {
    await expect(promptInput(page)).toBeEnabled();
    await voiceSettled(page);
    // The window's own renderer, and the GPU process that draws every window.
    const pids = await app.evaluate(({ app: a, BrowserWindow }) => ({
      Tab: BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId() ?? 0,
      GPU: a.getAppMetrics().find((m) => m.type === "GPU")?.pid ?? 0,
    }));
    // The voice helper holds the model on Apple silicon; elsewhere the window does,
    // and the isolation budgets below do not apply.
    const { where } = await page.evaluate(() => window.infinitary.voice.recognizer());
    const before = { renderer: footprintMB(pids.Tab), gpu: footprintMB(pids.GPU) };
    const transcribed = () =>
      expect(page.locator("[data-prompt-dock]")).toHaveAttribute(
        "data-voice-transcribing",
        "false",
        { timeout: 120_000 },
      );

    // First use, traced: the model loads while the captain talks.
    await app.evaluate(async ({ contentTracing }, config) => {
      await contentTracing.startRecording(config);
    }, TRACE);
    await page.keyboard.down("AltRight");
    await expect(page.getByRole("button", { name: "Abandon", exact: true })).toBeVisible();
    await page.waitForTimeout(3000);
    await page.keyboard.up("AltRight");
    await transcribed();
    await expect(page.locator("[data-voice-notice]")).toHaveCount(0);
    const firstPath = join(traceDir, "first-use.json");
    await app.evaluate(async ({ contentTracing }, p) => {
      await contentTracing.stopRecording(p);
    }, firstPath);
    const first = await readTrace(firstPath);
    const firstDown = first.keys.find((k) => k.type === "keydown")?.ts;
    expect(firstDown, "trace must contain the actual voice start").toBeDefined();
    if (firstDown === undefined) throw new Error("Missing voice start marker");
    const firstUseMainBusyMs = busyMs(first.browserMain.filter((s) => s.ts >= firstDown));
    const firstUseGpuLongestMs =
      Math.max(
        0,
        ...first.gpuMain
          .filter((s) => s.ts >= firstDown && s.name === "ThreadControllerImpl::RunTask")
          .map((s) => s.dur),
      ) / 1000;
    const after = { renderer: footprintMB(pids.Tab), gpu: footprintMB(pids.GPU) };
    // Where the model's memory went instead: the helper process, while it is loaded.
    const helperPid = await app.evaluate(
      ({ app: a }) =>
        a.getAppMetrics().find((m) => m.type === "Utility" && m.name === "Infinitary Voice")?.pid,
    );
    const helperMB = helperPid ? Math.round(footprintMB(helperPid)) : null;

    // A later use, traced: what lands on the GPU process's main thread, which
    // also composites and presents the window.
    await app.evaluate(async ({ contentTracing }, config) => {
      await contentTracing.startRecording(config);
    }, TRACE);
    await page.evaluate(() => {
      const w = window as unknown as { __keyups: number[] };
      w.__keyups = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEventTiming[])
          if (e.name === "keyup") w.__keyups.push(e.processingEnd - e.processingStart);
      }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
    });
    await page.keyboard.down("AltRight");
    await expect(page.getByRole("button", { name: "Abandon", exact: true })).toBeVisible();
    await page.waitForTimeout(Number(process.env.INFINITARY_VOICE_HOLD_MS ?? 3000));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    if (process.env.INFINITARY_VOICE_PROFILE === "1") {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
      await cdp.send("Profiler.start");
    }
    await page.keyboard.up("AltRight");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    if (process.env.INFINITARY_VOICE_PROFILE === "1") {
      const { profile } = await cdp.send("Profiler.stop");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(test.info().outputPath("release.cpuprofile"), JSON.stringify(profile));
    }
    await transcribed();
    // An entry exists only when the keyup's whole input-to-paint took 16 ms or more.
    const keyupProcessingMs = await page.evaluate(() =>
      Math.max(0, ...(window as unknown as { __keyups: number[] }).__keyups),
    );
    const tracePath = join(traceDir, "voice.json");
    await app.evaluate(async ({ contentTracing }, p) => {
      await contentTracing.stopRecording(p);
    }, tracePath);
    const { gpuMain, keys } = await readTrace(tracePath);
    const keyup = keys.filter((k) => k.type === "keyup").at(-1)?.ts;
    expect(keyup, "trace must contain the actual voice release").toBeDefined();
    if (keyup === undefined) throw new Error("Missing voice release marker");
    const end = gpuMain.at(-1)?.ts ?? keyup;
    const afterRelease = gpuMain.filter((s) => s.ts >= keyup && s.ts <= end);
    const webgpu = afterRelease.filter((s) => s.name === "WebGPU");
    const longestTaskMs =
      Math.max(
        0,
        ...afterRelease.filter((s) => s.name === "ThreadControllerImpl::RunTask").map((s) => s.dur),
      ) / 1000;

    const report = {
      recognizer: where,
      footprintMB: { before, after, helper: helperMB },
      firstUse: {
        mainBusyMs: Math.round(firstUseMainBusyMs),
        gpuMainLongestTaskMs: Math.round(firstUseGpuLongestMs * 10) / 10,
      },
      gpuMainAfterRelease: {
        webgpuTasks: webgpu.length,
        webgpuMs: Math.round(webgpu.reduce((a, s) => a + s.dur, 0) / 1000),
        longestTaskMs: Math.round(longestTaskMs * 10) / 10,
      },
      keyupProcessingMsAt6x: Math.round(keyupProcessingMs),
    };
    console.log(`[voice-freeze] ${JSON.stringify(report)}`);
    test.info().annotations.push({ type: "voice-freeze", description: JSON.stringify(report) });

    // Off the window thread and the main process (the in-place fix), and off
    // the drawing process and out of the window's memory (the voice helper).
    measured("voice first-use main busy", [firstUseMainBusyMs], MAIN_BUSY_MS);
    measured("voice release at 6x", [keyupProcessingMs], FRAME_MS);
    if (where === "window") {
      test.info().annotations.push({
        type: "voice-isolation",
        description: "not graded: this Mac transcribes in the window",
      });
    } else if (GRADES_BUDGETS) {
      expect
        .soft(report.gpuMainAfterRelease.webgpuTasks, "Whisper work on the drawing thread")
        .toBe(0);
      measured("voice GPU release", [report.gpuMainAfterRelease.longestTaskMs], FRAME_MS);
      expect
        .soft(after.renderer - before.renderer, "renderer footprint growth (MB)")
        .toBeLessThanOrEqual(FOOTPRINT_GROWTH_MB);
      expect
        .soft(after.gpu - before.gpu, "GPU footprint growth (MB)")
        .toBeLessThanOrEqual(FOOTPRINT_GROWTH_MB);
      measured("voice GPU first use", [report.firstUse.gpuMainLongestTaskMs], FRAME_MS);
    }
  } finally {
    await launched.close();
  }
});
