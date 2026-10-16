import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as Published from "../src/shared/publishedContract.ts";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";

/**
 * Writes docs/contract.json, the published contract (docs/contract.md),
 * from `src/shared/publishedContract.ts`. The contract is app code with
 * aliased, extensionless imports, so it loads through the Vite module runner
 * the other scripts use. The freshness test renders it again and compares,
 * so a contract change without `pnpm generate:contract` fails CI.
 */
const runner = await openModuleRunner();
try {
  const { CONTRACT_FILE, renderPublishedContract } = await runner.import<typeof Published>(
    join(REPO_ROOT, "src", "shared", "publishedContract.ts"),
  );
  writeFileSync(join(REPO_ROOT, CONTRACT_FILE), renderPublishedContract());
  console.log(`wrote ${CONTRACT_FILE}`);
} finally {
  await runner.close();
}
