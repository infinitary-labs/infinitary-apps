import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The folder inside a run's private root (./runTempRoot.ts) where Vitest's
 * Chromium keeps its own temporary files, apart from the root's top level
 * that the run's leftover scan reads.
 *
 * Playwright starts Chromium on Linux with --disable-dev-shm-usage, so each
 * Chromium process keeps its shared memory as a file in TMPDIR, made from
 * Chromium's template `.org.chromium.Chromium.XXXXXX` and unlinked right
 * after. A process that ends between the two, such as a renderer ended as its
 * page closes or a child ended as the browser shuts down, leaves that file
 * behind though no test made it. The run's global setup makes this folder and
 * removes it once the browser has closed, before the scan
 * (./vitestGlobalSetup.ts).
 */
export const CHROMIUM_TEMP = "chromium-temp";

export function openChromiumTemp(root: string): void {
  mkdirSync(join(root, CHROMIUM_TEMP));
}

/** Only once every browser has closed: a running Chromium makes its shared memory here. */
export function closeChromiumTemp(root: string): void {
  rmSync(join(root, CHROMIUM_TEMP), { recursive: true, force: true });
}

/**
 * Playwright launch options that start Chromium with TMPDIR at its own
 * folder. Vitest reads `env` as it opens the browser, after the global setup
 * pointed TMPDIR at the run's root and dropped the starting session's
 * variables; a plain value would be fixed as the config loads, before either.
 * The getter makes nothing, because Vitest also copies the config, and so
 * reads it, while loading it.
 */
export function chromiumLaunchOptions<T extends object>(
  options: T,
): T & { readonly env: Record<string, string> } {
  return {
    ...options,
    get env() {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(process.env))
        if (value !== undefined) env[name] = value;
      env.TMPDIR = join(tmpdir(), CHROMIUM_TEMP);
      return env;
    },
  };
}
