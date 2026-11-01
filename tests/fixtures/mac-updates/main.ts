import type { IpcMain } from "electron";
import {
  DIRECT_MAC_INSTALLATION,
  parseMacInstallation,
} from "../../../src/core/update/macInstallation";
import { MacUpdateProblem, MacUpdateReadyProblem } from "../../../src/core/update/macUpdates";
import { releaseSource } from "../../../src/core/update/releaseSource";
import { buildUpdateTarget } from "../../../src/core/update/updateChannels";
import { createInstalledUpdateChecker } from "../../../src/core/update/updateChecker";
import type { UpdateChannel } from "../../../src/shared/update";
import { UPDATE_PROBLEMS } from "../../../src/shared/updateWords";

/** A native-effect stand-in, not evidence of signing, download integrity or installed upgrades. */
export function install(
  ipcMain: IpcMain,
  dataRoot: string,
  currentVersion: string,
  receipt = DIRECT_MAC_INSTALLATION,
) {
  const state = {
    targets: { stable: "0.5.0", alpha: "0.5.1-alpha.11" } as Record<UpdateChannel, string | null>,
    downloads: 0,
    installations: 0,
    failRestart: false,
    /** The feed cannot be read. */
    failCheck: false,
    checks: 0,
    opened: [] as string[],
    progress: (_: number) => {},
    finish: () => {},
    fail: (_: string) => {},
  };
  const installation = parseMacInstallation(receipt);
  const checker = createInstalledUpdateChecker({
    app: { packaged: true, platform: "darwin", userDataDir: dataRoot, version: currentVersion },
    // Only the target metadata is stood in; no real cask artifact is downloaded by this UI fixture.
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          targets: Object.fromEntries(
            Object.entries(state.targets).flatMap(([channel, version]) =>
              version
                ? [
                    [
                      channel,
                      buildUpdateTarget(
                        {
                          version,
                          assetName: `Infinitary-${version}-universal.zip`,
                          sha256: "a".repeat(64),
                          sourceCommit: "b".repeat(40),
                        },
                        installation.kind === "homebrew" ? installation.tap : undefined,
                      ),
                    ],
                  ]
                : [],
            ),
          ),
        }),
      ),
    openExternal: (url) => {
      state.opened.push(url);
    },
    macDriver: {
      installation,
      check: async (channel) => {
        state.checks++;
        if (state.failCheck) throw new Error("The feed could not be read.");
        const version = state.targets[channel];
        return version ? { version, releaseUrl: releaseSource.releaseUrl(version) } : null;
      },
      download: async (_, progress, signal) => {
        state.downloads++;
        state.progress = progress;
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new Error("Cancelled"));
          state.finish = () => {
            signal.removeEventListener("abort", abort);
            resolve();
          };
          state.fail = (message) => {
            signal.removeEventListener("abort", abort);
            reject(new MacUpdateProblem(message));
          };
          signal.addEventListener("abort", abort, { once: true });
        });
      },
      install: async () => {
        state.installations++;
        if (state.failRestart) throw new MacUpdateReadyProblem(UPDATE_PROBLEMS.staged);
      },
    },
  });
  for (const name of [
    "inf:update:status",
    "inf:update:check",
    "inf:update:channel",
    "inf:update:install",
    "inf:update:open-release",
  ])
    ipcMain.removeHandler(name);
  ipcMain.handle("inf:update:status", () => checker.getStatus());
  ipcMain.handle("inf:update:check", () => checker.checkNow());
  ipcMain.handle("inf:update:channel", (_, channel) => checker.setChannel?.(channel));
  ipcMain.handle("inf:update:install", () => checker.install());
  ipcMain.handle("inf:update:open-release", () => checker.openReleasePage());
  return state;
}
