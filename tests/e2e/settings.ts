import { type ElectronApplication, expect, type Locator, type Page } from "@playwright/test";
import { overflows, settled, within } from "./layout";

/** The shared Settings shell must fit, including both of its side gutters. */
export async function assertSettingsFits(page: Page) {
  const screen = page.locator('[data-screen-label="Settings"]');
  const column = page.locator("[data-settings-column]");
  const layout = await settled(page, () =>
    column.evaluate((el) => {
      const screen = el.closest<HTMLElement>('[data-screen-label="Settings"]');
      const tabs = el.querySelector('[role="tablist"]');
      if (!screen || !tabs) throw new Error("Settings layout missing");
      const columnBox = el.getBoundingClientRect();
      const screenBox = screen.getBoundingClientRect();
      const tabsBox = tabs.getBoundingClientRect();
      const style = getComputedStyle(el);
      // Settings intentionally scrolls vertically; compare horizontal bounds only.
      const strip = (x: number, width: number) => ({ x, y: 0, width, height: 1 });
      return {
        viewport: strip(screenBox.x, screen.clientWidth),
        column: strip(columnBox.x, columnBox.width),
        tabs: strip(tabsBox.x, tabsBox.width),
        paddingLeft: Number.parseFloat(style.paddingLeft),
        paddingRight: Number.parseFloat(style.paddingRight),
        verticalOverflow: screen.scrollHeight - screen.clientHeight,
        scrollbarWidth: screenBox.width - screen.clientWidth,
      };
    }),
  );
  expect(within(layout.column, layout.viewport), "column stays inside the scroll region").toEqual(
    [],
  );
  expect(await overflows(screen), "Settings has no horizontal scrolling").toBe(0);
  expect(await overflows(column), "section content fits the column").toBe(0);
  expect(layout.paddingLeft).toBeGreaterThan(0);
  expect(layout.paddingRight).toBeGreaterThan(0);
  const paddedContent = {
    ...layout.column,
    x: layout.column.x + layout.paddingLeft,
    width: layout.column.width - layout.paddingLeft - layout.paddingRight,
  };
  expect(within(layout.tabs, paddedContent), "tabs stay inside both side gutters").toEqual([]);
  expect(layout.tabs.x - layout.viewport.x).toBeGreaterThanOrEqual(layout.paddingLeft);
  expect(
    layout.viewport.x + layout.viewport.width - (layout.tabs.x + layout.tabs.width),
  ).toBeGreaterThanOrEqual(layout.paddingRight);
  return layout;
}

/**
 * The shown Settings tab's page, by its tab's id in the built-in manifest
 * (`data-settings-section`), never by its label: Intelligence is
 * `subscriptions`.
 */
export function settingsSection(page: Page, id: string) {
  return page.locator(`[role="tabpanel"][data-settings-section="${id}"]`);
}

/** Settings feedback has stable hooks independent of its generated words. */
export function settingRow(page: Page, id: string) {
  return page.locator(`[data-setting="${id}"]`);
}

export function settingsFeedback(
  page: Page,
  surface: "subscriptions" | "sign-in" | "purge" | "model-slots" | "decisions" | "usage-unit",
) {
  return surface === "purge"
    ? settingRow(page, "purge-task-data")
    : page.locator(`[data-settings-error="${surface}"]`);
}

/** The boundary promise: a useful reason survives, transport diagnostics do not. */
export async function assertReadableSettingsFeedback(feedback: Locator, reason: string) {
  await expect(feedback).toBeVisible();
  await expect(feedback).toContainText(reason);
  await expect(feedback).not.toContainText(
    // e2e-typed-words: Electron's transport wrapper, stated apart from the sanitizer it checks.
    /Error invoking remote method|\bfm:|(?:Type|Zod)?Error:|\[object Object\]/,
  );
}

/** Login items are shared OS state, not disposable app data: box that one interface. */
export async function boxLoginItems(app: ElectronApplication) {
  await app.evaluate(({ app }) => {
    let openAtLogin = false;
    const settings = app.getLoginItemSettings();
    app.getLoginItemSettings = () => ({ ...settings, openAtLogin });
    app.setLoginItemSettings = (next) => {
      openAtLogin = next.openAtLogin ?? false;
    };
  });
}

/** The reason a refused Settings write gives in these journeys. */
export const REFUSAL = "The saved settings are locked. Try again.";

/**
 * Refuse ONE real request, optionally after its real writer has committed,
 * or held until `releaseSave`. The handler after it is the real one again.
 */
export async function refuseNext(
  app: ElectronApplication,
  channel: string,
  partial = false,
  reason = REFUSAL,
  hold = false,
) {
  await app.evaluate(
    ({ ipcMain }, { channel, partial, reason, hold }) => {
      const handlers = (
        ipcMain as typeof ipcMain & {
          _invokeHandlers: Map<string, Parameters<typeof ipcMain.handle>[1]>;
        }
      )._invokeHandlers;
      const original = handlers.get(channel);
      if (!original) throw new Error(`Missing handler: ${channel}`);
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (event, ...args) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, original);
        const perform = async () => {
          if (partial) await original(event, ...args);
          throw new TypeError(reason);
        };
        if (!hold) return perform();
        return new Promise((_resolve, reject) => {
          (
            globalThis as typeof globalThis & { releaseSettingsSave?: () => void }
          ).releaseSettingsSave = () => {
            delete (globalThis as typeof globalThis & { releaseSettingsSave?: () => void })
              .releaseSettingsSave;
            void perform().catch(reject);
          };
        });
      });
    },
    { channel, partial, reason, hold },
  );
}

/** Lets the refusal `refuseNext` held answer. */
export async function releaseSave(app: ElectronApplication) {
  await expect
    .poll(() =>
      app.evaluate(() =>
        Boolean(
          (globalThis as typeof globalThis & { releaseSettingsSave?: () => void })
            .releaseSettingsSave,
        ),
      ),
    )
    .toBe(true);
  await app.evaluate(() =>
    (
      globalThis as typeof globalThis & { releaseSettingsSave?: () => void }
    ).releaseSettingsSave?.(),
  );
}
