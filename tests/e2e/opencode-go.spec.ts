import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { EMPTY_QUOTA_TEXT } from "../../src/renderer/src/settings/subscriptionsWords";
import * as m from "../../src/shared/i18n/messages.generated";
import { STARTER_SLOTS } from "../../src/shared/modelSlots";
import { catalogEntry, OPENCODE_GO_PROVIDER_ID } from "../../src/shared/providers";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { type LaunchedApp, launchApp } from "./launch";
import { resizeWindow } from "./layout";
import { levelLane, modelPill, openModelsBoard } from "./modelsBoard";
import { heroShot, regionShot } from "./pictures";
import { pressKey, typeInto } from "./windowKeys";

/**
 * OpenCode Go as a built-in subscription (INF-6873 part 1): its chip asks
 * for the key at once, with a line saying where the key is; an
 * OPENCODE_API_KEY on the computer signs nothing in; the account's models
 * start in the levels the plan names; and its allowance is read from
 * OpenCode's usage reading with the account's own key. The reading comes
 * from a local stand-in answering OpenCode's documented shapes
 * (opencode.ai/docs/go, "Usage"); nothing here reaches OpenCode.
 */

/** A key the computer's environment holds, which the stand-in would accept if it were ever sent. */
const ENVIRONMENT_KEY = "go-key-from-the-environment";
const LIVE_KEY = "go-key-pasted";
const NO_PLAN_KEY = "go-key-without-a-plan";
const WRONG_KEY = "go-key-revoked";

const LIVE = "acct_opencode_live";
const NO_PLAN = "acct_opencode_no_plan";
const WRONG = "acct_opencode_wrong";
const SIGNED_OUT = "acct_opencode_signed_out";

type StandIn = { server: Server; url: string; seen: string[] };

/** OpenCode's usage reading: the documented answer, its 403 EntitlementError, else a 401. */
async function standInUsage(): Promise<StandIn> {
  const stand: StandIn = { server: createServer(), url: "", seen: [] };
  stand.server.on("request", (request, response) => {
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /, "");
    stand.seen.push(bearer);
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (bearer === LIVE_KEY || bearer === ENVIRONMENT_KEY) {
      const at = (hours: number) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
      reply(200, {
        usage: {
          rolling: { status: "ok", percent: 38, resetsAt: at(3) },
          weekly: { status: "ok", percent: 20, resetsAt: at(70) },
          monthly: { status: "ok", percent: 9, resetsAt: at(400) },
        },
      });
      return;
    }
    if (bearer === NO_PLAN_KEY) {
      reply(403, {
        type: "error",
        error: { type: "EntitlementError", message: "OpenCode Go subscription required." },
      });
      return;
    }
    reply(401, { type: "error" });
  });
  await new Promise<void>((resolve) => stand.server.listen(0, "127.0.0.1", resolve));
  const { port } = stand.server.address() as AddressInfo;
  stand.url = `http://127.0.0.1:${port}/inference/go/v1/usage`;
  return stand;
}

function seedOpenCodeGo(userDataDir: string, accounts: { id: string; key?: string }[]) {
  for (const account of accounts) {
    seedAccountStore(userDataDir, OPENCODE_GO_PROVIDER_ID, account.id, {
      recursive: true,
      mode: 0o700,
    });
    seedAccountAuth(
      userDataDir,
      OPENCODE_GO_PROVIDER_ID,
      account.id,
      account.key ? { [OPENCODE_GO_PROVIDER_ID]: { type: "api_key", key: account.key } } : {},
      { mode: 0o600 },
    );
  }
  seedAccountRegistry(
    userDataDir,
    accounts.map((account, index) => ({
      id: account.id,
      providerId: OPENCODE_GO_PROVIDER_ID,
      kind: "api_key",
      label: `Go ${index + 1}`,
      enabled: true,
      createdAt: Date.parse("2026-11-20T00:00:00Z") + index,
    })),
    {},
    { mode: 0o600 },
  );
}

async function openIntelligence(app: LaunchedApp) {
  await app.page.getByRole("button", { name: "Settings" }).click();
  await app.page.getByRole("tab", { name: "Intelligence" }).click();
}

function accountRow(app: LaunchedApp, accountId: string) {
  return app.page.locator(`[data-account-row="${accountId}"]`);
}

