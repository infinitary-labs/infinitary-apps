import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The one way a test makes a throwaway directory. `scratchDir` is
 * `mkdtempSync(join(tmpdir(), prefix))` that also registers the directory
 * for removal, so a test never has to remember its own cleanup:
 *
 * - under vitest, tests/helpers/scratchDirCleanup.ts removes every registered
 *   directory after the test file finishes, pass or fail;
 * - under Playwright, the worker removes them as it exits, because a
 *   relaunch test reads the same userData after the first app quit.
 *
 * Either way the run's private TMPDIR (runTempRoot.ts) must be empty at the
 * end, and the run fails naming whatever is left.
 */
type Registry = { dirs: Set<string> };

/** Set by the e2e global setup (tests/e2e/globalSetup.ts) to the run's root. */
export const E2E_RUN_ROOT = "INFINITARY_E2E_RUN_ROOT";

// One registry per process, however many times a runner re-imports this
// module, so exactly one exit handler is ever installed.
const KEY = Symbol.for("infinitary.tests.scratchDirs");
const holder = globalThis as { [KEY]?: Registry };
const registry: Registry = holder[KEY] ?? install();

function install(): Registry {
  const created: Registry = { dirs: new Set() };
  holder[KEY] = created;
  process.once("exit", () => removeAll(created.dirs));
  return created;
}

function removeAll(dirs: Set<string>): void {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Left for the run's leak report to name.
    }
    dirs.delete(dir);
  }
}

export function scratchDir(prefix: string): string {
  // Playwright's runner loads every spec to list it, running module scope and
  // describe bodies there; a directory made then outlives every worker's
  // cleanup, so it is refused where it would be made.
  if (process.env[E2E_RUN_ROOT] && process.env.TEST_WORKER_INDEX === undefined) {
    throw new Error(
      `scratchDir("${prefix}") ran while Playwright was loading the spec; make it in a hook or a test.`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  registry.dirs.add(dir);
  return dir;
}

/**
 * A throwaway directory for Unix sockets, registered like `scratchDir`, under
 * `/tmp` rather than the run's TMPDIR: a socket's whole path must fit in 104
 * bytes on macOS, and OpenSSH adds 17 to a control socket's while it makes
 * one, which a path under the run's root on a Mac can pass.
 */
export function socketScratchDir(prefix: string): string {
  if (process.env[E2E_RUN_ROOT] && process.env.TEST_WORKER_INDEX === undefined) {
    throw new Error(
      `socketScratchDir("${prefix}") ran while Playwright was loading the spec; make it in a hook or a test.`,
    );
  }
  const dir = mkdtempSync(join("/tmp", prefix));
  registry.dirs.add(dir);
  return dir;
}

/** Registers a directory made some other way for the same removal. */
export function removeLater(dir: string): string {
  registry.dirs.add(dir);
  return dir;
}

/** Removes every registered directory now. */
export function removeScratchDirs(): void {
  removeAll(registry.dirs);
}
