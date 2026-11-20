import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { appPathsFor } from "../../src/core/paths";
import { COMPUTER } from "../../src/shared/deviceNames";
import { scratchDir } from "../helpers/scratchDirs";
import { seedMockModelCatalog } from "./accountFixtures";
import { endCommands, run, runEnv } from "./commandRun";
import { panelBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { mockModelsJson } from "./mockModels";
import { startMockProvider } from "./mockProvider";
import { clickInBody } from "./stack";

/**
 * Panels in every window (docs/view.md, "Panels in every window"): the
 * captain's answer panels=every-window on INF-3660's plan, which takes in
 * INF-3027. The first mate keeps each panel of the captain's, its built
 * files and its data; every window that shows that first mate asks it for
 * them and draws them itself, whether the window is its own program's, one
 * opened beside a command, or one on another computer. Data: two of the
 * panel fixtures under tests/fixtures/personal/, in the first mate's own
 * workspace before it starts: `shaky`, which is always present, and
 * `open-items`, present while its store holds items. Shared resources: one
 * mock provider per journey, and each app's own loopback port.
 */

test.afterEach(endCommands);

/** The line tests/fixtures/personal/shaky/panel.tsx draws, and the one a journey saves over it. */
const SHAKY_LINE = "steady as she goes";
const SHAKY_REBUILT_LINE = "steadier still";
const PANELS = ["open-items", "shaky"];

/** The first mate's workspace with the two fixture panels, before it starts. */
function seedPanels(userDataDir: string): string {
  const workspace = appPathsFor(userDataDir).personalWorkspaceDir;
  mkdirSync(workspace, { recursive: true });
  for (const panel of PANELS)
    cpSync(join(process.cwd(), "tests", "fixtures", "personal", panel), join(workspace, panel), {
      recursive: true,
    });
  return workspace;
}

/**
 * What a window that is not the first mate's own program does with its
 * panels: it draws one from the files the first mate built, a panel's
 * action runs at the first mate and its answer shows here, and a panel the
 * first mate builds again while the window is open is drawn anew.
 */
async function drawsTheFirstMatesPanels(page: Page, workspace: string): Promise<void> {
  await test.step("draws a panel from the files the first mate built", async () => {
    await expect(page.locator('[data-side-panel="shaky"]')).toBeVisible({ timeout: 60_000 });
    await expect(panelBody(page, "shaky").locator("[data-fixture]")).toHaveText(SHAKY_LINE);
    expect(
      (await page.evaluate(() => window.infinitary.plugins.personal.list())).extensions.map(
        (extension) => extension.id,
      ),
    ).toEqual(PANELS);
  });

  await test.step("a panel's action runs at the first mate, and its data shows here", async () => {
    const panel = page.locator('[data-side-panel="open-items"]');
    await expect(panel).toHaveCount(0);
    const filled = await page.evaluate(() =>
      window.infinitary.plugins.invoke("open-items", "fill", ["alpha", "beta", "gamma"]),
    );
    expect(filled).toEqual({ ok: true, result: { filled: 3, host: "string" } });
    await expect(panel).toBeVisible();
    const body = panelBody(page, "open-items");
    await expect(body.locator("[data-fixture-item]")).toHaveCount(3);
    // The panel's own button asks the first mate from inside its frame.
    await clickInBody(body.locator("[data-fixture-clear]"));
    await expect(panel).toHaveCount(0);
  });

  await test.step("a panel built again while the window is open is drawn anew", async () => {
    const source = join(workspace, "shaky", "panel.tsx");
    writeFileSync(source, readFileSync(source, "utf8").replace(SHAKY_LINE, SHAKY_REBUILT_LINE));
    await expect(panelBody(page, "shaky").locator("[data-fixture]")).toHaveText(
      SHAKY_REBUILT_LINE,
      { timeout: 30_000 },
    );
  });
}

/** A panel the first mate builds while a window on another computer is open, reading settings. */
const LOOK_PANEL = "look-glance";
const LOOK_PANEL_CODE = `import type { PanelProps, PanelSettings } from "@infinitary/contracts";
import { useEffect, useState } from "react";

type Read = PanelSettings<"theme" | "ambient-music" | "notifications">;

export default function Panel({ reads }: PanelProps) {
  const [now, setNow] = useState<Read | null>(null);
  useEffect(
    () =>
      reads.subscribe(
        "settings.current",
        { names: ["theme", "ambient-music", "notifications"] },
        setNow,
      ),
    [reads],
  );
  if (!now) return <p>Reading</p>;
  return (
    <p data-look>
      {\`\${now.theme.theme} theme, music \${now["ambient-music"].on ? "on" : "off"}, notifications \${now.notifications.enabled ? "on" : "off"}\`}
    </p>
  );
}
`;

/**
 * The captain's choice on INF-5357's review (docs/view.md, "The switch and
 * the layout"): a panel in a window on another computer reads that window's
 * own look, which a change there never sends to the first mate, and reads
 * the first mate's own settings, such as notifications, from it.
 */
async function readsItsOwnLook(home: Page, page: Page, workspace: string): Promise<void> {
  await test.step("a panel reading settings follows this window's look and the first mate's notifications", async () => {
    await home.evaluate(() => window.infinitary.settings.setNotifications(false));
    const homeLook = await home.evaluate(() => window.infinitary.settings.getAppearance());
    const dir = join(workspace, LOOK_PANEL);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        title: "Look",
        placement: { x: "right", y: "top" },
        size: "content",
        presence: { always: true },
        reads: ["settings.current"],
      }),
    );
    writeFileSync(join(dir, "panel.tsx"), LOOK_PANEL_CODE);
    const look = panelBody(page, LOOK_PANEL).locator("[data-look]");
    await expect(look).toHaveText("dark theme, music off, notifications off", { timeout: 60_000 });
    await page.evaluate(async () => {
      const own = await window.infinitary.settings.getAppearance();
      await window.infinitary.settings.setAppearance({
        ...own,
        theme: "light",
        ambientMusic: true,
      });
    });
    await expect(look).toHaveText("light theme, music on, notifications off");
    expect(await home.evaluate(() => window.infinitary.settings.getAppearance())).toEqual(homeLook);
  });
}

