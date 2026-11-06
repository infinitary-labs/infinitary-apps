import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { PANEL_UPDATE_ASKED_OPENING } from "../../src/core/orchestrator/noticeWakes";
import { PANEL_SILENCE_MS } from "../../src/core/panels/panelRuntimes";
import { appPathsFor } from "../../src/core/paths";
import { PANELS_SAFE_MODE_NOTE } from "../../src/core/personal/panelLines";
import {
  BACKGROUND_PAUSED_LINE,
  BACKGROUND_RETRY,
  BACKGROUND_STOPPED_LINE,
  BACKGROUND_UPDATE,
} from "../../src/renderer/src/personal/panelBoundaryWords";
import { YOUR_PANELS_WORDS } from "../../src/renderer/src/settings/generalWords";
import { scratchDir } from "../helpers/scratchDirs";
import { panelBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import {
  seedOlderApiPanel,
  seedPersonalWorkspace,
  seedUnresponsivePanel,
  updateOlderApiPanel,
} from "./personalFixtures";
import { feedLineOf } from "./rails";
import { settingRow } from "./settings";
import { pressKey } from "./windowKeys";

/**
 * Hardening the personal panels (talk-to-personalize Step 5, plan section
 * 5.5 and the section 7 Step 5 row). Two acceptance criteria, one each:
 *
 * 1. The host-owned switch unmounts everything personal in one tick, and
 *    the Firstmate's context says so. Off is not a rail trick - the core
 *    stops the server modules too - so the spec reads the snapshot, the
 *    rails, and the context block the Firstmate is actually served.
 * 2. A crash-looping app boots into safe mode. The fixture is the real
 *    thing rather than a stubbed counter: the app is SIGKILLed twice
 *    before it has settled, which is exactly what a force quit of a window
 *    a panel has wedged leaves behind, and the third launch comes up with
 *    the panels off and says why.
 */

/** The three Step 2 fixtures, already exercised by personal-panels.spec.ts. */
function seedFixtures(userDataDir: string): string {
  return seedPersonalWorkspace(userDataDir, join(process.cwd(), "tests", "fixtures", "personal"));
}

const mountedIds = (app: LaunchedApp) =>
  app.page.evaluate(() =>
    window.infinitary.plugins.personal.list().then((s) => s.extensions.map((e) => e.id)),
  );

const panelsPreference = (app: LaunchedApp) =>
  app.page.evaluate(() => window.infinitary.settings.getPreferences().then((p) => p.panels));

/** The Settings switch, which carries no visible label of its own. */
function panelsSwitch(page: Page) {
  return page.locator('[data-setting="your-panels"] [role="switch"]');
}

test.describe
  .serial("the host-owned switch over the captain's own panels (Step 5)", () => {
    let launched: LaunchedApp;
    let userDataDir: string;

    test.beforeAll(async () => {
      userDataDir = scratchDir("infinitary-e2e-panels-off-");
      seedFixtures(userDataDir);
      launched = await launchApp({ userDataDir, withMockProvider: true });
      await expect
        .poll(() => mountedIds(launched), { timeout: 30_000 })
        .toEqual(["bad", "open-items", "shaky"]);
    });

    test.afterAll(async () => {
      await launched.close();
    });

    test("off unmounts every personal panel in one tick and leaves the app's own alone", async () => {
      const { page } = launched;
      // `shaky` is present on its own (its presence rule is `always`) and
      // docks on the left rail beside Activity.
      await expect(page.locator('[data-side-panel="shaky"]')).toBeVisible();
      await expect(page.locator('[data-rail="left"] [data-side-panel="activity"]')).toHaveCount(1);
      expect(await panelsPreference(launched)).toEqual({ enabled: true, offReason: null });

      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(
        settingRow(page, "your-panels").getByText(YOUR_PANELS_WORDS.title),
      ).toBeVisible();
      await expect(panelsSwitch(page)).toHaveAttribute("aria-checked", "true");
      await panelsSwitch(page).click();

      await expect
        .poll(() => panelsPreference(launched))
        .toEqual({ enabled: false, offReason: "captain" });
      await expect.poll(() => mountedIds(launched)).toEqual([]);

      await page.keyboard.press("Escape");
      await expect(page.locator('[data-side-panel="shaky"]')).toHaveCount(0);
      await expect(page.locator('[data-side-panel="open-items"]')).toHaveCount(0);
      // The app's own panels are untouched: this switch is about the
      // captain's panels, not about the rails.
      await expect(page.locator('[data-rail="left"] [data-side-panel="activity"]')).toHaveCount(1);
      // And the server module is gone with them, not merely hidden.
      expect(
        await page.evaluate(() => window.infinitary.plugins.invoke("open-items", "fill", ["a"])),
      ).toEqual({ ok: false, error: '"open-items" is not in the personal workspace' });
    });

    test("on again brings every one of them back", async () => {
      const { page } = launched;
      // Its own start: the panels off, through the channel the switch drives.
      await page.evaluate(() => window.infinitary.settings.setPanels(false));
      await expect.poll(() => mountedIds(launched)).toEqual([]);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await expect(panelsSwitch(page)).toHaveAttribute("aria-checked", "false");
      await panelsSwitch(page).click();
      await expect
        .poll(() => panelsPreference(launched))
        .toEqual({ enabled: true, offReason: null });
      await expect.poll(() => mountedIds(launched)).toEqual(["bad", "open-items", "shaky"]);
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-side-panel="shaky"]')).toBeVisible();
    });
  });

