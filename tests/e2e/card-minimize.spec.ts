import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { MAXIMIZE_LABEL, MINIMIZE_LABEL } from "../../src/renderer/src/design/cards/cardSizeWords";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { startDemo } from "./demo";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { expandDock, nowFrame, pressRow, recordCard, recordFrame } from "./rails";
import { cardReply, clickInBody, showCard, shownCard, shownEntry } from "./stack";
import { boardCard, boardMenu, boardTile, pressInBoard } from "./taskBoard";
import { pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

const TITLE = "Choose the launch window";
const evidence = process.env.MINIMIZE_EVIDENCE;

/** INF-476: minimizing preserves the open decision and its drafts; its task row brings it back. */
test("minimize preserves the decision and restores it from its own task row", async () => {
  test.setTimeout(150_000);
  const userDataDir = scratchDir("infinitary-minimize-");
  const db = openDatabase(userDataDir);
  let key = "";
  try {
    key = seedTask(new TaskService({ db, strict: true }), {
      id: "minimize-launch",
      title: "Prepare the launch checklist",
      status: "idle",
    }).key;
    new CardStore(db).upsert({
      id: "minimize-choice",
      taskId: "minimize-launch",
      author: "firstmate",
      meta: "firstmate",
      title: TITLE,
      priority: 20,
      status: "ready",
      createdAt: Date.now(),
      body: '<p>Keep the launch and its review together.</p><fieldset><legend>When should we launch?</legend><label><input type="radio" name="launch" value="tuesday"> Tuesday</label><label><input type="radio" name="launch" value="friday"> Friday</label><label><input type="radio" name="launch" value="other" data-inf-write-in> Something else</label></fieldset>',
      actions: [{ id: "go", label: "Use this window", default: true }],
    });
  } finally {
    db.close();
  }
  const demo = await startDemo({
    userDataDir,
    withMockProvider: true,
    size: { width: 1280, height: 820 },
  });
  const { page, app } = demo.launched;
  try {
    await showCard(page, TITLE);
    await expandDock(page, "now");
    if (evidence) {
      await regionShot(shownEntry(page), join(evidence, "card-after.png"));
      await regionShot(page.locator('[data-side-panel="now"]'), join(evidence, "tasks-after.png"));
    }
    if (process.env.MINIMIZE_HERO === "1")
      await heroShot(page, { region: shownEntry(page), name: "card-minimize" });
    const answer = () => cardBody(page, TITLE).getByRole("radio", { name: "Friday", exact: true });
    await clickInBody(answer());
    await cardReply(page).field.fill("Keep the review beside it.");
    await demo.record("Minimize the decision and bring it back from Tasks", "window", async () => {
      await pressWindowKey(app, "m", ["meta", "shift"]);

      await expect(shownCard(page, TITLE)).toBeHidden();
      const saved = await page.evaluate(() => window.infinitary.cards.list());
      expect(saved.find((card) => card.id === "minimize-choice")).toMatchObject({
        status: "ready",
        minimized: true,
      });

      await pressRow(page, key);
      await expect(shownCard(page, TITLE)).toBeVisible();
      await expect(shownEntry(page)).toBeFocused();
      await expect(answer()).toBeChecked();
      await expect(cardReply(page).field).toHaveValue("Keep the review beside it.");
    });

    await runFromSearch(app, page, "cards.maximize");
    const minimize = shownEntry(page).getByRole("button", { name: MINIMIZE_LABEL, exact: true });
    await pressKey(minimize, "Enter");
    await expect(shownCard(page, TITLE)).toBeHidden();
    await expandDock(page, "now");
    await pressKey(nowFrame(page).locator(`[data-now-key="${key}"]`), "Enter");
    await expect(shownCard(page, TITLE)).toBeVisible();
    await expect(
      shownEntry(page).getByRole("button", { name: MAXIMIZE_LABEL, exact: true }),
    ).toBeVisible();
    await expect(answer()).toBeChecked();
    await expect(cardReply(page).field).toHaveValue("Keep the review beside it.");
    await shownEntry(page).getByRole("button", { name: MINIMIZE_LABEL, exact: true }).click();
    // Explicit record access remains available while the row opens the pending card.
    await page.evaluate(() => window.infinitary.tasks.detail("minimize-launch"));

    {
      await runFromSearch(app, page, "panel:now/board");
      await expect(boardCard(page)).toBeVisible();
      if (evidence) await regionShot(shownEntry(page), join(evidence, "board-after.png"));
      const tile = boardTile(page, key);
      await pressKey(tile, " ");
      await pressInBoard(boardMenu(page, key).entry("open"));
      await expect(recordCard(page)).toBeVisible();
      await clickInBody(recordFrame(page).locator('[data-record-section="cards"] > summary'));
      await expect(recordFrame(page).locator('[data-record-card="minimize-choice"]')).toContainText(
        "Minimized",
      );
      if (evidence) await regionShot(shownEntry(page), join(evidence, "record-after.png"));

      await clickInBody(recordFrame(page).locator('[data-record-card="minimize-choice"] button'));
      await expect(shownCard(page, TITLE)).toBeVisible();
    }

    if (evidence) await demo.finish({ dir: evidence, name: "minimize-after" });
    else await demo.finish({ dir: test.info().outputPath("demo"), name: "minimize" });
  } finally {
    await demo.launched.close();
  }
});

/** INF-476: notes on finished tasks and taskless cards have a way back; first mate restores only when asked. */
test("minimized notes use the task row, taskless notes use their title, and restart retains visibility", async () => {
  const userDataDir = scratchDir("infinitary-minimized-notes-");
  const db = openDatabase(userDataDir);
  let key = "";
  try {
    const tasks = new TaskService({ db, strict: true });
    key = seedTask(tasks, {
      id: "finished-review",
      title: "Review the launch checklist",
      status: "completed",
    }).key;
    tasks.close("finished-review", {
      status: "done",
      reason: "answered",
      actor: "captain",
      text: "Reviewed the launch.",
    });
    const store = new CardStore(db);
    for (const [id, title, taskId] of [
      ["review-ready", "The launch review is ready", "finished-review"],
      ["review-notes", "Keep Friday for the launch", "finished-review"],
      ["week-note", "Your weekly overview", undefined],
    ] as const)
      store.upsert({
        id,
        title,
        ...(taskId ? { taskId } : {}),
        author: "firstmate",
        meta: "firstmate",
        body: "<p>The review stays beside the launch.</p>",
        actions: [],
        status: "ready",
        priority: 20,
        createdAt: Date.now(),
      });
  } finally {
    db.close();
  }
  let launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    let { page } = launched;
    for (const title of ["The launch review is ready", "Keep Friday for the launch"]) {
      await showCard(page, title);
      await shownEntry(page).getByRole("button", { name: MINIMIZE_LABEL, exact: true }).click();
      await expect(shownCard(page, title)).toBeHidden();
    }
    await expandDock(page, "now");
    const row = nowFrame(page).locator(`[data-now-group="waiting"] [data-now-key="${key}"]`);
    await expect(row).toHaveCount(1);
    if (evidence)
      await regionShot(
        page.locator('[data-side-panel="now"]'),
        join(evidence, "notes-minimized-after.png"),
      );
    await expect(row).not.toContainText("minimized");
    expect(
      (await page.evaluate(() => window.infinitary.tasks.detail("finished-review"))).status,
    ).toBe("done");
    await pressRow(page, key);
    await expect(shownCard(page, "The launch review is ready")).toBeVisible();
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).filter((card) => card.minimized),
    ).toEqual([]);
    await showCard(page, "Your weekly overview");
    await shownEntry(page).getByRole("button", { name: MINIMIZE_LABEL, exact: true }).click();
    const standalone = nowFrame(page).getByRole("button", { name: /Your weekly overview/ });
    await expect(standalone).toBeVisible();
    await clickInBody(standalone);
    await expect(shownCard(page, "Your weekly overview")).toBeVisible();
    await shownEntry(page).getByRole("button", { name: MINIMIZE_LABEL, exact: true }).click();
    await expect(shownCard(page, "Your weekly overview")).toBeHidden();
    await launched.close();
    launched = await launchApp({ userDataDir, withMockProvider: true });
    page = launched.page;
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).find(
        (card) => card.id === "week-note",
      )?.minimized,
    ).toBe(true);
    await promptInput(page).fill(
      APP_CATALOG_PROMPT_MARKER +
        JSON.stringify({ action: "show-card", value: { cardId: "week-note" } }),
    );
    await promptInput(page).press("Enter");
    await expect(shownCard(page, "Your weekly overview")).toBeVisible();
    await waitForFirstmateIdle(page);
    await shownEntry(page).getByRole("button", { name: MINIMIZE_LABEL, exact: true }).click();
    await page.evaluate(() => window.infinitary.cards.close("week-note"));
    await expect(nowFrame(page).getByRole("button", { name: /Your weekly overview/ })).toHaveCount(
      0,
    );
  } finally {
    await launched.close();
  }
});

