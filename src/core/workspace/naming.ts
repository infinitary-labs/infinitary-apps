import type { NamingRule } from "@shared/runbooks";
import { cutText } from "@shared/textCut";
import { git } from "./git";

/*
 * Every commit and pull request name follows the active naming runbook
 * alone (docs/runbooks.md, "Built-ins"): the app holds no convention of its
 * own. `null` means no naming runbook is on, so nothing is checked and a
 * commit the app writes itself carries its plain summary.
 */

export function requireNamed(name: string, what: string, rule: NamingRule | null): string {
  if (rule === null) return name;
  if (!new RegExp(rule.pattern).test(name) || name.includes("\n")) {
    throw new Error(
      `The ${what} does not follow the naming runbook. ${rule.message} Received: ${JSON.stringify(name)}.`,
    );
  }
  return name;
}

/**
 * Check only commits introduced by the branch, not historical commits on its
 * base. Merge commits that take newer work in are skipped: git names them,
 * and they bring in no work of the branch's own.
 */
export async function requireNamedRange(
  dir: string,
  base: string,
  head: string,
  rule: NamingRule | null,
): Promise<void> {
  if (rule === null) return;
  const lines = await git(dir, ["log", "--no-merges", "--format=%s", `${base}..${head}`]);
  for (const subject of lines.split("\n").filter(Boolean)) requireNamed(subject, "commit", rule);
}

/**
 * The name of a commit the app writes itself: the runbook's `compose` form
 * around the app's plain summary, or the summary alone when the runbook
 * gives no form or none is on.
 */
export function composedName(summary: string, rule: NamingRule | null): string {
  return rule?.compose ? rule.compose.replaceAll("{summary}", () => summary) : summary;
}

/**
 * A subject someone else wrote, such as a crewmate's report, kept when the
 * runbook accepts it and otherwise put in the runbook's form, within
 * `width` characters of the form's own words.
 */
export function namedSubject(subject: string, rule: NamingRule | null, width: number): string {
  if (!rule?.compose || new RegExp(rule.pattern).test(subject)) return subject;
  const room = Math.max(0, width - composedName("", rule).length);
  return composedName(cutText(subject, room), rule);
}

/** The footers of a pull request's own text that the runbook has its squash commit message carry. */
export function carriedFooters(text: string, rule: NamingRule | null): string[] {
  if (!rule?.footer) return [];
  return [...text.matchAll(new RegExp(rule.footer, "gm"))]
    .map((match) => match[0].replaceAll("\r\n", "\n"))
    .filter(Boolean);
}
