// The latency check (INF-2078's approved plan): the actual app on a record
// the captain's size, six crewmates writing, the captain typing and then
// scrolling the Tasks list, graded against the plan's bar on a perf run.
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import {
  FREEZE_THRESHOLD_MS,
  type FreezeLine,
  freezeLineSchema,
} from "../../src/core/freeze/freezeRecorder";
import { appPathsFor } from "../../src/core/paths";
import { scratchDir } from "../helpers/scratchDirs";
import { seedCaptainSizedRecord } from "./captainSizedRecord";
import { waitForFirstmateIdle } from "./crew";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { GRADES_BUDGETS, graded, PERF_TAG } from "./perf";
import { promptInput } from "./prompt";
import { dockFrameElement, expandDock, nowFrame, openGroup } from "./rails";
import { WRITING_CREW_MARKER, WRITING_CREW_SIZE, writingCrew } from "./scenarios/writingCrew";
import { MAC_ONLY_TAG } from "./tags";
import { focusOn } from "./windowKeys";

/**
 * INF-2078's bar, what a person feels as a responsive app (its card, "What
 * done looks like"): no main thread stall of 50 ms or more during typing or
 * scrolling; a key press round trip within one frame at its 95th
 * percentile; Tasks list frames within 20 ms at their 95th percentile and
 * none over 50 ms, under one in twenty dropped, while scrolling with
 * changes arriving; each list redraw within 4 ms; the core's cost per
 * change within 5 ms. INF-1359 and INF-1361 run this check on their cards
 * as their latency measure (docs/testing.md, "The latency check").
 */
const FRAME_MS = 17;
const SCROLL_FRAME_P95_MS = 20;
const SCROLL_FRAME_MS = 50;
/** A frame that took more than one and a half frame intervals was a dropped frame. */
const DROPPED_FRAME_MS = 25;
/** The dropped frames the bar allows: under one in twenty, so this many in twenty. */
const DROPPED_IN_TWENTY = 1;
const LIST_REDRAW_MS = 4;
const CORE_COST_MS = 5;

/** What the captain types, one key at a time, as a question to the first mate. */
const TYPED = "How is the history coming along, and what did the crew change this afternoon?";
/** How long the scrolling and the quiet stretch each run. */
const STRETCH_MS = 5_000;
/** How far each frame of the scroll moves the list, in pixels. */
const SCROLL_STEP_PX = 40;

/** The Chromium trace of the quiet stretch: each thread's tasks, nothing else. */
const TRACE = { included_categories: ["toplevel"], excluded_categories: ["*"] };

test.setTimeout(420_000);
test.skip(
  !GRADES_BUDGETS || process.platform !== "darwin",
  "a perf run on a Mac: INFINITARY_PERF_BUDGETS=1, journeys.yml with perf or verify.yml with perf",
);

function readFreezes(path: string): FreezeLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((text) => freezeLineSchema.parse(JSON.parse(text)));
}

/** One stall in words: its wall and processor time, and its call path, innermost first. */
const described = (line: FreezeLine) =>
  `${line.wallMs} ms (${line.cpuMs} ms of processor time${line.uncertain ? `, ${line.uncertain}` : ""}): ${
    line.frames
      .slice(0, 8)
      .map((frame) => `${frame.name} (${frame.file}:${frame.line})`)
      .join(" <- ") || "no call path"
  }`;

type Stretch = { from: number; to: number };
const within = (line: FreezeLine, stretches: Stretch[]) => {
  const at = Date.parse(line.at);
  return stretches.some((stretch) => at >= stretch.from && at <= stretch.to);
};

type Slice = { key: string; ts: number; dur: number };

/** Every thread's top-level tasks from a Chromium trace, with each thread's name. */
async function readTrace(path: string): Promise<{ slices: Slice[]; threads: Map<string, string> }> {
  const threads = new Map<string, string>();
  const slices: Slice[] = [];
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
      args?: { name?: string };
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const key = `${e.pid}:${e.tid}`;
    if (e.ph === "M" && e.name === "thread_name") threads.set(key, e.args?.name ?? "");
    if (e.ph === "X" && e.name === "ThreadControllerImpl::RunTask")
      slices.push({ key, ts: e.ts, dur: e.dur ?? 0 });
  }
  return { slices, threads };
}

