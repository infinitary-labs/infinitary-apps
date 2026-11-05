import { execFileSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { defaultUserDataDir } from "../dispatch-corpus/userData.ts";
import { openModuleRunner, REPO_ROOT } from "../moduleRunner.ts";
import type * as Eval from "./runner.ts";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    out: { type: "string", default: "test-results/account-eval" },
    "user-data": { type: "string" },
    live: { type: "boolean", default: false },
    "approved-hash": { type: "string" },
    "claude-crew-turn": { type: "boolean", default: false },
    "firstmate-account": { type: "string" },
    "firstmate-provider": { type: "string" },
    "firstmate-model": { type: "string" },
    "builder-account": { type: "string" },
    "builder-provider": { type: "string" },
    "builder-model": { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(`Developer account evaluation: default mode writes a free run sheet, never calls a model.
  --out DIR --user-data DIR --module PATH (optional exported evaluation module)
  --firstmate-account ID --firstmate-provider PROVIDER --firstmate-model MODEL
    Omit all three to read only the two Firstmate settings rows.
  --builder-account ID --builder-provider PROVIDER --builder-model MODEL
  --live --approved-hash HASH
    Only after the captain approves that exact sheet. Never permission to merge.
  --claude-crew-turn
    Run from a Claude crewmate's own shell and hold the turn until the run exits.
    The runner refuses to start, or stops, when it is not under that crewmate's client.
Review responses.json independently, then use approval-handoff.ts --responses.`);
} else {
  const runner = await openModuleRunner();
  try {
    const module = await runner.import<typeof Eval>(join(REPO_ROOT, "scripts/evals/runner.ts"));
    const { hostEnv } = await runner.import<typeof import("../../src/core/hostEnv.ts")>(
      join(REPO_ROOT, "src/core/hostEnv.ts"),
    );
    const userData = resolve(values["user-data"] ?? defaultUserDataDir());
    const ref = (role: "firstmate" | "builder") => {
      const accountId = values[`${role}-account`];
      const provider = values[`${role}-provider`];
      const model = values[`${role}-model`];
      if (!accountId && !provider && !model) return undefined;
      if (!accountId || !provider || !model) throw new Error(`Name all three ${role} fields`);
      return { accountId, provider, model };
    };
    const version = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      env: hostEnv(),
      encoding: "utf8",
    }).trim();
    const diff = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: REPO_ROOT,
      env: hostEnv(),
      encoding: "utf8",
    });
    if (diff.trim()) throw new Error("Run sheets require a committed, clean version");
    if (values.module) {
      const path = relative(REPO_ROOT, resolve(values.module));
      if (path === ".." || path.startsWith(`..${sep}`))
        throw new Error("Evaluation modules must belong to the committed version");
    }
    const evaluation = values.module
      ? (await runner.import<{ evaluation: Eval.EvaluationModule }>(resolve(values.module)))
          .evaluation
      : undefined;
    const result = await module.runEvaluation(
      {
        out: resolve(values.out),
        version,
        sourceHash: version,
        roles: module.accountModels(userData, ref("firstmate"), ref("builder")),
        userData,
        live: values.live,
        approvedHash: values["approved-hash"],
        claudeCrewTurn: values["claude-crew-turn"],
      },
      { module: evaluation },
    );
    console.log(module.artifact(result.sheet));
    console.log(`Run sheet hash: ${result.sheetHash}`);
    if (result.responses && Object.values(result.responses).some((run) => !run.endedNormally))
      process.exitCode = 1;
  } catch {
    // Never print a provider's exception: it can contain headers or credentials.
    console.error(
      "Evaluation refused or stopped. Check explicit model/account fields, the approved hash, the Claude crewmate's client and clean version. No automatic retry.",
    );
    process.exitCode = 2;
  } finally {
    await runner.close();
  }
}
