import { symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { expect, type Page } from "@playwright/test";
import type { Core } from "../../src/core";
import type { CustodySlot } from "../../src/core/secrets/custody";
import type { httpSecretBroker } from "../../src/core/secrets/httpBroker";
import { SECRETS_AREAS } from "../../src/shared/secrets";
import type { DisposableCustody } from "../helpers/disposableCustody";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchOptions, launchApp } from "./launch";
import { settingsSection } from "./settings";
import { focusOn, pressKey } from "./windowKeys";

/**
 * The Secrets quiet rows' owner: all journeys open a row under the list the
 * same way, by its summary and the keyboard, and get that summary back.
 */
export async function secretsArea(page: Page, area: (typeof SECRETS_AREAS)[number]["value"]) {
  const label = SECRETS_AREAS.find((option) => option.value === area)?.label;
  if (!label) throw new Error("Unknown Secrets row.");
  const row = settingsSection(page, "secrets").locator(`details[data-secrets-area="${area}"]`);
  const summary = row.locator(":scope > summary");
  await expect(summary).toContainText(label);
  if ((await row.getAttribute("open")) === null) {
    await focusOn(summary);
    await pressKey(summary, "Enter");
  }
  await expect(row).toHaveAttribute("open", "");
  return summary;
}

/** Test-owned host resources only; the app, controller, IPC, native chrome and sealed files are real. */
export type SecretsJourney = {
  custody: DisposableCustody;
  core: Core;
  confirmation: boolean;
  confirmations: number;
  recovery: { archive: string; key: string; cancel: boolean };
  httpBroker: typeof httpSecretBroker;
  readProbe?: { deliveries: number; credentialMatched: boolean };
  /** A test may hold the actual view response, without replacing its contents. */
  finishViewRead?: () => void;
};
export type SecretsJourneyGlobal = typeof globalThis & { secretsJourney: SecretsJourney };

/**
 * INF-1109: inject disposable custody, private fixture file choices and a declared human-confirmation stand-in
 * through the app's host seam. No production setting, native store, credential
 * or extra IPC is involved. The ordinary hermetic launcher still owns HOME,
 * userData, provider isolation, the hidden window and cleanup.
 * `leftCustody` fills the stand-in custody before the app starts, as the items
 * an earlier data folder left in the computer's Keychain or Secret Service.
 */
export async function launchSecrets({
  leftCustody,
  ...options
}: Omit<LaunchOptions, "entry" | "packaged"> & {
  leftCustody?: ReadonlyMap<CustodySlot, Buffer>;
} = {}) {
  const entry = await secretsEntry({ leftCustody });
  return launchApp({ ...options, entry, withMockProvider: options.withMockProvider ?? true });
}

/**
 * The main entry `launchSecrets` starts, built once per call. With `run`, it
 * starts the app the way `<app> run` does, with no window (docs/run.md), so a
 * spec that spawns a run as a command gives it the same disposable Secrets.
 * The start is awaited at the top level, as `src/main/index.ts` awaits it:
 * Electron is ready once the entry module finishes, and a Linux run starts
 * its own display before that.
 */
export async function secretsEntry(
  options: { run?: boolean; leftCustody?: ReadonlyMap<CustodySlot, Buffer> } = {},
): Promise<string> {
  const left = [...(options.leftCustody ?? [])].map(([slot, bytes]) => [
    slot,
    bytes.toString("base64"),
  ]);
  const dir = scratchDir("infinitary-secrets-entry-");
  const root = process.cwd();
  const require = createRequire(import.meta.url);
  const fromVite = createRequire(require.resolve("vite"));
  const { build } = fromVite("esbuild") as { build: (options: unknown) => Promise<unknown> };
  const entry = join(dir, "entry.mjs");
  const appEntry = resolve(root, "out/main/app.js");
  symlinkSync(resolve(root, "node_modules"), join(dir, "node_modules"));
  await build({
    stdin: {
      contents: `
        import { app } from 'electron';
        import { startApp } from ${JSON.stringify(appEntry)};
        import { installMainProcessErrorHandlers } from './src/main/processErrors';
        import { disposableCustody } from './tests/helpers/disposableCustody';
        import { httpSecretBroker } from './src/core/secrets/httpBroker';
        import { readSecretRecoveryFiles, saveSecretRecoveryFiles } from './src/main/host/secretRecoveryFiles';
        installMainProcessErrorHandlers();
        app.setAppPath(${JSON.stringify(root)});
        const fixture = { custody: disposableCustody(), confirmation: true, confirmations: 0, core: null, httpBroker: httpSecretBroker,
          recovery: { archive: ${JSON.stringify(join(dir, "fixture-archive"))}, key: ${JSON.stringify(join(dir, "fixture-key"))}, cancel: false }
        };
        for (const [slot, bytes] of ${JSON.stringify(left)}) fixture.custody.slots.set(slot, Buffer.from(bytes, 'base64'));
        globalThis.secretsJourney = fixture;
        await startApp(${JSON.stringify(resolve(root, "out/main"))}, ${options.run ? "{ args: [] }" : "null"}, {
          secrets: {
            custody: fixture.custody,
            recovery: {
              chooseSave: async () => fixture.recovery.cancel ? undefined : files => saveSecretRecoveryFiles(fixture.recovery, files),
              chooseRestore: async () => fixture.recovery.cancel ? undefined : readSecretRecoveryFiles(fixture.recovery)
            },
            authentication: {
              available: async () => true,
              confirm: async () => { fixture.confirmations += 1; return fixture.confirmation; }
            }
          },
          started: core => { fixture.core = core; }
        });
      `,
      loader: "ts",
      resolveDir: root,
    },
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node24",
    tsconfig: resolve(root, "tsconfig.node.json"),
    outfile: entry,
    // Only fixture capabilities are bundled here. Main, its defines, virtual
    // modules and assets come unchanged from electron.vite.config.ts's build.
    external: [appEntry],
  });
  return entry;
}
