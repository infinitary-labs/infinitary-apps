import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { scratchDir } from "../helpers/scratchDirs";
import { panelBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { seedPersonalWorkspace } from "./personalFixtures";

/**
 * A panel reads the app's settings (INF-5326's approved piece 4,
 * primitives/live-reads.md "settings.current"): a panel of the captain's own
 * that declares the read shows the music's state and the theme, and shows
 * each change the window's Settings makes as it lands; a setting with no
 * panel value is refused. The panel's own code is written here, as a person
 * would write it in their workspace.
 */

const PANEL = "music-glance";

const PANEL_CODE = `import type { PanelProps, PanelSettings } from "@infinitary/contracts";
import { useEffect, useState } from "react";

export default function Panel({ reads }: PanelProps) {
  const [now, setNow] = useState<PanelSettings<"ambient-music" | "theme"> | null>(null);
  useEffect(
    () => reads.subscribe("settings.current", { names: ["ambient-music", "theme"] }, setNow),
    [reads],
  );
  if (!now) return <p>Reading</p>;
  const music = now["ambient-music"];
  return (
    <p>
      {\`Music \${music.on ? "on" : "off"}, \${music.paused ? "paused" : "not paused"}, \${music.style} at \${music.volume}%, \${now.theme.theme} theme\`}
    </p>
  );
}
`;

let launched: LaunchedApp;

test.beforeAll(async () => {
  const userDataDir = scratchDir("infinitary-e2e-panel-settings-");
  const source = join(scratchDir("infinitary-e2e-panel-settings-src-"), PANEL);
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "manifest.json"),
    JSON.stringify({
      title: "Music",
      placement: { x: "right", y: "top" },
      size: "content",
      presence: { always: true },
      reads: ["settings.current"],
    }),
  );
  writeFileSync(join(source, "panel.tsx"), PANEL_CODE);
  seedPersonalWorkspace(userDataDir, source, PANEL);
  launched = await launchApp({ userDataDir });
});

test.afterAll(async () => {
  await launched?.close();
});

test("a panel shows the music and the theme as Settings changes them, and is refused a setting it may not read", async () => {
  const { page } = launched;
  const music = panelBody(page, PANEL);
  await expect(
    music.getByText("Music off, not paused, star-cruise at 40%, dark theme"),
  ).toBeVisible({ timeout: 30_000 });

  // The window's own Settings writes, one at a time, each read back live.
  const setLook = (change: Record<string, unknown>) =>
    page.evaluate(async (next) => {
      const look = await window.infinitary.settings.getAppearance();
      await window.infinitary.settings.setAppearance({ ...look, ...next });
    }, change);
  await setLook({ ambientMusic: true, ambientPaused: false });
  await expect(
    music.getByText("Music on, not paused, star-cruise at 40%, dark theme"),
  ).toBeVisible();
  await setLook({ ambientPaused: true });
  await expect(music.getByText("Music on, paused, star-cruise at 40%, dark theme")).toBeVisible();
  await setLook({ ambientStyle: "quiet-cove", ambientVolume: 25 });
  await expect(music.getByText("Music on, paused, quiet-cove at 25%, dark theme")).toBeVisible();
  await setLook({ theme: "light" });
  await expect(music.getByText("Music on, paused, quiet-cove at 25%, light theme")).toBeVisible();

  // A line with no panel value is refused before any value is read.
  const refused = await page.evaluate(() =>
    window.infinitary.plugins
      .read("settings.current", { names: ["project-settings"] } as never)
      .then(
        () => "answered",
        () => "refused",
      ),
  );
  expect(refused).toBe("refused");
});
