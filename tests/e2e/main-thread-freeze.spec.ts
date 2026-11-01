import { existsSync, readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { type FreezeLine, freezeLineSchema } from "../../src/core/freeze/freezeRecorder";
import { appPathsFor } from "../../src/core/paths";
import { scratchDir } from "../helpers/scratchDirs";
import { seedCaptainSizedRecord } from "./captainSizedRecord";
import { waitForFirstmateIdle } from "./crew";
import { launchApp, SHORT_TICK } from "./launch";
import { REACT_PROMPT_MARKER } from "./mockProvider";
import { promptInput } from "./prompt";
import { boardEntry, openBoardButton } from "./taskBoard";
import { typeInto } from "./windowKeys";

/**
 * The freeze journey (INF-2061's approved plan, direction B; built as
 * INF-2068; docs/freeze-recorder.md, "Before a change merges"). It runs the
 * actual app on a record the captain's size with the freeze recorder on,
 * drives the work that repeats - first mate turns, which read the open
 * messages before and after each, the minute passes with the answer-delivery
 * sweep, the task board and typing - and fails, naming the call path, on any
 * stretch of the main thread's own processor time at or over the line.
 *
 * The line counts processor time, never wall time: a busy test computer
 * stretches a freeze's wall time but not the work the main thread did in it
 * (docs/testing.md, the captain's B1 timing rule). A wait on another program uses almost no
 * processor time, so the wait check in `pnpm check` covers it instead
 * (scripts/main-thread-waits.ts).
 *
 * Promised result: no recorded stall reaches the line. Data: the captain's
 * readings (captainSizedRecord.ts). Completion signal: the minute passes the
 * app reports on its own output. Prerequisites: none beyond a built app;
 * the recorder works the same on Linux and the Mac. Shared resources: none.
 */

/**
 * The line, INF-2061's plan: the past freezes a person felt as one (INF-1348,
 * INF-1956, INF-2059) each held the main thread 800 ms or more at a time.
 */
const FREEZE_LINE_CPU_MS = 250;
/** Minute passes to drive after the turns: each runs every check the minute pass holds. */
const MINUTE_PASSES = 5;

async function say(page: Page, text: string): Promise<void> {
  const input = promptInput(page);
  await input.click();
  await input.fill(text);
  await input.press("Enter");
}

function readFreezes(path: string): FreezeLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((text) => freezeLineSchema.parse(JSON.parse(text)));
}

/** What the journey was doing, by when it began each part. */
type Step = { at: number; doing: string };

/**
 * One stall in words: its processor time, what the journey was doing, and
 * its call path, innermost first.
 */
const described = (line: FreezeLine, steps: readonly Step[]) =>
  `${line.cpuMs} ms of processor time in ${line.wallMs} ms, ${
    steps.findLast((step) => step.at <= Date.parse(line.at))?.doing ?? "before the launch"
  }: ${
    line.frames
      .slice(0, 8)
      .map((frame) => `${frame.name} (${frame.file}:${frame.line})`)
      .join(" <- ") || "no call path"
  }`;

test("the main thread never spends 250 ms of its own processor time at once on a record the captain's size", async () => {
  // Seeding 160,094 events through the one writer takes most of a minute on
  // a shared runner; the passes and turns take about another.
  test.setTimeout(240_000);
  const userDataDir = scratchDir("infinitary-freeze-journey-");
  seedCaptainSizedRecord(userDataDir);
  const recordPath = appPathsFor(userDataDir).freezeRecordPath;
  const steps: Step[] = [];
  const step = (doing: string) => steps.push({ at: Date.now(), doing });
  step("while the app started");
  const app = await launchApp({
    userDataDir,
    withMockProvider: true,
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
      .poll(() => readFreezes(recordPath).filter((line) => line.uncertain === "waited").length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    for (const piece of ["the history", "the open messages", "the board"]) {
      step(`in the first mate's turn about ${piece}`);
      await say(page, `${REACT_PROMPT_MARKER}: how is ${piece} going?`);
      await waitForFirstmateIdle(page);
    }
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

    const record = readFreezes(recordPath);
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
    // The minute's passes name themselves, which a stall the recorder could
    // not name needs (docs/architecture.md, "[ticker] <name>").
    for (const pass of slowPasses) console.log(`[freeze journey] ${pass}`);
    const frozen = record.filter((line) => line.cpuMs >= FREEZE_LINE_CPU_MS);
    expect(frozen.map((line) => described(line, steps))).toEqual([]);
  } finally {
    await app.close();
  }
});
