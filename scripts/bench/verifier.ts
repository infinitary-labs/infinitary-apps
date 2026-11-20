/**
 * The verifier seam of the headless attempt driver (`scripts/bench/`).
 *
 * One interface in, one out: a unified diff against the task's base commit
 * plus the task id go in; the task's `reward.json` scores come out. The
 * runtime that grades for real (the task container and its official
 * verifier) is built beside this one and plugs in through
 * `commandVerifier`: any executable called as
 *
 *   <command> <task-id> <patch-path> <out-dir>
 *
 * that writes `<out-dir>/reward.json` and exits 0. Until it lands,
 * `stubVerifier` grades on the host: the patch must apply to a clean
 * checkout of the base commit, and an optional check command must pass
 * there.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The scores a verifier writes. `reward` is the binary pass (1 or 0);
 * `partial` the fraction of graded tests that passed. The task verifier
 * adds its own counts (`f2p_total`, `p2p_passed`, ...), carried as they are.
 */
export type Reward = {
  reward: number;
  partial?: number;
  [field: string]: unknown;
};

export type VerifyInput = {
  taskId: string;
  /** A unified diff (`git diff --binary`) against the task's base commit. */
  patchPath: string;
  /** Where the verifier writes `reward.json` and anything else it keeps. */
  outDir: string;
};

export type Verifier = {
  /** Named on the row, so a stub-graded row is never mistaken for a real one. */
  readonly kind: string;
  verify: (input: VerifyInput) => Promise<Reward>;
};

export function readReward(path: string): Reward {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { reward?: unknown }).reward !== "number"
  ) {
    throw new Error(`${path} carries no numeric reward`);
  }
  return parsed as Reward;
}

/** The real runtime's seam: an executable that writes `<out-dir>/reward.json`. */
export function commandVerifier(command: string): Verifier {
  return {
    kind: `command:${command}`,
    verify: async ({ taskId, patchPath, outDir }) => {
      mkdirSync(outDir, { recursive: true });
      const run = spawnSync(command, [taskId, patchPath, outDir], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      writeFileSync(join(outDir, "verifier-stdout.txt"), `${run.stdout ?? ""}${run.stderr ?? ""}`);
      if (run.error) throw run.error;
      if (run.status !== 0) {
        throw new Error(`${command} exited ${run.status}; see verifier-stdout.txt`);
      }
      const rewardPath = join(outDir, "reward.json");
      if (!existsSync(rewardPath)) throw new Error(`${command} wrote no reward.json`);
      return readReward(rewardPath);
    },
  };
}

/**
 * The local stand-in: applies the patch to a fresh clone of `repo` at
 * `base` and, when given, runs `check` there through `sh -c`. Reward 1 only
 * when the patch applies and the check passes; an empty patch scores 0.
 */
export function stubVerifier(options: { repo: string; base: string; check?: string }): Verifier {
  return {
    kind: "stub",
    verify: async ({ patchPath, outDir }) => {
      mkdirSync(outDir, { recursive: true });
      const checkout = mkdtempSync(join(outDir, "stub-checkout-"));
      const log: string[] = [];
      const score = (reward: number, fields: Record<string, unknown>): Reward => {
        const result = { reward, partial: reward, ...fields };
        writeFileSync(join(outDir, "reward.json"), `${JSON.stringify(result)}\n`);
        writeFileSync(join(outDir, "verifier-stdout.txt"), log.join("\n"));
        return result;
      };
      try {
        execFileSync("git", ["clone", "--quiet", "--no-checkout", options.repo, checkout]);
        execFileSync("git", ["-C", checkout, "checkout", "--quiet", "--detach", options.base]);
        const patch = readFileSync(patchPath, "utf8");
        if (patch.trim() === "") return score(0, { applied: false, empty: true });
        const apply = spawnSync("git", ["-C", checkout, "apply", "--binary", patchPath], {
          encoding: "utf8",
        });
        log.push(`git apply: exit ${apply.status}`, apply.stderr ?? "");
        if (apply.status !== 0) return score(0, { applied: false });
        if (!options.check) return score(1, { applied: true });
        const check = spawnSync("sh", ["-c", options.check], { cwd: checkout, encoding: "utf8" });
        log.push(`check: exit ${check.status}`, check.stdout ?? "", check.stderr ?? "");
        return score(check.status === 0 ? 1 : 0, { applied: true, check_exit: check.status });
      } finally {
        rmSync(checkout, { recursive: true, force: true });
      }
    },
  };
}
