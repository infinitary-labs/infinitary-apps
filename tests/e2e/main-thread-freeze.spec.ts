import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { FreezeLine } from "../../src/core/freeze/freezeRecorder";
import { appPathsFor } from "../../src/core/paths";
import { openDatabase } from "../../src/core/storage/db";
import { git } from "../../src/core/workspace/git";
import { shortTaskTitle } from "../../src/shared/taskTitle";
import { MERGE_WORDS } from "../../src/shared/vocabulary";
import { readFreezes, readPasses } from "../helpers/freezeRecord";
import { scratchDir } from "../helpers/scratchDirs";
import { seedCaptainSizedRecord } from "./captainSizedRecord";
import { waitForFirstmateIdle } from "./crew";
import { launchApp, SHORT_TICK } from "./launch";
import { REACT_PROMPT_MARKER, SPAWN_PROMPT_MARKER } from "./mockProvider";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { reportLine, startedLine, taskKey, taskKeys } from "./rails";
import { readSavedData } from "./savedData";
import {
  FREEZE_BURST_TITLES,
  FREEZE_BURST_WORDS,
  scriptFreezeBurst,
} from "./scenarios/freezeBurst";
import {
  FREEZE_MERGE_ACTION,
  FREEZE_MERGE_MARKER,
  FREEZE_MERGE_TITLE,
  freezeMerge,
} from "./scenarios/freezeMerge";
import { showCard, shownCard } from "./stack";
import { boardEntry, openBoardButton } from "./taskBoard";
import { typeInto } from "./windowKeys";

/**
 * The freeze journey (INF-2061's approved plan, direction B; built as
 * INF-2068; docs/freeze-recorder.md, "Before a change merges"). It runs the
 * actual app on a record the captain's size with the freeze recorder on,
 * drives the work that repeats - first mate turns, which read the open
 * messages before and after each, a crewmate's start through its first
 * report, several starts issued together while typing, a merged close
 * whose change declared a required action (INF-4224), the minute passes
 * with the answer-delivery sweep, the task board and typing - and fails,
 * naming the call path, on any stretch of the main
 * thread's own processor time at or over the line.
 *
 * The line counts processor time, never wall time: a busy test computer
 * stretches a freeze's wall time but not the work the main thread did in it
 * (docs/testing.md, the captain's B1 timing rule). A wait on another program uses almost no
 * processor time, so the wait check in `pnpm check` covers it instead
 * (scripts/main-thread-waits.ts).
 *
 * Promised result: no recorded stall reaches the line. Data: the captain's
 * readings (captainSizedRecord.ts), plus the reported nine-start burst and
 * one local-only project whose change merges with a required action.
 * Completion signals: every start and first report, retained window input,
 * and the minute passes the app reports on its own output.
 * Prerequisites: none beyond a built app;
 * the recorder works the same on Linux and the Mac. Shared resources: none.
 */

/**
 * The line, INF-2061's plan: the past freezes a person felt as one (INF-1348,
 * INF-1956, INF-2059) each held the main thread 800 ms or more at a time.
 */
const FREEZE_LINE_CPU_MS = 250;
/** The local-only project whose change merges with a required action. */
const GAUGE_PROJECT = "gaugelab";
/** Minute passes to drive after the turns: each runs every check the minute pass holds. */
const MINUTE_PASSES = 5;

