import { expect, test } from "@playwright/test";
import { SECRET_COPY_WORDS } from "../../src/shared/secrets";
import { handoverCard, offeredCard } from "./handoverCards";
import { askFirstmate } from "./lastTurn";
import { APP_CATALOG_PROMPT_MARKER } from "./mockProvider";
import { savedText } from "./savedText";
import { launchSecrets, type SecretsJourneyGlobal } from "./secretsHarness";
import { settingsSection } from "./settings";
import { pressKey } from "./windowKeys";

// Intent: INF-6315's approved plan, with the captain's answers - copy, not
// reveal; cleared after 90 seconds; this computer only. Copy value on a
// secret's row puts its value on the clipboard after this computer's own
// confirmation, the row says until when, Clear now takes it off, and no
// saved file holds the value. The first mate's card names the secret and
// opens its row, where the press stays the captain's.
// Data: the hermetic launcher's disposable Secrets custody, one invented
// token added through the core, and the harness's stand-in clipboard writer,
// which never touches the computer's clipboard. The 90-second clear is
// `src/core/secrets/settings.test.ts`'s, on a fake clock.
// Completion: the stand-in holds the value after the press and nothing after
// Clear now, and the row's status says it was copied by you.
const TOKEN = "ghp_invented0CopyJourney7Q2xV9mK4tR8wL1nB6cZ3";
const LABEL = "Staging deploy token";

test("Copy value puts a secret on this computer's clipboard after confirmation and Clear now takes it off, by keys", async () => {
  const launched = await launchSecrets();
  try {
    const { app, page, userDataDir } = launched;
    await app.evaluate(
      async (_electron, { token, label }) => {
        await (globalThis as SecretsJourneyGlobal).secretsJourney.core.services.secrets.put({
          label,
          value: token,
          expectedVersion: 0,
          expectedRevision: null,
          environment: "",
        });
      },
      { token: TOKEN, label: LABEL },
    );
    const fixture = () =>
      app.evaluate(() => {
        const { clipboard, confirmations } = (globalThis as SecretsJourneyGlobal).secretsJourney;
        return { ...clipboard, confirmations };
      });

    await askFirstmate(
      page,
      APP_CATALOG_PROMPT_MARKER +
        JSON.stringify({ action: "secrets-page", value: { secret: LABEL.toLowerCase() } }),
    );
    const offer = offeredCard("secrets-page", { secret: LABEL.toLowerCase() }, null);
    const card = await handoverCard(page, offer);
    await pressKey(card.getByRole("button", { name: offer.label, exact: true }), "Enter");

    const section = settingsSection(page, "secrets");
    const row = section.locator("li[data-secret-row]", { hasText: LABEL });
    await expect(row.locator(":scope > details")).toHaveAttribute("open", "");
    await expect(row.locator(":scope > details > summary")).toBeFocused();
    expect(await fixture()).toMatchObject({ held: null, writes: 0, confirmations: 0 });

    await pressKey(row.getByRole("button", { name: SECRET_COPY_WORDS.copy, exact: true }), "Enter");
    const copied = row.locator("[data-secret-copied]");
    await expect(copied).toBeVisible();
    expect(await fixture()).toMatchObject({ held: TOKEN, writes: 1, confirmations: 1 });
    await expect(row.locator("summary")).toContainText(SECRET_COPY_WORDS.byYou);

    await pressKey(
      copied.getByRole("button", { name: SECRET_COPY_WORDS.clearNow, exact: true }),
      "Enter",
    );
    await expect(copied).toHaveCount(0);
    await expect(
      row.getByRole("button", { name: SECRET_COPY_WORDS.copy, exact: true }),
    ).toBeFocused();
    expect(await fixture()).toMatchObject({ held: null, writes: 1 });

    for (const { file, text } of savedText(userDataDir)) {
      expect(text, file).not.toContain(TOKEN);
      expect(text, file).not.toContain(Buffer.from(TOKEN).toString("base64"));
    }
  } finally {
    await launched.close();
  }
});
