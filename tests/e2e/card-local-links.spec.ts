import { expect, test } from "@playwright/test";
import { CardStore } from "../../src/core/storage/cardStore";
import { openDatabase } from "../../src/core/storage/db";
import type { Card } from "../../src/shared/cards";
import { scratchDir } from "../helpers/scratchDirs";
import { cardBody, frameGesturesDecided } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { pressPointer } from "./layout";
import { promptInput } from "./prompt";
import {
  LOCAL_LINK_CARD_TITLES,
  LOCAL_LINK_CARDS_PROMPT_MARKER,
  LOCAL_LINK_HREF,
  localLinkCards,
} from "./scenarios/localLinkCards";
import { clickInBody, pager, showCard } from "./stack";
import { focusOn, pressKey } from "./windowKeys";

/**
 * An anchor to a genuine `.localhost` subdomain opens through the host's
 * opener from a note, a decision and a scripted body alike; a public http
 * anchor opens nothing. A link opens only from the captain's own click or
 * Enter on it, never from the body's own script (docs/keyboard.md, "Cards
 * and frames"). The system browser is a recorder here.
 */

/** Replaces the system browser with a recorder of the addresses it is asked to open. */
const recordOpens = (launched: LaunchedApp) =>
  launched.app.evaluate(({ shell }) => {
    const recorded: string[] = [];
    (globalThis as { __fmOpened?: string[] }).__fmOpened = recorded;
    shell.openExternal = async (url: string) => {
      recorded.push(url);
    };
  });

const opened = (launched: LaunchedApp) =>
  launched.app.evaluate(() => (globalThis as { __fmOpened?: string[] }).__fmOpened ?? []);

test("local-subdomain links in notes, decisions and scripted cards reach the host opener", async () => {
  const launched = await launchApp({ withMockProvider: true, scenarios: [localLinkCards] });
  try {
    const { page } = launched;
    await recordOpens(launched);
    const input = promptInput(page);
    await input.click();
    await input.fill(`commission a crewmate: ${LOCAL_LINK_CARDS_PROMPT_MARKER}`);
    await input.press("Enter");
    await expect(pager(page, 3)).toBeVisible({ timeout: 30_000 });

    let expected = 0;
    for (const title of Object.values(LOCAL_LINK_CARD_TITLES)) {
      await showCard(page, title);
      const anchor = cardBody(page, title).getByRole("link", { name: "Open the report" });
      await expect(anchor).toHaveAttribute("href", LOCAL_LINK_HREF);
      await clickInBody(anchor);
      expected += 1;
      await expect.poll(() => opened(launched)).toHaveLength(expected);
    }
    expect(await opened(launched)).toEqual(Array(3).fill(LOCAL_LINK_HREF));

    // The same gate still refuses a public http address, in the host itself.
    await page.evaluate(() => window.infinitary.app.openExternal("http://localhost.example.com/"));
    await page.evaluate(() => window.infinitary.app.openExternal("http://evillocalhost/"));
    expect(await opened(launched)).toHaveLength(3);
  } finally {
    await launched.close();
  }
});

const FORGER = "A card that opens its own link";
const DRAFT = "ship the login fix today";

/**
 * A body whose script, ten times over two seconds, clicks its own link and
 * posts the bridge's link message itself, while the captain types elsewhere.
 */
function linkForgingCard(): Card {
  const forged = JSON.stringify({ fm: 2, type: "link", href: LOCAL_LINK_HREF });
  return {
    id: "card-fm-link-forger",
    author: "firstmate",
    meta: "firstmate",
    priority: 30,
    title: FORGER,
    body:
      `<p>The report is ready to read.</p><p><a href="${LOCAL_LINK_HREF}">Open the report</a></p>` +
      `<p role="status">0</p>` +
      "<script>(function () {" +
      "var sent = 0;" +
      "var forge = setInterval(function () {" +
      '  document.querySelector("a").click();' +
      `  parent.postMessage(${forged}, "*");` +
      "  sent += 1;" +
      '  document.querySelector("[role=status]").textContent = String(sent);' +
      "  if (sent >= 10) clearInterval(forge);" +
      "}, 200);" +
      "})();</script>",
    status: "ready",
    createdAt: Date.now(),
    actions: [],
  };
}

test("a card's script cannot open its own link; the captain's click and Enter on it do", async () => {
  const userDataDir = scratchDir("infinitary-card-links-");
  const db = openDatabase(userDataDir);
  try {
    new CardStore(db).upsert(linkForgingCard());
  } finally {
    db.close();
  }
  const launched = await launchApp({
    userDataDir,
    withMockProvider: true,
    scenarios: [localLinkCards],
    gpuBenchmarking: true,
  });
  try {
    const { page } = launched;
    await recordOpens(launched);
    await showCard(page, FORGER);
    const frame = cardBody(page, FORGER);
    const link = frame.getByRole("link", { name: "Open the report" });
    const prompt = promptInput(page);
    await prompt.fill(DRAFT);
    await expect(prompt).toBeFocused();

    await test.step("the clicks and messages the script sends while focus is elsewhere open nothing", async () => {
      await expect(frame.getByRole("status")).toHaveText("10", { timeout: 10_000 });
      await frameGesturesDecided(page);
      await expect(prompt).toBeFocused();
      await expect(prompt).toHaveValue(DRAFT);
      expect(await opened(launched)).toEqual([]);
    });

    await test.step("the captain's own click on the link opens it once", async () => {
      await pressPointer(page, link);
      await expect.poll(() => opened(launched)).toEqual([LOCAL_LINK_HREF]);
    });

    await test.step("Enter on the link opens it once more", async () => {
      await focusOn(prompt);
      await pressKey(link, "Enter");
      await expect.poll(() => opened(launched)).toEqual([LOCAL_LINK_HREF, LOCAL_LINK_HREF]);
    });
  } finally {
    await launched.close();
  }
});
