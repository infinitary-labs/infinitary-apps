import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DECISION_MODEL_CATALOG } from "../../src/shared/decisions";
import { offeringKey, STARTER_SLOTS } from "../../src/shared/modelSlots";
import { scratchDir } from "../helpers/scratchDirs";
import { seedAccountAuth, seedAccountRegistry, seedAccountStore } from "./accountFixtures";
import { THIS_DESKTOP } from "./desktop";
import { launchApp } from "./launch";
import { alwaysUseSwitch, modelsSection, openModelPanel, setLevelInPanel } from "./modelsBoard";
import {
  assertReadableSettingsFeedback,
  boxLoginItems,
  REFUSAL,
  refuseNext,
  releaseSave,
  settingRow,
  settingsFeedback,
} from "./settings";
import { MAC_ONLY_TAG } from "./tags";
import { setThemeViaSettings } from "./theme";

const KEY = "disposable-decision-key";

async function assertRefusal(feedback: Locator, reason = REFUSAL) {
  await assertReadableSettingsFeedback(feedback, reason);
  await expect(feedback).not.toBeEmpty();
  await expect(feedback).toBeInViewport();
}

function saveEvidence(name: string, state: unknown) {
  writeFileSync(test.info().outputPath(`${name}.json`), JSON.stringify(state, null, 2));
}

for (const theme of ["dark"] as const) {
  test(`notification and presence refusals restore saved values and remain retryable (${theme})`, {
    tag: MAC_ONLY_TAG,
  }, async () => {
    const launched = await launchApp();
    try {
      const { app, page } = launched;
      const unhandled: string[] = [];
      page.on("pageerror", (error) => unhandled.push(error.message));
      await boxLoginItems(app);
      await setThemeViaSettings(page, theme, { close: false });
      const notify = settingRow(page, "notifications");
      const login = settingRow(page, "start-at-login");
      const dock = settingRow(page, "show-in-dock");
      await expect(notify.getByRole("switch")).toBeChecked();
      await expect(login.getByRole("switch")).not.toBeChecked();
      // Show in dock is the Mac's: Settings offers it only beside a Dock.
      if (THIS_DESKTOP.dock) await expect(dock.getByRole("switch")).toBeChecked();
      const before = await page.evaluate(async () => ({
        notifications: await window.infinitary.settings.getNotifications(),
        presence: await window.infinitary.presence.get(),
      }));

      await refuseNext(app, "inf:settings:notifications:set", false, REFUSAL, true);
      await notify.getByRole("switch").click();
      await expect(notify.getByRole("switch")).toBeDisabled();
      await releaseSave(app);
      await assertRefusal(notify.getByRole("alert"), REFUSAL);
      await expect(notify.getByRole("switch")).toBeChecked();
      expect(await page.evaluate(() => window.infinitary.settings.getNotifications())).toBe(
        before.notifications,
      );
      await page.screenshot({ path: test.info().outputPath(`notifications-${theme}.png`) });
      const notificationsFailure = await notify.getByRole("alert").textContent();
      await refuseNext(app, "inf:settings:notifications:set");
      await refuseNext(app, "inf:settings:notifications:get");
      await notify.getByRole("switch").click();
      await assertRefusal(notify.getByRole("alert"));
      await expect(notify.getByRole("alert")).not.toHaveText(notificationsFailure ?? "");
      await expect(notify.getByRole("switch")).toBeChecked();
      const recoveryFailure = await notify.getByRole("alert").textContent();
      await page.screenshot({ path: test.info().outputPath(`recovery-${theme}.png`) });
      await notify.getByRole("switch").click();
      await expect(notify.getByRole("switch")).not.toBeChecked();
      await expect(notify.getByRole("alert")).toHaveCount(0);
      expect(await page.evaluate(() => window.infinitary.settings.getNotifications())).toBe(false);

      await refuseNext(app, "inf:presence:set");
      await login.getByRole("switch").click();
      await assertRefusal(login.getByRole("alert"), REFUSAL);
      await expect(login.getByRole("switch")).not.toBeChecked();
      const presenceFailure = await login.getByRole("alert").textContent();
      await page.screenshot({ path: test.info().outputPath(`login-${theme}.png`) });
      await login.getByRole("switch").click();
      await expect(login.getByRole("switch")).toBeChecked();
      await expect(login.getByRole("alert")).toHaveCount(0);

      // The dock setting persists before its native operation returns. A
      // refusal must re-read that partial success, not blindly undo the click.
      if (THIS_DESKTOP.dock) {
        await refuseNext(app, "inf:presence:set", true);
        await dock.getByRole("switch").click();
        await assertRefusal(dock.getByRole("alert"), REFUSAL);
        await expect(dock.getByRole("switch")).not.toBeChecked();
        expect(await page.evaluate(() => window.infinitary.presence.get())).toEqual({
          startAtLogin: true,
          showInDock: false,
        });
        await page.screenshot({ path: test.info().outputPath(`dock-partial-${theme}.png`) });
        await dock.getByRole("switch").click();
        await expect(dock.getByRole("switch")).toBeChecked();
        await expect(dock.getByRole("alert")).toHaveCount(0);
      }

      // Reopening reads the saved values, rather than the previous component's state.
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(notify.getByRole("switch")).not.toBeChecked();
      await expect(login.getByRole("switch")).toBeChecked();
      if (THIS_DESKTOP.dock) await expect(dock.getByRole("switch")).toBeChecked();
      saveEvidence(`general-${theme}`, {
        before,
        notificationsFailure,
        recoveryFailure,
        presenceFailure,
        after: await page.evaluate(async () => ({
          notifications: await window.infinitary.settings.getNotifications(),
          presence: await window.infinitary.presence.get(),
        })),
        unhandled,
      });
      expect(unhandled).toEqual([]);
    } finally {
      await launched.close();
    }
  });
}

