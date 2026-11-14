import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { pillWords, type ViewMac } from "../../src/renderer/src/devices/viewWords";
import { PROTOCOL_VERSION, VIEW_FLOOR } from "../../src/shared/ipc";
import { VIEW_OPEN_LISTS } from "../../src/shared/openLists";
import { type TaskBoard, taskKindSchema } from "../../src/shared/tasks";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { showCard } from "./stack";

/**
 * The view floor between two computers (INF-1649, the captain's direction A:
 * "a floor for every view, the phone and a Mac viewing another Mac, while
 * work computers stay strict", and newer-phone: "Yes, both directions"; the
 * live desktop proof review R8 asked for). A second app controls the Mac
 * where Firstmate lives across a major the floor covers, older or newer, and
 * its answer reaches that Mac; past the floor it reads, and its pill names
 * the side to update. The Mac where Firstmate lives stands in its contract
 * version and floor (`INFINITARY_CONTRACT_VERSION`, `INFINITARY_VIEW_FLOOR`,
 * docs/view.md); the view speaks this build's own.
 */

const MAJOR = Number(PROTOCOL_VERSION.split(".")[0]);
const CARD = "Two ways to fix the flaky test";
const TASK = "harbour-task";

/** The Mac where Firstmate lives, on a stand-in contract, with one choice to answer. */
async function homeOn(major: number, floor: number): Promise<LaunchedApp> {
  const dir = scratchDir("infinitary-view-floor-home-");
  const db = openDatabase(dir);
  new CardStore(db).upsert({
    id: "flaky",
    author: "firstmate",
    priority: 50,
    meta: "harbour",
    status: "ready",
    createdAt: Date.now(),
    title: CARD,
    body: "<p>Mock the clock, or await the queue. The second is smaller.</p>",
    actions: [
      { id: "clock", label: "Mock the clock" },
      { id: "queue", label: "Await the queue", default: true },
    ],
  });
  seedTask(new TaskService({ db, strict: true }), {
    id: TASK,
    title: "Chart the harbour",
    status: "queued",
    startPolicy: "on-request",
  });
  db.close();
  return launchApp({
    userDataDir: dir,
    env: {
      INFINITARY_DEVICE_NAME: "MacBook Pro",
      INFINITARY_CONTRACT_VERSION: `${major}.0.0`,
      INFINITARY_VIEW_FLOOR: `${floor}`,
    },
  });
}

/** This build's app, joined to that Mac with its link as a view. */
async function viewOf(pro: LaunchedApp): Promise<LaunchedApp> {
  const invite = await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
  const air = await launchApp({ env: { INFINITARY_DEVICE_NAME: "MacBook Air" } });
  // Joining starts the window over, so its answer may never return to this page.
  await air.page.evaluate((link) => {
    void window.infinitary.devices.join(link);
  }, invite.link);
  await expect(air.page.locator("[data-remote-control]")).toHaveAttribute(
    "data-remote-control",
    "in-reach",
  );
  return air;
}

const shownIds = (page: Page) =>
  page.evaluate(async () => (await window.infinitary.cards.list()).map((card) => card.id));

/** The view answers the choice, and the Mac where Firstmate lives takes it. */
async function answers(air: LaunchedApp, pro: LaunchedApp) {
  await expect.poll(() => shownIds(air.page)).toContain("flaky");
  await expect(air.page.locator("[data-view-pill]")).toHaveCount(0);
  await showCard(air.page, CARD);
  await air.page.getByRole("button", { name: "Await the queue" }).click();
  await expect.poll(() => shownIds(pro.page)).not.toContain("flaky");
}

