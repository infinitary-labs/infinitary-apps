import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { ACTIONS } from "@shared/actions";
import { scratchDir } from "../helpers/scratchDirs";
import { waitForFirstmateIdle } from "./crew";
import { THIS_DESKTOP } from "./desktop";
import { launchApp } from "./launch";
import {
  APP_CATALOG_PROMPT_MARKER,
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  mockModelsJson,
} from "./mockProvider";
import { promptInput } from "./prompt";
import { feedLine } from "./rails";
import { boxLoginItems, settingRow } from "./settings";

test("captain clicks and Firstmate catalog changes share persisted settings and trails without cards", async () => {
  const app = await launchApp({
    withMockProvider: true,
    prepareHome: (home) => mkdirSync(join(home, "catalog-projects")),
  });
  try {
    const { page } = app;
    const ask = async (action: string, value: unknown) => {
      const input = promptInput(page);
      await input.fill(APP_CATALOG_PROMPT_MARKER + JSON.stringify({ action, value }));
      await input.press("Enter");
    };
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("before.png") });
    const notifications = settingRow(page, "notifications").getByRole("switch");
    await notifications.click();
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getNotifications()))
      .toBe(false);
    await page.keyboard.press("Escape");
    await expect(feedLine(page, ACTIONS.notifications.done({ enabled: false }))).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("after-captain-click.png") });
    await ask("notifications", { enabled: true });
    await expect(feedLine(page, ACTIONS.notifications.done({ enabled: true }))).toBeVisible();
    await waitForFirstmateIdle(page);
    await ask("window-wash", { strength: 42 });
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.infinitary.settings.getAppearance()).washStrength),
      )
      .toBe(42);
    await waitForFirstmateIdle(page);
    await ask("crew-model-names", { visible: false });
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.infinitary.settings.getAppearance()).showCrewModelNames,
        ),
      )
      .toBe(false);
    await waitForFirstmateIdle(page);
    await ask("projects-folder", { path: "~/catalog-projects" });
    await expect
      .poll(() => page.evaluate(async () => (await window.infinitary.repos.folder()).path))
      .toContain("catalog-projects");
    await waitForFirstmateIdle(page);
    await expect(page.locator("[data-card-layer]")).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(notifications).toHaveAttribute("aria-checked", "true");
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    // Settings offers the wash only on a window with the Mac's material.
    if (THIS_DESKTOP.material) {
      await expect(page.getByRole("slider", { name: "Window wash" })).toHaveValue("42");
    }
    await expect(settingRow(page, "crew-model-names").getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.screenshot({
      path: test.info().outputPath("after-settings.png"),
      animations: "disabled",
    });
    await page.getByRole("tab", { name: "Projects", exact: true }).click();
    await expect(
      settingRow(page, "projects-folder").locator("[data-projects-folder-path]"),
    ).toContainText("catalog-projects");
    await page.screenshot({ path: test.info().outputPath("after-folder.png") });
    await page.keyboard.press("Escape");
    await ask("panel-collapse", { surface: "activity", collapsed: true });
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.infinitary.settings.getLayout()).collapsedPanels.activity,
        ),
      )
      .toBe(true);
    await waitForFirstmateIdle(page);
    await page.screenshot({ path: test.info().outputPath("after-collapse.png") });
    await ask("panel-collapse", { surface: "activity", collapsed: false });
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.infinitary.settings.getLayout()).collapsedPanels.activity,
        ),
      )
      .toBe(false);
    await waitForFirstmateIdle(page);
    const board = await page.evaluate(() => window.infinitary.tasks.board());
    await test.info().attach("persisted-records", {
      body: JSON.stringify(board, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({ path: test.info().outputPath("after-trail.png") });
  } finally {
    await app.close();
  }
});

