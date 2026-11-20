import { join, resolve } from "node:path";
import { build } from "vite";
import { DIRECT_MAC_INSTALLATION } from "../../src/core/update/macInstallation";
import type { install } from "../fixtures/mac-updates/main";
import { scratchDir } from "../helpers/scratchDirs";
import type { LaunchedApp } from "./launch";
import { untilWindowCommands } from "./windowKeys";

declare global {
  var __macUpdateFixture: ReturnType<typeof install>;
}

/** Real update controller and IPC/UI, with native download/replacement effects stood in. */
export async function arrangeMacUpdates(
  launched: LaunchedApp,
  version: string,
  targets?: Partial<Record<"stable" | "alpha", string | null>>,
  receipt = DIRECT_MAC_INSTALLATION,
) {
  const health = await launched.page.evaluate(() => window.infinitary.app.healthcheck());
  const output = scratchDir("inf-mac-update-fixture-");
  await build({
    configFile: false,
    logLevel: "silent",
    resolve: { alias: { "@shared": resolve("src/shared"), "@core": resolve("src/core") } },
    build: {
      outDir: output,
      minify: false,
      lib: {
        entry: resolve("tests/fixtures/mac-updates/main.ts"),
        formats: ["cjs"],
        fileName: () => "fixture.cjs",
      },
      rollupOptions: { external: [/^node:/, "electron"] },
    },
  });
  await launched.app.evaluate(
    async ({ ipcMain }, args) => {
      const require = process.getBuiltinModule("module").createRequire(process.execPath);
      const fixture = require(args.module);
      globalThis.__macUpdateFixture = fixture.install(
        ipcMain,
        args.dataRoot,
        args.version,
        args.receipt,
      );
      Object.assign(globalThis.__macUpdateFixture.targets, args.targets);
      ipcMain.removeHandler("inf:app:healthcheck");
      ipcMain.handle("inf:app:healthcheck", () => ({ ...args.health, version: args.version }));
    },
    {
      module: join(output, "fixture.cjs"),
      dataRoot: launched.userDataDir,
      version,
      targets,
      receipt,
      health,
    },
  );
  await launched.page.reload();
  await untilWindowCommands(launched.page);
}