test.describe("OpenCode Go", () => {
  let app: LaunchedApp | undefined;
  let usage: StandIn | undefined;

  test.afterEach(async () => {
    await app?.close();
    app = undefined;
    const server = usage?.server;
    usage = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("the chip asks for the key at once, and the pasted key, never the computer's, signs in and reads the allowance", async () => {
    test.setTimeout(180_000);
    usage = await standInUsage();
    app = await launchApp({
      env: { INFINITARY_OPENCODE_GO_USAGE_URL: usage.url, OPENCODE_API_KEY: ENVIRONMENT_KEY },
    });
    const { page } = app;
    await resizeWindow(app.app, page, { width: 1180, height: 760 });
    const gate = page.locator("[data-first-run-gate]");
    await expect(gate).toHaveAttribute("data-first-run-gate", "open", { timeout: 20_000 });
    await pressKey(page.locator('[data-gate-choice="here"]'), "Enter");

    const chip = gate.locator(`[data-connect-provider="${OPENCODE_GO_PROVIDER_ID}"]`);
    await expect(chip).toHaveText(catalogEntry(OPENCODE_GO_PROVIDER_ID)?.name as string);
    await pressKey(chip, "Enter");

    // One way in: no browser-or-key question, the key field and where the key is.
    const keyField = gate.locator('input[type="password"]');
    await expect(keyField).toBeFocused();
    await expect(gate.locator("[data-connect-method]")).toHaveCount(0);
    await expect(gate.locator("[data-connect-key-where]")).toHaveText(
      m.accountsConnectKeyWhere({ site: "OpenCode Console", provider: "OpenCode Go" }),
    );
    await regionShot(
      keyField.locator("xpath=ancestor::div[contains(@class,'fm-connect-aside')][1]"),
      test.info().outputPath("opencode-go-key-step.png"),
    );
    await typeInto(keyField, LIVE_KEY);
    await pressKey(keyField, "Enter");
    await expect(gate).toHaveCount(0, { timeout: 30_000 });

    await openIntelligence(app);
    const row = page.locator("[data-account-row]").filter({ hasText: "OpenCode Go" });
    for (const label of ["session", "weekly", "monthly"]) {
      await expect(row.getByText(label, { exact: true })).toBeVisible({ timeout: 30_000 });
    }
    await regionShot(row, test.info().outputPath("opencode-go-account-row.png"));
    await heroShot(app.app, page, { region: row, name: "opencode-go-subscription" });
    expect(new Set(usage.seen)).toEqual(new Set([LIVE_KEY]));

    // The starter levels: K3 high, Grok 4.7 medium, GPT-6 Luna and Claude
    // Haiku 5.5 low, and no OpenCode Go model in premium.
    const models = await openModelsBoard(page);
    const starters = Object.entries(STARTER_SLOTS[OPENCODE_GO_PROVIDER_ID] ?? {});
    expect(starters.length).toBeGreaterThan(0);
    for (const [model, slots] of starters) {
      for (const slot of slots) {
        await expect(modelPill(models, slot, `${OPENCODE_GO_PROVIDER_ID}/${model}`)).toBeVisible();
      }
    }
    await expect(
      levelLane(models, "premium").locator('[data-model-row^="opencode-go/"]'),
    ).toHaveCount(0);
    for (const level of ["premium", "high", "medium", "low"] as const) {
      await regionShot(
        levelLane(models, level),
        test.info().outputPath(`opencode-go-models-${level}.png`),
      );
    }
  });

  test("a key without a plan, a refused key and a row with no key each say so, and the computer's key answers none", async () => {
    test.setTimeout(180_000);
    usage = await standInUsage();
    const userDataDir = scratchDir("infinitary-e2e-");
    seedOpenCodeGo(userDataDir, [
      { id: LIVE, key: LIVE_KEY },
      { id: NO_PLAN, key: NO_PLAN_KEY },
      { id: WRONG, key: WRONG_KEY },
      { id: SIGNED_OUT },
    ]);
    app = await launchApp({
      userDataDir,
      env: { INFINITARY_OPENCODE_GO_USAGE_URL: usage.url, OPENCODE_API_KEY: ENVIRONMENT_KEY },
    });
    await resizeWindow(app.app, app.page, { width: 1180, height: 900 });
    await openIntelligence(app);

    const live = accountRow(app, LIVE);
    await expect(live.getByText("session", { exact: true })).toBeVisible({ timeout: 30_000 });

    const noPlan = accountRow(app, NO_PLAN);
    await expect(noPlan.getByText(m.accountsQuotaOpenCodeGoNoPlan())).toBeVisible({
      timeout: 30_000,
    });
    await expect(noPlan.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toHaveCount(0);
    await regionShot(noPlan, test.info().outputPath("opencode-go-no-plan.png"));

    const wrong = accountRow(app, WRONG);
    await expect(wrong.getByText(EMPTY_QUOTA_TEXT.signInAgain)).toBeVisible({ timeout: 30_000 });
    await regionShot(wrong, test.info().outputPath("opencode-go-refused-key.png"));

    // The row whose store holds no key stays signed out: the environment's
    // key, which the stand-in would accept, is never read for it.
    const signedOut = accountRow(app, SIGNED_OUT);
    await expect(signedOut.getByRole("button", { name: "Sign in" })).toBeVisible({
      timeout: 30_000,
    });
    await expect(signedOut.getByText("session", { exact: true })).toHaveCount(0);
    await regionShot(signedOut, test.info().outputPath("opencode-go-signed-out.png"));
    expect(usage.seen).not.toContain(ENVIRONMENT_KEY);
    expect(new Set(usage.seen)).toEqual(new Set([LIVE_KEY, NO_PLAN_KEY, WRONG_KEY]));
  });
});
