import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { answersLine as answersWords } from "../../src/renderer/src/cards/answersLine";
import {
  MAXIMIZE_LABEL,
  PUT_ASIDE_LABEL,
  PUT_ASIDE_REST,
} from "../../src/renderer/src/design/cards/cardSizeWords";
import { scratchDir } from "../helpers/scratchDirs";
import { startDemo } from "./demo";
import { hintOf } from "./desktop";
import { cardBody } from "./frames";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { expandDock, nowFrame, pressRow, recordCard, recordFrame, showRecordTab } from "./rails";
import {
  cardAnswersLine,
  cardLeave,
  cardReply,
  clickInBody,
  closeQuestion,
  minimizeForLegacyView,
  noteDone,
  showCard,
  shownCard,
  shownEntry,
} from "./stack";
import { boardCard, boardMenu, boardTile, pressInBoard } from "./taskBoard";
import { focusOn, pressKey, pressWindowKey, runFromSearch } from "./windowKeys";

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
      await heroShot(app, page, { region: shownEntry(page), name: "card-minimize" });
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
    const minimize = shownEntry(page).getByRole("button", { name: PUT_ASIDE_LABEL, exact: true });
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
    await shownEntry(page).getByRole("button", { name: PUT_ASIDE_LABEL, exact: true }).click();
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
      await showRecordTab(page, "cards");
      await expect(recordFrame(page).locator('[data-record-card="minimize-choice"]')).toContainText(
        "Put aside",
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
test("legacy note-minimize requests keep the task or title row and retain visibility after restart", async () => {
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
      await minimizeForLegacyView(page, title);
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
    await minimizeForLegacyView(page, "Your weekly overview");
    const standalone = nowFrame(page).getByRole("button", { name: /Your weekly overview/ });
    await expect(standalone).toBeVisible();
    await clickInBody(standalone);
    await expect(shownCard(page, "Your weekly overview")).toBeVisible();
    await minimizeForLegacyView(page, "Your weekly overview");
    await launched.close();
    launched = await launchApp({ userDataDir, withMockProvider: true });
    page = launched.page;
    expect(
      (await page.evaluate(() => window.infinitary.cards.list())).find(
        (card) => card.id === "week-note",
      )?.minimized,
    ).toBe(true);
    // The ask ends on the first mate's answer, never on the character looking idle,
    // which a relaunched first mate does before its turn starts.
    await askFirstmate(
      page,
      APP_CATALOG_PROMPT_MARKER +
        JSON.stringify({ action: "show-card", value: { cardId: "week-note" } }),
    );
    await expect(shownCard(page, "Your weekly overview")).toBeVisible();
    // The note's Got it reads it; no legacy minimized row remains (INF-2794).
    await noteDone(page).click();
    await expect(nowFrame(page).getByRole("button", { name: /Your weekly overview/ })).toHaveCount(
      0,
    );
  } finally {
    await launched.close();
  }
});

/** INF-476 answer where=A: minimizing in a viewing Mac is shared, and restoring at home updates that view. */
test("legacy minimized-note visibility is shared by Macs that show the same first mate", async () => {
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
    await minimizeForLegacyView(view.page, "The shared launch review");
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
test("a legacy minimized-note request retains the review's reading place", async () => {
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
    await minimizeForLegacyView(page, "Read the launch review");
    await expandDock(page, "now");
    await clickInBody(nowFrame(page).getByRole("button", { name: /Read the launch review/ }));
    await expect(shownCard(page, "Read the launch review")).toBeVisible();
    await expect.poll(() => body().evaluate((element) => element.scrollTop)).toBe(top);
  } finally {
    await launched.close();
  }
});

/**
 * Minus preserves an unanswered reply and its draft without a confirmation.
 */
test("INF-1879: one minus keeps an unanswered reply open without a warning", async () => {
  const userDataDir = scratchDir("infinitary-card-exits-");
  const db = openDatabase(userDataDir);
  let key = "";
  try {
    key = seedTask(new TaskService({ db, strict: true }), {
      id: "exits-launch",
      title: "Prepare the launch checklist",
      status: "idle",
    }).key;
    const store = new CardStore(db);
    store.upsert({
      id: "exits-choice",
      taskId: "exits-launch",
      author: "firstmate",
      meta: "firstmate",
      title: TITLE,
      priority: 20,
      status: "ready",
      createdAt: Date.now(),
      body: "<p>Keep the launch and its review together.</p>",
      actions: [{ id: "go", label: "Use this window", default: true }],
    });
    store.appendMessage({ cardId: "exits-choice", who: "captain", text: "Why Friday?" });
  } finally {
    db.close();
  }
  const launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = launched;
    await showCard(page, TITLE);
    const label = page.locator("[data-icon-label]");
    const putAside = shownEntry(page).getByRole("button", { name: PUT_ASIDE_LABEL, exact: true });
    await test.step("INF-1879: the one minus says what it does and sends no unanswered-reply question", async () => {
      await expect(shownEntry(page).locator("[data-card-leave]")).toHaveCount(1);
      await focusOn(putAside);
      await expect(label.filter({ hasText: PUT_ASIDE_REST })).toBeVisible();
      await expect(label).toContainText(hintOf("cards.minimize"));
      await putAside.click();
      await expect(shownCard(page, TITLE)).toBeHidden();
      expect(
        (await page.evaluate(() => window.infinitary.cards.list())).find(
          (card) => card.id === "exits-choice",
        )?.minimized,
      ).toBe(true);
      await expandDock(page, "now");
      await pressRow(page, key);
      await expect(shownCard(page, TITLE)).toBeVisible();
      await putAside.click();
      expect(
        (await page.evaluate(() => window.infinitary.cards.list())).find(
          (card) => card.id === "exits-choice",
        )?.minimized,
      ).toBe(true);
    });
  } finally {
    await launched.close();
  }
});