function seedIntelligence() {
  const starterMap = STARTER_SLOTS["openai-codex"];
  if (!starterMap) throw new Error("The Codex starter map is missing");
  const userDataDir = scratchDir("infinitary-settings-saves-");
  const fixtureDir = scratchDir("infinitary-save-quota-");
  const accountId = "acct_save_feedback";

  seedAccountStore(userDataDir, "openai-codex", accountId, { recursive: true });
  seedAccountAuth(
    userDataDir,
    "openai-codex",
    accountId,
    {
      "openai-codex": {
        type: "oauth",
        access: "fake-access",
        refresh: "fake-refresh",
        expires: Date.now() + 86400000,
      },
    },
    {},
  );
  seedAccountRegistry(
    userDataDir,
    [
      {
        id: accountId,
        providerId: "openai-codex",
        label: "Personal",
        kind: "subscription_oauth",
        enabled: true,
        createdAt: 1,
      },
    ],
    {},
    {},
  );
  writeFileSync(
    join(fixtureDir, "snapshot.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      fetchedAt: Date.now(),
      providers: [
        {
          provider: "codex",
          label: "Codex",
          accountId,
          accountLabel: "Personal",
          status: "ok",
          stale: false,
          windows: [],
        },
      ],
    }),
  );
  writeFileSync(
    join(fixtureDir, "models.json"),
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      models: Object.keys(starterMap).map((id) => ({
        provider: "codex",
        id,
        label: id,
      })),
    }),
  );
  return { userDataDir, fixtureDir };
}

