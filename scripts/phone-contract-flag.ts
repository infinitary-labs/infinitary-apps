/**
 * The phone contract flag (INF-4500's weekly audit, addition 4;
 * docs/testing.md, "What a task branch requests"). A change that moves the
 * published contract's major or its view floor (`PROTOCOL_VERSION` and
 * `VIEW_FLOOR` in src/shared/ipc.ts) can leave the next alpha waiting for a
 * phone build that keeps changing things on it (docs/alpha.md, "The phone
 * goes first"). Seven alpha cuts failed after a change raised the view floor
 * on purpose and no phone build followed it. This compares the two values
 * with the change's base and, when either moved, names the after-merge step
 * the change's story carries. It flags; it never fails the check, since the
 * move is the change's own choice.
 *
 *   node scripts/phone-contract-flag.ts --base <commit>
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const IPC_FILE = "src/shared/ipc.ts";

export type ContractLine = { major: number; floor: number };

/** The contract's major and view floor as `src/shared/ipc.ts` declares them; undefined when unreadable. */
export function contractLine(text: string): ContractLine | undefined {
  const version = /export const PROTOCOL_VERSION = "(\d+)\.\d+\.\d+";/.exec(text);
  const floor = /export const VIEW_FLOOR = (\d+);/.exec(text);
  if (!version || !floor) return undefined;
  return { major: Number(version[1]), floor: Number(floor[1]) };
}

/** What the flag says when the change moved the major or the view floor; undefined when neither moved. */
export function phoneFlag(before: ContractLine, after: ContractLine): string | undefined {
  const moved: string[] = [];
  if (after.major !== before.major) moved.push(`the contract's major from ${before.major} to ${after.major}`);
  if (after.floor !== before.floor) moved.push(`the view floor from ${before.floor} to ${after.floor}`);
  if (!moved.length) return undefined;
  return [
    `This change moves ${moved.join(" and ")} (${IPC_FILE}).`,
    "The next alpha waits for a phone build on TestFlight that keeps changing things on it (docs/alpha.md, \"The phone goes first\").",
    "Put the step that cuts that phone build from main before the next alpha on the change's story as an after-merge step, unless the major's contract change file says Views: keep and the build already on TestFlight reaches it.",
  ].join(" ");
}

function show(ref: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${ref}:${IPC_FILE}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--base");
  const base = at > 0 ? process.argv[at + 1] : undefined;
  if (!base) {
    console.error("usage: node scripts/phone-contract-flag.ts --base <commit>");
    process.exit(2);
  }
  const before = contractLine(show(base) ?? "");
  const after = contractLine(readFileSync(resolve(ROOT, IPC_FILE), "utf8"));
  // A base without the file, or a file in another shape, says nothing to flag.
  const flag = before && after ? phoneFlag(before, after) : undefined;
  if (flag) {
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log(`::warning file=${IPC_FILE},title=Phone build needed before the next alpha::${flag}`);
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Phone build needed before the next alpha\n\n${flag}\n`);
    } else console.log(`phone contract: ${flag}`);
  }
}