async function say(page: Page, text: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

/** What the journey was doing, by when it began each part. */
type Step = { at: number; doing: string };

/**
 * One stall in words: its processor time, what the journey was doing, its
 * call path, innermost first, and when the watchdog read that path.
 */
const described = (line: FreezeLine, steps: readonly Step[]) =>
  `${line.cpuMs} ms of processor time in ${line.wallMs} ms, ${
    steps.findLast((step) => step.at <= Date.parse(line.at))?.doing ?? "before the launch"
  }${passStep(line)}: ${
    line.frames
      .slice(0, 8)
      .map((frame) => `${frame.name} (${frame.file}:${frame.line})`)
      .join(" <- ") || "no call path"
  }${readAt(line)}`;

/**
 * When the watchdog asked for the stall's call path after the stall began,
 * and how long the main thread took to answer, counting its wait to run
 * JavaScript again, so a reader sees whether the path is where the stall was
 * (docs/freeze-recorder.md, "The record").
 */
const readAt = (line: FreezeLine) =>
  line.captureRequestedAt && line.capturedAt
    ? `, call path asked for ${Date.parse(line.captureRequestedAt) - Date.parse(line.at)} ms after it began and read ${
        Date.parse(line.capturedAt) - Date.parse(line.captureRequestedAt)
      } ms later${line.uncertain ? ` (${line.uncertain})` : ""}`
    : "";

/** The minute pass's step the stall fell in, as the recorder tagged it (docs/freeze-recorder.md). */
const passStep = (line: FreezeLine) => {
  const running = line.step?.running ? ` in step ${line.step.running}` : "";
  const unsettled = line.step?.unsettled?.length
    ? ` with ${line.step.unsettled.join(", ")} unsettled`
    : "";
  return running + unsettled;
};

test("the main thread never spends 250 ms of its own processor time at once on a record the captain's size", async () => {
  // Seeding 287,538 events through the one writer takes about two minutes
  // on a shared runner; the passes, turns, starts and the merge take about
  // two more.
  test.setTimeout(420_000);
  const userDataDir = scratchDir("infinitary-freeze-journey-");
  // The seed hands this worker's event loop a turn between its transactions,
  // which is when the statements it prepared are freed (WRITES_PER_TURN).
  // Written in one synchronous call it held them all, several gigabytes, and
  // the Linux runner killed this worker. A ticker beside it counts the turns
  // and the worker's largest size, printed on every run.
  let turns = 0;
  let largestRss = process.memoryUsage().rss;
  const startRss = largestRss;
  const ticker = setInterval(() => {
    turns += 1;
    largestRss = Math.max(largestRss, process.memoryUsage().rss);
  }, 0);
  try {
    await seedCaptainSizedRecord(userDataDir);
  } finally {
    clearInterval(ticker);
  }
  console.log(
    `[freeze journey] the seed ran over ${turns} turns; the worker grew from ${Math.round(startRss / 2 ** 20)} MiB to at most ${Math.round(largestRss / 2 ** 20)} MiB`,
  );
  // The project whose change merges with a required action: local-only, so
  // the captain's merge click puts it on its own main with no forge.
  const gaugeDir = join(userDataDir, GAUGE_PROJECT);
  const gitIn = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
  gitIn("init", "--initial-branch=main", gaugeDir);
  gitIn("-C", gaugeDir, "config", "user.name", "Test");
  gitIn("-C", gaugeDir, "config", "user.email", "test@localhost");
  gitIn("-C", gaugeDir, "commit", "--allow-empty", "-m", "chore: seed the gauge");
  const db = openDatabase(userDataDir);
  try {
    seedProject(db, {
      id: `repo-${GAUGE_PROJECT}`,
      path: gaugeDir,
      name: GAUGE_PROJECT,
      setupKind: "init",
      origin: null,
      runsOn: null,
      delivery: "local-only",
      autonomy: false,
      rigor: "quick",
      addedAt: 1,
    });
  } finally {
    db.close();
  }
  // A seed that never gives the loop a turn holds every statement again.
  expect(turns).toBeGreaterThan(0);
  const recordPath = appPathsFor(userDataDir).freezeRecordPath;
  const passRecordPath = appPathsFor(userDataDir).passRecordPath;
  const steps: Step[] = [];
  const step = (doing: string) => steps.push({ at: Date.now(), doing });
  step("while the app started");
  const app = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [freezeMerge()],
    env: { ...SHORT_TICK, INFINITARY_FREEZE_RECORDER: "1" },
  });
  // Each pass reports its synchronous run on the app's own output
  // (docs/architecture.md, "[ticker] <name>"); the idle ladder runs on every one.
  let passes = 0;
  const slowPasses: string[] = [];
  app.app.process().stdout?.on("data", (chunk) => {
    const text = String(chunk);
    passes += text.split("[ticker] idle-ladder:").length - 1;
    for (const [pass] of text.matchAll(/\[ticker\] \S+: \d{3,}\.\d+ ms synchronous/g))
      slowPasses.push(pass);
  });
  try {
    const { page } = app;
    step("while the window settled");
    // The recorder is on: a wait the journey holds the main thread in is
    // recorded, and as a wait - almost none of it the main thread's own
    // processor time, so it stays under the line.
    await app.app.evaluate(() => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    });
    await expect
      .poll(
        () =>
          readFreezes(recordPath).filter(
            (line) => "uncertain" in line && line.uncertain === "waited",
          ).length,
        {
          timeout: 15_000,
        },
      )
      .toBeGreaterThan(0);

    for (const piece of ["the history", "the open messages", "the board"]) {
      step(`in the first mate's turn about ${piece}`);
      await say(page, `${REACT_PROMPT_MARKER}: how is ${piece} going?`);
      await waitForFirstmateIdle(page);
    }
    // Starting a crewmate and opening it (INF-2297, the captain's "Starting a
    // task froze the app for half a second"): every start-path stall the
    // captain's record held - preparing the first turn, the brief's inbox
    // row, reading the app's source as the crewmate opens and choosing its
    // model - ran between the first mate's spawn and the crewmate's first
    // report, which comes after its first turn opened.
    const started = "Measure how the open messages are going";
    step("while a crewmate started and opened");
    await say(page, `${SPAWN_PROMPT_MARKER} ${started}`);
    const startedKey = await taskKey(page, started);
    await expect(startedLine(page, startedKey).first()).toBeVisible({ timeout: 30_000 });
    await expect(reportLine(page, startedKey).first()).toBeVisible({ timeout: 30_000 });
    await waitForFirstmateIdle(page);
    // The captain's several-start case: all requests come from one first-mate
    // turn, not nine sequential asks. The same recorder covers their complete
    // start paths while the window also accepts a draft, without a timing sleep.
    if (!app.mockProvider) throw new Error("The freeze burst needs its scripted provider");
    const burst = scriptFreezeBurst(app.mockProvider);
    step(
      `while ${FREEZE_BURST_TITLES.length} crewmates started together and the window accepted typing`,
    );
    await say(page, FREEZE_BURST_WORDS);
    const draft = "How are the session audits coming along";
    // One board read per try finds all nine tasks (INF-3453): nine reads at
    // once, each a copy of the whole record's board, were the burst's own
    // largest stalls on hosted Linux, the journey measuring itself.
    const [burstKeys] = await Promise.all([
      (async () =>
        Promise.all(
          (await taskKeys(page, FREEZE_BURST_TITLES)).map(async (key) => {
            await expect(startedLine(page, key).first()).toBeVisible({ timeout: 30_000 });
            await expect(reportLine(page, key).first()).toBeVisible({ timeout: 30_000 });
            return key;
          }),
        ))(),
      (async () => {
        const duringBurst = promptInput(page);
        await duringBurst.click();
        await typeInto(duringBurst, draft, { delay: 20 });
        await expect(duringBurst).toHaveValue(draft);
        await duringBurst.fill("");
      })(),
    ]);
    await expect.poll(() => burst.outcome().state).toBe("closed");
    await waitForFirstmateIdle(page);
    // The intermittent failure was two rejected Git starts, not a measured
    // freeze: one add read another's unfinished commondir. Keep all nine
    // start/report assertions, and verify their actual isolated checkouts too.
    const worktrees = readSavedData(userDataDir, (db) =>
      burstKeys.map(
        (key) =>
          db
            .prepare("SELECT key, worktree_dir AS cwd, branch FROM tasks WHERE key = ?")
            .get(key) as { key: string; cwd: string; branch: string },
      ),
    );
    expect(new Set(worktrees.map((tree) => tree.cwd)).size).toBe(FREEZE_BURST_TITLES.length);
    for (const tree of worktrees) {
      expect(await git(tree.cwd, ["symbolic-ref", "--short", "HEAD"])).toBe(tree.branch);
    }
    console.log(
      JSON.stringify({
        scenario: "concurrent crewmate starts",
        startedAndReported: burstKeys,
        isolatedCheckouts: worktrees,
        windowDraft: draft,
      }),
    );
    // A merged close whose change declared a required action (INF-4224):
    // on the captain's record its step that files the action's task read
    // every task and held the main thread 491 ms.
    const gauge = `${GAUGE_PROJECT} ${FREEZE_MERGE_MARKER}`;
    await say(page, `${SPAWN_PROMPT_MARKER} ${gauge}`);
    const gaugeKey = await taskKey(page, gauge);
    // The burst's own cards stack ahead of the merge card, so the walk
    // pages to it once it has joined the stack.
    await waitForFirstmateIdle(page);
    await expect(() => showCard(page, FREEZE_MERGE_TITLE)).toPass({ timeout: 60_000 });
    const mergeCard = shownCard(page, FREEZE_MERGE_TITLE);
    step("while a change with a required action merged");
    await mergeCard.getByRole("button", { name: MERGE_WORDS.land, exact: true }).click();
    const board = () => page.evaluate(() => window.infinitary.tasks.board());
    const gaugeId = (await board()).tasks.find((row) => row.key === gaugeKey)?.id;
    if (!gaugeId) throw new Error("The gauge task never reached the board.");
    await expect
      .poll(() => page.evaluate((id) => window.infinitary.tasks.detail(id), gaugeId), {
        timeout: 30_000,
      })
      .toMatchObject({ status: "done" });
    // The close filed the captain's action as a task of its own.
    const filed = shortTaskTitle(FREEZE_MERGE_ACTION.title);
    await expect
      .poll(async () => (await board()).tasks.some((row) => row.title === filed))
      .toBe(true);
    step("while the task board opened");
    await openBoardButton(page).click();
    await expect(boardEntry(page)).toBeVisible();
    step("while the captain typed");
    const input = promptInput(page);
    await input.click();
    await typeInto(input, "How is the history coming along", { delay: 20 });
    step("in the minute passes");
    const after = passes;
    await expect
      .poll(() => passes - after, { timeout: 120_000 })
      .toBeGreaterThanOrEqual(MINUTE_PASSES);

    let incidents = readFreezes(recordPath);
    // INF-2205: wait for the recording to finish, not for a guessed CPU
    // reading. An interrupted incident cannot count as zero work.
    await expect
      .poll(() => {
        incidents = readFreezes(recordPath);
        return incidents.filter((line) => !("cpuMs" in line));
      })
      .toEqual([]);
    const record = incidents.filter((line): line is FreezeLine => "cpuMs" in line);
    // The busiest stall, printed on every run, so a change that brings the
    // app nearer the line shows before it crosses it.
    const busiest = record.reduce<FreezeLine | undefined>(
      (most, line) => (most && most.cpuMs >= line.cpuMs ? most : line),
      undefined,
    );
    test.info().annotations.push({
      type: "busiest main thread stall",
      description: busiest ? described(busiest, steps) : "none recorded",
    });
    console.log(
      `[freeze journey] ${record.length} stall(s); busiest: ${busiest ? described(busiest, steps) : "none"}`,
    );
    // How many stalls have a call path, and how long each took to arrive once
    // asked for: the wait until the main thread next ran JavaScript, as well
    // as the read itself.
    const reads = record
      .flatMap((line) =>
        line.captureRequestedAt && line.capturedAt
          ? [Date.parse(line.capturedAt) - Date.parse(line.captureRequestedAt)]
          : [],
      )
      .sort((a, b) => a - b);
    const named = record.filter((line) => line.frames.length > 0).length;
    console.log(
      `[freeze journey] ${named} of ${record.length} stall(s) named; call paths read for ${reads.length}${
        reads.length
          ? `, ${reads[reads.length >> 1]} ms after being asked for at the median and ${reads.at(-1)} ms at the longest`
          : ""
      }`,
    );
    // The minute's passes name themselves, which a stall the recorder could
    // not name needs (docs/architecture.md, "[ticker] <name>").
    for (const pass of slowPasses) console.log(`[freeze journey] ${pass}`);
    // The captain's pick on INF-4076, "Start timing each minute-pass step":
    // each pass's steps are timed, the work they set off included, and the
    // record holds a line for every pass but the one still collecting.
    await expect
      .poll(() => readPasses(passRecordPath).length)
      .toBeGreaterThanOrEqual(MINUTE_PASSES - 1);
    const timed = readPasses(passRecordPath);
    for (const pass of timed) {
      const names = pass.steps.map((each) => each.name);
      expect(names).toEqual(expect.arrayContaining(["idle-ladder", "sweep-release"]));
      console.log(
        `[freeze journey] pass ${pass.at}: ${pass.steps
          .map(
            (each) =>
              `${each.name} +${each.startMs} ${each.syncMs} ms (${each.cpuMs} cpu)${
                each.workMs === undefined ? "" : `, work ${each.workMs} ms`
              }`,
          )
          .join("; ")}`,
      );
    }
    const frozen = record.filter((line) => line.cpuMs >= FREEZE_LINE_CPU_MS);
    expect(frozen.map((line) => described(line, steps))).toEqual([]);
  } finally {
    await app.close();
  }
});