for (const theme of ["dark"] as const) {
  test(`routing, slot and decision saves explain refusals without selecting an unsaved key (${theme})`, async () => {
    const { userDataDir, fixtureDir } = seedIntelligence();
    const launched = await launchApp({
      userDataDir,
      env: { INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir },
    });
    try {
      const { app, page } = launched;
      const unhandled: string[] = [];
      page.on("pageerror", (error) => unhandled.push(error.message));
      await setThemeViaSettings(page, theme, { close: false });
      await page.getByRole("tab", { name: "Intelligence" }).click();
      const routing = settingRow(page, "dynamic-routing");
      const models = modelsSection(page);
      await expect(models).toBeVisible();
      const before = await page.evaluate(async () => ({
        routing: await window.infinitary.settings.getRouting(),
        slots: await window.infinitary.models.slots(),
        decisions: await window.infinitary.models.decisions(),
      }));
      const routingSwitch = routing.getByRole("switch");
      const originalRouting = before.routing.dynamicRouting;
      await refuseNext(app, "inf:settings:routing:set", false, REFUSAL, true);
      await routingSwitch.click();
      await expect(routingSwitch).toBeDisabled();
      await expect(models.getByRole("button", { name: /^Models/ })).toBeDisabled();
      await releaseSave(app);
      await assertRefusal(routing.getByRole("alert"), REFUSAL);
      await expect(routingSwitch).toBeChecked({ checked: originalRouting });
      await page.screenshot({ path: test.info().outputPath(`routing-${theme}.png`) });
      await routingSwitch.click();
      await expect(routingSwitch).toBeChecked({ checked: !originalRouting });
      await expect(routing.getByRole("alert")).toHaveCount(0);
      expect(
        (await page.evaluate(() => window.infinitary.settings.getRouting())).dynamicRouting,
      ).toBe(!originalRouting);

      const selected = before.slots.models.find((model) => model.slots.includes("low"));
      if (!selected) throw new Error("The starter pool has no low-slot model");
      const key = offeringKey(selected);
      const low = models.locator('[data-slot-group="low"]');
      const high = models.locator('[data-slot-group="high"]');
      const row = low.locator(`[data-model-row="${key}"]`);
      await expect(row).toBeVisible();
      const panel = await openModelPanel(page, low, selected.label);
      const alwaysUse = alwaysUseSwitch(panel, selected.label);
      await refuseNext(app, "inf:settings:routing:set", false, "");
      await alwaysUse.click();
      await assertRefusal(routing.getByRole("alert"), "");
      expect((await page.evaluate(() => window.infinitary.settings.getRouting())).pins).toEqual(
        before.routing.pins,
      );
      await alwaysUse.click();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.settings.getRouting())).pins.length,
        )
        .toBe(before.routing.pins.length + 1);
      await expect(routing.getByRole("alert")).toHaveCount(0);

      const slotFeedback = settingsFeedback(page, "model-slots");
      await refuseNext(app, "inf:models:slots:set");
      await setLevelInPanel(panel, selected.label, "high", true);
      await assertRefusal(slotFeedback, REFUSAL);
      await expect(high.locator(`[data-model-row="${key}"]`)).toHaveCount(0);
      expect(
        (await page.evaluate(() => window.infinitary.models.slots())).models.find(
          (model) => offeringKey(model) === key,
        )?.slots,
      ).toEqual(selected.slots);
      await slotFeedback.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`slots-${theme}.png`) });
      await setLevelInPanel(panel, selected.label, "high", true);
      await expect(high.locator(`[data-model-row="${key}"]`)).toBeVisible();
      await expect(slotFeedback).toHaveCount(0);

      // Both reset entry points have their own confirmation but share recovery.
      for (const providerOnly of [false, true]) {
        await refuseNext(app, "inf:models:slots:reset");
        if (providerOnly) {
          await page
            .locator("[data-account-row]")
            .getByRole("button", { name: /actions$/ })
            .click();
          await page.getByRole("menuitem", { name: "Reset model slots", exact: true }).click();
        } else {
          await models
            .getByRole("button", { name: "Reset to starting levels", exact: true })
            .click();
        }
        await page.getByRole("button", { name: "Confirm reset", exact: true }).click();
        await assertRefusal(slotFeedback, REFUSAL);
        await expect(high.locator(`[data-model-row="${key}"]`)).toBeVisible();
      }
      await models.getByRole("button", { name: "Reset to starting levels", exact: true }).click();
      await page.getByRole("button", { name: "Confirm reset", exact: true }).click();
      await expect(high.locator(`[data-model-row="${key}"]`)).toHaveCount(0);
      await expect(slotFeedback).toHaveCount(0);

      const decisionFeedback = settingsFeedback(page, "decisions");
      const decisionMenu = page.getByRole("button", {
        name: "Decision model actions",
        exact: true,
      });
      const chooseSpecific = async () => {
        await decisionMenu.click();
        await page.getByRole("menuitem", { name: "Use a specific model", exact: true }).click();
        await page
          .getByRole("button", { name: `Answer decisions with ${selected.label}`, exact: true })
          .click();
      };
      await refuseNext(app, "inf:settings:decisions:set");
      await chooseSpecific();
      await assertRefusal(decisionFeedback, REFUSAL);
      expect((await page.evaluate(() => window.infinitary.models.decisions())).settings).toEqual(
        before.decisions.settings,
      );
      await chooseSpecific();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.models.decisions())).settings.answerer,
        )
        .toEqual({ kind: "adapted", offering: key });
      await expect(decisionFeedback).toHaveCount(0);

      const native = DECISION_MODEL_CATALOG[0];
      const turnOn = async () => {
        await decisionMenu.click();
        await page
          .getByRole("menuitem", { name: `Use ${native.name} (${native.vendor})`, exact: true })
          .click();
        await page.getByLabel(`${native.name} key`, { exact: true }).fill(KEY);
        await page.getByRole("button", { name: "Turn on", exact: true }).click();
      };
      await refuseNext(app, "inf:decisions:key:set");
      await turnOn();
      await assertRefusal(decisionFeedback, REFUSAL);
      let view = await page.evaluate(() => window.infinitary.models.decisions());
      expect(view.settings.answerer).toEqual({ kind: "adapted", offering: key });
      expect(view.natives.find((row) => row.id === native.id)?.keyStored).toBe(false);
      await expect(page.getByLabel(`${native.name} key`, { exact: true })).toHaveCount(0);
      await decisionFeedback.scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath(`decision-key-${theme}.png`) });
      await refuseNext(app, "inf:settings:decisions:set");
      await turnOn();
      await assertRefusal(decisionFeedback, REFUSAL);
      view = await page.evaluate(() => window.infinitary.models.decisions());
      expect(view.settings.answerer).toEqual({ kind: "adapted", offering: key });
      expect(view.natives.find((row) => row.id === native.id)?.keyStored).toBe(true);
      await decisionMenu.click();
      await page
        .getByRole("menuitem", { name: `Use ${native.name} (${native.vendor})`, exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.models.decisions())).settings.answerer,
        )
        .toEqual({ kind: "native", id: native.id });
      await expect(decisionFeedback).toHaveCount(0);

      await refuseNext(app, "inf:decisions:key:remove");
      await decisionMenu.click();
      await page.getByRole("menuitem", { name: `Remove ${native.name}`, exact: true }).click();
      await assertRefusal(decisionFeedback, REFUSAL);
      view = await page.evaluate(() => window.infinitary.models.decisions());
      expect(view.natives.find((row) => row.id === native.id)?.keyStored).toBe(true);
      await decisionMenu.click();
      await page.getByRole("menuitem", { name: `Remove ${native.name}`, exact: true }).click();
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.infinitary.models.decisions())).natives.find(
              (row) => row.id === native.id,
            )?.keyStored,
        )
        .toBe(false);
      await expect(decisionFeedback).toHaveCount(0);
      const after = await page.evaluate(async () => ({
        routing: await window.infinitary.settings.getRouting(),
        slots: await window.infinitary.models.slots(),
        decisions: await window.infinitary.models.decisions(),
      }));
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("tab", { name: "Intelligence" }).click();
      await expect(routingSwitch).toBeChecked({ checked: !originalRouting });
      await expect(row).toBeVisible();
      saveEvidence(`intelligence-${theme}`, { before, after, unhandled });
      expect(unhandled).toEqual([]);
    } finally {
      await launched.close();
    }
  });
}

