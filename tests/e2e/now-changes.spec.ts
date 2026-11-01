import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { measured, PERF_TAG } from "./perf";
import { expandDock, nowFrame, nowRowGroup, openGroup } from "./rails";

/**
 * INF-2105, on INF-2078's accepted plan ("every row stays in the page; only
 * the redraw and the measuring are narrowed to what changed"): a board
 * change reaching a Tasks list of many rows paints only the rows the change
 * touched and measures only the rows a dependency edge needs, with every
 * row still in the page. The work each paint did is read off the frame's
 * own `now:render` measures (their `detail.rows`, the rows the paint
 * built), the measuring off the rows' own rect reads; each paint's duration
 * prints, and grades only on a perf run (./perf.ts).
 */

const ROWS = 2_000;
/** Backlog rows blocked by another backlog row: each pair is two rows an edge needs placed. */
const PAIRS = 5;
/**
 * The row each change moves: the last backlog row, which waits on the row
 * before it. A queued row that nothing holds starts at once (the board's
 * queue op is a Start then), so only a held row moves from Backlog to
 * Queued and back.
 */
const MOVED = ROWS - 1;
/** One paint of the groups after a change: INF-2078's bar for a list redraw. */
const CHANGE_RENDER_BUDGET_MS = 4;

type Paint = { duration: number; rows: number };

test("a board change paints and measures only the rows it touched", { tag: PERF_TAG }, async () => {
  const userDataDir = scratchDir("infinitary-now-changes-");
  const db = openDatabase(userDataDir);
  try {
    let writtenAt = Date.now();
    const tasks = new TaskService({ db, strict: true, now: () => writtenAt });
    db.transaction(() => {
      for (let i = 0; i < ROWS; i++) {
        writtenAt--;
        seedTask(tasks, {
          id: `change-${i}`,
          title: `${["Review keyboard navigation", "Check task summaries", "Update project documentation", "Verify dependency display"][i % 4]} ${i + 1}`,
          status: "queued",
          startPolicy: "on-request",
          createdAt: writtenAt,
        });
      }
      for (let i = 0; i < PAIRS; i++) {
        tasks.link(`change-${i * 2}`, `change-${i * 2 + 1}`, "blocks", "host");
      }
      tasks.link(`change-${MOVED - 1}`, `change-${MOVED}`, "blocks", "host");
    })();
  } finally {
    db.close();
  }
  const app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = app;
    await expandDock(page, "now");
    await openGroup(page, "backlog");
    const body = nowFrame(page).locator("body");
    await expect(body.locator("[data-now-row]")).toHaveCount(ROWS);
    await body.evaluate(() =>
      Promise.all(document.getAnimations().map((motion) => motion.finished.catch(() => undefined))),
    );
    const moved = await body.locator(`[data-now-row="change-${MOVED}"]`).evaluate((row) => ({
      id: row.getAttribute("data-now-row") ?? "",
      key: row.getAttribute("data-now-key") ?? "",
    }));
    expect(await nowRowGroup(page, moved.key)).toBe("backlog");
    // Count the rows' rect reads from here on; the paints the frame
    // records carry the rows each one built.
    const recorder = await body.evaluateHandle(() => {
      let rowReads = 0;
      const original = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        if (this.hasAttribute("data-now-row")) rowReads++;
        return original.call(this);
      };
      const seen = performance.getEntriesByName("now:render").length;
      return {
        read: () => ({
          rowReads,
          paints: performance
            .getEntriesByName("now:render")
            .slice(seen)
            .map((entry): Paint => {
              const detail = (entry as PerformanceMeasure).detail as { rows?: unknown } | null;
              return {
                duration: entry.duration,
                rows: typeof detail?.rows === "number" ? detail.rows : Number.NaN,
              };
            }),
        }),
        stop: () => {
          Element.prototype.getBoundingClientRect = original;
        },
      };
    });
    // The blocked pairs' ends, the moved row's own pair among them.
    const endpoints = (PAIRS + 1) * 2;
    const paints: Paint[] = [];
    let readsSoFar = 0;
    // Each change moves one backlog row into Queued and back: the row
    // leaves one group and joins the other, and no other row's data moves.
    for (const [op, group] of [
      ["queue-task", "queued"],
      ["unqueue-task", "backlog"],
    ] as const) {
      await page.evaluate(({ id, op }) => window.infinitary.task.run(id, op), {
        id: moved.id,
        op,
      } as const);
      await expect.poll(() => nowRowGroup(page, moved.key)).toBe(group);
      await expect(body.locator("[data-now-row]")).toHaveCount(ROWS);
      const { rowReads, paints: since } = await recorder.evaluate((rec) => rec.read());
      const painted = since.slice(paints.length);
      expect(painted.length).toBeGreaterThan(0);
      // The paints since the change built the moved row, and nothing else
      // (the moved row mounts once in its new group); every other row kept
      // its object and its memoized paint.
      expect(painted.map((paint) => paint.rows)).toEqual(
        painted.map((_, index) => (index === 0 ? 1 : 0)),
      );
      // The measuring covered the rows an edge needs - the blocked pairs'
      // ends - and not the list: once from the changed rows, and at most
      // twice more as the list's resize observer reports the moved row's
      // room (its first report at observe, and the root's new height).
      const reads = rowReads - readsSoFar;
      expect(reads).toBeLessThanOrEqual(endpoints * 3);
      expect(reads).toBeLessThan(ROWS);
      readsSoFar = rowReads;
      paints.push(...painted);
    }
    await recorder.evaluate((rec) => rec.stop());
    measured(
      "now:render after a change",
      paints.map((paint) => paint.duration),
      CHANGE_RENDER_BUDGET_MS,
    );
  } finally {
    await app.close();
  }
});