/** INF-476 answer where=A: minimizing in a viewing Mac is shared, and restoring at home updates that view. */
test("minimized visibility is shared by Macs that show the same first mate", async () => {
  const userDataDir = scratchDir("infinitary-minimize-home-");
  const db = openDatabase(userDataDir);
  new CardStore(db).upsert({
    id: "shared-note",
    title: "The shared launch review",
    author: "firstmate",
    meta: "firstmate",
    body: "<p>Keep the review beside the launch.</p>",
    actions: [],
    status: "ready",
    priority: 20,
    createdAt: Date.now(),
  });
  db.close();
  const home = await launchApp({ userDataDir, withMockProvider: true });
  let view: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    const invite = await home.page.evaluate(() =>
      window.infinitary.devices.invite({ kind: "mac" }),
    );
    view = await launchApp();
    const viewing = view.page;
    await view.page.evaluate((link) => {
      void window.infinitary.devices.join(link);
    }, invite.link);
    await expect(view.page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
    );
    await showCard(view.page, "The shared launch review");
    await shownEntry(view.page).getByRole("button", { name: MINIMIZE_LABEL, exact: true }).click();
    await expect
      .poll(
        async () =>
          (await home.page.evaluate(() => window.infinitary.cards.list())).find(
            (card) => card.id === "shared-note",
          )?.minimized,
      )
      .toBe(true);
    await expandDock(home.page, "now");
    await clickInBody(
      nowFrame(home.page).getByRole("button", { name: /The shared launch review/ }),
    );
    await expect(shownCard(home.page, "The shared launch review")).toBeVisible();
    await expect
      .poll(
        async () =>
          (await viewing.evaluate(() => window.infinitary.cards.list())).find(
            (card) => card.id === "shared-note",
          )?.minimized,
      )
      .toBeUndefined();
    await showCard(view.page, "The shared launch review");
    await expect(shownCard(view.page, "The shared launch review")).toBeVisible();
  } finally {
    await view?.close();
    await home.close();
  }
});