/** Every look choice a person can make, as the core saved it. */
function savedLook(page: Page) {
  return page.evaluate(() => window.infinitary.settings.getAppearance());
}

test("appearance refusals show the saved look again and say why beside the choice", {
  tag: MAC_ONLY_TAG,
}, async () => {
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    const unhandled: string[] = [];
    page.on("pageerror", (error) => unhandled.push(error.message));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    const theme = settingRow(page, "theme");
    const light = theme.getByRole("radio", { name: "Light", exact: true });
    const dark = theme.getByRole("radio", { name: "Dark", exact: true });
    const bodyTheme = () => page.evaluate(() => document.body.dataset.theme);

    // The choice shows at once; refused, the window takes the saved theme again.
    await refuseNext(app, "inf:settings:appearance:set", false, REFUSAL, true);
    await light.check();
    await expect.poll(bodyTheme).toBe("light");
    await releaseSave(app);
    await assertRefusal(theme.getByRole("alert"), REFUSAL);
    await expect(dark).toBeChecked();
    await expect.poll(bodyTheme).toBe("dark");
    expect((await savedLook(page)).theme).toBe("dark");
    await light.check();
    await expect(theme.getByRole("alert")).toHaveCount(0);
    await expect.poll(async () => (await savedLook(page)).theme).toBe("light");

    // The window wash is the Mac's: Settings offers it only beside the
    // Mac's window material.
    const wash = settingRow(page, "window-wash");
    const slider = wash.getByRole("slider", { name: "Window wash" });
    const savedWash = (await savedLook(page)).washStrength ?? 0;
    if (THIS_DESKTOP.material) {
      await refuseNext(app, "inf:settings:appearance:set");
      await slider.fill(String(savedWash + 30));
      await assertRefusal(wash.getByRole("alert"), REFUSAL);
      await expect(slider).toHaveValue(String(savedWash));
      // The refused wash says nothing about the theme, which stays as saved.
      await expect(theme.getByRole("alert")).toHaveCount(0);
      expect(await savedLook(page)).toMatchObject({ theme: "light", washStrength: savedWash });
    }

    const size = settingRow(page, "size");
    const savedSize = (await savedLook(page)).size;
    await refuseNext(app, "inf:settings:appearance:set");
    // The size waits for the core's answer: the window zooms to what is saved.
    await size.getByRole("radio", { name: "110%", exact: true }).click();
    await assertRefusal(size.getByRole("alert"), REFUSAL);
    await expect(size.getByRole("radio", { name: "100%", exact: true })).toBeChecked();
    await expect(wash.getByRole("alert")).toHaveCount(0);
    expect((await savedLook(page)).size).toBe(savedSize);

    // The unit is a look choice too, told where it is chosen.
    await page.getByRole("tab", { name: "Usage", exact: true }).click();
    const unit = page.getByRole("radiogroup", { name: "Show usage as", exact: true });
    await refuseNext(app, "inf:settings:appearance:set");
    await unit.getByRole("radio", { name: "Estimated $", exact: true }).click();
    await assertRefusal(settingsFeedback(page, "usage-unit"), REFUSAL);
    await expect(unit.getByRole("radio", { name: "Tokens", exact: true })).toBeChecked();
    await unit.getByRole("radio", { name: "Estimated $", exact: true }).check();
    await expect(settingsFeedback(page, "usage-unit")).toHaveCount(0);
    await expect.poll(async () => (await savedLook(page)).usageUnit).toBe("usd");

    // Reopening reads what is saved.
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Appearance", exact: true }).click();
    await expect(light).toBeChecked();
    if (THIS_DESKTOP.material) await expect(slider).toHaveValue(String(savedWash));
    await expect(page.locator('[data-setting] [role="alert"]')).toHaveCount(0);
    expect(unhandled).toEqual([]);
  } finally {
    await launched.close();
  }
});

