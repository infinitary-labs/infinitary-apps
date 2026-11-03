import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import type { Card } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import { shownCard, shownEntry, stageAtRest } from "./stack";

/**
 * The stack's depth sits behind the front card (design skill CardStack:
 * "depth comes from their offset and hairline"). The captain reported the
 * top of the stack drawn wrong: each peek, the strip of a card behind,
 * overlaps the front card's top edge by one step and was painted over it,
 * hiding the front card's top border and notching its rounded corners. The
 * front card owns every point of its own top edge, so a point there finds
 * the front card, never a peek.
 */

const evidence = process.env.FM_CARD_STACK_PEEKS_EVIDENCE;

function card(n: number, count: number): Card {
  return {
    id: `stacked-${n}`,
    author: "firstmate",
    meta: "firstmate",
    priority: 50,
    title: `Stacked card ${n}`,
    body: `<p>Card ${n} of ${count} in the stack.</p>`,
    status: "ready",
    createdAt: n,
    actions: [],
  };
}

for (const count of [2, 3]) {
  test(`the front card draws over the peeks behind it with ${count} cards stacked`, async () => {
    const userDataDir = scratchDir("infinitary-stack-peeks-");
    const db = openDatabase(userDataDir);
    const cards = new CardStore(db);
    for (let n = 1; n <= count; n++) cards.upsert(card(n, count));
    db.close();
    const launched = await launchApp({ userDataDir });
    try {
      const { app, page } = launched;
      await resizeWindow(app, page, { width: 1280, height: 800 });
      await expect(shownCard(page, "Stacked card 1")).toBeVisible();
      const peeks = shownEntry(page).locator("[data-card-peek]");
      await expect(peeks).toHaveCount(count - 1);
      await stageAtRest(page);
      const hits = await shownEntry(page).evaluate((entry) => {
        const front = entry.querySelector("[data-card-surface], [data-response-card]");
        if (!front) throw new Error("The shown entry draws no card");
        const r = front.getBoundingClientRect();
        // Each peek reaches one step into the card from above, so these
        // points all lie where a peek overlaps the front card.
        const points = {
          "top border": [r.left + r.width / 2, r.top + 0.5],
          "just inside the top": [r.left + r.width / 2, r.top + 3],
          "top-left corner": [r.left + 10, r.top + 4],
          "top-right corner": [r.right - 10, r.top + 4],
        } as const;
        return Object.fromEntries(
          Object.entries(points).map(([name, [x, y]]) => {
            const hit = document.elementFromPoint(x, y);
            return [
              name,
              hit?.closest("[data-card-peek]")
                ? "peek"
                : hit && front.contains(hit)
                  ? "front card"
                  : (hit?.tagName ?? "nothing"),
            ];
          }),
        );
      });
      if (evidence)
        await regionShot(
          page.locator("[data-card-layer]"),
          join(evidence, `stack-${count}-cards.png`),
        );
      if (process.env.STACK_PEEKS_HERO === "1" && count === 3)
        await heroShot(app, page, {
          region: shownEntry(page),
          anchors: [peeks.first()],
          name: "card-stack-front-edge",
        });
      expect(hits, "The front card's top edge is the front card's own").toEqual({
        "top border": "front card",
        "just inside the top": "front card",
        "top-left corner": "front card",
        "top-right corner": "front card",
      });
    } finally {
      await launched.close();
    }
  });
}
