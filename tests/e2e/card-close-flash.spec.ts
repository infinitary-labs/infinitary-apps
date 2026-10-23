import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { scratchDir } from "../helpers/scratchDirs";
import { launchApp } from "./launch";
import { shownEntry, stageAtRest } from "./stack";

// INF-1011, captain: closing a card must remove it without a brief flash.
// Ordinary ready notes reproduce the alpha's failure without model or network work.
for (const count of [1, 2]) {
  test(`Close never restores the outgoing drawing with ${count} cards`, async () => {
    const userDataDir = scratchDir("infinitary-close-flash-");
    const db = openDatabase(userDataDir);
    const cards = new CardStore(db);
    for (let i = 0; i < count; i++)
      cards.upsert({
        id: `flash-${i}`,
        title: i === 0 ? "Card close investigation" : "The next note",
        body: "<p>Closing this note should remove it once, without showing it again.</p>",
        author: "firstmate",
        meta: "firstmate",
        priority: 50,
        createdAt: i + 1,
        status: "ready",
        actions: [],
      });
    db.close();
    const launched = await launchApp({ userDataDir });
    try {
      const { page } = launched;
      await expect(shownEntry(page)).toHaveAttribute("data-stage-entry-id", "flash-0");
      await stageAtRest(page);
      await page.evaluate(() => {
        const samples: { role: string | null; opacity: number; connected: boolean }[] = [];
        const node = document.querySelector<HTMLElement>('[data-stage-entry-id="flash-0"]');
        if (!node) throw new Error("The closing note has not drawn");
        const read = () => {
          const sample = {
            role: node.getAttribute("data-stage-entry"),
            opacity: Number(getComputedStyle(node).opacity),
            connected: node.isConnected,
          };
          samples.push(sample);
        };
        // Observe the real cancellation boundary too: an opaque connected outgoing
        // node here is the exact rebound that a paint can expose before React retires it.
        const cancel = Animation.prototype.cancel;
        Animation.prototype.cancel = function () {
          const target = (this.effect as KeyframeEffect | null)?.target;
          cancel.call(this);
          if (target === node) read();
        };
        const tick = () => {
          read();
          if (node.isConnected) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        (window as typeof window & { closeFlashSamples: typeof samples }).closeFlashSamples =
          samples;
      });
      await shownEntry(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.locator('[data-stage-entry-id="flash-0"]')).toHaveCount(0);
      if (count === 2) {
        await expect(shownEntry(page)).toHaveAttribute("data-stage-entry-id", "flash-1");
        await stageAtRest(page);
      }
      const samples = await page.evaluate(
        () =>
          (
            window as typeof window & {
              closeFlashSamples: { role: string | null; opacity: number; connected: boolean }[];
            }
          ).closeFlashSamples,
      );
      const outgoing = samples.filter((sample) => sample.connected && sample.role === "outgoing");
      const reversals = outgoing.filter((sample, i) => {
        const previous = outgoing[i - 1];
        return previous !== undefined && sample.opacity > previous.opacity;
      });
      writeFileSync(test.info().outputPath("opacity.json"), JSON.stringify(samples));
      expect(outgoing.length, "the check observed the real outgoing drawing").toBeGreaterThan(1);
      expect(reversals, "a closing card must not become more opaque before it leaves").toEqual([]);
      expect(
        (await page.evaluate(() => window.infinitary.cards.list())).map((card) => card.id),
      ).toEqual(count === 1 ? [] : ["flash-1"]);
    } finally {
      await launched.close();
    }
  });
}