/**
 * Promised result: the window opened beside Infinitary started by a
 * command, which has no first mate of its own, shows the captain's panels
 * from that first mate. Completion: the panel's own line in its frame, an
 * action's answer and data, and the rebuilt line.
 */
test("the window opened beside a command draws the first mate's panels, runs their actions there and follows a rebuild", async () => {
  test.setTimeout(180_000);
  const provider = await startMockProvider();
  try {
    const userDataDir = scratchDir("infinitary-panels-beside-");
    seedMockModelCatalog(userDataDir, mockModelsJson(provider.port));
    const workspace = seedPanels(userDataDir);
    const ran = run(await runEnv(userDataDir));
    await ran.started();
    const opened = await launchApp({ userDataDir });
    try {
      await drawsTheFirstMatesPanels(opened.page, workspace);
    } finally {
      await opened.close();
    }
    ran.child.kill("SIGTERM");
    expect(await ran.exited, ran.error()).toBe(0);
  } finally {
    await provider.close();
  }
});

/**
 * Promised result: a window on another computer, joined with a link, shows
 * the panels of the first mate it controls, built there. Completion: the
 * same three results as the window beside a command, in the joined window,
 * whose own data folder holds no panel; then a panel reading settings shows
 * the joined window's own look and the first mate's notifications.
 */
test("a window on another computer draws the panels of the first mate it controls, runs their actions there and follows a rebuild", async () => {
  test.setTimeout(240_000);
  const homeDir = scratchDir("infinitary-panels-view-home-");
  const workspace = seedPanels(homeDir);
  const provider = await startMockProvider();
  const pro: LaunchedApp = await launchApp({
    userDataDir: homeDir,
    reuseMockProvider: provider,
    env: { INFINITARY_DEVICE_NAME: "MacBook Pro" },
  });
  let air: LaunchedApp | undefined;
  try {
    await expect(pro.page.locator('[data-side-panel="shaky"]')).toBeVisible({ timeout: 60_000 });
    const invite = await pro.page.evaluate(() => window.infinitary.devices.invite({ kind: "mac" }));
    air = await launchApp({ env: { INFINITARY_DEVICE_NAME: "MacBook Air" } });
    const { page } = air;
    await expect(page.locator('[data-first-run-gate="open"]')).toBeVisible();
    await page.locator("[data-join-chip]").click();
    await page.getByLabel(`The link from your other ${COMPUTER.one}`).fill(invite.link);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Control it from here" }).click();
    await expect(page.locator("[data-remote-control]").first()).toHaveAttribute(
      "data-remote-control",
      "in-reach",
      { timeout: 60_000 },
    );
    // The panels are the other computer's: this one's own folder holds none.
    expect(existsSync(join(appPathsFor(air.userDataDir).personalWorkspaceDir, "shaky"))).toBe(
      false,
    );
    await drawsTheFirstMatesPanels(page, workspace);
    await readsItsOwnLook(pro.page, page, workspace);
  } finally {
    await air?.close();
    await pro.close();
    await provider.close();
  }
});
