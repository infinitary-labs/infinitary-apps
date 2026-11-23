import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { waitForFirstmateIdle } from "./crew";
import { startCustomApiFixture } from "./customApiFixture";
import { launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { ANSWER_PROMPT_MARKER, MOCK_ANSWER_TITLE, startMockProvider } from "./mockProvider";
import { heroShot, regionShot } from "./pictures";
import { promptInput } from "./prompt";
import { starterFor } from "./starters";
import { usageSummary, usageTab } from "./usage";
import { runFromSearch } from "./windowKeys";

test("custom turns remain in Usage without counts and exact catalog ids receive estimates", async () => {
  const mock = await startMockProvider();
  const requested = await startCustomApiFixture(mock.port, undefined, undefined, "requested");
  const silent = await startCustomApiFixture(mock.port, undefined, undefined, "silent");
  const launched = await launchApp({ reuseMockProvider: mock });
  const evidence = process.env.FM_USAGE_EVIDENCE;
  try {
    const { page, app } = launched;
    await resizeWindow(app, page, { width: 1200, height: 1000 });
    for (const [baseUrl, label, id] of [
      [requested.baseUrl, "Team gateway", starterFor("openai-codex", "medium")],
      [requested.baseUrl, "Local model", "operator-model"],
      [silent.baseUrl, "Lab server", starterFor("openai-codex", "medium")],
    ] as const) {
      await page.evaluate(
        async ({ baseUrl, label, id }) => {
          const draft = await window.infinitary.accounts.custom.prepare({
            baseUrl,
            approvedDestination: baseUrl,
            label,
            mode: "local",
            protocol: "openai-completions",
            key: "",
            noKey: true,
            headers: [],
            unencryptedLocalApproved: true,
            allowStorageDefault: false,
            storageApproved: false,
            models: [{ id, context: 200000, output: 4096 }],
          });
          const checked = await window.infinitary.accounts.custom.check(draft.draftId ?? "", id);
          if (!checked.models[0]?.checked) throw new Error("Fixture model check failed");
          const saved = await window.infinitary.accounts.custom.save(draft.draftId ?? "", false);
          const account = (await window.infinitary.accounts.list()).find(
            (entry) => entry.id === saved.accountId,
          );
          if (!account) throw new Error("Fixture account missing");
          await window.infinitary.settings.setFirstmateModel({ provider: account.providerId, id });
          await window.infinitary.settings.setFirstmateAccount(account.id);
        },
        { baseUrl, label, id },
      );
      const cardsBefore = (await page.evaluate(() => window.infinitary.cards.list())).filter(
        (card) => card.title === MOCK_ANSWER_TITLE,
      ).length;
      const input = promptInput(page);
      await expect(input).toBeEnabled();
      await input.fill(`please ${ANSWER_PROMPT_MARKER}: show usage for ${label}`);
      await input.press("Enter");
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.cards.list())).filter(
              (card) => card.title === MOCK_ANSWER_TITLE,
            ).length,
        )
        .toBeGreaterThan(cardsBefore);
      await waitForFirstmateIdle(page);
    }
    const summary = await usageSummary(page, { period: "all", scope: "firstmate" });
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, "after.json"),
        JSON.stringify({ summary, requests: [...requested.requests, ...silent.requests] }, null, 2),
      );
    }
    {
      const known = summary.models.find((model) => model.providerName === "Team gateway");
      const unknown = summary.models.find((model) => model.providerName === "Local model");
      const noCounts = summary.models.find((model) => model.providerName === "Lab server");
      if (!known || !unknown || !noCounts)
        throw new Error("A custom connection disappeared from Usage");
      expect(known.amount.records).toBeGreaterThan(0);
      expect(known.amount.counted).toBe(known.amount.records);
      expect(known.amount.cost).toBeGreaterThan(0);
      expect(unknown.amount.counted).toBe(unknown.amount.records);
      expect(unknown.amount.cost).toBeNull();
      expect(noCounts.amount.records).toBeGreaterThan(0);
      expect(noCounts.amount.counted).toBe(0);
      expect(noCounts.amount.cost).toBeNull();
    }
    // Leave room for Cost per task and keep the whole Usage overview in both captures.
    await resizeWindow(app, page, { width: 1200, height: 1550 });
    await runFromSearch(app, page, "settings.usage");
    const usage = usageTab(page);
    for (const unit of ["tokens", "usd"] as const) {
      await usage.unit(unit).check();
      await regionShot(usage.section, evidence ? join(evidence, `${unit}-after.png`) : undefined);
    }
    if (evidence) {
      for (const model of summary.models) {
        for (const unit of ["tokens", "usd"] as const) {
          await usage.unit(unit).check();
          await usage.model(model.id).click();
          await expect(usage.detail).toBeVisible();
          await regionShot(
            usage.detail,
            join(evidence, `${model.providerName}-${unit}-detail.png`),
          );
          await page.keyboard.press("Escape");
        }
      }
      await usage.unit("usd").check();
    }
    if (evidence)
      await heroShot(app, page, {
        region: usage.section.locator("[data-usage-models]"),
        name: "custom-usage",
      });
  } finally {
    await launched.close();
    await requested.close();
    await silent.close();
    await mock.close();
  }
});
