/**
 * Loading app core modules from a plain-Node script. Node 24 strips types
 * but cannot resolve what core modules import: the `@core` / `@shared`
 * aliases and extensionless relative paths (`db.ts` importing
 * `./inboxStore`). So a script that needs the core - the replay engine, the
 * task record export - loads it through a Vite module runner instead, the
 * way vitest does. Scripts that only read tables or JSONL stay plain Node.
 *
 * The runner stays open until `close`: modules under it import lazily (the
 * Pi SDK), which a one-shot `runnerImport` would refuse once it closed.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type ModuleRunner = {
  import: <T>(path: string) => Promise<T>;
  close: () => Promise<void>;
};

export async function openModuleRunner(): Promise<ModuleRunner> {
  const { createServer, createServerModuleRunner } = await import("vite");
  const server = await createServer({
    configFile: false,
    root: REPO_ROOT,
    logLevel: "error",
    appType: "custom",
    // HMR-off still opens Vite's WebSocket listener; offline imports need
    // neither transport nor a shared development port.
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    // Nothing is served to a browser, so the client's dependency scan has no
    // work; left on, a short-lived runner closing mid-scan prints its errors.
    optimizeDeps: { noDiscovery: true, entries: [] },
    resolve: {
      alias: {
        "@core": join(REPO_ROOT, "src", "core"),
        "@shared": join(REPO_ROOT, "src", "shared"),
        // The panel library a Tasks panel module reads (src/panels/now/rows.ts), for the phone's recorded readings.
        "@infinitary/ui": join(REPO_ROOT, "src", "renderer", "src", "design", "index.ts"),
      },
    },
  });
  const runner = createServerModuleRunner(server.environments.ssr, { hmr: false });
  return {
    import: async <T>(path: string) => (await runner.import(path)) as T,
    close: async () => {
      await runner.close();
      await server.close();
    },
  };
}