test("Intelligence requests persist and show the same account and routing controls with one trail", async () => {
  const userDataDir = scratchDir("intelligence-catalog-");
  const accountId = "acct_catalog_test";
  // The account's label as seeded, and the one the rename gives it.
  const firstLabel = "Personal";
  const nextLabel = "Work";
  const dir = join(userDataDir, "accounts", "xai", accountId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ xai: { type: "api_key", key: "disposable-key" } }),
  );
  writeFileSync(
    join(userDataDir, "accounts", "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: accountId,
          providerId: "xai",
          kind: "api_key",
          label: firstLabel,
          enabled: true,
          createdAt: 1,
        },
      ],
      pins: {},
    }),
  );
  const nextModel = "mock-next";
  const app = await launchApp({
    withMockProvider: true,
    userDataDir,
    modelsJson: (port) => {
      const config = JSON.parse(mockModelsJson(port));
      config.providers[MOCK_PROVIDER_ID].models.push({
        id: nextModel,
        name: "Next mock model",
        input: ["text", "image"],
      });
      return JSON.stringify(config);
    },
  });
  try {
    const { page } = app;
    // The seeded account is for Settings, not a real answering session.
    await page.evaluate(
      ({ provider, id }) => window.infinitary.settings.setFirstmateModel({ provider, id }),
      { provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID },
    );
    const ask = async (action: string, value: unknown) => {
      await promptInput(page).fill(APP_CATALOG_PROMPT_MARKER + JSON.stringify({ action, value }));
      await promptInput(page).press("Enter");
    };
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence", exact: true }).click();
    await expect(page.locator(`[data-account-row="${accountId}"]`)).toContainText(firstLabel);
    await page.screenshot({ path: test.info().outputPath("intelligence-before.png") });
    await page.keyboard.press("Escape");
    await ask("account-rename", { accountId, label: nextLabel });
    await expect(
      feedLine(page, ACTIONS["account-rename"].done({ accountId: firstLabel, label: nextLabel })),
    ).toBeVisible();
    await waitForFirstmateIdle(page);
    await ask("account-prefer", { provider: "xai", accountId });
    await expect(
      feedLine(page, ACTIONS["account-prefer"].done({ provider: "xai", accountId: nextLabel })),
    ).toBeVisible();
    await waitForFirstmateIdle(page);
    await ask("model-pins", { pins: [{ provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID }] });
    await expect
      .poll(() => page.evaluate(async () => (await window.infinitary.settings.getRouting()).pins))
      .toEqual([{ provider: MOCK_PROVIDER_ID, id: MOCK_MODEL_ID }]);
    await waitForFirstmateIdle(page);
    await ask("firstmate-model", { model: { provider: MOCK_PROVIDER_ID, id: nextModel } });
    await expect
      .poll(() => page.evaluate(() => window.infinitary.settings.getFirstmateModel()))
      .toEqual({ provider: MOCK_PROVIDER_ID, id: nextModel });
    await waitForFirstmateIdle(page);
    // The next request runs after the model change, proving the seat survives its own change.
    await ask("routing", { enabled: false });
    await expect(feedLine(page, ACTIONS.routing.done({ enabled: false }))).toBeVisible();
    await waitForFirstmateIdle(page);
    const pool = await page.evaluate(() => window.infinitary.models.slots());
    const offering = [...pool.models, ...pool.byName].find((model) => model.provider === "xai");
    if (!offering) throw new Error("Disposable account has no offered model");
    const key = `${offering.provider}/${offering.id}`;
    const on = !offering.slots.includes("high");
    await ask("crew-slots", { key, slot: "high", on });
    await expect(
      feedLine(page, ACTIONS["crew-slots"].done({ key, slot: "high", on })),
    ).toBeVisible();
    await waitForFirstmateIdle(page);
    await ask("crew-slots-reset", { provider: "xai" });
    await expect(
      feedLine(page, ACTIONS["crew-slots-reset"].done({ provider: "xai" })),
    ).toBeVisible();
    await waitForFirstmateIdle(page);
    await ask("account-pause", { accountId, paused: true });
    await expect(
      feedLine(page, ACTIONS["account-pause"].done({ accountId: nextLabel, paused: true })),
    ).toBeVisible();
    await waitForFirstmateIdle(page);
    await ask("decision-model", {
      answerer: { kind: "adapted", offering: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}` },
    });
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.infinitary.models.decisions()).settings.answerer),
      )
      .toEqual({ kind: "adapted", offering: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}` });
    await waitForFirstmateIdle(page);
    await ask("refresh-usage", {});
    await expect(feedLine(page, ACTIONS["refresh-usage"].done({}))).toBeVisible();
    await waitForFirstmateIdle(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence", exact: true }).click();
    await expect(page.locator(`[data-account-row="${accountId}"]`)).toContainText(nextLabel);
    await expect(settingRow(page, "dynamic-routing").getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.screenshot({ path: test.info().outputPath("intelligence-after.png") });
    await page.keyboard.press("Escape");
    await ask("account-disconnect", { accountId });
    await expect(
      feedLine(page, ACTIONS["account-disconnect"].done({ accountId: nextLabel })),
    ).toBeVisible();
    await waitForFirstmateIdle(page);
    await expect.poll(() => page.evaluate(() => window.infinitary.accounts.list())).toEqual([]);
    await expect(page.locator("[data-card-layer]")).toHaveCount(0);
    await test.info().attach("intelligence-record", {
      body: JSON.stringify(await page.evaluate(() => window.infinitary.tasks.board()), null, 2),
      contentType: "application/json",
    });
    await page.screenshot({ path: test.info().outputPath("intelligence-trail.png") });
  } finally {
    await app.close();
  }
});

