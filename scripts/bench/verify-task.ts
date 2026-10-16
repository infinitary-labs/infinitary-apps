#!/usr/bin/env node
/**
 * The S0 verifier runner behind the attempt driver's verifier seam
 * (`commandVerifier` in `verifier.ts`, `--verifier` on `run-attempt.ts`):
 *
 *   scripts/bench/verify-task.ts <task-id> <patch-path> <out-dir>
 *
 * grades the patch with the task's own verifier in a fresh task container
 * and writes its `reward.json`, verbatim, to `<out-dir>/reward.json`, exiting 0. The
 * verifier's logs land in `<out-dir>/verifier/` and the graded patch in
 * `<out-dir>/artifacts/model.patch`. When the verifier itself fails (a
 * timeout, or no reward) it writes no `reward.json` and exits 3, so the
 * driver records an infrastructure failure, never a 0. See INTERFACE.md.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { taskById } from "./pool.ts";
import { runVerifier } from "./verifierRunner.ts";

const VERIFIER_FAILED = 3;

async function main(argv: string[]): Promise<number> {
  const [taskId, patchPath, outDir] = argv;
  if (!taskId || !patchPath || !outDir || argv.length !== 3) {
    process.stderr.write("usage: verify-task.ts <task-id> <patch-path> <out-dir>\n");
    return 2;
  }
  const result = await runVerifier(taskById(taskId), readFileSync(patchPath), { logsDir: outDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.reward < 0) return VERIFIER_FAILED;
  writeFileSync(join(outDir, "reward.json"), `${JSON.stringify(result.scores)}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`[bench] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
