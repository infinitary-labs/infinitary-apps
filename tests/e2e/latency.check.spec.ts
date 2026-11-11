// The latency check (INF-2078's approved plan): the actual app on a record
// the captain's size, six crewmates writing, the captain typing and then
// scrolling the Tasks list, graded against the plan's bar on a perf run.
// A second test prints, ungraded, a card picture's and a task browser
// picture's time to reach the window (INF-1352's plan, measure=inside-pieces).
import { createReadStream, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { FREEZE_THRESHOLD_MS, type FreezeIncident } from "../../src/core/freeze/freezeRecorder";
import { appPathsFor } from "../../src/core/paths";
import { readFreezes } from "../helpers/freezeRecord";
import { scratchDir } from "../helpers/scratchDirs";
import { seedCaptainSizedRecord } from "./captainSizedRecord";
import { waitForFirstmateIdle } from "./crew";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { GRADES_BUDGETS, graded, PERF_TAG } from "./perf";
import { encodeInBrowser, WORKING_COPY_PICTURES } from "./pictureFixtures";
import { promptInput } from "./prompt";
import {
  dockFrameElement,
  expandDock,
  expectRecordBody,
  nowFrame,
  openGroup,
  pressRow,
  recordCard,
  taskFact,
} from "./rails";
import {
  CARD_PICTURES_PROMPT_MARKER,
  cardPictures,
  PICTURE_CARD_TITLES,
} from "./scenarios/cardPictures";
import {
  TASK_BROWSER_READY_WORDS,
  TASK_BROWSER_WATCH_MARKER,
  taskBrowserJourneys,
} from "./scenarios/taskBrowserJourneys";
import { WRITING_CREW_MARKER, WRITING_CREW_SIZE, writingCrew } from "./scenarios/writingCrew";
import { showCard } from "./stack";
import { MAC_ONLY_TAG } from "./tags";
import { browserView, pageSays } from "./taskBrowser";
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

/** How many core requests the window asks back to back for their round trip. */
const ROUND_TRIPS = 50;

/** The Chromium trace of the quiet stretch: each thread's tasks, nothing else. */
const TRACE = { included_categories: ["toplevel"], excluded_categories: ["*"] };

test.setTimeout(420_000);
test.skip(
  !GRADES_BUDGETS || process.platform !== "darwin",
  "a perf run on a Mac: INFINITARY_PERF_BUDGETS=1, journeys.yml with perf or verify.yml with perf",
);

/** One stall in words: its wall and processor time, and its call path, innermost first. */
const described = (line: FreezeIncident) =>
  !("wallMs" in line)
    ? `unfinished stall (${line.status}); duration and processor time unknown`
    : `${line.wallMs} ms (${line.cpuMs} ms of processor time${line.uncertain ? `, ${line.uncertain}` : ""}): ${
        line.frames
          .slice(0, 8)
          .map((frame) => `${frame.name} (${frame.file}:${frame.line})`)
          .join(" <- ") || "no call path"
      }`;

type Stretch = { from: number; to: number };
const within = (line: FreezeIncident, stretches: Stretch[]) => {
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

/**
 * The first mate's answer reaching the window, timed by the window's own
 * clock: from the Enter that sends `text` to the first mate's reply and
 * then its idle state heard there. Polling from the test would round the
 * time up to its next look.
 */
async function timedAsk(page: Page, text: string, timeout: number): Promise<number> {
  await page.evaluate(() => {
    const at: { sent: number; heard: string[]; answered: number } = {
      sent: 0,
      heard: [],
      answered: 0,
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && !at.sent) at.sent = performance.now();
    };
    window.addEventListener("keydown", onKey, true);
    const stop = window.infinitary.events.on((event) => {
      if (!at.sent || at.answered) return;
      if (event.type === "user_turn") at.heard.push("turn");
      else if (event.type === "firstmate_reply") at.heard.push("reply");
      else if (event.type === "firstmate_state" && !event.busy) {
        const turn = at.heard.lastIndexOf("turn");
        if (turn >= 0 && at.heard.indexOf("reply", turn) >= 0) at.answered = performance.now();
      }
    });
    (window as unknown as { __timedAsk: unknown }).__timedAsk = {
      at,
      stop: () => {
        stop();
        window.removeEventListener("keydown", onKey, true);
      },
    };
  });
  const input = promptInput(page);
  await focusOn(input);
  await input.fill(text);
  await input.press("Enter");
  const read = () =>
    page.evaluate(() => {
      const timed = (
        window as unknown as {
          __timedAsk: { at: { sent: number; answered: number } };
        }
      ).__timedAsk;
      return timed.at.answered ? timed.at.answered - timed.at.sent : 0;
    });
  await expect
    .poll(read, { timeout, message: `the first mate answers "${text}"` })
    .toBeGreaterThan(0);
  const ms = await read();
  await page.evaluate(() =>
    (window as unknown as { __timedAsk: { stop: () => void } }).__timedAsk.stop(),
  );
  return ms;
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
  await seedCaptainSizedRecord(userDataDir);
  const recordPath = appPathsFor(userDataDir).freezeRecordPath;
  // INF-1352's plan, measure=inside-pieces: the window's start, memory and
  // the time a request and an answer take to reach it, measured before and
  // after it reaches its first mate over the connection, and printed, not graded.
  const launchedAt = performance.now();
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [writingCrew],
    env: { INFINITARY_FREEZE_RECORDER: "1" },
  });
  const { app, page } = launched;
  try {
    await waitForFirstmateIdle(page);
    const startMs = performance.now() - launchedAt;
    // The Tasks list as the captain keeps it, with the landed work open
    // too, so every change the crew writes redraws the whole list.
    await expandDock(page, "now");
    await openGroup(page, "landed");
    await expect(nowFrame(page).locator("[data-now-row]").first()).toBeVisible();

    // Six crewmates, each commissioned by the first mate, each writing
    // from its first turn on and for the rest of the run.
    const answerMs: number[] = [];
    for (let n = 1; n <= WRITING_CREW_SIZE; n += 1)
      answerMs.push(
        await timedAsk(page, `${SPAWN_PROMPT_MARKER} ${WRITING_CREW_MARKER} ${n}`, 60_000),
      );
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

    // A core request's round trip from the window's page, back to back.
    const requestMs = await page.evaluate(async (count) => {
      const took: number[] = [];
      for (let n = 0; n < count; n += 1) {
        const began = performance.now();
        await window.infinitary.app.healthcheck();
        took.push(performance.now() - began);
      }
      return took;
    }, ROUND_TRIPS);
    // Memory with the crew writing: the main process, and every process of the app.
    const memory = await app.evaluate(({ app: electronApp }) => {
      const metrics = electronApp.getAppMetrics();
      const mib = (kb: number) => Math.round(kb / 1024);
      return {
        mainMiB: mib(
          metrics.find((metric) => metric.type === "Browser")?.memory.workingSetSize ?? 0,
        ),
        allMiB: mib(metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0)),
      };
    });
    const middle = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
    console.log(`[perf] start to an idle first mate: ${Math.round(startMs)} ms`);
    console.log(
      `[perf] memory: main process ${memory.mainMiB} MiB, whole app ${memory.allMiB} MiB`,
    );
    console.log(`[perf] core request round trip, median: ${middle(requestMs).toFixed(2)} ms`);
    console.log(
      `[perf] the first mate's answer reaching the window, median: ${Math.round(middle(answerMs))} ms`,
    );

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
      startMs,
      memory,
      requestMs,
      answerMs,
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