test("presence requests reach Settings while sharing and purge stay yours and a decision key offers a button", async () => {
  const app = await launchApp({ withMockProvider: true });
  await boxLoginItems(app.app);
  try {
    const { page } = app;
    const ask = async (action: string, value: unknown) => {
      await promptInput(page).fill(APP_CATALOG_PROMPT_MARKER + JSON.stringify({ action, value }));
      await promptInput(page).press("Enter");
      await waitForFirstmateIdle(page);
    };
    await ask("start-at-login", { enabled: true });
    await expect
      .poll(() => page.evaluate(() => window.infinitary.presence.get()))
      .toEqual({ startAtLogin: true, showInDock: true });
    await ask("show-in-dock", { enabled: false });
    await expect
      .poll(() => page.evaluate(() => window.infinitary.presence.get()))
      .toEqual({ startAtLogin: true, showInDock: false });
    await expect(feedLine(page, ACTIONS["start-at-login"].done({ enabled: true }))).toBeVisible();
    await expect(feedLine(page, ACTIONS["show-in-dock"].done({ enabled: false }))).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(settingRow(page, "start-at-login").getByRole("switch")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // Settings offers Show in dock only on a desktop with the Mac's Dock.
    if (THIS_DESKTOP.dock) {
      await expect(settingRow(page, "show-in-dock").getByRole("switch")).toHaveAttribute(
        "aria-checked",
        "false",
      );
    }
    await page.screenshot({
      path: test.info().outputPath("presence-settings.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    const before = await page.evaluate(() => window.infinitary.tasks.board());
    await ask("diagnostics", {});
    await ask("purge", {});
    const after = await page.evaluate(() => window.infinitary.tasks.board());
    expect(after.tasks.filter((task) => task.kind === "operation")).toEqual(
      before.tasks.filter((task) => task.kind === "operation"),
    );
    for (const task of before.tasks)
      expect(after.tasks.some((saved) => saved.id === task.id)).toBe(true);
    await expect(page.locator("[data-card-layer]")).toHaveCount(0);
    await ask("decision-key", {});
    await expect(page.locator("[data-card-layer]")).toHaveCount(1);
    const cards = await page.evaluate(() => window.infinitary.cards.list());
    expect(
      cards.some((card) =>
        card.actions.some(
          (action) => action.effect?.kind === "open" && action.effect.target === "subscriptions",
        ),
      ),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath("decision-key-hand-over.png") });
    await page.getByRole("button", { name: "Open Settings", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Intelligence", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.screenshot({ path: test.info().outputPath("decision-key-settings.png") });
    await test.info().attach("piece3-records", {
      body: JSON.stringify(after, null, 2),
      contentType: "application/json",
    });
  } finally {
    await app.close();
  }
});
