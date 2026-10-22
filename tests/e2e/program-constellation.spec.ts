import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";

/**
 * A task with parts draws on the stage as a branching constellation (the
 * captain's INF-799 choice, "Branching constellation": "the branches are the
 * program's own graph"). A review program is seeded the way the task graph
 * records one: two finders done, a verifier for each underway, built on its
 * finder by a recorded wait, and a synthesis waiting on both verifiers. The
 * stage draws one branch per recorded link and none it was not given, seats
 * each verifier's crewmate at its node, and redraws when a part is dropped.
 * Completion is the near layer's published constellation; it runs on this
 * Mac alone and shares nothing with another test.
 */

const near = (page: Page) => page.locator('canvas[data-crew-layer="near"]');

async function constellation(page: Page): Promise<string> {
  return (await near(page).getAttribute("data-constellation")) ?? "";
}

test("a task with parts draws its recorded graph as a constellation and redraws when a part is dropped", async () => {
  const userDataDir = scratchDir("infinitary-program-constellation-");
  const db = openDatabase(userDataDir);
  const tasks = new TaskService({ db });
  const worktree = (id: string) => {
    const dir = join(userDataDir, "worktrees", id);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  // The program is a container nobody starts; its parts are its children.
  seedTask(tasks, {
    id: "review",
    title: "Review the session parser for lost turns",
    status: "queued",
    startPolicy: "on-request",
  });
  for (const id of ["find-a", "find-b"]) {
    seedTask(tasks, {
      id,
      title: `Find lost turns in the parser, ${id === "find-a" ? "Pi" : "Claude"} sessions`,
      parentId: "review",
      status: "idle",
      outcome: "Two places drop a turn on resume.",
    });
    tasks.close(id, { status: "done", reason: "answered", actor: "host" });
  }
  for (const [id, finder] of [
    ["verify-a", "find-a"],
    ["verify-b", "find-b"],
  ] as const) {
    seedTask(tasks, {
      id,
      title: `Verify the lost turns ${finder} found`,
      parentId: "review",
      status: "idle",
      worktreeDir: worktree(id),
      outcome: "Reproduced one of the two.",
    });
    tasks.link(finder, id, "blocks", "host");
  }
  seedTask(tasks, {
    id: "synthesize",
    title: "Write up the verified lost turns",
    parentId: "review",
    status: "queued",
    startPolicy: "on-request",
  });
  tasks.link("verify-a", "synthesize", "blocks", "host");
  tasks.link("verify-b", "synthesize", "blocks", "host");
  db.pragma("query_only = ON");

  const app = await launchApp({ withMockProvider: true, userDataDir });
  try {
    const { page } = app;
    await waitForFirstmateIdle(page);
    // One settled frame, so the picture is the layout and not a moment of it.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await resizeWindow(app.app, page, { width: 1280, height: 860 });

    // Section 1: every branch is one recorded link, from the program's mark.
    await expect
      .poll(() => constellation(page), { timeout: 15_000 })
      .toBe(
        "review=review>find-a review>find-b find-a>verify-a find-b>verify-b verify-a>synthesize verify-b>synthesize",
      );
    await expect(near(page)).toHaveAttribute("data-constellation-crew", "verify-a verify-b");
    await regionShot(
      page.locator("[data-crew-formation]"),
      test.info().outputPath("constellation-review.png"),
    );
    // The release note's pair, taken on request: it rewrites committed files.
    if (process.env.CONSTELLATION_HERO === "1")
      await heroShot(app.app, page, {
        region: page.locator("[data-crew-formation]"),
        name: "program-constellation",
      });

    // Section 2: the synthesis is dropped before it starts; it leaves no node.
    // The record's Drop task, with the effects it reviewed: none wait on it.
    await page.evaluate(() =>
      window.infinitary.task.run("synthesize", "drop-task", {
        parts: [],
        waiting: [],
        underway: [],
      }),
    );
    await expect
      .poll(() => page.evaluate(() => window.infinitary.tasks.detail("synthesize")))
      .toMatchObject({ status: "dropped" });
    await expect
      .poll(() => constellation(page), { timeout: 15_000 })
      .toBe("review=review>find-a review>find-b find-a>verify-a find-b>verify-b");
    await expect(near(page)).toHaveAttribute("data-constellation-crew", "verify-a verify-b");
    await regionShot(
      page.locator("[data-crew-formation]"),
      test.info().outputPath("constellation-dropped-part.png"),
    );
  } finally {
    await app.close();
  }
});
