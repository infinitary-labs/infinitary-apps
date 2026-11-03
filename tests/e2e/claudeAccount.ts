import { expect, type Page, test } from "@playwright/test";

/** INF-2384: connected-Claude journeys must reach the real account health path. */
export async function expectClaudeConnected(page: Page, accountId: string): Promise<void> {
  const reading = await page.evaluate(async (id) => {
    const account = (await window.infinitary.accounts.list()).find((each) => each.id === id);
    const slots = await window.infinitary.models.slots();
    return {
      accountId: id,
      connected: account?.connected,
      models: [...slots.models, ...slots.byName]
        .filter((model) => model.provider === "anthropic-claude")
        .map(({ id, label, slots }) => ({ id, label, slots })),
    };
  }, accountId);
  await test.info().attach("claude-account-prerequisite", {
    body: JSON.stringify(reading, null, 2),
    contentType: "application/json",
  });
  expect(reading.connected).toBe(true);
}