test("a Mac controlling another changes things across majors the view floor covers, both ways, and reads past it", async () => {
  // Three pairs of launches: a newer home, an older home its floor reaches, one it does not.
  test.setTimeout(240_000);
  const opened: LaunchedApp[] = [];
  try {
    await test.step("an older view changes things on a newer home whose major kept views", async () => {
      const pro = await homeOn(MAJOR + 1, MAJOR);
      opened.push(pro);
      const air = await viewOf(pro);
      opened.push(air);
      await answers(air, pro);
      await air.page.screenshot({ path: test.info().outputPath("older-view-newer-home.png") });
    });

    await test.step("the running view keeps a task of a kind it does not know, and still drops a broken board", async () => {
      // INF-1649 open-lists, "Yes, for what phones and views read"; review R11 asked for it in the
      // running app. A newer home's board names a task kind this build does not list. The view's
      // link hands each home push to its window over IPC, so the push is stood in there, at the
      // view's own main process, and read by its preload as a home's would be.
      const [pro, air] = opened as [LaunchedApp, LaunchedApp];
      const board = (await pro.page.evaluate(() => window.infinitary.tasks.board())) as TaskBoard;
      expect(board.tasks.map((task) => task.id)).toContain(TASK);
      const withTask = (change: Record<string, unknown>) => ({
        ...board,
        tasks: board.tasks.map((task) => (task.id === TASK ? { ...task, ...change } : task)),
      });
      await air.page.evaluate(() => {
        const seen: TaskBoard[] = [];
        (window as unknown as { __boards: TaskBoard[] }).__boards = seen;
        window.infinitary.tasks.onBoard((next) => seen.push(next));
      });
      // A status no list leaves open, a kind no version names yet, then the board as it is. The
      // home's own pushes reach this window too - answering its card above republishes its board
      // - so each stand-in carries a seq past the home's, and only those are counted.
      const first = board.seq + 1_000;
      const pushes = [withTask({ status: "paused" }), withTask({ kind: "inquiry" }), board];
      for (const [n, pushed] of pushes.entries())
        await air.app.evaluate(
          ({ BrowserWindow }, payload) => {
            BrowserWindow.getAllWindows()[0]?.webContents.send("inf:tasks", payload);
          },
          { ...pushed, seq: first + n },
        );
      const seen = async () =>
        (
          await air.page.evaluate(() => (window as unknown as { __boards: TaskBoard[] }).__boards)
        ).filter((next) => next.seq >= first);
      // Pushes arrive in order, so once the last is in, every earlier one that was kept is too.
      await expect.poll(async () => (await seen()).at(-1)?.seq).toBe(first + 2);
      expect((await seen()).map((next) => next.seq)).toEqual([first + 1, first + 2]);
      const [kept, plain] = await seen();
      // No board the home pushed meanwhile reached the stand-ins' seqs.
      const home = (await pro.page.evaluate(() => window.infinitary.tasks.board())) as TaskBoard;
      expect(home.seq).toBeLessThan(first);
      const standIn = VIEW_OPEN_LISTS.find(({ list }) => list === taskKindSchema)?.unknown;
      expect(kept?.tasks.find((task) => task.id === TASK)?.kind).toBe(standIn);
      expect(plain?.tasks.find((task) => task.id === TASK)?.kind).toBe("work");
    });

    await test.step("a newer view changes things on an older home its own floor reaches", async () => {
      const pro = await homeOn(VIEW_FLOOR, VIEW_FLOOR);
      opened.push(pro);
      const air = await viewOf(pro);
      opened.push(air);
      await answers(air, pro);
      await air.page.screenshot({ path: test.info().outputPath("newer-view-older-home.png") });
    });

    await test.step("past the view's floor it reads, and its pill names that Mac to update", async () => {
      const pro = await homeOn(VIEW_FLOOR - 1, VIEW_FLOOR - 1);
      opened.push(pro);
      const air = await viewOf(pro);
      opened.push(air);
      const seen: ViewMac = {
        role: "view",
        name: "MacBook Pro",
        address: "127.0.0.1",
        joinedAt: 0,
        contact: "in-reach",
        readOnly: "older-there",
        heardAt: null,
        caughtUp: 0,
      };
      await expect(air.page.locator('[data-view-pill="older-there"]')).toContainText(
        pillWords(seen) ?? "",
      );
      await expect.poll(() => shownIds(air.page)).toContain("flaky");
      await expect(
        air.page.evaluate(() => window.infinitary.cards.close("flaky")),
      ).rejects.toThrow();
      expect(await shownIds(pro.page)).toContain("flaky");
      await air.page.screenshot({ path: test.info().outputPath("view-past-floor.png") });
    });
  } finally {
    for (const app of opened.reverse()) await app.close();
  }
});
