import { expect, type Page, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { seedTask } from "../../src/core/tasks/seedTask";
import { TaskService } from "../../src/core/tasks/taskService";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { windowShot } from "./pictures";
import { showCard, shownCard } from "./stack";
import { pressKey } from "./windowKeys";

// INF-2022 / INF-2020: two real desktop views of one owner, isolated homes and mock subscriptions.
// A reading clears news after delivery, not membership or the other window's selection.
const titles = ["Sampler result", "Latency findings", "Reconnection findings"];
const badge = (page: Page) => page.getByRole("status").filter({ hasText: /^\d+ new$/ });

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
test("two desktop views share drawn-update sightings while retaining their own selection through reload", async ({}, testInfo) => {
  const userDataDir = scratchDir("infinitary-shared-seen-");
  const db = openDatabase(userDataDir);
  seedTask(new TaskService({ db, strict: true }), {
    id: "findings",
    title: "Check latency",
    status: "completed",
  });
  const store = new CardStore(db);
  for (const [index, title] of titles.entries())
    store.upsert({
      id: `card-findings-${index}`,
      taskId: "findings",
      title,
      author: "crewmate",
      meta: "Check latency",
      body: `<p>${title}: the findings remain available until you close or put aside this card.</p>`,
      actions: [],
      status: "ready",
      priority: 15,
      createdAt: Date.now() + index,
    });
  db.close();
  const home = await launchApp({ userDataDir, withMockProvider: true });
  let view: LaunchedApp | undefined;
  try {
    await resizeWindow(home.app, home.page, { width: 1280, height: 800 });
    await showCard(home.page, titles[0]!);
    // A hidden test window must actually gain foreground focus before its initial card counts as read.
    await shownCard(home.page, titles[0]!).locator("[data-card-title]").click();
    await expect
      .poll(() =>
        home.page.evaluate(
          async (title) =>
            (await window.infinitary.cards.list()).find((card) => card.title === title)
              ?.currentUpdateSeen,
          titles[0]!,
        ),
      )
      .toBe(true);
    const invite = await home.page.evaluate(() =>
      window.infinitary.devices.invite({ kind: "mac" }),
    );
    view = await launchApp();
    await view.page.evaluate((link) => {
      void window.infinitary.devices.join(link);
    }, invite.link);
    await expect(view.page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
    );
    await resizeWindow(view.app, view.page, { width: 1280, height: 800 });
    await showCard(view.page, titles[0]!);
    await expect(badge(view.page)).toHaveText("2 new");
    await expect(badge(home.page)).toHaveText("2 new");
    await windowShot(home.page, testInfo.outputPath("home-two-new.png"));
    await windowShot(view.page, testInfo.outputPath("view-two-new.png"));
    // A keyboard page turn reads the second card only after its body draws.
    await pressKey(view.page.getByRole("button", { name: "Next card" }), "Enter");
    await expect(shownCard(view.page, titles[1]!)).toBeVisible();
    await expect(badge(home.page)).toHaveText("1 new");
    await expect(shownCard(home.page, titles[0]!)).toBeVisible();
    await windowShot(home.page, testInfo.outputPath("home-after-peer-reading.png"));
    await showCard(home.page, titles[2]!);
    await expect(badge(view.page)).toHaveCount(0);
    await windowShot(view.page, testInfo.outputPath("view-after-home-reading.png"));
    await expect(shownCard(view.page, titles[1]!)).toBeVisible();
    await view.page.reload();
    await showCard(view.page, titles[0]!);
    await expect(badge(view.page)).toHaveCount(0);
    const cards = await view.page.evaluate(() => window.infinitary.cards.list());
    expect(cards.map((card) => card.title)).toEqual(titles);
    expect(cards.every((card) => card.currentUpdateSeen === true)).toBe(true);
    // Put aside and restoration still use the shared lifecycle owner, never a local auto-hide list.
    const target = cards.find((card) => card.title === titles[1])!;
    await home.page.evaluate((id) => window.infinitary.cards.minimize(id, true), target.id);
    await expect
      .poll(() =>
        view!.page.evaluate(
          async (id) => (await window.infinitary.cards.list()).find((c) => c.id === id)?.minimized,
          target.id,
        ),
      )
      .toBe(true);
    await home.page.evaluate((id) => window.infinitary.cards.minimize(id, false), target.id);
    await expect
      .poll(() =>
        view!.page.evaluate(
          async (id) =>
            (await window.infinitary.cards.list()).find((c) => c.id === id)?.minimized === true,
          target.id,
        ),
      )
      .toBe(false);
  } finally {
    await view?.close();
    await home.close();
  }
});