test.describe
  .serial("safe-mode boot after a crash loop (Step 5)", () => {
    let userDataDir: string;

    test.beforeAll(() => {
      userDataDir = scratchDir("infinitary-e2e-safe-mode-");
      seedFixtures(userDataDir);
    });

    /**
     * A launch settles ten seconds in; a loaded CI machine could take that
     * long to boot, and then the kill below would be racing the settle
     * rather than modelling a crash. The dev-only override makes the
     * fixture deterministic: nothing settles until the spec has killed it.
     */
    const EARLY_WINDOW = { INFINITARY_EARLY_LAUNCH_MS: "600000" };

    /**
     * One launch that dies before the app has settled. `app.close()` would
     * be a clean quit and would clear the marker, which is the distinction
     * the whole mechanism rests on, so the process is killed outright.
     */
    async function crashOnce(): Promise<void> {
      const app = await launchApp({ userDataDir, env: EARLY_WINDOW });
      // Wait until the core is up, so the launch really did start and
      // write its marker before it dies.
      await expect.poll(() => mountedIds(app), { timeout: 30_000 }).not.toEqual([]);
      const process = app.app.process();
      process.kill("SIGKILL");
      await new Promise<void>((resolve) => {
        if (process.exitCode !== null) resolve();
        else process.once("exit", () => resolve());
      });
    }

    test("two launches that never settle bring the third up in safe mode, and a clean quit after it is not another crash", async () => {
      // Each step keeps the minute it had as a test of its own.
      test.setTimeout(2 * 60_000);
      await test.step("two launches that never settle, then the third comes up with the panels off and says why", async () => {
        await crashOnce();
        // One is not enough: a single bad shutdown must never cost the
        // captain their panels.
        const second = await launchApp({ userDataDir, env: EARLY_WINDOW });
        expect(await panelsPreference(second)).toEqual({ enabled: true, offReason: null });
        await expect.poll(() => mountedIds(second), { timeout: 30_000 }).not.toEqual([]);
        second.app.process().kill("SIGKILL");
        await new Promise<void>((resolve) => {
          const child = second.app.process();
          if (child.exitCode !== null) resolve();
          else child.once("exit", () => resolve());
        });

        const safe = await launchApp({ userDataDir, env: EARLY_WINDOW });
        try {
          await expect
            .poll(() => panelsPreference(safe), { timeout: 30_000 })
            .toEqual({ enabled: false, offReason: "safe-mode" });
          // Nothing personal is mounted, and nothing personal is on a rail.
          expect(await mountedIds(safe)).toEqual([]);
          await expect(safe.page.locator('[data-side-panel="shaky"]')).toHaveCount(0);
          // The captain is told, in the feed, what happened and where to undo it.
          await expect(
            feedLineOf(safe.page, { type: "firstmate_note", text: PANELS_SAFE_MODE_NOTE }),
          ).toBeVisible({ timeout: 30_000 });
          // And Settings says why rather than reading as a switch they forgot.
          await safe.page.getByRole("button", { name: "Settings", exact: true }).click();
          await expect(
            settingRow(safe.page, "your-panels").getByText(YOUR_PANELS_WORDS.safeMode),
          ).toBeVisible();
          await safe.page.keyboard.press("Escape");
        } finally {
          await safe.close();
        }
      });

      await test.step("a clean quit after safe mode is not another crash: the next launch is ordinary", async () => {
        const next = await launchApp({ userDataDir });
        try {
          // Still off - the switch is a recorded choice, not a per-boot mood -
          // but the crash count started over, so this is an ordinary launch.
          expect(await panelsPreference(next)).toEqual({ enabled: false, offReason: "safe-mode" });
          await next.page.getByRole("button", { name: "Settings", exact: true }).click();
          await panelsSwitch(next.page).click();
          await expect
            .poll(() => panelsPreference(next))
            .toEqual({ enabled: true, offReason: null });
          await next.page.keyboard.press("Escape");
          await expect
            .poll(() => mountedIds(next), { timeout: 30_000 })
            .toEqual(["bad", "open-items", "shaky"]);
        } finally {
          await next.close();
        }
      });
    });
  });

