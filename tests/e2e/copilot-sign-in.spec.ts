import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { FORGE_SECTION_WORDS } from "../../src/shared/forges";
import { CODE_STEP_WORDS, COPILOT_PROVIDER_ID } from "../../src/shared/providers";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchedApp, launchApp } from "./launch";
import { minimumWindowSize, resizeWindow } from "./layout";
import { windowShot } from "./pictures";
import { pressKey, typeInto } from "./windowKeys";

/**
 * The Copilot sign-in, step by step (INF-842, the captain's answers on
 * INF-838): the chip goes straight to the code, github.com is assumed with a
 * GitHub Enterprise row, one press copies the code and opens GitHub, Cancel
 * ends the wait quietly, an expired code offers a new one, and signing in
 * again asks nothing the account already knows.
 */

/** The code GitHub's stand-in hands out, and the token it grants once approved. */
const USER_CODE = "WDJB-MJHT";
const ENTERPRISE = "acme.ghe.com";
const GITHUB = "GitHub";

type StandIn = { approve: boolean; expiresIn: number; asked: string[]; opened: string[] };

/**
 * GitHub's device flow, answered in the app's main process where Pi asks
 * it, and the system browser replaced by a recorder: nothing here reaches
 * github.com or opens a page.
 */
async function standInGitHub(launched: LaunchedApp) {
  await launched.app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { fetch: typeof fetch; __copilot?: StandIn };
    const real = g.fetch;
    const state: StandIn = { approve: false, expiresIn: 900, asked: [], opened: [] };
    g.__copilot = state;
    shell.openExternal = async (url: string) => {
      state.opened.push(url);
    };
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    g.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/login/device/code") {
        state.asked.push(url.host);
        return json({
          device_code: "device-stand-in",
          user_code: "WDJB-MJHT",
          verification_uri: `https://${url.host}/login/device`,
          expires_in: state.expiresIn,
          interval: 1,
        });
      }
      if (url.pathname === "/login/oauth/access_token")
        return json(
          state.approve ? { access_token: "gho_stand_in" } : { error: "authorization_pending" },
        );
      if (url.pathname === "/copilot_internal/v2/token")
        return json({
          token: "tid=stand-in;exp=4000000000;proxy-ep=proxy.individual.githubcopilot.com",
          expires_at: 4000000000,
        });
      if (url.pathname.endsWith("/models")) return json({ data: [] });
      if (url.hostname === "127.0.0.1") return real(input, init);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
  });
}

function standIn(launched: LaunchedApp): Promise<StandIn> {
  return launched.app.evaluate(() => (globalThis as unknown as { __copilot: StandIn }).__copilot);
}

async function setStandIn(launched: LaunchedApp, change: Partial<StandIn>) {
  await launched.app.evaluate((_electron, next) => {
    Object.assign((globalThis as unknown as { __copilot: StandIn }).__copilot, next);
  }, change);
}

/** A private clipboard stand-in: no test reads or changes the person's clipboard. */
async function standInClipboard(page: Page) {
  await page.evaluate(() => {
    const writes: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = writes;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    });
  });
}

const copied = (page: Page) =>
  page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