/** INF-476 assumption 5: the reading place survives a minimized card's in-session remount. */
test("a minimized review returns to its reading place", async () => {
  const userDataDir = scratchDir("infinitary-minimize-reading-");
  const db = openDatabase(userDataDir);
  const checks = [
    "Read the release notes against the changes people will see.",
    "Check the launch window and keep the review beside it.",
    "Confirm every supported computer can get the new version.",
    "Try the card controls with the keyboard before publishing.",
    "Check the saved data with a disposable profile before updating.",
    "Keep the previous version available until the review is complete.",
    "Confirm the checks passed on the version being published.",
    "Read each screenshot and make sure its caption describes it.",
    "Keep the release highlights in the order the captain chose.",
    "Confirm the new version opens its release notes on first launch.",
    "Make sure unfinished work is named before offering the merge.",
    "Check the download on a second computer before finishing.",
  ];
  new CardStore(db).upsert({
    id: "reading-review",
    title: "Read the launch review",
    author: "firstmate",
    meta: "firstmate",
    body: `<h2>Before publishing</h2>${checks.map((check) => `<p>${check}</p>`).join("")}<h2>After publishing</h2>${checks.map((check) => `<p>${check}</p>`).join("")}`,
    actions: [],
    status: "ready",
    priority: 20,
    createdAt: Date.now(),
  });
  db.close();
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = launched;
    await showCard(page, "Read the launch review");
    const body = () => shownEntry(page).locator("[data-card-body]");
    await expect
      .poll(() => body().evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    const top = await body().evaluate((element) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
      return element.scrollTop;
    });
    expect(top).toBeGreaterThan(0);
    await shownEntry(page).getByRole("button", { name: MINIMIZE_LABEL, exact: true }).click();
    await expect(shownCard(page, "Read the launch review")).toBeHidden();
    await expandDock(page, "now");
    await clickInBody(nowFrame(page).getByRole("button", { name: /Read the launch review/ }));
    await expect(shownCard(page, "Read the launch review")).toBeVisible();
    await expect.poll(() => body().evaluate((element) => element.scrollTop)).toBe(top);
  } finally {
    await launched.close();
  }
});