/**
 * A panel whose background work holds its loop (INF-2205 piece B, the
 * captain's "Stop only the identified panel; keep the broad fallback").
 * Promised result: the host stops that one panel's background process, the
 * window draws its own stopped line and Retry above the panel, another
 * panel's background work keeps answering, and Retry - pressed from the
 * keyboard - starts it again. Data: the shared fixtures plus `spinner`, a
 * panel whose `spin` action never gives its loop back. Completion signal:
 * the snapshot's `stopped` field, set and then cleared. Platform: any; the
 * stop waits out the app's own `PANEL_SILENCE_MS`. Shared resources: none
 * beyond its own launch.
 */
test.describe
  .serial("a panel whose background work stops responding (INF-2205)", () => {
    let launched: LaunchedApp;

    test.beforeAll(async () => {
      const userDataDir = scratchDir("infinitary-e2e-panels-stopped-");
      const workspace = seedFixtures(userDataDir);
      seedUnresponsivePanel(workspace);
      launched = await launchApp({ userDataDir, withMockProvider: true });
      await expect
        .poll(() => mountedIds(launched), { timeout: 30_000 })
        .toEqual(["bad", "open-items", "shaky", "spinner"]);
    });

    test.afterAll(async () => {
      await launched.close();
    });

    test("stops only that panel, keeps its sibling answering, and Retry from the keyboard starts it again", async () => {
      test.setTimeout(PANEL_SILENCE_MS * 6);
      const { page } = launched;
      const stoppedOf = () =>
        page.evaluate(() =>
          window.infinitary.plugins.personal
            .list()
            .then((s) => s.extensions.find((e) => e.id === "spinner")?.stopped?.reason ?? null),
        );
      await expect(panelBody(page, "spinner").locator('[data-fixture="spinner"]')).toBeVisible();
      expect(
        await page.evaluate(() => window.infinitary.plugins.invoke("spinner", "ping", null)),
      ).toEqual({ ok: true, result: "pong" });

      // The spin is left running in the window while the sibling is asked.
      await page.evaluate(() => {
        (window as unknown as { spun: Promise<unknown> }).spun = window.infinitary.plugins.invoke(
          "spinner",
          "spin",
          null,
        );
      });
      expect(
        await page.evaluate(() => window.infinitary.plugins.invoke("open-items", "fill", ["a"])),
      ).toMatchObject({ ok: true, result: { filled: 1 } });

      await expect.poll(stoppedOf, { timeout: PANEL_SILENCE_MS * 3 }).toBe("unresponsive");
      const spun = (await page.evaluate(
        () => (window as unknown as { spun: Promise<unknown> }).spun,
      )) as { ok: boolean; error?: string };
      expect(spun.ok).toBe(false);
      expect(spun.error).toMatch(/Retry/);

      const row = page.locator(
        '[data-side-panel="spinner"] [data-panel-background-stopped="spinner"]',
      );
      await expect(row).toContainText(BACKGROUND_STOPPED_LINE);
      // The panel's own drawing stays, and so does every other panel's work.
      await expect(panelBody(page, "spinner").locator('[data-fixture="spinner"]')).toBeVisible();
      expect(
        await page.evaluate(() => window.infinitary.plugins.invoke("open-items", "clear", null)),
      ).toMatchObject({ ok: true, result: { filled: 0 } });
      expect(
        await page.evaluate(() => window.infinitary.plugins.invoke("spinner", "ping", null)),
      ).toMatchObject({ ok: false });

      await pressKey(row.getByRole("button", { name: BACKGROUND_RETRY }), "Enter");
      await expect.poll(stoppedOf).toBeNull();
      await expect(row).toHaveCount(0);
      expect(
        await page.evaluate(() => window.infinitary.plugins.invoke("spinner", "ping", null)),
      ).toEqual({ ok: true, result: "pong" });
    });
  });

