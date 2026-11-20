import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import type { TaskBoard, TaskBoardDelta, TaskView } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { regionShot } from "./pictures";
import { served } from "./providerRequest";

/**
 * Above the board's delta trigger (task-system P5: more than 500 rows or
 * 256 KiB) the core pushes what changed instead of the board, and the
 * stage's wait arrows and tasks with parts still follow every change
 * (INF-892: they listened to snapshots alone, so a large board froze them).
 * The dev override lowers the trigger to zero, so a small board takes the
 * path a large one takes. A review program is seeded as
 * `program-constellation.spec.ts` seeds one, with a second verifier running
 * beside the first, next to two idle crewmates.
 * The first mate links the two crewmates by a wait and later unlinks them,
 * and puts the second verifier behind the first, so the constellation, which
 * draws only running parts (INF-1037), moves; the window records every board push, and
 * each change must arrive as a delta, never a snapshot, before the stage's
 * published arrows and constellation are read. Completion is the near
 * layer's published reading; it runs on this Mac alone and shares nothing
 * with another test.
 */

const near = (page: Page) => page.locator('canvas[data-crew-layer="near"]');
const formation = (page: Page) => page.locator("[data-crew-formation]");

type BoardPush =
  | { channel: "snapshot"; value: TaskBoard }
  | { channel: "delta"; value: TaskBoardDelta };

declare global {
  interface Window {
    __boardPushes?: BoardPush[];
  }
}

/** Every board push the window has received since it started recording. */
function boardPushes(page: Page): Promise<BoardPush[]> {
  return page.evaluate(() => window.__boardPushes ?? []);
}

/**
 * The carrier of the first push, from the `since`th on, whose row for `id`
 * holds; null while none has.
 */
async function carrierOf(
  page: Page,
  id: string,
  holds: (task: TaskView) => boolean,
  since = 0,
): Promise<BoardPush["channel"] | null> {
  for (const push of (await boardPushes(page)).slice(since)) {
    const rows = push.channel === "snapshot" ? push.value.tasks : push.value.upserts;
    const row = rows.find((task) => task.id === id);
    if (row && holds(row)) return push.channel;
  }
  return null;
}

/** The captain's words, answered by the first mate with one `link_tasks` call. */
async function firstmateLinks(
  app: LaunchedApp,
  words: string,
  remove: boolean,
  { from, to }: { from: string; to: string } = { from: "owner", to: "waiter" },
): Promise<void> {
  if (!app.mockProvider) throw new Error("This journey scripts the first mate's link");
  const turn = app.mockProvider.scriptFirstmateTurn(
    served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
    [
      {
        name: "link_tasks",
        args: { from, to, type: "blocks", ...(remove ? { remove } : {}) },
      },
    ],
  );
  await askFirstmate(app.page, words);
  await expect.poll(() => turn.outcome().state).toBe("closed");
}

test("above the delta trigger, the stage's wait arrows and constellation follow every board change", async () => {
  const userDataDir = scratchDir("infinitary-crew-board-delta-");
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
    shape: { kind: "unclear", program: { script: 'return task("Find lost turns.");', bound: 3 } },
  });
  seedTask(tasks, {
    id: "find",
    title: "Find lost turns in the parser",
    parentId: "review",
    status: "idle",
    outcome: "Two places drop a turn on resume.",
  });
  tasks.close("find", { status: "done", reason: "answered", actor: "host" });
  seedTask(tasks, {
    id: "verify",
    title: "Verify the lost turns the finder found",
    parentId: "review",
    status: "idle",
    worktreeDir: worktree("verify"),
    outcome: "Reproduced one of the two.",
  });
  tasks.graph.link("find", "verify", "blocks", "host");
  seedTask(tasks, {
    id: "check",
    title: "Check the finder's second lost turn",
    parentId: "review",
    status: "idle",
    worktreeDir: worktree("check"),
    outcome: "Reading the resume path.",
  });
  tasks.graph.link("find", "check", "blocks", "host");
  seedTask(tasks, {
    id: "synthesize",
    title: "Write up the verified lost turns",
    parentId: "review",
    status: "queued",
    startPolicy: "on-request",
  });
  tasks.graph.link("verify", "synthesize", "blocks", "host");
  // Two crewmates with no wait between them yet.
  seedTask(tasks, {
    id: "owner",
    title: "Fix the session parser's resume",
    status: "idle",
    worktreeDir: worktree("owner"),
    outcome: "The resume fix is ready for review.",
  });
  seedTask(tasks, {
    id: "waiter",
    title: "Ship the resume fix to the importer",
    status: "idle",
    worktreeDir: worktree("waiter"),
    outcome: "The importer change is ready.",
  });
  const ownerKey = tasks.get("owner")?.key ?? "";
  const checkKey = tasks.get("check")?.key ?? "";
  db.pragma("query_only = ON");

  const app = await launchApp({
    withMockProvider: true,
    userDataDir,
    env: { INFINITARY_TASK_DELTA_ROWS: "0" },
  });
  try {
    const { page } = app;
    const out = (name: string) => test.info().outputPath(name);
    await waitForFirstmateIdle(page);
    // One settled frame, so each picture is the layout and not a moment of it.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await resizeWindow(app.app, page, { width: 1280, height: 860 });
    await expect
      .poll(() => near(page).getAttribute("data-constellation"), { timeout: 15_000 })
      .toBe("review=review>verify review>check");
    await expect(near(page)).toHaveAttribute("data-crew-arrows", "");
    // The core's first push follows the boot's presentation pass, so every
    // push from here on has a base and is a delta.
    await page.evaluate(() => {
      const pushes: BoardPush[] = [];
      window.__boardPushes = pushes;
      window.infinitary.tasks.onBoard((value) => pushes.push({ channel: "snapshot", value }));
      window.infinitary.tasks.onBoardDelta((value) => pushes.push({ channel: "delta", value }));
    });

    // Section 1: the first mate puts the importer behind the parser fix.
    await firstmateLinks(app, "Have the importer wait for the parser fix.", false);
    await expect
      .poll(() => carrierOf(page, "waiter", (task) => task.blockedBy.includes(ownerKey)))
      .toBe("delta");
    await expect(near(page)).toHaveAttribute("data-crew-arrows", "wait:waiter>owner");
    await regionShot(formation(page), out("delta-wait-drawn.png"));

    // Section 2: the first mate puts the second verifier behind the first.
    await firstmateLinks(app, "Have the second check wait for the verification.", false, {
      from: "verify",
      to: "check",
    });
    await expect
      .poll(() => carrierOf(page, "verify", (task) => task.blocks.includes(checkKey)))
      .toBe("delta");
    await expect(near(page)).toHaveAttribute(
      "data-constellation",
      "review=review>verify verify>check",
    );
    await regionShot(formation(page), out("delta-part-linked.png"));

    // Section 3: the first mate takes the wait away again.
    const linked = (await boardPushes(page)).length;
    await firstmateLinks(app, "The importer no longer needs to wait for the parser fix.", true);
    await expect
      .poll(() => carrierOf(page, "waiter", (task) => task.blockedBy.length === 0, linked))
      .toBe("delta");
    await expect(near(page)).toHaveAttribute("data-crew-arrows", "");
    await regionShot(formation(page), out("delta-wait-cleared.png"));

    // Nothing reached the window but deltas: no snapshot redrew the stage.
    expect((await boardPushes(page)).map((push) => push.channel)).not.toContain("snapshot");
  } finally {
    await app.close();
  }
});
