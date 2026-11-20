import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import { CARD_BODY_WORDS } from "../../src/renderer/src/cards/cardBodyWords";
import type { Card } from "../../src/shared/cards";
import { FRAME_TITLE_MAX } from "../../src/shared/plugins/frameDocument";
import { OVERSIZED_CARD, oversizedMergeCardBody } from "../fixtures/oversized-card/mergeCard";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, cardBodyElement } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { heroShot, regionShot } from "./pictures";
import { showCard, shownCard, shownEntry } from "./stack";

/**
 * INF-3887's plan, approved by the captain: a card the window cannot mount
 * whole still opens. A scripted body over the mount's size limit shows its
 * words, tables and still drawings under one line saying its drawings are
 * off, with nothing to retry; a scripted card whose title is longer than a
 * mount takes opens with its script running.
 */

/** A real pull request title's length past the mount's limit, as the window receives it. */
const LONG_TITLE =
  "fix(cards): keep a merge card's live validation table, its proof transcripts, " +
  "its map view and its pictures together when a crewmate's story is prepared again";

const card = (id: string, title: string, body: string): Card => ({
  id,
  author: "firstmate",
  meta: "firstmate",
  priority: 30,
  title,
  body,
  status: "ready",
  createdAt: Date.now(),
  actions: [],
});

test("a card too large to run its drawings opens with its words, and a long title still mounts", async () => {
  expect(LONG_TITLE.length).toBeGreaterThan(FRAME_TITLE_MAX);
  const userDataDir = scratchDir("infinitary-card-too-large-");
  const db = openDatabase(userDataDir);
  try {
    const cards = new CardStore(db);
    cards.upsert(card("card-oversized-merge", OVERSIZED_CARD.title, oversizedMergeCardBody()));
    cards.upsert(
      card(
        "card-long-title",
        LONG_TITLE,
        '<p data-ran="">Waiting</p><script>document.querySelector("[data-ran]").textContent = "Drawn by its script";</script>',
      ),
    );
  } finally {
    db.close();
  }
  const launched = await launchApp({ userDataDir });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1100, height: 760 });

    await test.step("the oversized card opens with its words under the drawings-off line", async () => {
      await showCard(page, OVERSIZED_CARD.title);
      const body = cardBody(page, OVERSIZED_CARD.title);
      await expect(body.getByText(CARD_BODY_WORDS.drawingsOff)).toBeVisible();
      await expect(body.getByText(OVERSIZED_CARD.words)).toBeVisible();
      await expect(body.getByRole("figure", { name: OVERSIZED_CARD.drawing })).toBeVisible();
      // Its scripts stay off: the map view never draws itself.
      await expect(body.getByText(OVERSIZED_CARD.mapDrawn)).toHaveCount(0);
      const shown = shownEntry(page);
      await expect(shown.getByText(CARD_BODY_WORDS.failed)).toHaveCount(0);
      await expect(shown.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await regionShot(
        shownCard(page, OVERSIZED_CARD.title),
        test.info().outputPath("oversized-card-after.png"),
      );
      await heroShot(app, page, {
        region: shownCard(page, OVERSIZED_CARD.title),
        name: "oversized-card-opens",
      });
    });

    await test.step("a card with a title past the mount's limit mounts and runs its script", async () => {
      await showCard(page, LONG_TITLE);
      await expect(cardBodyElement(page, LONG_TITLE)).toHaveAttribute(
        "src",
        /^app-frame:\/\/card-[0-9a-f-]{36}\/$/,
      );
      await expect(cardBody(page, LONG_TITLE).getByText("Drawn by its script")).toBeVisible();
      await regionShot(
        shownCard(page, LONG_TITLE),
        test.info().outputPath("long-title-card-after.png"),
      );
    });
  } finally {
    await launched.close();
  }
});
