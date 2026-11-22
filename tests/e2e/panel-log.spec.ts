import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { stoppedLine } from "../../src/core/panels/panelRuntimes";
import { appPathsFor } from "../../src/core/paths";
import { scratchDir } from "../helpers/scratchDirs";
import { panelBody } from "./frames";
import { launchApp } from "./launch";
import { CHATTY_LINES, seedChattyPanel } from "./personalFixtures";

/**
 * The panel log (INF-2817; docs/personal-panels.md, "The panel log"). In
 * the windowed app a panel's lines went to a console nobody kept, so a
 * panel whose saves were refused looked as if GitHub had stopped answering.
 * Now every panel's lines reach one file in the app's data folder: what its
 * code hands `context.log`, what its process prints on either stream, the
 * last thing a process prints as it ends, and the host's own line about it.
 *
 * Data: a panel of the captain's whose code writes each kind of line, in a
 * fresh data folder. Done when the file holds each line on a line naming
 * the panel. Portable: the utility process prints the same way on Linux and
 * the Mac. Shared resources: none.
 */

function chattyLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.includes("chatty"));
}

const holding = (lines: string[], words: string) => lines.some((line) => line.includes(words));

test("a panel's own lines, what its process prints and the host's line about it reach the panel log", async () => {
  const userDataDir = scratchDir("infinitary-e2e-panel-log-");
  const paths = appPathsFor(userDataDir);
  mkdirSync(paths.personalWorkspaceDir, { recursive: true });
  seedChattyPanel(paths.personalWorkspaceDir);
  const app = await launchApp({ userDataDir, withMockProvider: true });
  try {
    const { page } = app;
    await expect(panelBody(page, "chatty").locator('[data-fixture="chatty"]')).toBeVisible({
      timeout: 30_000,
    });

    await test.step("what its code logs and prints", async () => {
      expect(
        await page.evaluate(() => window.infinitary.plugins.invoke("chatty", "talk", null)),
      ).toEqual({ ok: true, result: "said" });
      await expect
        .poll(() => {
          const lines = chattyLines(paths.panelLogPath);
          return [CHATTY_LINES.logged, CHATTY_LINES.printed, CHATTY_LINES.warned].filter(
            (words) => !holding(lines, words),
          );
        })
        .toEqual([]);
    });

    await test.step("what a process that ends on its own prints last, and the host's line", async () => {
      // Its answer may or may not arrive before the process ends; the log is the subject.
      await page.evaluate(() => window.infinitary.plugins.invoke("chatty", "end", null));
      const ended = stoppedLine({
        incidentId: "",
        reason: "exited",
        at: "",
        silentMs: null,
        termination: "confirmed",
        version: "",
      });
      await expect
        .poll(() => {
          const lines = chattyLines(paths.panelLogPath);
          return [CHATTY_LINES.last, ended].filter((words) => !holding(lines, words));
        })
        .toEqual([]);
    });
  } finally {
    await app.close();
  }
});