const PLAN = "Plan: split the large files";

/** A plan card shaped like the one INF-2710 was found on: required questions, each with a recommendation and a Something else row. */
const PLAN_BODY = `<p>Thirty files are over 2,000 lines. I would split each one along the jobs it already does.</p>
<fieldset><legend>Which direction?</legend>
<label><input type="radio" name="direction" value="owners" required data-inf-recommended> Split along owners and delete as it goes</label>
<label><input type="radio" name="direction" value="mechanical" required> Split mechanically by size</label>
<label><input type="radio" name="direction" value="other" required data-inf-write-in> Something else</label></fieldset>
<fieldset><legend>Do the tests split too?</legend>
<label><input type="radio" name="scope" value="all" required data-inf-recommended> Yes: tests, journeys and stand-ins split too</label>
<label><input type="radio" name="scope" value="source" required> Only the product code</label>
<label><input type="radio" name="scope" value="other" required data-inf-write-in> Something else</label></fieldset>
<fieldset><legend>Should a size check hold the line?</legend>
<label><input type="radio" name="size_check" value="yes" required data-inf-recommended> Yes: it refuses a file over 2,000 lines</label>
<label><input type="radio" name="size_check" value="no" required> No check</label>
<label><input type="radio" name="size_check" value="other" required data-inf-write-in> Something else</label></fieldset>`;

/** INF-2710 (the captain: "Keep picks across restarts"): a card put aside keeps its picks when the app starts again. */
test("INF-2710: a put-aside decision keeps its picks across a restart", async () => {
  test.setTimeout(150_000);
  const userDataDir = scratchDir("infinitary-minimize-restart-");
  const db = openDatabase(userDataDir);
  let key = "";
  try {
    key = seedTask(new TaskService({ db, strict: true }), {
      id: "restart-plan",
      title: "Split the large files",
      status: "idle",
    }).key;
    new CardStore(db).upsert({
      id: "restart-plan-card",
      taskId: "restart-plan",
      author: "crewmate",
      meta: "crewmate 1",
      title: PLAN,
      priority: 20,
      status: "ready",
      createdAt: Date.now(),
      body: PLAN_BODY,
      actions: [
        { id: "save-defer", label: "Save and defer" },
        { id: "abandon", label: "Abandon" },
        { id: "approve-build", label: "Approve and build", default: true },
      ],
    });
  } finally {
    db.close();
  }
  // Two of the three take the recommendation, which reads as unchanged; the third changes it.
  const picks = [
    ["direction", "owners"],
    ["scope", "source"],
    ["size_check", "yes"],
  ] as const;
  const picked = answersWords({ answered: 3, of: 3, changed: 1 }, false);
  const choice = (page: Page, name: string, value: string) =>
    cardBody(page, PLAN).locator(`input[name="${name}"][value="${value}"]`);
  let launched = await launchApp({ userDataDir, withMockProvider: true });
  try {
    let { page } = launched;
    await showCard(page, PLAN);
    for (const [name, value] of picks) await clickInBody(choice(page, name, value));
    await expect(cardAnswersLine(page)).toHaveText(picked);
    if (evidence) await regionShot(shownEntry(page), join(evidence, "restart-picked-after.png"));
    await cardLeave(page).click();
    await expect(shownCard(page, PLAN)).toBeHidden();

    await launched.close();
    launched = await launchApp({ userDataDir, withMockProvider: true });
    page = launched.page;
    await pressRow(page, key);
    await expect(shownCard(page, PLAN)).toBeVisible();
    for (const [name, value] of picks) await expect(choice(page, name, value)).toBeChecked();
    await expect(cardAnswersLine(page)).toHaveText(picked);
    if (evidence) await regionShot(shownEntry(page), join(evidence, "restart-restored-after.png"));
  } finally {
    await launched.close();
  }
});