/** How many changes of the watched page are timed to the window's view. */
const PAGE_CHANGES = 12;
/** The two colours the watched page alternates, told apart in the view's centre pixel. */
const PAGE_COLOURS = [
  [200, 40, 40],
  [40, 40, 200],
] as const;
/** How far a drawn pixel may sit from the page's colour after the picture's compression. */
const COLOUR_SLACK = 40;

/**
 * A page the crewmate keeps watching: it says it is ready only once the
 * check lets it, which keeps the crewmate's turn, and the browser, open.
 */
const WATCHED_PAGE = `<!doctype html>
<html>
  <head><title>Sign up</title><style>html, body { height: 100%; margin: 0; background: rgb(40, 40, 200); }</style></head>
  <body>
    <label>Name <input id="name"></label>
    <button id="send">Send</button>
    <p id="ready"></p>
    <script>
      setInterval(async () => {
        if ((await (await fetch("/ready")).text()) === "yes") document.getElementById("ready").textContent = "${TASK_BROWSER_READY_WORDS}";
      }, 200);
    </script>
  </body>
</html>`;

// INF-1352's plan, measure=inside-pieces: a card's picture and a task
// browser's picture reaching the window, measured before and after the
// window reaches its first mate over the connection, printed, not graded.
test("a card's picture and a task browser's picture reach the window", {
  tag: [PERF_TAG, MAC_ONLY_TAG],
}, async () => {
  let ready = false;
  const watched = createServer((request, response) => {
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(ready ? "yes" : "no");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(WATCHED_PAGE);
  });
  await new Promise<void>((resolve) => watched.listen(0, "127.0.0.1", resolve));
  const watchedUrl = `http://127.0.0.1:${(watched.address() as AddressInfo).port}/`;
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [cardPictures, taskBrowserJourneys],
  });
  const { app, page } = launched;
  const middle = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
  try {
    await waitForFirstmateIdle(page);

    // 1. A crewmate's card naming a picture in its working copy: from the
    // card reaching the window's stack to its picture drawn in the card.
    await encodeInBrowser(page, WORKING_COPY_PICTURES);
    const title = PICTURE_CARD_TITLES.wide;
    const listed = () =>
      page.evaluate(
        async (wanted) => (await window.infinitary.cards.list()).some((c) => c.title === wanted),
        title,
      );
    await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${CARD_PICTURES_PROMPT_MARKER}`);
    await promptInput(page).press("Enter");
    await expect.poll(listed, { timeout: 60_000, intervals: [10] }).toBe(true);
    const cardAt = performance.now();
    await showCard(page, title);
    const picture = cardBody(page, title).locator("img").first();
    await expect
      .poll(
        () =>
          picture.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
        {
          intervals: [10],
        },
      )
      .toBe(true);
    const pictureMs = performance.now() - cardAt;

    // 2. A task's browser the captain watches: each change of its page,
    // from the change to its picture drawn in the window's view.
    const browserTitle = `${TASK_BROWSER_WATCH_MARKER}${watchedUrl} as Sam`;
    await promptInput(page).fill(`${SPAWN_PROMPT_MARKER} ${browserTitle}`);
    await promptInput(page).press("Enter");
    const task = async () =>
      page.evaluate(async (wanted) => {
        const row = (await window.infinitary.tasks.board()).tasks.find((t) => t.title === wanted);
        return row ? window.infinitary.tasks.detail(row.id) : null;
      }, browserTitle);
    await expect
      .poll(async () => (await task())?.browser?.state ?? "", { timeout: 60_000 })
      .toBe("open");
    await expect
      .poll(() => pageSays(app, watchedUrl, "name").catch(() => null), { timeout: 30_000 })
      .not.toBeNull();
    const detail = await task();
    if (!detail) throw new Error("The watched task left the board.");
    await expandDock(page, "now");
    await pressRow(page, detail.key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", detail.id);
    await expectRecordBody(page);
    await taskFact(recordCard(page), "browser").locator("[data-browser-open]").click();
    await expect(browserView(page, detail.id)).toHaveAttribute("data-browser-state", "watching");
    const frameMs: number[] = [];
    for (let n = 0; n < PAGE_CHANGES; n += 1) {
      const colour = PAGE_COLOURS[n % PAGE_COLOURS.length] ?? PAGE_COLOURS[0];
      const began = performance.now();
      await app.evaluate(
        async ({ webContents }, wanted) => {
          const contents = webContents
            .getAllWebContents()
            .find((candidate) => candidate.getURL().startsWith(wanted.url));
          await contents?.executeJavaScript(
            `document.body.style.background = "rgb(${wanted.colour.join(", ")})"`,
          );
        },
        { url: watchedUrl, colour: [...colour] },
      );
      await page.evaluate(
        async ({ selector, colour: want, slack }) => {
          await new Promise<void>((done) => {
            const frame = () => {
              const canvas = document.querySelector<HTMLCanvasElement>(selector);
              const pixel = canvas
                ?.getContext("2d")
                ?.getImageData(
                  Math.floor(canvas.width / 2),
                  Math.floor(canvas.height / 2),
                  1,
                  1,
                ).data;
              if (pixel && want.every((value, at) => Math.abs((pixel[at] ?? 0) - value) <= slack))
                done();
              else requestAnimationFrame(frame);
            };
            frame();
          });
        },
        {
          selector: `[data-task-browser="${detail.id}"] [data-browser-canvas]`,
          colour: [...colour],
          slack: COLOUR_SLACK,
        },
      );
      frameMs.push(performance.now() - began);
    }
    ready = true;

    console.log(
      `[perf] a card's picture, from the card reaching the window to its picture drawn: ${Math.round(pictureMs)} ms`,
    );
    console.log(
      `[perf] a task browser's page change reaching the window's view, median of ${frameMs.length}: ${Math.round(middle(frameMs))} ms (max ${Math.round(Math.max(...frameMs))} ms)`,
    );
    writeFileSync(
      test.info().outputPath("picture-latency.json"),
      JSON.stringify({ pictureMs, frameMs }, null, 2),
    );
  } finally {
    ready = true;
    await launched.close();
    await new Promise<void>((resolve) => watched.close(() => resolve()));
  }
});
