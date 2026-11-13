import { expect, type Locator, type Page, test } from "@playwright/test";
import { captainTurn, renderWake } from "../../src/core/orchestrator/wakes";
import { COMPUTER_FONTS, cssFamily } from "../../src/shared/fonts";
import * as m from "../../src/shared/i18n/messages.generated";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { cardBody } from "./frames";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { served } from "./providerRequest";
import { settingRow } from "./settings";
import { focusOn, pressKey, pressWindowKey } from "./windowKeys";

// The approved font plan (INF-3982), direction B as the captain chose it:
// any installed font for the app, for reading and for code, chosen in
// Settings → Appearance by the keyboard, followed at once by the window and by
// a card already open, and kept across a restart.

const CARD_TITLE = "Fonts on a card";
const CARD_WORDS = "What the crew writes reads in the reading font.";

/** A note on the first mate's own card, through the real emitted-card interface. */
async function emitCard(app: LaunchedApp): Promise<void> {
  await waitForFirstmateIdle(app.page);
  if (!app.mockProvider) throw new Error("The font journey needs the mock provider");
  const words = "Show me a card with some code";
  const answer = app.mockProvider.scriptFirstmateTurn(
    served({ kind: "user", origin: "captain", body: renderWake(captainTurn(words, false)) }),
    [
      {
        name: "emit_card",
        args: {
          id: "font-card",
          title: CARD_TITLE,
          body: `<p>${CARD_WORDS}</p><p><code>pnpm check:changed</code></p>`,
          actions: [],
        },
      },
    ],
  );
  await askFirstmate(app.page, words);
  await expect.poll(answer.outcome).toMatchObject({ state: "closed" });
}

/** The family list a token resolves to on the window's document. */
function windowToken(page: Page, token: string): Promise<string> {
  return page.evaluate(
    (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    token,
  );
}

/** A family name as a pattern, its letters taken literally. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fontOf(element: Locator): Promise<string> {
  return element.evaluate((node) => getComputedStyle(node).fontFamily);
}

/**
 * The first family an element draws in, by name. The browser quotes a
 * family only when its name needs it, so `C059` reads bare and
 * `Space Grotesk` in quotes.
 */
async function firstFont(element: Locator): Promise<string> {
  const [first = ""] = (await fontOf(element)).split(",");
  return first.trim().replace(/^"(.*)"$/, "$1");
}

async function openAppearance(app: LaunchedApp): Promise<void> {
  await pressWindowKey(app.app, ",", ["meta"]);
  await pressKey(app.page.locator('[data-settings-tabs] [role="tab"]').first(), "ArrowDown");
}

test("Fonts: any installed font for the app, reading and code, chosen by keys, followed by an open card and kept across a restart", async () => {
  const userDataDir = scratchDir("infinitary-fonts-");
  const homeDir = scratchDir("infinitary-fonts-home-");
  let installed = "";
  const first = await launchApp({ withMockProvider: true, userDataDir, homeDir });
  try {
    const { page } = first;
    await emitCard(first);
    const body = cardBody(page, CARD_TITLE);
    await expect(body.locator("p").first()).toHaveText(CARD_WORDS);
    // Infinitary's own fonts before any choice.
    expect(await firstFont(body.locator("body"))).toBe("Space Grotesk");
    expect(await firstFont(body.locator("code"))).toBe("JetBrains Mono");

    await openAppearance(first);
    const app = settingRow(page, "font-app").locator("select");
    const reading = settingRow(page, "font-reading").locator("select");
    const code = settingRow(page, "font-code").locator("select");
    await expect(reading.locator("option").first()).toHaveText(m.settingsFontSameAsApp());

    // The computer's installed fonts are listed under their own heading.
    const families = app.locator(`optgroup[label="${m.settingsFontInstalled()}"] option`);
    await expect(families.first()).toBeAttached();
    installed = (await families.first().getAttribute("value")) ?? "";
    expect(installed).not.toBe("");

    // The app font: an installed font, from the keyboard-focused picker. The
    // window's words take it at once.
    await focusOn(app);
    await app.selectOption(installed);
    await expect
      .poll(() => windowToken(page, "--font-ui"))
      .toMatch(new RegExp(`^"${literal(installed)}", "Space Grotesk"`));

    // The code font: this computer's own, named by its row.
    await focusOn(code);
    await expect(code.locator("option").nth(1)).toHaveText(m.settingsFontComputer());
    // A closed picker's arrow keys change its value only on Linux (and
    // Windows); on the Mac they open the menu, so the Mac picks from it.
    if (process.platform === "linux") await pressKey(code, "ArrowDown");
    else await code.selectOption(COMPUTER_FONTS.code);
    await expect(code).toHaveValue(COMPUTER_FONTS.code);
    await expect
      .poll(() => windowToken(page, "--font-mono"))
      .toMatch(new RegExp(`^${cssFamily(COMPUTER_FONTS.code)}, "JetBrains Mono"`));
    await expect(code).toBeFocused();

    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getAppearance()))
      .toMatchObject({ fonts: { app: installed, code: COMPUTER_FONTS.code } });

    // Back from Settings, the card already open is drawn again: its words in
    // the app font, since no reading font is chosen, and its code in the new
    // code font.
    await page.keyboard.press("Escape");
    await expect.poll(() => firstFont(body.locator("body"))).toBe(installed);
    await expect.poll(() => firstFont(body.locator("code"))).toBe(COMPUTER_FONTS.code);
  } finally {
    await first.close();
  }

  const second = await launchApp({ withMockProvider: true, userDataDir, homeDir });
  try {
    const { page } = second;
    // The choice outlives the restart, from the first paint.
    await expect
      .poll(() => windowToken(page, "--font-ui-face"))
      .toBe(`"${installed}", "Space Grotesk"`);
    await openAppearance(second);
    const app = settingRow(page, "font-app").locator("select");
    await expect(app).toHaveValue(installed);

    // Infinitary's own font again: the choice is gone from the saved look.
    await focusOn(app);
    await app.selectOption("");
    await expect.poll(() => windowToken(page, "--font-ui")).toMatch(/^"Space Grotesk"/);
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getAppearance()))
      .toMatchObject({ fonts: { code: COMPUTER_FONTS.code } });
  } finally {
    await second.close();
  }
});
