import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { runningWorkFixture } from "../fixtures/installed-updates/runningWork";
import { launchApp } from "./launch";

// INF-643: the signed-update probe must reach its update while a provider stream remains open.
// A fresh hermetic app and loopback provider need no account, signing, keychain, or shared state.
// Completion is a prepared active stream followed by its closure when the app stops.
test("the installed-update probe prepares live work without waiting for it to finish", async () => {
  const phases: string[] = [];
  const launched = await launchApp({
    withMockProvider: false,
  });
  const work = await runningWorkFixture(
    () => "before replacement",
    (phase) => {
      phases.push(phase);
      console.info(`Installed-update fixture: ${phase}`);
    },
  );
  let problem: unknown;
  const preparing = work.start(launched.page).catch((error) => {
    problem = error;
  });
  try {
    await expect
      .poll(() => ({ phase: work.phase, problem: problem ? String(problem) : null }), {
        timeout: 20_000,
      })
      .toEqual({ phase: "Active-work message accepted", problem: null });
    await preparing;
    await expect.poll(() => work.started).toBe(true);
    expect(work.closedAtVersion).toBeUndefined();
    const portFile = join(launched.userDataDir, "DevToolsActivePort");
    expect(existsSync(portFile), launched.app.process().spawnargs.join(" ")).toBe(true);
    const port = readFileSync(portFile, "utf8").split("\n")[0];
    const nativeBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    console.info("Installed-update fixture: Disconnecting the native inspection browser");
    await Promise.all(nativeBrowser.contexts().map((context) => context.tracing.stop()));
    await nativeBrowser.close();
    console.info("Installed-update fixture: Inspection browser disconnected");
    const child = launched.app.process();
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    console.info("Installed-update fixture: Application process exited");
    await launched.close();
    await expect.poll(() => work.closedAtVersion).toBe("before replacement");
    expect(work.messageSurvived(launched.userDataDir)).toBe(true);
  } finally {
    writeFileSync(
      test.info().outputPath("active-work-phases.json"),
      JSON.stringify(
        {
          phases,
          phase: work.phase,
          started: work.started,
          problem: problem ? String(problem) : null,
        },
        null,
        2,
      ),
    );
    await work.close();
    await launched.close();
    await preparing;
  }
});