/**
 * INF-2470, the captain's "Approve and build" on direction A with "Start the
 * update at once" and "No, the line on the panel is enough": a panel whose
 * `server.ts` is written for the earlier panel API says its background work
 * is paused, Update panel - pressed from the keyboard - tells the first mate
 * once, and the updated files clear the line and run the work with no Retry.
 * Data: `counter`, written as panels were before the store answered
 * asynchronously, with a saved count. Completion signal: the snapshot's
 * `paused` field, set and then cleared, and the first mate's request carrying
 * the press. Platform: any. Shared resources: none beyond its own launch.
 */
test.describe
  .serial("a panel written for an earlier panel API (INF-2470)", () => {
    let launched: LaunchedApp;
    let workspace: string;

    test.beforeAll(async () => {
      const userDataDir = scratchDir("infinitary-e2e-panels-paused-");
      workspace = appPathsFor(userDataDir).personalWorkspaceDir;
      mkdirSync(workspace, { recursive: true });
      seedOlderApiPanel(workspace);
      launched = await launchApp({ userDataDir, withMockProvider: true });
      await expect.poll(() => mountedIds(launched), { timeout: 30_000 }).toEqual(["counter"]);
    });

    test.afterAll(async () => {
      await launched.close();
    });

    test("says its background work is paused, asks the first mate once, and runs it once updated", async () => {
      const { page } = launched;
      const pausedOf = () =>
        page.evaluate(() =>
          window.infinitary.plugins.personal
            .list()
            .then((s) => s.extensions.find((e) => e.id === "counter")?.paused ?? null),
        );
      await expect(panelBody(page, "counter").locator('[data-fixture="counter"]')).toBeVisible();
      const row = page.locator(
        '[data-side-panel="counter"] [data-panel-background-paused="counter"]',
      );
      await expect(row).toContainText(BACKGROUND_PAUSED_LINE);
      expect(
        await page.evaluate(() => window.infinitary.plugins.invoke("counter", "count", null)),
      ).toMatchObject({ ok: false });

      const update = row.getByRole("button", { name: BACKGROUND_UPDATE });
      await pressKey(update, "Enter");
      await expect.poll(pausedOf).toEqual({ api: 1, serves: [2], asked: true });
      await expect(update).toBeDisabled();
      const told = () =>
        (launched.mockProvider?.requestBodies() ?? []).filter(
          (body) => body.includes(PANEL_UPDATE_ASKED_OPENING) && body.includes("(id counter)"),
        ).length;
      await expect.poll(told, { timeout: 30_000 }).toBeGreaterThan(0);
      // A second ask while the first stands tells no one.
      expect(await page.evaluate(() => window.infinitary.plugins.personal.update("counter"))).toBe(
        false,
      );

      updateOlderApiPanel(workspace);
      await expect.poll(pausedOf, { timeout: 30_000 }).toBeNull();
      await expect(row).toHaveCount(0);
      expect(
        await page.evaluate(() => window.infinitary.plugins.invoke("counter", "count", null)),
      ).toEqual({ ok: true, result: 1 });
    });
  });
