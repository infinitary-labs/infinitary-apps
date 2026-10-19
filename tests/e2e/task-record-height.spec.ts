import { expect, type Page, test } from "@playwright/test";
import type { PlanItem } from "../../src/shared/taskPlan";
import { type CrewRouting, crewRoster } from "./crewRoster";
import { cardBodySelector } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { expandDock, hideRecord, pressRow, recordCard, recordFrame } from "./rails";

/**
 * A task card opens tall enough to show what it holds (FI3-948). A crewmate
 * with a Progress list and a fact strip pushes the record's lower part -
 * Goal and your words, Activity, Details - below the card's first height,
 * and the card still grows to show all of it, up to the cap every card
 * shares, without the captain scrolling it into view. Both plans fit under
 * the cap of a 900px window, so nothing is left to scroll.
 */

const PLAN: PlanItem[] = [
  { label: "Read the notes review and confirm coverage", short: "Review", state: "done" },
  { label: "Cut the alpha from current main", short: "Cut", state: "current" },
  { label: "Pin the manifest and post the notes card", short: "Pin", state: "next" },
];
const LONG_PLAN: PlanItem[] = [
  ...PLAN,
  { label: "Watch the release run to green", short: "Watch", state: "next" },
  { label: "Check the published notes", short: "Notes", state: "next" },
  { label: "Tell the captain the alpha is out", short: "Tell", state: "next" },
];
const ROUTING: CrewRouting = {
  shape: { kind: "fix", basis: "tall-crew-basis", basis_verified: true },
  rule: "R6",
  asked: "low",
  served: "low",
};

/** What of the shown record's body the captain cannot see without scrolling; empty when nothing. */
async function unseen(page: Page): Promise<string[]> {
  const drawn = await recordFrame(page)
    .locator("body")
    .evaluate((body) => Math.ceil(body.getBoundingClientRect().height));
  return recordCard(page).evaluate(
    (card, [drawn, frameSelector]) => {
      const body = card.querySelector<HTMLElement>("[data-card-body]");
      const frame = card.querySelector<HTMLIFrameElement>(frameSelector);
      if (!body || !frame) return ["no record body"];
      const missing: string[] = [];
      const hidden = body.scrollHeight - body.clientHeight;
      if (hidden > 1) missing.push(`${hidden}px of the body scrolls`);
      if (frame.clientHeight + 1 < drawn)
        missing.push(`the lower part shows ${frame.clientHeight}px of its ${drawn}px`);
      const below = frame.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom;
      if (below > 1) missing.push(`the lower part ends ${Math.round(below)}px below the body`);
      return missing;
    },
    [drawn, cardBodySelector("Task record")] as const,
  );
}

test("a task card with a long Progress list opens to show all of it, without a scroll", async () => {
  const fixture = await crewRoster(2, {
    idPrefix: "tall-crew",
    title: (index) => (index === 0 ? "Cut the alpha in three steps" : "Cut the alpha in six steps"),
    note: () => "The alpha is running from the reviewed commit.",
    plan: (index) => (index === 0 ? PLAN : LONG_PLAN),
    routing: () => ROUTING,
  });
  const app = await launchApp({ ...fixture, withMockProvider: true });
  try {
    const { page } = app;
    await resizeWindow(app.app, page, { width: 1280, height: 900 });
    await expandDock(page, "now");
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    for (const [id, plan] of [
      ["tall-crew-0", PLAN],
      ["tall-crew-1", LONG_PLAN],
    ] as const) {
      await test.step(`${plan.length} steps`, async () => {
        const key = board.tasks.find((task) => task.id === id)?.key;
        if (!key) throw new Error(`The seeded task ${id} is missing`);
        await pressRow(page, key);
        await expect(recordCard(page)).toHaveAttribute("data-task-record", id);
        // The whole plan and the readout are on the card, and the lower part has drawn.
        await expect(
          recordCard(page).locator("[data-task-plan-list] [data-plan-label]"),
        ).toHaveText(plan.map((item) => item.label));
        await expect(recordCard(page).locator("[data-record-strip]")).toBeVisible();
        await expect(
          recordFrame(page).locator('[data-record-section="details"] > summary'),
        ).toBeVisible();
        // The card grows by itself until nothing is left to scroll to.
        await expect.poll(() => unseen(page)).toEqual([]);
        await page.screenshot({ path: test.info().outputPath(`record-${plan.length}-steps.png`) });
        await hideRecord(page).click();
        await expect(recordCard(page)).toHaveCount(0);
      });
    }
  } finally {
    await app.close();
  }
});

/**
 * INF-510, the captain: "when i open a task record card, it will have layout
 * shift in the first 1-2 seconds". A record opened on an empty stage appears
 * once, with its facts and its body drawn, and then holds its height: it is
 * not shown as an empty Loading card that grows and re-centres as the facts
 * and then the body frame arrive.
 */
test("a task record opened on an empty stage keeps one height from its first visible frame", async () => {
  const fixture = await crewRoster(1, {
    idPrefix: "steady-crew",
    title: () => "Cut the alpha in six steps",
    note: () => "The alpha is running from the reviewed commit.",
    plan: () => LONG_PLAN,
    routing: () => ROUTING,
  });
  const app = await launchApp({ ...fixture, withMockProvider: true });
  try {
    const { page } = app;
    await resizeWindow(app.app, page, { width: 1280, height: 900 });
    await expandDock(page, "now");
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    const key = board.tasks.find((task) => task.id === "steady-crew-0")?.key;
    if (!key) throw new Error("The seeded task steady-crew-0 is missing");
    // Every frame, the stage shell's laid-out height (the arrival's scale does
    // not touch it) and whether the stage has revealed the shown entry (it holds
    // an unready one at opacity 0).
    await page.evaluate(() => {
      const w = window as unknown as {
        __shell: { visible: boolean; height: number; title: string }[];
      };
      w.__shell = [];
      const tick = () => {
        const shell = document.querySelector<HTMLElement>("[data-card-presentation]");
        const entry = shell?.querySelector<HTMLElement>(':scope > [data-stage-entry="shown"]');
        if (shell && entry)
          w.__shell.push({
            visible: entry.style.opacity !== "0",
            height: shell.offsetHeight,
            title:
              shell.querySelector<HTMLElement>("[data-record-title]")?.textContent?.trim() ?? "",
          });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await pressRow(page, key);
    await expect(recordCard(page)).toHaveAttribute("data-task-record", "steady-crew-0");
    await expect(
      recordFrame(page).locator('[data-record-section="details"] > summary'),
    ).toBeVisible();
    await page.waitForTimeout(1000);
    const samples = await page.evaluate(
      () =>
        (window as unknown as { __shell: { visible: boolean; height: number; title: string }[] })
          .__shell,
    );
    const seen = samples.filter((sample) => sample.visible);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]?.title, "the first visible frame already names the task").not.toBe("");
    expect(new Set(seen.map((sample) => sample.height)).size, "heights while visible").toBe(1);
  } finally {
    await app.close();
  }
});
