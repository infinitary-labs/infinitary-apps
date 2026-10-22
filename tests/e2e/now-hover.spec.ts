import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { DEPENDENCY_VISUAL } from "../../src/shared/dependencyVisual";
import { scratchDir } from "../helpers/scratchDirs";
import { startDemo } from "./demo";
import { launchApp } from "./launch";
import { resizeWindow, slidePointer } from "./layout";
import {
  dockFrameElement,
  expandDock,
  expectRecordBody,
  nowFrame,
  openGroup,
  POINT_SUMMARY,
  restOnTaskKey,
  rowSummary,
} from "./rails";
import { pressKey } from "./windowKeys";

/**
 * INF-657, from the captain's rapid-row-hover report and INF-656's reproduction:
 * crossing visible Tasks rows must not measure unchanged clipped rows. Real
 * Chromium pointer routing, real task records, isolated HOME/data/provider; no
 * timing ceiling and no disabled summaries. The desktop lane owns pointer input.
 */
test("rapid Tasks row sweeps leave unchanged offscreen geometry alone", async () => {
  const userDataDir = scratchDir("infinitary-now-hover-");
  const db = openDatabase(userDataDir);
  const count = 1_200;
  try {
    let writtenAt = Date.now();
    const tasks = new TaskService({ db, strict: true, now: () => writtenAt });
    db.transaction(() => {
      for (let i = 0; i < count; i++) {
        writtenAt--;
        seedTask(tasks, {
          id: `hover-${i}`,
          title: `${["Review keyboard navigation", "Check task summaries", "Update project documentation", "Verify dependency display"][i % 4]} ${i + 1}`,
          status: "queued",
          startPolicy: "on-request",
          createdAt: writtenAt,
        });
      }
    })();
  } finally {
    db.close();
  }
  const size = { width: 1200, height: 800 };
  const options = { userDataDir, withMockProvider: true, gpuBenchmarking: true };
  // Optional evidence capture uses exactly the journey's fixture and action.
  const evidence = process.env.HOVER_EVIDENCE;
  const demo = evidence ? await startDemo({ ...options, size }) : null;
  const app = demo?.launched ?? (await launchApp(options));
  try {
    const { page } = app;
    if (!demo) await resizeWindow(app.app, page, size);
    await expandDock(page, "now");
    await openGroup(page, "backlog");
    const body = nowFrame(page).locator("body");
    await expect(body.locator("[data-now-row]")).toHaveCount(count);
    await body.evaluate(() =>
      Promise.all(document.getAnimations().map((motion) => motion.finished.catch(() => undefined))),
    );
    // The panel document is taller than its visible shell. Read the actual clip,
    // not the frame viewport, to distinguish rows the person can and cannot see.
    const clip = await dockFrameElement(page, "now").evaluate((frame) => {
      const origin = frame.getBoundingClientRect();
      let top = Math.max(0, origin.top);
      let bottom = Math.min(innerHeight, origin.bottom);
      for (let el = frame.parentElement; el; el = el.parentElement) {
        if (!/(auto|scroll|hidden|clip)/.test(getComputedStyle(el).overflowY)) continue;
        const box = el.getBoundingClientRect();
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
      return { top: top - origin.top, bottom: bottom - origin.top, x: origin.x, y: origin.y };
    });
    const visible = await body.locator("[data-now-row]").evaluateAll(
      (rows, clip) =>
        rows.flatMap((row) => {
          const box = row.getBoundingClientRect();
          return box.top >= clip.top && box.bottom <= clip.bottom
            ? [
                {
                  id: row.getAttribute("data-now-row") ?? "",
                  x: box.x + box.width / 2 + clip.x,
                  y: box.y + box.height / 2 + clip.y,
                },
              ]
            : [];
        }),
      clip,
    );
    const sweepRows = visible.slice(0, 12);
    expect(sweepRows.length).toBeGreaterThan(2);
    const first = sweepRows[0];
    const last = sweepRows[sweepRows.length - 1];
    if (!first || !last) throw new Error("The list has no visible sweep endpoints");
    await slidePointer(page, first, first, 1);
    await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, first.id);
    await expect(body.locator(`[data-now-row="${first.id}"]`)).toHaveAttribute("data-now-lit", "");
    const read = await body.evaluateHandle((_, clip) => {
      let offscreenReads = 0;
      let rowReads = 0;
      let entries = 0;
      const delays: number[] = [];
      const original = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function () {
        const box = original.call(this);
        if (this.hasAttribute("data-now-row")) {
          rowReads++;
          if (box.bottom <= clip.top || box.top >= clip.bottom) offscreenReads++;
        }
        return box;
      };
      const onOver = (event: PointerEvent) => {
        if ((event.target as Element).closest("[data-now-row]")) {
          entries++;
          delays.push(performance.now() - event.timeStamp);
        }
      };
      document.addEventListener("pointerover", onOver);
      return {
        result: () => ({ offscreenReads, rowReads, entries, delays }),
        stop: () => {
          Element.prototype.getBoundingClientRect = original;
          document.removeEventListener("pointerover", onOver);
        },
      };
    }, clip);
    const sweep = async () => {
      for (let pass = 0; pass < 17; pass++) {
        const [from, to] = pass % 2 === 0 ? [first, last] : [last, first];
        await slidePointer(page, from, to, sweepRows.length - 1);
      }
      // Chromium's synthetic mouse on Linux can lose the final move of a rapid
      // gesture on its way into the panel's frame (INF-823). One resting move
      // inside the last row puts the pointer there; every check below stands.
      await slidePointer(page, last, { x: last.x + 3, y: last.y }, 1);
      // A real summary and the echoed highlight, not just native CSS :hover,
      // must reach the final row before the reading is complete.
      await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, last.id);
      await expect(body.locator(`[data-now-row="${last.id}"]`)).toHaveAttribute("data-now-lit", "");
    };
    if (demo) await demo.record("Sweep across Tasks rows", "window", sweep);
    else await sweep();
    const result = await read.evaluate((reader) => reader.result());
    await read.evaluate((reader) => reader.stop());
    await read.dispose();
    const { delays: _delays, ...work } = result;
    console.log("Hover work:", JSON.stringify(work));
    if (evidence) writeFileSync(`${evidence}/hover-work.json`, JSON.stringify(result, null, 2));
    if (demo && evidence) await demo.finish({ dir: evidence, name: "tasks-hover" });
    expect(result.entries, "the real pointer crossed multiple rows").toBeGreaterThan(
      sweepRows.length,
    );
    expect(result.offscreenReads, "rapid hovering remeasures unchanged offscreen task rows").toBe(
      0,
    );
  } finally {
    await app.close();
  }
});

