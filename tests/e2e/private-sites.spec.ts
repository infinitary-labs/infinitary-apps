import { expect, test } from "@playwright/test";
import { ACTIONS } from "../../src/shared/actions";
import { normalizePrivateSite, PRIVATE_SITES_WORDS } from "../../src/shared/privateSites";
import { askFirstmate } from "./lastTurn";
import { launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { settingsSection } from "./settings";
import { shownCard } from "./stack";
import { focusOn, pressKey, typeInto } from "./windowKeys";

/**
 * The private sites list (docs/task-browser.md, "Private sites"; the
 * keyboard rule, docs/keyboard.md "A new feature"): the first mate offers
 * the app's own Allow card for a site a crewmate named, the captain's Allow
 * - pressed by key - opens Settings › General with the site added, and the
 * captain adds a suffix, is refused an address and removes the first site,
 * all from the keyboard, with each change saved where task browsers read it
 * and the add on the record as one operation naming the site.
 * What a listed or unlisted site reaches is the connection guard's and the
 * task browser's own tests (connectionGuard.test.ts, taskBrowsers.reading.test.ts):
 * a run never dials a private network.
 */

const SITE = "wiki.corp.example";
const SUFFIX = ".corp.example.com";
const ADDRESS = "10.20.30.40";

test("an Allow card adds a private site, and Settings adds, refuses and removes one by keys", async () => {
  const launched = await launchApp({ withMockProvider: true });
  try {
    const { page } = launched;
    const saved = () => page.evaluate(() => window.infinitary.browser.privateSites());

    await test.step("the Allow card's key adds the site and lands on General", async () => {
      await askFirstmate(
        page,
        APP_CATALOG_PROMPT_MARKER +
          JSON.stringify({ action: "private-site-allow", value: { site: SITE } }),
      );
      const offer = ACTIONS["private-site-allow"].offer?.(
        { site: SITE },
        { sites: [] },
        { platform: process.platform },
      );
      if (!offer) throw new Error("The private site line offers a card");
      const card = shownCard(page, offer.title);
      await expect(card).toBeVisible();
      expect((await saved()).sites).toEqual([]);
      await pressKey(card.getByRole("button", { name: offer.label, exact: true }), "Enter");
      const section = settingsSection(page, "general").locator("[data-private-sites]");
      await expect(section.locator(`[data-private-site="${SITE}"]`)).toBeVisible();
      await expect.poll(async () => (await saved()).sites).toEqual([SITE]);
      // The captain's add is one operation on the record, naming the site it saved.
      const done = ACTIONS["private-site-allow"].done({ site: SITE });
      await expect
        .poll(() =>
          page.evaluate(async () =>
            (await window.infinitary.tasks.board()).tasks.map((task) => task.title),
          ),
        )
        .toContain(done);
    });

    const section = settingsSection(page, "general").locator("[data-private-sites]");
    const field = section.getByRole("textbox", { name: PRIVATE_SITES_WORDS.field, exact: true });

    await test.step("a typed suffix is added with Enter", async () => {
      await focusOn(field);
      await typeInto(field, `*${SUFFIX}`);
      await pressKey(field, "Enter");
      await expect(section.locator(`[data-private-site="${SUFFIX}"]`)).toBeVisible();
      await expect(field).toHaveValue("");
      await expect.poll(async () => (await saved()).sites).toEqual([SITE, SUFFIX]);
    });

    await test.step("an address is refused with the reason", async () => {
      const refused = normalizePrivateSite(ADDRESS);
      if (refused.ok) throw new Error("An address must be refused");
      await focusOn(field);
      await typeInto(field, ADDRESS);
      await pressKey(field, "Enter");
      await expect(section.getByText(refused.text, { exact: true })).toBeVisible();
      await expect(field).toHaveValue(ADDRESS);
      expect((await saved()).sites).toEqual([SITE, SUFFIX]);
    });

    await test.step("Remove, pressed by key, takes the first site off", async () => {
      const row = section.locator(`[data-private-site="${SITE}"]`);
      await pressKey(row.getByRole("button", { name: PRIVATE_SITES_WORDS.remove }), "Enter");
      await expect(row).toHaveCount(0);
      await expect.poll(async () => (await saved()).sites).toEqual([SUFFIX]);
    });
  } finally {
    await launched.close();
  }
});
