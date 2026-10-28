import naming from "../../../resources/runbooks/naming/runbook.json" with { type: "json" };
import type { NamingRule } from "../../shared/runbooks";
import { git } from "./git";

/** Release-please recognises these conventional subjects; scopes are open-ended. */
export const DEFAULT_NAMING_RULE: NamingRule = naming.naming;

export function requireConventional(
  subject: string,
  what = "commit",
  rule: NamingRule | null = DEFAULT_NAMING_RULE,
): string {
  if (rule === null) return subject;
  if (!new RegExp(rule.pattern).test(subject) || subject.includes("\n")) {
    throw new Error(
      `The ${what} needs a conventional name. ${rule.message} Received: ${JSON.stringify(subject)}.`,
    );
  }
  return subject;
}

/**
 * Check only commits introduced by the branch, not historical commits on its
 * base. Merge commits that take newer work in are skipped: git names them,
 * and they bring in no work of the branch's own.
 */
export async function requireConventionalRange(
  dir: string,
  base: string,
  head: string,
  rule: NamingRule | null = DEFAULT_NAMING_RULE,
): Promise<void> {
  const lines = await git(dir, ["log", "--no-merges", "--format=%s", `${base}..${head}`]);
  for (const subject of lines.split("\n").filter(Boolean))
    requireConventional(subject, "commit", rule);
}