test("panels and sharing refusals keep the saved switch and say why", async () => {
  const launched = await launchApp();
  try {
    const { app, page } = launched;
    const unhandled: string[] = [];
    page.on("pageerror", (error) => unhandled.push(error.message));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const panels = settingRow(page, "your-panels");
    const panelsSwitch = panels.getByRole("switch");
    const savedPanels = () =>
      page.evaluate(async () => (await window.infinitary.settings.getPreferences()).panels);
    await expect(panelsSwitch).toBeChecked();
    await refuseNext(app, "inf:settings:panels:set", false, REFUSAL, true);
    await panelsSwitch.click();
    await expect(panelsSwitch).toBeDisabled();
    await releaseSave(app);
    await assertRefusal(panels.getByRole("alert"), REFUSAL);
    await expect(panelsSwitch).toBeChecked();
    expect(await savedPanels()).toEqual({ enabled: true, offReason: null });
    await panelsSwitch.click();
    await expect(panelsSwitch).not.toBeChecked();
    await expect(panels.getByRole("alert")).toHaveCount(0);
    expect(await savedPanels()).toEqual({ enabled: false, offReason: "captain" });

    const diagnostics = settingRow(page, "diagnostics");
    const diagnosticsSwitch = diagnostics.getByRole("switch");
    const savedDiagnostics = () =>
      page.evaluate(
        async () => (await window.infinitary.settings.getSharing()).diagnostics.enabled,
      );
    const before = await savedDiagnostics();
    await expect(diagnosticsSwitch).toBeChecked({ checked: before });
    await refuseNext(app, "inf:settings:sharing:set");
    await diagnosticsSwitch.click();
    await assertRefusal(diagnostics.getByRole("alert"), REFUSAL);
    await expect(diagnosticsSwitch).toBeChecked({ checked: before });
    expect(await savedDiagnostics()).toBe(before);
    await diagnosticsSwitch.click();
    await expect(diagnosticsSwitch).toBeChecked({ checked: !before });
    await expect(diagnostics.getByRole("alert")).toHaveCount(0);
    expect(await savedDiagnostics()).toBe(!before);

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(panelsSwitch).not.toBeChecked();
    await expect(diagnosticsSwitch).toBeChecked({ checked: !before });
    expect(unhandled).toEqual([]);
  } finally {
    await launched.close();
  }
});