test("the first screen's Copilot chip goes straight to the code, by keys, through every way it can end", async () => {
  test.setTimeout(180_000);
  const launched = await launchApp({});
  try {
    const { app, page } = launched;
    await standInGitHub(launched);
    await standInClipboard(page);
    const gate = page.locator("[data-first-run-gate]");
    await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
    const chip = gate.locator(`[data-connect-provider="${COPILOT_PROVIDER_ID}"]`);
    const step = gate.locator("[data-code-step]");
    const primary = step.getByRole("button", { name: CODE_STEP_WORDS.copyAndOpen(GITHUB) });

    // The chip asks no browser-or-key question: the code is the first thing shown.
    await pressKey(chip, "Enter");
    await expect(step.locator("[data-code-step-code]")).toHaveText(USER_CODE);
    await expect(gate.locator("[data-connect-method]")).toHaveCount(0);
    await expect(step.locator("[data-code-step-waiting]")).toContainText(
      CODE_STEP_WORDS.waiting(GITHUB),
    );
    await expect(primary).toBeFocused();
    expect((await standIn(launched)).asked).toEqual(["github.com"]);

    // The whole step fits the smallest window without scrolling.
    await resizeWindow(app, page, await minimumWindowSize(app));
    const fits = await step.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    });
    expect(fits).toBe(true);
    await windowShot(page, test.info().outputPath("code-step-smallest-window.png"));
    await resizeWindow(app, page, { width: 1180, height: 760 });

    // One press copies the code and opens GitHub's page, and says it copied.
    await pressKey(primary, "Enter");
    await expect(step.getByRole("status")).toHaveText(FORGE_SECTION_WORDS.copied);
    expect(await copied(page)).toEqual([USER_CODE]);
    expect((await standIn(launched)).opened).toEqual(["https://github.com/login/device"]);

    // GitHub Enterprise: a bad address is one sentence beside the field,
    // a good one gets a code from that address.
    await pressKey(step.getByRole("button", { name: CODE_STEP_WORDS.useEnterprise }), "Enter");
    const field = step.getByLabel(CODE_STEP_WORDS.enterpriseLabel);
    await typeInto(field, "not a host!");
    await pressKey(field, "Enter");
    await expect(step.getByRole("alert")).toHaveText(CODE_STEP_WORDS.badEnterprise);
    await field.fill(ENTERPRISE);
    await pressKey(field, "Enter");
    await expect
      .poll(async () => (await standIn(launched)).asked)
      .toEqual(["github.com", ENTERPRISE]);
    await expect(step.locator("[data-code-step-code]")).toHaveText(USER_CODE);
    await expect(step.locator("[data-code-step-waiting]")).toContainText(
      CODE_STEP_WORDS.waiting(ENTERPRISE),
    );

    // Cancel ends the wait at once: the chips are back, with no error and no account.
    await pressKey(step.getByRole("button", { name: "Cancel", exact: true }), "Enter");
    await expect(step).toHaveCount(0);
    await expect(chip).toBeVisible();
    await expect(gate.getByRole("alert")).toHaveCount(0);
    expect(await page.evaluate(() => window.infinitary.accounts.list())).toEqual([]);

    // A code GitHub lets expire says so and offers a new one.
    await setStandIn(launched, { expiresIn: 2 });
    await pressKey(chip, "Enter");
    const expired = gate.locator("[data-code-expired]");
    await expect(expired).toContainText(CODE_STEP_WORDS.expired, { timeout: 20_000 });
    await setStandIn(launched, { expiresIn: 900 });
    await pressKey(expired.getByRole("button", { name: CODE_STEP_WORDS.newCode }), "Enter");
    await expect(step.locator("[data-code-step-code]")).toHaveText(USER_CODE);

    // Approved on GitHub: the account is added and the step closes.
    await setStandIn(launched, { approve: true });
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.infinitary.accounts.list())).map(
            (account) => account.providerId,
          ),
        { timeout: 20_000 },
      )
      .toEqual([COPILOT_PROVIDER_ID]);
    await expect(step).toHaveCount(0);
  } finally {
    await launched.close();
  }
});

test("signing in again to a GitHub Enterprise Copilot account asks nothing it already knows", async () => {
  test.setTimeout(120_000);
  const userDataDir = scratchDir("infinitary-copilot-");
  const accountId = "acct_copilot_enterprise";
  const authPath = join(userDataDir, "accounts", COPILOT_PROVIDER_ID, accountId, "auth.json");
  mkdirSync(join(authPath, ".."), { recursive: true, mode: 0o700 });
  // A lapsed sign-in at a GitHub Enterprise address, as Pi keeps one.
  writeFileSync(
    authPath,
    JSON.stringify({
      [COPILOT_PROVIDER_ID]: {
        type: "oauth",
        refresh: "gho_lapsed",
        access: "tid=lapsed;exp=1;proxy-ep=proxy.individual.githubcopilot.com",
        expires: 1,
        enterpriseUrl: ENTERPRISE,
      },
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(userDataDir, "accounts", "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: accountId,
          providerId: COPILOT_PROVIDER_ID,
          kind: "subscription_oauth",
          label: "Work",
          enabled: true,
          createdAt: 1,
        },
      ],
      pins: {},
    }),
    { mode: 0o600 },
  );
  const launched = await launchApp({ userDataDir });
  try {
    const { page } = launched;
    await standInGitHub(launched);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence" }).click();
    const list = page.locator("[data-subscriptions-list]");
    const row = list.locator(`[data-account-row="${accountId}"]`);
    await pressKey(row.getByRole("button", { name: "Sign in", exact: true }), "Enter");

    // Straight to the code at the account's own address: no question, no field.
    const step = list.locator("[data-code-step]");
    await expect(step.locator("[data-code-step-code]")).toHaveText(USER_CODE);
    await expect(step.locator("[data-code-step-waiting]")).toContainText(
      CODE_STEP_WORDS.waiting(ENTERPRISE),
    );
    await expect(list.locator("[data-enterprise-step]")).toHaveCount(0);
    await expect(list.locator("[data-connect-aside] input")).toHaveCount(0);
    expect((await standIn(launched)).asked).toEqual([ENTERPRISE]);

    await setStandIn(launched, { approve: true });
    await expect(step).toHaveCount(0, { timeout: 20_000 });
    await expect(list.locator('[data-settings-error="sign-in"]')).toHaveCount(0);
    const stored = JSON.parse(readFileSync(authPath, "utf8"))[COPILOT_PROVIDER_ID];
    expect(stored).toMatchObject({ refresh: "gho_stand_in", enterpriseUrl: ENTERPRISE });
  } finally {
    await launched.close();
  }
});
