import { expect, test } from "@playwright/test";
import type { Card } from "../../src/shared/cards";
import * as m from "../../src/shared/i18n/messages.generated";
import { SECRETS_AREAS } from "../../src/shared/secrets";
import { handoverCard, offeredCard } from "./handoverCards";
import { askFirstmate } from "./lastTurn";
import { type LaunchedApp, launchApp } from "./launch";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { pressKey } from "./windowKeys";

/**
 * INF-5326's approved plan, piece 2, with the captain's choice on its review
 * (share-checks-and-keep-card): a first mate's card for an act Settings shows
 * only on the first mate's own computer stays up on a Mac that controls it.
 * Its button there says where to choose it and sends nothing, and the first
 * mate refuses the click itself when a window sends it anyway, as a window
 * from before this change does. The data: the first mate's computer and a
 * second app joined to it as a view, both on this Mac with their own data,
 * and the card for a page of Secrets. The completion signal is the card
 * still up on both, with the words on the view's card and the refusal's own.
 */

test("a card for the first mate's own computer stays up on a Mac that controls it, from its button or a window that sends the click anyway", async () => {
  test.setTimeout(120_000);
  const pro = await launchApp({
    withMockProvider: true,
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro" },
  });
  let air: LaunchedApp | undefined;
  try {
    const area = SECRETS_AREAS[2];
    const offer = offeredCard("secrets-page", { page: area.value }, null);
    await askFirstmate(
      pro.page,
      APP_CATALOG_PROMPT_MARKER +
        JSON.stringify({ action: "secrets-page", value: { page: area.value } }),
    );
    await handoverCard(pro.page, offer);
    const invite = await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
    air = await launchApp({ env: { INFINITARY_DEVICE_NAME: "MacBook Air" } });
    const { page } = air;
    // Joining starts the window over as the other Mac's, so the call is not awaited in it.
    await page.evaluate((link) => {
      void window.infinitary.devices.join(link);
    }, invite.link);
    await expect(page.locator("[data-remote-control]")).toHaveAttribute(
      "data-remote-control",
      "in-reach",
    );
    const cardIn = async (app: LaunchedApp) =>
      ((await app.page.evaluate(() => window.infinitary.cards.list())) as Card[]).find(
        (card) => card.title === offer.title,
      );

    await test.step("its button on the view says where to choose it, and the card stays up on both", async () => {
      const card = await handoverCard(page, offer);
      await pressKey(card.getByRole("button", { name: offer.label, exact: true }), "Enter");
      await expect(card.getByRole("alert")).toHaveText(m.viewFromHomeOnly({ mac: "MacBook Pro" }));
      await expect(page.locator("[data-settings-column]")).toHaveCount(0);
      expect((await cardIn(pro))?.status).toBe("ready");
    });

    await test.step("a window that sends the click anyway is refused by the first mate, and the card stays up", async () => {
      const shown = await cardIn(air as LaunchedApp);
      const open = shown?.actions.find((action) => action.default);
      const refused = await page.evaluate(
        ([cardId, actionId]) =>
          window.infinitary.cards.act(cardId, actionId, "chrome").then(
            () => "sent",
            (error: Error) => error.message,
          ),
        [shown?.id ?? "", open?.id ?? ""] as const,
      );
      expect(refused).toContain(m.viewFromHomeOnlyThere());
      expect((await cardIn(pro))?.status).toBe("ready");
      await handoverCard(pro.page, offer);
    });
  } finally {
    await air?.close();
    await pro.close();
  }
});
