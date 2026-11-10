import { symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import type { Core } from "../../src/core";
import type { httpSecretBroker } from "../../src/core/secrets/httpBroker";
import { SECRETS_AREAS, SECRETS_WORDS } from "../../src/shared/secrets";
import type { DisposableCustody } from "../helpers/disposableCustody";
import { scratchDir } from "../helpers/scratchDirs";
import { type LaunchOptions, launchApp } from "./launch";
import { settingsSection } from "./settings";
import { focusOn, pressKey } from "./windowKeys";

/** The Secrets navigation owner: all journeys use the same native radio/keyboard path. */
export async function secretsArea(page: Page, area: (typeof SECRETS_AREAS)[number]["value"]) {
  const label = SECRETS_AREAS.find((option) => option.value === area)?.label;
  if (!label) throw new Error("Unknown Secrets section.");
  const radio = settingsSection(page, "secrets")
    .getByRole("radiogroup", { name: SECRETS_WORDS.area, exact: true })
    .getByRole("radio", { name: label, exact: true });
  await focusOn(radio);
  await pressKey(radio, "Space");
  return radio;
}

/** Custom references live in entry's optional details; all callers open them through this owner. */
export async function secretReference(page: Page) {
  const section = settingsSection(page, "secrets");
  const reference = section.getByLabel(SECRETS_WORDS.reference, { exact: true });
  if (!(await reference.isVisible())) {
    const details = section.getByText(SECRETS_WORDS.details, { exact: true });
    await focusOn(details);
    await pressKey(details, "Enter");
  }
  return reference;
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
 */
export async function launchSecrets(options: Omit<LaunchOptions, "entry" | "packaged"> = {}) {
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
        globalThis.secretsJourney = fixture;
        startApp(${JSON.stringify(resolve(root, "out/main"))}, null, {
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
  return launchApp({ ...options, entry, withMockProvider: options.withMockProvider ?? true });
}