// The geometry cache must remain live: retaining positions must not hide edges
// on inspection or leave old lines after the captain changes the visible list.
test("cached Tasks positions follow dependency inspection, folding and filtering", async () => {
  const userDataDir = scratchDir("infinitary-now-edges-");
  const db = openDatabase(userDataDir);
  const pairs = Array.from({ length: DEPENDENCY_VISUAL.edgeLanes + 1 }, (_, i) => ({
    blocker: `blocker-${i}`,
    task: `dependent-${i}`,
    title: `Dependency pair ${i + 1}`,
  }));
  try {
    const tasks = new TaskService({ db, strict: true });
    for (const pair of pairs) {
      seedTask(tasks, {
        id: pair.blocker,
        title: `${pair.title} prepare`,
        status: "queued",
        startPolicy: "on-request",
      });
      seedTask(tasks, {
        id: pair.task,
        title: `${pair.title} verify`,
        status: "queued",
        startPolicy: "on-request",
      });
      tasks.link(pair.blocker, pair.task, "blocks", "host");
    }
  } finally {
    db.close();
  }
  const app = await launchApp({ userDataDir, withMockProvider: true, gpuBenchmarking: true });
  try {
    const { page } = app;
    await resizeWindow(app.app, page, { width: 1200, height: 800 });
    await expandDock(page, "now");
    await openGroup(page, "backlog");
    const frame = nowFrame(page);
    const edges = frame.locator("[data-now-edge]");
    await expect(edges.first()).toBeVisible();
    await frame
      .locator("body")
      .evaluate(() =>
        Promise.all(
          document.getAnimations().map((motion) => motion.finished.catch(() => undefined)),
        ),
      );
    // A cached endpoint must still reach its row after the opening transform
    // finishes, rather than retaining a position partway through the reveal.
    await expect
      .poll(() =>
        edges.evaluateAll((edges) =>
          edges.every((edge) => {
            const row = document.querySelector(
              `[data-now-row="${edge.getAttribute("data-now-edge-from")}"]`,
            );
            const root = document.querySelector("[data-now-groups]");
            if (!row || !root) return false;
            const box = row.getBoundingClientRect();
            return (
              (edge as SVGPathElement).getPointAtLength(0).y ===
              Math.round(box.top - root.getBoundingClientRect().top + box.height / 2)
            );
          }),
        ),
      )
      .toBe(true);
    const drawn = await edges.evaluateAll((edges) =>
      edges.map((edge) => edge.getAttribute("data-now-edge-from")),
    );
    const overflow = pairs.find((pair) => !drawn.includes(pair.task));
    if (!overflow) throw new Error("Fixture must include a dependency outside the ordinary lanes");
    const row = frame.locator(`[data-now-row="${overflow.task}"]`);
    await restOnTaskKey(page, row);
    await expect(rowSummary(page)).toHaveAttribute(POINT_SUMMARY, overflow.task);
    const inspected = frame.locator(
      `[data-now-edge-from="${overflow.task}"][data-now-edge-to="${overflow.blocker}"]`,
    );
    await expect(inspected).toHaveAttribute("data-now-edge-lit", "");
    const originalPath = await inspected.getAttribute("d");

    const header = frame.locator('[data-now-group-header="backlog"]');
    await pressKey(header, "Enter");
    await expect(frame.locator("[data-now-row]")).toHaveCount(0);
    await expect(edges).toHaveCount(0);
    await pressKey(header, "Enter");
    await expect(frame.locator("[data-now-row]")).toHaveCount(pairs.length * 2);
    await expect(edges.first()).toBeVisible();

    await page
      .locator('[data-side-panel="now"]')
      .getByRole("button", { name: "Search tasks" })
      .click();
    await frame.locator("[data-now-query]").fill(overflow.title);
    await expect(frame.locator("[data-now-row]")).toHaveCount(2);
    await expect(edges).toHaveCount(1);
    await expect(inspected).toBeVisible();
    // This pair has moved into the two-row filtered list, not retained its
    // previous endpoints among the eight rows.
    await expect(inspected).not.toHaveAttribute("d", originalPath ?? "");
    await pressKey(row, "Enter");
    await expectRecordBody(page);
    await expect(row).toHaveAttribute("data-now-selected", "");
  } finally {
    await app.close();
  }
});
