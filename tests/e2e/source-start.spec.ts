import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { PROTOCOL_VERSION } from "@shared/ipc";
import electronPath from "electron";
import { hostEnv } from "../../src/core/hostEnv";
import { scratchDir } from "../helpers/scratchDirs";
import { builtAppDir, launchApp } from "./launch";
import { resizeWindow } from "./layout";

/** The source-start contract shared by the first desktop lane on each system. */
test("a source desktop opens with private state and a usable host bridge", async () => {
  const launched = await launchApp();
  try {
    const { app, page, homeDir, userDataDir } = launched;
    const health = await page.evaluate(() => window.infinitary.app.healthcheck());
    expect(health.ok).toBe(true);
    expect(health.platform).toBe(process.platform);
    // Startup reads presence even on Linux, where Electron has no login-item API.
    const presence = await page.evaluate(() => window.infinitary.presence.get());
    expect(typeof presence.startAtLogin).toBe("boolean");
    const state = await app.evaluate(({ app }) => ({
      home: process.env.HOME,
      config: process.env.XDG_CONFIG_HOME,
      cache: process.env.XDG_CACHE_HOME,
      data: process.env.XDG_DATA_HOME,
      userData: app.getPath("userData"),
      sandboxDisabled: app.commandLine.hasSwitch("no-sandbox"),
    }));
    expect(state).toEqual({
      home: homeDir,
      config: join(homeDir, ".config"),
      cache: join(homeDir, ".cache"),
      data: join(homeDir, ".local", "share"),
      userData: userDataDir,
      sandboxDisabled: false,
    });
    await expect(page.getByRole("textbox", { name: "Task prompt" })).toBeVisible();
    const evidence = process.env.INFINITARY_SOURCE_EVIDENCE;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      await resizeWindow(app, page, { width: 1280, height: 800 });
      await page.screenshot({
        path: join(evidence, `${process.platform}-source.png`),
        animations: "disabled",
      });
    }
  } finally {
    await launched.close();
  }
});

// The source work entry must reach its command without a Mac activation API.
// It starts no service, joins no home and reads no actual sign-in.
test("the isolated source work entry reports its version", async () => {
  const home = scratchDir("infinitary-source-work-home-");
  const data = scratchDir("infinitary-source-work-data-");
  const result = await promisify(execFile)(
    electronPath as unknown as string,
    [builtAppDir(), "work", "version"],
    {
      timeout: 20_000,
      env: {
        ...hostEnv(),
        ELECTRON_RENDERER_URL: "",
        ELECTRON_RUN_AS_NODE: "",
        HOME: home,
        TMPDIR: scratchDir("infinitary-source-work-tmp-"),
        CFFIXED_USER_HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        INFINITARY_HELPER_DATA_DIR: data,
        PI_OFFLINE: "1",
      },
    },
  );
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  expect(result.stdout.trim()).toBe(`Infinitary ${version} · contract ${PROTOCOL_VERSION}`);
  await test.info().attach("source-work-version", {
    body: result.stdout,
    contentType: "text/plain",
  });
});
