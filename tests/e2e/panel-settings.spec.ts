import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { undeclaredReadMessage } from "../../src/shared/personal/manifest";
import { DEFAULT_AMBIENT_STYLE } from "../../src/shared/preferences";
import { scratchDir } from "../helpers/scratchDirs";
import { panelBody } from "./frames";
import { type LaunchedApp, launchApp } from "./launch";
import { seedPersonalWorkspace } from "./personalFixtures";

/**
 * A panel reads the app's settings (INF-5326's approved piece 4,
 * primitives/live-reads.md "settings.current"): a panel of the captain's own
 * that declares the read shows the music's state and the theme, and shows
 * each change the window's Settings makes as it lands; a setting with no
 * panel value is refused, and so is the read to a panel that does not declare
 * it. The panels' own code is written here, as a person would write it in
 * their workspace.
 */

const PANEL = "music-glance";
const PEEK = "settings-peek";

const PANEL_CODE = `import type { PanelProps, PanelSettings } from "@infinitary/contracts";
import { useEffect, useState } from "react";

export default function Panel({ reads }: PanelProps) {
  const [now, setNow] = useState<PanelSettings<"ambient-music" | "theme"> | null>(null);
  const [secret, setSecret] = useState("no value");
  useEffect(
    () => reads.subscribe("settings.current", { names: ["ambient-music", "theme"] }, setNow),
    [reads],
  );
  // A setting with no panel value, asked once the theme turns light: the host
  // refuses it, the panel's console says so, and it delivers nothing.
  const light = now?.theme.theme === "light";
  useEffect(() => {
    if (!light) return;
    return reads.subscribe("settings.current", { names: ["project-settings"] } as never, (value) =>
      setSecret(JSON.stringify(value)),
    );
  }, [reads, light]);
  if (!now) return <p>Reading</p>;
  const music = now["ambient-music"];
  return (
    <div>
      <p>
        {\`Music \${music.on ? "on" : "off"}, \${music.paused ? "paused" : "not paused"}, \${music.style} at \${music.volume}%, \${now.theme.theme} theme\`}
      </p>
      <p>{\`Project settings: \${secret}\`}</p>
    </div>
  );
}
`;

// A panel that does not declare the read: asking it throws at the call.
const PEEK_CODE = `import type { PanelProps } from "@infinitary/contracts";
import { useEffect, useState } from "react";

export default function Panel({ reads }: PanelProps) {
  const [said, setSaid] = useState("Asking");
  useEffect(() => {
    try {
      return reads.subscribe("settings.current", { names: ["theme"] }, (value) =>
        setSaid(\`Read \${JSON.stringify(value)}\`),
      );
    } catch (error) {
      setSaid(\`Refused: \${(error as Error).message}\`);
    }
  }, [reads]);
  return <p>{said}</p>;
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
  const peek = join(scratchDir("infinitary-e2e-panel-settings-peek-"), PEEK);
  mkdirSync(peek, { recursive: true });
  writeFileSync(
    join(peek, "manifest.json"),
    JSON.stringify({
      title: "Peek",
      placement: { x: "right", y: "bottom" },
      size: "content",
      presence: { always: true },
    }),
  );
  writeFileSync(join(peek, "panel.tsx"), PEEK_CODE);
  seedPersonalWorkspace(userDataDir, peek, PEEK);
  launched = await launchApp({ userDataDir });
});

test.afterAll(async () => {
  await launched?.close();
});

test("a panel shows the music and the theme as Settings changes them, and is refused a setting it may not read or a read it did not declare", async () => {
  const { page } = launched;
  const said: string[] = [];
  page.on("console", (message) => said.push(message.text()));
  const music = panelBody(page, PANEL);
  await expect(
    music.getByText(`Music off, not paused, ${DEFAULT_AMBIENT_STYLE} at 40%, dark theme`),
  ).toBeVisible({ timeout: 30_000 });

  // The window's own Settings writes, one at a time, each read back live.
  const setLook = (change: Record<string, unknown>) =>
    page.evaluate(async (next) => {
      const look = await window.infinitary.settings.getAppearance();
      await window.infinitary.settings.setAppearance({ ...look, ...next });
    }, change);
  await setLook({ ambientMusic: true, ambientPaused: false });
  await expect(
    music.getByText(`Music on, not paused, ${DEFAULT_AMBIENT_STYLE} at 40%, dark theme`),
  ).toBeVisible();
  // INF-6406: a pause, as an older build's sound button still saves one, reads as off.
  await setLook({ ambientPaused: true });
  await expect(
    music.getByText(`Music off, not paused, ${DEFAULT_AMBIENT_STYLE} at 40%, dark theme`),
  ).toBeVisible();
  await setLook({ ambientStyle: "quiet-cove", ambientVolume: 25 });
  await expect(
    music.getByText("Music off, not paused, quiet-cove at 25%, dark theme"),
  ).toBeVisible();
  await setLook({ theme: "light" });
  await expect(
    music.getByText("Music off, not paused, quiet-cove at 25%, light theme"),
  ).toBeVisible();

  // The setting with no panel value, asked in the light theme, is refused and delivers nothing.
  await expect
    .poll(() =>
      said.find(
        (line) =>
          line.includes('panel read "settings.current" refused') &&
          line.includes('"settings.current" args'),
      ),
    )
    .toBeDefined();
  await setLook({ ambientVolume: 30 });
  await expect(
    music.getByText("Music off, not paused, quiet-cove at 30%, light theme"),
  ).toBeVisible();
  await expect(music.getByText("Project settings: no value")).toBeVisible();
  // A panel that does not declare the read is refused at its call and reads nothing.
  await expect(
    panelBody(page, PEEK).getByText(`Refused: ${undeclaredReadMessage("settings.current")}`),
  ).toBeVisible();
});
