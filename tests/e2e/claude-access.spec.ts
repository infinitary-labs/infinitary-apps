import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { FIRSTMATE_PERSONA } from "../../src/core/pi/piResources";
import { CLAUDE_ACCESS_ALLOWANCE_TEXT, CLAUDE_ACCESS_LABEL } from "../../src/shared/claudeAccess";
import { claudeSettingsGateway } from "./claudeAccount";
import { CLAUDE_SEAT_MODEL, NO_CLAUDE_LOGIN_USER, say } from "./claudeSeat";
import { launchApp } from "./launch";
import { ANSWER_PROMPT_MARKER, MOCK_ANSWER_TITLE, startMockProvider } from "./mockProvider";
import { shownCard } from "./stack";

/**
 * Claude through a gateway set up in the person's own Claude Code settings
 * (INF-3449, the captain's words: "Take the gateway address and token
 * command from the person's own Claude settings too"). The throwaway HOME
 * holds a Claude settings file naming a token command and the mock
 * provider's address, as a company's gateway hands them out, and no Claude
 * login at all. The boxed client is handed neither a key nor an address
 * (`credential: "settings"`), so the first mate's turn reaches the mock only
 * through what the app took from that file.
 *
 * Connect ends connected with no browser sign-in, the row names where the
 * access comes from and says its allowance is not measured, and the first
 * mate's turn on Claude carries the token the command printed.
 */

/** What the person's token command prints: the mock accepts any token, so the request shows which one came. */
const GATEWAY_TOKEN = "e2e-gateway-token-from-command";

test("Claude connects from the gateway in the person's Claude settings, with no browser sign-in", async () => {
  const mockProvider = await startMockProvider();
  try {
    const app = await launchApp({
      reuseMockProvider: mockProvider,
      claudeTurns: { credential: "settings", maxRetries: 0 },
      prepareHome: claudeSettingsGateway(`http://127.0.0.1:${mockProvider.port}`, GATEWAY_TOKEN),
      env: { USER: NO_CLAUDE_LOGIN_USER },
    });
    try {
      const { page } = app;
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Intelligence" }).click();
      await page.getByRole("button", { name: "Connect Claude" }).first().click();
      // Nothing asks for a code: the new account only asks for its name.
      await page.getByRole("button", { name: "Save", exact: true }).click({ timeout: 20_000 });
      // The client's browser sign-in never ran: it would have left its login
      // marker in the Claude folder (`writeMockClaudeClient`).
      expect(existsSync(join(app.homeDir, ".claude", "stub-credential"))).toBe(false);
      const accounts = await page.evaluate(() => window.infinitary.accounts.list());
      const claude = accounts.find((account) => account.providerId === "anthropic-claude");
      expect(claude).toMatchObject({ connected: true, access: "claude-settings" });
      const row = page.locator(`[data-account-row="${claude?.id}"]`);
      await expect(row).toContainText(CLAUDE_ACCESS_LABEL["claude-settings"]);
      await expect(row).toContainText(CLAUDE_ACCESS_ALLOWANCE_TEXT["claude-settings"], {
        timeout: 20_000,
      });
      await expect(row.getByTestId("quota-micro-meter")).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Sign in" })).toHaveCount(0);

      // The first mate answers on Claude, through the gateway.
      await page.evaluate(
        (model) => window.infinitary.settings.setFirstmateModel(model),
        CLAUDE_SEAT_MODEL,
      );
      await page.keyboard.press("Escape");
      await expect(page.locator("[data-screen-label]")).not.toHaveAttribute(
        "data-screen-label",
        "Settings",
      );
      await say(page, `why does the meter idle? ${ANSWER_PROMPT_MARKER}`);
      await expect(shownCard(page, MOCK_ANSWER_TITLE)).toBeVisible({ timeout: 45_000 });
      const headers = mockProvider.requestHeaders();
      const seat = mockProvider
        .requestBodies()
        .map((body, index) => ({ body, headers: headers[index] }))
        .filter(
          (request) =>
            request.body.includes(FIRSTMATE_PERSONA) &&
            request.headers?.["user-agent"]?.startsWith("claude-cli/") === true,
        );
      expect(seat.length).toBeGreaterThanOrEqual(1);
      for (const request of seat) expect(request.headers?.["x-api-key"]).toBe(GATEWAY_TOKEN);
    } finally {
      await app.close();
    }
  } finally {
    await mockProvider.close();
  }
});
