import { expect, test } from "@playwright/test";
import { HAS_APP_MENU } from "./desktop";
import { launchApp } from "./launch";

for (const build of ["development", "local-package", "release"] as const) {
  test(`${build}: developer boundary and crashed page returns without a loop`, async () => {
    const run = await launchApp({
      packaged: build !== "development",
      devFlavor: build === "local-package",
      withMockProvider: true,
    });
    try {
      const release = build === "release";
      // Playwright reaches the page over remote debugging, like the release gate.
      expect(await run.page.evaluate(() => window.infinitary.app.healthcheck())).toMatchObject({
        ok: true,
      });
      await expect
        .poll(() =>
          run.app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0]?.webContents.isLoadingMainFrame(),
          ),
        )
        .toBe(false);
      const state = await run.app.evaluate(({ BrowserWindow, Menu }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win) throw new Error("No main window");
        return {
          windowId: win.id,
          roles: Menu.getApplicationMenu()
            ?.items.find((item) => item.role?.toLowerCase() === "viewmenu")
            ?.submenu?.items.map((item) => item.role?.toLowerCase()),
        };
      });
      // This is a build boundary, not a copy or layout assertion. A desktop
      // whose window draws its own controls has no app menu to hold the roles.
      if (HAS_APP_MENU) {
        for (const role of ["reload", "forcereload", "toggledevtools"]) {
          expect(state.roles?.includes(role)).toBe(!release);
        }
      }
      if (release) {
        await run.app.evaluate(({ BrowserWindow }, id) => {
          BrowserWindow.fromId(id)?.webContents.openDevTools();
        }, state.windowId);
        expect(
          await run.app.evaluate(
            ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.webContents.isDevToolsOpened(),
            state.windowId,
          ),
        ).toBe(false);
      }
      await run.app.evaluate(({ BrowserWindow }, id) => {
        const contents = BrowserWindow.fromId(id)?.webContents;
        contents?.closeDevTools();
        // Install the witness before crashing: a load event must follow a crash.
        const events: string[] = [];
        Reflect.set(globalThis, "recoveryEvents", events);
        contents?.on("render-process-gone", (_event, details) =>
          events.push(`gone:${details.reason}`),
        );
        contents?.on("did-finish-load", () => events.push("loaded"));
        if (!contents) throw new Error("No main window");
        // Page.crash produces a real crash; forcefullyCrashRenderer reports "killed".
        contents.debugger.attach();
        void contents.debugger.sendCommand("Page.crash").catch(() => {});
      }, state.windowId);
      await expect
        .poll(() => run.app.evaluate(() => Reflect.get(globalThis, "recoveryEvents")))
        .toEqual(["gone:crashed", "loaded"]);
      // The page's real release-launch interface still answers with tools off.
      const health = await run.app.evaluate(
        ({ BrowserWindow }, id) =>
          BrowserWindow.fromId(id)?.webContents.executeJavaScript(
            "window.infinitary.app.healthcheck()",
          ),
        state.windowId,
      );
      expect(health).toMatchObject({ ok: true });
      console.log(
        JSON.stringify({
          build,
          menuRoles: state.roles,
          health,
          recovery: await run.app.evaluate(() => Reflect.get(globalThis, "recoveryEvents")),
        }),
      );
      await run.app.evaluate(async ({ BrowserWindow }, id) => {
        const contents = BrowserWindow.fromId(id)?.webContents;
        if (!contents) throw new Error("No main window");
        await new Promise<void>((resolve) => {
          contents.once("render-process-gone", () => resolve());
          if (!contents.debugger.isAttached()) contents.debugger.attach();
          void contents.debugger.sendCommand("Page.crash").catch(() => {});
        });
      }, state.windowId);
      expect(
        await run.app.evaluate(
          ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.webContents.isCrashed(),
          state.windowId,
        ),
      ).toBe(true);
      expect(await run.app.evaluate(() => Reflect.get(globalThis, "recoveryEvents"))).toEqual([
        "gone:crashed",
        "loaded",
        "gone:crashed",
      ]);
    } finally {
      await run.close();
    }
  });
}
