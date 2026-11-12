import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ANTIGRAVITY_PROVIDER_ID, ANTIGRAVITY_SIGN_IN_WORDS } from "../../src/shared/antigravity";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { agyHome, standInAgy } from "./agyStandIn";
import { expectClaudeConnected, launchSignedInClaude } from "./claudeAccount";
import { resizeWindow } from "./layout";
import { writeMockClaudeClient } from "./mockClaudeClient";
import { regionShot } from "./pictures";
import { focusOn, pressKey } from "./windowKeys";

/**
 * Connecting a Google AI plan through the installed Antigravity (INF-3776,
 * the captain's approved plan, its second pull request): the chip in
 * Settings → Intelligence shows what Google's terms and forum say before
 * anything starts, "Not now" starts nothing, and "Sign in with Google" runs
 * the program's own sign-in, whose success adds the one Antigravity
 * account. Driven by keys (docs/keyboard.md, "A new feature").
 *
 * Its data is a fresh profile and HOME with a signed-in Claude account, so
 * the first-launch gate is down, and a stand-in `agy` in that HOME's
 * `~/.local/bin`, where the app looks for the program first
 * (`tests/helpers/agyCommandStandIn.ts`); no Google sign-in or network is
 * used. It shares no sign-in, keychain, account or folder with another
 * journey and needs no Mac. Its completion signal is the Antigravity
 * account's row in the tab, with the stand-in's log holding the one sign-in
 * the person started, the code they pasted and the one allowance read that
 * follows it, whose Gemini weekly limit becomes the account's allowance.
 */

const CLAUDE_PERSONAL = "acct_claude_antigravity";

/** The link the stand-in's sign-in prints, as the program prints Google's page. */
const SIGN_IN_LINK = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=agy";

/** The program's own words around the link, read from a real `agy acp --login`. */
const SIGN_IN_WORDS = `Open this link in a browser to log in with Google:\n\n  ${SIGN_IN_LINK}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`;

/** The code Google's page shows once the person signs in. */
const CODE = "4/0Abc-stand-in-code";

const picture = (name: string) => test.info().outputPath(`${name}.png`);

function seedClaude(userDataDir: string) {
  seedAccountStore(userDataDir, "anthropic-claude", CLAUDE_PERSONAL, {
    recursive: true,
    mode: 0o700,
  });
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: CLAUDE_PERSONAL,
        providerId: "anthropic-claude",
        kind: "subscription_oauth",
        label: "Personal",
        enabled: true,
        createdAt: Date.parse("2026-08-01T00:00:00Z"),
      },
    ],
    {},
    { mode: 0o600 },
  );
}

test("an Antigravity chip shows Google's terms first, and Sign in with Google adds the account", async () => {
  test.setTimeout(2 * 60_000);
  const userDataDir = scratchDir("infinitary-e2e-");
  seedClaude(userDataDir);
  const agy = standInAgy({
    login: { stdout: SIGN_IN_WORDS, readCode: true, exit: 0 },
    // The program's real usage report, its conversation id replaced.
    print: {
      stdout: readFileSync("tests/fixtures/antigravity/usage-report.json", "utf8"),
      exit: 0,
    },
  });
  const launched = await launchSignedInClaude(CLAUDE_PERSONAL, {
    userDataDir,
    prepareHome: agyHome(agy),
    env: {
      // Dummy credentials never reach the provider's allowance endpoint.
      INFINITARY_CLAUDE_USAGE_URL: "http://127.0.0.1:9/usage",
      INFINITARY_CLAUDE_CLI: writeMockClaudeClient(scratchDir("infinitary-claude-stub-")),
    },
  });
  try {
    const { app, page } = launched;
    // The system browser replaced by a recorder: nothing here opens a page.
    await app.evaluate(({ shell }) => {
      const g = globalThis as unknown as { __opened: string[] };
      g.__opened = [];
      shell.openExternal = async (url: string) => {
        g.__opened.push(url);
      };
    });
    const opened = () =>
      app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);
    await expectClaudeConnected(page, CLAUDE_PERSONAL);
    await resizeWindow(app, page, { width: 1280, height: 1000 });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    const list = page.locator("[data-subscriptions-list]");
    const chip = list.locator(`[data-connect-provider="${ANTIGRAVITY_PROVIDER_ID}"]`);
    const warning = list.locator(`[data-sign-in-warning="${ANTIGRAVITY_PROVIDER_ID}"]`);

    await test.step("the chip shows Google's terms, and Not now starts nothing", async () => {
      await expect(chip).toBeVisible({ timeout: 20_000 });
      await expect(chip).not.toHaveAttribute("aria-disabled", "true");
      await pressKey(chip, "Enter");
      await expect(warning).toBeVisible();
      for (const sentence of ANTIGRAVITY_SIGN_IN_WORDS.sentences) {
        await expect(warning).toContainText(sentence);
      }
      await expect(
        warning.getByRole("link", { name: ANTIGRAVITY_SIGN_IN_WORDS.terms }),
      ).toBeVisible();
      await expect(
        warning.getByRole("link", { name: ANTIGRAVITY_SIGN_IN_WORDS.forum }),
      ).toBeVisible();
      await regionShot(list, picture("antigravity-warning"));
      await pressKey(
        warning.getByRole("button", { name: ANTIGRAVITY_SIGN_IN_WORDS.notNow }),
        "Enter",
      );
      await expect(warning).toHaveCount(0);
      expect(agy.log()).toEqual([]);
    });

    await test.step("Sign in with Google runs the program's own sign-in and adds the one account", async () => {
      await pressKey(chip, "Enter");
      const go = warning.getByRole("button", { name: ANTIGRAVITY_SIGN_IN_WORDS.go });
      await focusOn(go);
      await pressKey(go, "Enter");
      // The program opens no browser: the app opens its link, then asks for
      // the code Google's page shows.
      await expect.poll(opened).toEqual([SIGN_IN_LINK]);
      const code = list.getByPlaceholder("paste the code");
      await expect(code).toBeFocused();
      await code.fill(CODE);
      await pressKey(code, "Enter");
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.accounts.list())).filter(
              (account) => account.providerId === "google-antigravity",
            ).length,
          { timeout: 20_000 },
        )
        .toBe(1);
      const accounts = await page.evaluate(() => window.infinitary.accounts.list());
      const account = accounts.find((each) => each.providerId === ANTIGRAVITY_PROVIDER_ID);
      const row = list.locator(`[data-account-row="${account?.id}"]`);
      await expect(row).toBeVisible();
      await expect(list.locator('[data-settings-error="sign-in"]')).toHaveCount(0);
      // The program keeps one login for the computer: a second account cannot be added.
      await expect(chip).toHaveAttribute("aria-disabled", "true");
      // The sign-in the person pressed, the code handed to the program, then
      // the one allowance read the finished sign-in asks for
      // (docs/antigravity-client.md, "The allowance").
      await expect
        .poll(() => agy.log().map((entry) => entry.args?.slice(0, 2) ?? entry))
        .toEqual([["acp", "--login"], { code: CODE }, ["-p", "/usage"]]);
      // The report's Gemini weekly limit, 98% left, is the account's allowance.
      await expect
        .poll(async () => {
          const snapshot = await page.evaluate(() => window.infinitary.quota.snapshot());
          const mine = snapshot?.providers.find((each) => each.accountId === account?.id);
          return mine?.windows.map((window) => [
            window.id,
            Math.round(window.percentRemaining ?? -1),
          ]);
        })
        .toEqual([["seven_day", 98]]);
      await regionShot(list, picture("antigravity-connected"));
    });
  } finally {
    await launched.close();
  }
});
