import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { openDatabase } from "../../src/core/storage/db";
import * as m from "../../src/shared/i18n/messages.generated";
import { MERGE_NOT_NOW_WORDS } from "../../src/shared/vocabulary";
import { scratchDir } from "../helpers/scratchDirs";
import { baseEnv } from "../helpers/standInGh";
import { cardBody } from "./frames";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { SPAWN_PROMPT_MARKER } from "./mockProvider";
import { regionShot } from "./pictures";
import { seedProject } from "./projectSeed";
import { promptInput } from "./prompt";
import { MOCK_GITHUB_STORY } from "./scenarios/changeStory";
import {
  RETURNING_MERGE_MARKER,
  RETURNING_MERGE_REPLY,
  RETURNING_MERGE_SUMMARIES,
  RETURNING_MERGE_TITLE,
  returningMergeCard,
} from "./scenarios/returningMergeCard";
import { cardReply, expectCardSeen, shownCard, shownEntry, stageAtRest } from "./stack";

/**
 * INF-5035, the captain's "make sure to add a journey test that would have
 * caught the bug": a merge card that comes back opens with its crewmate's
 * summary of what changed under a label naming the captain's last act on the
 * earlier card (docs/card-authoring.md, "Since the card you saw"). INF-3715
 * built it, but only the older sighting report kept the earlier card, and
 * every window has sent today's report since, so no summary was ever drawn.
 * This journey reaches the summary only through the window's own sighting
 * and the captain's own click.
 *
 * Its data is a disposable local project and the scripted crewmate in
 * `scenarios/returningMergeCard.ts`. Its completion signals are the
 * returning cards' bodies, read in their frames. It shares no sign-in,
 * account or folder with another journey.
 */

const why = MOCK_GITHUB_STORY.why[0];
if (!why) throw new Error("The story fixture needs its reason.");

/** A label's words with its time left open, read from the catalog message that owns them. */
const HOLE = "\u0000";
function labelPattern(words: string): RegExp {
  const [before = "", after = ""] = words.split(HOLE);
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${literal(before)}.+${literal(after)}$`);
}

const offerOf = (page: Page) =>
  page.evaluate(
    async (title) =>
      (await window.infinitary.cards.list()).find((card) => card.title === title)?.offerId,
    RETURNING_MERGE_TITLE,
  );

const shownAgain = (page: Page, earlier: string | undefined) =>
  expect
    .poll(
      async () => {
        const offer = await offerOf(page);
        return offer !== undefined && offer !== earlier;
      },
      { timeout: 60_000 },
    )
    .toBe(true);

test("a merge card that comes back opens with its crewmate's summary under the captain's last act", async () => {
  test.setTimeout(3 * 60_000);
  const userDataDir = scratchDir("infinitary-since-seen-");
  const dir = join(userDataDir, "meterlab");
  // The seed's git reads none of this computer's settings: no system, global or inherited -c ones.
  const git = (...args: string[]) =>
    execFileSync("git", args, { env: baseEnv(userDataDir), stdio: "pipe" });
  git("init", "--initial-branch=main", dir);
  git("-C", dir, "config", "user.name", "Test");
  git("-C", dir, "config", "user.email", "test@localhost");
  git("-C", dir, "commit", "--allow-empty", "-m", "chore: seed the meter");
  const db = openDatabase(userDataDir);
  seedProject(db, {
    id: "repo-meterlab",
    path: dir,
    name: "meterlab",
    setupKind: "init",
    origin: null,
    runsOn: null,
    delivery: "local-only",
    autonomy: false,
    rigor: "quick",
    addedAt: 1,
  });
  db.close();
  const launched = await launchApp({
    withMockProvider: true,
    scenarios: [returningMergeCard],
    userDataDir,
  });
  try {
    const { app, page } = launched;
    await resizeWindow(app, page, { width: 1280, height: 1000 });
    const card = shownCard(page, RETURNING_MERGE_TITLE);
    const frame = cardBody(page, RETURNING_MERGE_TITLE);
    const section = frame.locator("[data-since-seen]");
    let firstOffer: string | undefined;

    await test.step("the captain sees the crewmate's merge card", async () => {
      const input = promptInput(page);
      await input.fill(`${SPAWN_PROMPT_MARKER} meterlab ${RETURNING_MERGE_MARKER}`);
      await input.press("Enter");
      await expect(card).toBeVisible({ timeout: 60_000 });
      await expect(frame.locator("body")).toContainText(why);
      // A hidden test window has the card in front of the captain once it has the focus.
      await card.locator("[data-card-title]").click();
      await expectCardSeen(page, RETURNING_MERGE_TITLE);
      firstOffer = await offerOf(page);
      // The first merge card of a change has nothing to say since.
      await expect(section).toHaveCount(0);
    });

    await test.step("after a reply, the card comes back with the summary under the card the captain saw", async () => {
      const reply = cardReply(page);
      await reply.field.fill(RETURNING_MERGE_REPLY);
      await reply.send.click();
      await shownAgain(page, firstOffer);
      await expect(frame.locator("body")).toContainText(why);
      await expect(section.locator("h6")).toHaveText(
        labelPattern(m.cardSinceSeenSaw({ when: HOLE })),
      );
      await expect(section.locator("p")).toHaveText([RETURNING_MERGE_SUMMARIES.reply]);
      const words = await frame.locator("body").innerText();
      expect(words.indexOf(RETURNING_MERGE_SUMMARIES.reply)).toBeLessThan(words.indexOf(why));
      await stageAtRest(page);
      await regionShot(card, test.info().outputPath("since-seen-after-sighting.png"));
    });

    await test.step("after Not now, the card comes back naming the captain's choice", async () => {
      const seen = await offerOf(page);
      // The card's buttons sit at the foot of its thread, beside the body.
      await shownEntry(page)
        .getByRole("button", { name: MERGE_NOT_NOW_WORDS, exact: true })
        .click();
      await shownAgain(page, seen);
      await expect(card).toBeVisible();
      await expect(section.locator("h6")).toHaveText(
        labelPattern(m.cardSinceSeenChose({ button: MERGE_NOT_NOW_WORDS, when: HOLE })),
      );
      await expect(section.locator("p")).toHaveText([RETURNING_MERGE_SUMMARIES.notNow]);
      await stageAtRest(page);
      await regionShot(card, test.info().outputPath("since-seen-after-not-now.png"));
    });
  } finally {
    await launched.close();
  }
});