test("Firstmate model and account edit refusals keep what is saved and say why", async () => {
  const { userDataDir, fixtureDir } = seedIntelligence();
  const launched = await launchApp({
    userDataDir,
    env: { INFINITARY_QUOTA_FIXTURE_DIR: fixtureDir },
  });
  try {
    const { app, page } = launched;
    const unhandled: string[] = [];
    page.on("pageerror", (error) => unhandled.push(error.message));
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("tab", { name: "Intelligence", exact: true }).click();

    const seat = settingRow(page, "firstmate-model");
    const picker = seat.getByRole("combobox", { name: "First mate model" });
    const savedSeat = () => page.evaluate(() => window.infinitary.settings.getFirstmateModel());
    await expect(picker).toBeEnabled();
    await expect.poll(async () => (await picker.locator("option").count()) > 1).toBe(true);
    const pick = await picker
      .locator("option")
      .evaluateAll(
        (options) =>
          (options as HTMLOptionElement[]).find(
            (option) => option.value && !option.value.startsWith("\u0000"),
          )?.value,
      );
    if (!pick) throw new Error("The seeded account offers no Firstmate model");
    expect(await savedSeat()).toBeNull();
    await refuseNext(app, "inf:settings:firstmate-model:set", false, REFUSAL, true);
    await picker.selectOption(pick);
    await expect(picker).toBeDisabled();
    await releaseSave(app);
    await assertRefusal(seat.getByRole("alert"), REFUSAL);
    await expect(picker).toHaveValue("");
    expect(await savedSeat()).toBeNull();
    await picker.selectOption(pick);
    await expect(picker).toHaveValue(pick);
    await expect(seat.getByRole("alert")).toHaveCount(0);
    expect(await savedSeat()).toMatchObject({ id: pick.split("/").slice(1).join("/") });

    const accountId = "acct_save_feedback";
    const row = page.locator(`[data-account-row="${accountId}"]`);
    const feedback = page.locator(`[data-account-error="${accountId}"]`);
    const saved = async () =>
      (await page.evaluate(() => window.infinitary.accounts.list())).find(
        (account) => account.id === accountId,
      );
    const choose = async (item: string | RegExp) => {
      await row.getByRole("button", { name: /actions$/ }).click();
      await page.getByRole("menuitem", { name: item }).click();
    };
    const edits = [
      {
        channel: "inf:accounts:set-enabled",
        act: () => choose("Pause"),
        unchanged: async () => {
          await expect(row).not.toHaveAttribute("data-paused");
          expect((await saved())?.enabled).toBe(true);
        },
        changed: async () => {
          await expect(row).toHaveAttribute("data-paused", "true");
          expect((await saved())?.enabled).toBe(false);
        },
      },
      {
        channel: "inf:accounts:rename",
        act: async () => {
          await choose("Rename");
          await row.getByPlaceholder("Account name").fill("Work");
          await row.getByRole("button", { name: "Save", exact: true }).click();
        },
        unchanged: async () => {
          await expect(row.locator("[data-account-name]")).toContainText("Personal");
          expect((await saved())?.label).toBe("Personal");
        },
        changed: async () => {
          await expect(row.locator("[data-account-name]")).toContainText("Work");
          expect((await saved())?.label).toBe("Work");
        },
      },
      {
        channel: "inf:accounts:pin",
        act: () => choose(/^Prefer for crew work/),
        unchanged: async () => {
          await expect(row.locator("[data-crew-preferred]")).toHaveCount(0);
          expect((await saved())?.pinned).toBe(false);
        },
        changed: async () => {
          await expect(row.locator("[data-crew-preferred]")).toHaveCount(1);
          expect((await saved())?.pinned).toBe(true);
        },
      },
      {
        channel: "inf:accounts:remove",
        act: () => choose("Disconnect"),
        unchanged: async () => {
          await expect(row).toBeVisible();
          expect(await saved()).toBeDefined();
        },
        changed: async () => {
          await expect(row).toHaveCount(0);
          expect(await saved()).toBeUndefined();
        },
      },
    ];
    for (const edit of edits) {
      await refuseNext(app, edit.channel);
      await edit.act();
      await assertRefusal(feedback, REFUSAL);
      await edit.unchanged();
      await edit.act();
      await expect(feedback).toHaveCount(0);
      await edit.changed();
    }
    expect(unhandled).toEqual([]);
  } finally {
    await launched.close();
  }
});
