/**
 * The live check for the Codex and Grok account-list filters
 * (docs/model-lists.md, "The live check"): one read of each signed-in
 * account's own model list, with the verdict the app's safety rail would
 * give it. The filters ship behind that rail precisely because neither
 * endpoint could be verified without a signed-in account; this is the one
 * command that verifies them, on a machine that has them.
 *
 * Run it with the app QUIT - it resolves each account's auth from the same
 * store the app uses, and one process at a time must own a single-use
 * refresh token:
 *   pnpm check:account-models
 *   pnpm check:account-models --user-data /path/to/userData
 *
 * Output is statuses and model ids only. Node 24 strips the types; the core
 * loads through Vite (`scripts/moduleRunner.ts`).
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as AccountModels from "./account-models.ts";
import { defaultUserDataDir } from "./dispatch-corpus/userData.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

export type AccountModelsModule = typeof AccountModels;

export type CliArgs = { userDataDir: string; help: boolean };

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { userDataDir: defaultUserDataDir(), help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--user-data") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--user-data needs a value");
      args.userDataDir = value;
      index += 1;
    } else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const USAGE = `check-account-models: read each signed-in Codex and Grok account's own model list

  --user-data <dir>     the app's userData (default: this machine's release profile)

Quit the app first. Prints statuses and model ids only.
`;

export type MainDeps = {
  load: () => Promise<{ module: AccountModelsModule; close?: () => Promise<void> }>;
  print?: (line: string) => void;
};

/** The CLI's own loader: the core through a Vite module runner. */
export async function loadThroughVite(): ReturnType<MainDeps["load"]> {
  const runner = await openModuleRunner();
  try {
    const module = await runner.import<AccountModelsModule>(
      join(REPO_ROOT, "scripts", "account-models.ts"),
    );
    return { module, close: runner.close };
  } catch (caught) {
    await runner.close();
    throw caught;
  }
}

export async function main(
  argv: string[],
  deps: MainDeps = { load: loadThroughVite },
): Promise<number> {
  const print = deps.print ?? ((line: string) => console.log(line));
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (caught) {
    console.error(caught instanceof Error ? caught.message : String(caught));
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    print(USAGE);
    return 0;
  }
  const { module, close } = await deps.load();
  try {
    const reports = await module.readAccountModels(resolve(args.userDataDir));
    print(module.describeAccountModels(reports));
    // Verified means every account's list was read AND the rail accepted it.
    const verified =
      reports.length > 0 &&
      reports.every((report) => report.result.status === "ok" && report.rail?.ok === true);
    return verified ? 0 : 1;
  } finally {
    await close?.();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // The Pi runtimes keep a background catalog refresh alive; the answer
      // is already printed.
      setTimeout(() => process.exit(code), 100).unref();
    },
    (caught: unknown) => {
      console.error(caught instanceof Error ? (caught.stack ?? caught.message) : String(caught));
      process.exitCode = 1;
    },
  );
}
