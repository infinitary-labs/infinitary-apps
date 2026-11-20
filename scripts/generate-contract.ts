import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Published from "../src/shared/publishedContract.ts";
import { staleGeneratedFile } from "./github-errors.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

/**
 * Writes docs/contract.json, the published contract (docs/contract.md),
 * from `src/shared/publishedContract.ts`. The contract is app code with
 * aliased, extensionless imports, so it loads through the Vite module runner
 * the other scripts use. With `--check`, which `pnpm check` runs, it writes
 * nothing and fails when the file differs from what it would write: a
 * published shape changed without `pnpm generate:contract` passed the pull
 * request check, because the freshness test runs only when it reads a
 * changed file (INF-4500's weekly audit, addition 5).
 */
const runner = await openModuleRunner();
try {
  const { CONTRACT_FILE, renderPublishedContract } = await runner.import<typeof Published>(
    join(REPO_ROOT, "src", "shared", "publishedContract.ts"),
  );
  const path = join(REPO_ROOT, CONTRACT_FILE);
  const rendered = renderPublishedContract();
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== rendered)
      throw staleGeneratedFile(CONTRACT_FILE, "pnpm generate:contract");
  } else {
    writeFileSync(path, rendered);
    console.log(`wrote ${CONTRACT_FILE}`);
  }
} finally {
  await runner.close();
}