/** The durations, in milliseconds, of the outermost tasks among (possibly nested) slices. */
function outermostMs(slices: Slice[]): number[] {
  const durations: number[] = [];
  let end = -1;
  for (const slice of [...slices].sort((a, b) => a.ts - b.ts)) {
    if (slice.ts >= end) {
      durations.push(slice.dur / 1000);
      end = slice.ts + slice.dur;
    }
  }
  return durations;
}

/** The Tasks panel's own process: its frame runs apart from the window's page. */
async function tasksProcessId(app: ElectronApplication, page: Page): Promise<number> {
  const mountId = await dockFrameElement(page, "now").getAttribute("data-frame-mount");
  expect(mountId, "the Tasks frame names its mount").toBeTruthy();
  return app.evaluate(({ BrowserWindow }, mount) => {
    const frames = BrowserWindow.getAllWindows()[0]?.webContents.mainFrame.framesInSubtree ?? [];
    return frames.find((frame) => frame.url.includes(mount))?.osProcessId ?? 0;
  }, mountId as string);
}

/** Frame-to-frame times in the Tasks panel's page for `ms`, as its own animation frames see them. */
function tasksFrameTimes(page: Page, ms: number): Promise<number[]> {
  return nowFrame(page)
    .locator("[data-now-group-header]")
    .first()
    .evaluate(async (_, hold) => {
      const deltas: number[] = [];
      const until = performance.now() + hold;
      let last = performance.now();
      await new Promise<void>((done) => {
        const frame = () => {
          const now = performance.now();
          deltas.push(now - last);
          last = now;
          if (now >= until) done();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      return deltas.slice(1);
    }, ms);
}

/** Scrolls the Tasks dock's list down and back up, a step every frame, for `ms`. */
function scrollTasks(page: Page, ms: number): Promise<number> {
  return page.locator('[data-side-panel="now"] [data-side-panel-body]').evaluate(
    async (element, { hold, step }) => {
      let frames = 0;
      let direction = 1;
      const until = performance.now() + hold;
      await new Promise<void>((done) => {
        const frame = () => {
          const limit = element.scrollHeight - element.clientHeight;
          const next = element.scrollTop + direction * step;
          if (next >= limit || next <= 0) direction = -direction;
          element.scrollTop = Math.max(0, Math.min(limit, next));
          frames += 1;
          if (performance.now() >= until) done();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      });
      return frames;
    },
    { hold: ms, step: SCROLL_STEP_PX },
  );
}

test("typing and scrolling on a record the captain's size, while six crewmates write, stay under the latency bar", {
  tag: [PERF_TAG, MAC_ONLY_TAG],
}, async () => {
  // Seeding 160,094 events through the one writer takes most of a minute;
  // commissioning six crewmates and the three measured stretches take
  // about another.
  const userDataDir = scratchDir("infinitary-latency-check-");
  seedCaptainSizedRecord(userDataDir);
  const recordPath = appPathsFor(userDataDir).freezeRecordPath;
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [writingCrew],
    env: { INFINITARY_FREEZE_RECORDER: "1" },
  });
  const { app, page } = launched;
  try {
    await waitForFirstmateIdle(page);
    // The Tasks list as the captain keeps it, with the landed work open
    // too, so every change the crew writes redraws the whole list.
    await expandDock(page, "now");
    await openGroup(page, "landed");
    await expect(nowFrame(page).locator("[data-now-row]").first()).toBeVisible();

    // Six crewmates, each commissioned by the first mate, each writing
    // from its first turn on and for the rest of the run.
    for (let n = 1; n <= WRITING_CREW_SIZE; n += 1)
      await askFirstmate(page, `${SPAWN_PROMPT_MARKER} ${WRITING_CREW_MARKER} ${n}`, 60_000);
    const writing = () =>
      page.evaluate(
        async (marker) =>
          (await window.infinitary.tasks.board()).tasks.filter(
            (task) => task.title.includes(marker) && task.status === "active",
          ).length,
        WRITING_CREW_MARKER,
      );
    await expect.poll(writing, { timeout: 60_000 }).toBe(WRITING_CREW_SIZE);
    const tasksPid = await tasksProcessId(app, page);
    expect(tasksPid, "the Tasks panel's process").toBeGreaterThan(0);

    // 1. Typing: each key's round trip, from the press leaving the test
    // to the window's page done with it, which a main thread stall holds.
    const input = promptInput(page);
    await focusOn(input);
    const typing: Stretch = { from: Date.now(), to: 0 };
    const keyMs: number[] = [];
    for (const key of TYPED) {
      const began = performance.now();
      await page.keyboard.press(key);
      keyMs.push(performance.now() - began);
    }
    typing.to = Date.now();
    await expect(input).toHaveValue(TYPED);

    // 2. A quiet stretch with only the crew writing, traced: each top-level
    // task of the Tasks panel's main thread is a list redraw, and each of
    // the app's main thread is the core's cost for a change.
    const tracePath = test.info().outputPath("quiet-stretch.trace.json");
    await app.evaluate(async ({ contentTracing }, config) => {
      await contentTracing.startRecording(config);
    }, TRACE);
    await page.waitForTimeout(STRETCH_MS);
    await app.evaluate(async ({ contentTracing }, path) => {
      await contentTracing.stopRecording(path);
    }, tracePath);
    const { slices, threads } = await readTrace(tracePath);
    const named = (name: string, pid?: number) =>
      slices.filter(
        (slice) =>
          threads.get(slice.key) === name && (pid === undefined || slice.key.startsWith(`${pid}:`)),
      );
    const listRedrawMs = outermostMs(named("CrRendererMain", tasksPid));
    const coreCostMs = outermostMs(named("CrBrowserMain"));
    expect(listRedrawMs.length, "the Tasks panel's main thread ran tasks").toBeGreaterThan(0);
    expect(coreCostMs.length, "the app's main thread ran tasks").toBeGreaterThan(0);

    // 3. Scrolling the Tasks list, a step every frame, while the crew's
    // changes keep arriving: the Tasks panel's own frames.
    const scrolling: Stretch = { from: Date.now(), to: 0 };
    const [frameMs, scrolled] = await Promise.all([
      tasksFrameTimes(page, STRETCH_MS),
      scrollTasks(page, STRETCH_MS),
    ]);
    scrolling.to = Date.now();
    expect(scrolled, "the list scrolled").toBeGreaterThan(0);
    const dropped = frameMs.filter((ms) => ms > DROPPED_FRAME_MS).length;
    const droppedInTwenty = (dropped / Math.max(1, frameMs.length)) * 20;

    // The stalls the recorder saw while the captain typed or scrolled.
    const stalls = readFreezes(recordPath).filter((line) => within(line, [typing, scrolling]));
    for (const line of stalls)
      console.log(`[perf] stall while typing or scrolling: ${described(line)}`);

    const report = {
      keyMs,
      frameMs,
      scrolledFrames: scrolled,
      droppedFrames: dropped,
      listRedrawMs,
      coreCostMs,
      stalls: stalls.map(described),
      writingCrew: await writing(),
    };
    writeFileSync(test.info().outputPath("latency.json"), JSON.stringify(report, null, 2));

    graded(
      `main thread stalls of ${FREEZE_THRESHOLD_MS} ms or more while typing or scrolling`,
      [stalls.length],
      { max: 1 },
      " stalls",
    );
    graded("key press round trip", keyMs, { p95: FRAME_MS });
    graded("Tasks list frames while scrolling with changes", frameMs, {
      p95: SCROLL_FRAME_P95_MS,
      max: SCROLL_FRAME_MS,
    });
    graded(
      "Tasks list frames dropped in twenty while scrolling with changes",
      [droppedInTwenty],
      { max: DROPPED_IN_TWENTY },
      " frames",
    );
    graded("Tasks list redraw", listRedrawMs, { max: LIST_REDRAW_MS });
    graded("core cost per change", coreCostMs, { max: CORE_COST_MS });
  } finally {
    await launched.close();
  }
});
