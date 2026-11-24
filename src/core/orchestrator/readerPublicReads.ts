import type { ForgeKind } from "@shared/forge";

/**
 * The areas of a public GitHub repository anyone may read, as paths under
 * `/repos/{owner}/{repo}` (docs/agents-reach.md, "Web pages"). The captain's
 * sign-in reads more of the same repository - secret-scanning, code-scanning
 * and Dependabot alerts, draft advisories, Actions variables, hooks and keys
 * among them - so a path outside this list marks the reader as holding.
 * A new area joins only once anyone signed out can read it on a public
 * repository.
 */
const GITHUB_PUBLIC_AREAS: readonly (readonly string[])[] = [
  [],
  ["issues"],
  ["pulls"],
  ["comments"],
  ["commits"],
  ["contents"],
  ["readme"],
  ["git"],
  ["branches"],
  ["tags"],
  ["compare"],
  ["releases"],
  ["labels"],
  ["milestones"],
  ["actions", "runs"],
  ["actions", "jobs"],
  ["actions", "workflows"],
];

/**
 * Whether a reader's read of its own project, `rest` being the path under
 * the project (`ApiRoute.rest`), reaches only what anyone may read when the
 * project is public. GitLab and Bitbucket set each area of a public project
 * members-only on its own, and GitLab's project answer carries a runner
 * token to its maintainers, so no path there is known public and every read
 * there marks the reader.
 */
export function publicProjectRead(kind: ForgeKind, rest: string): boolean {
  if (kind !== "github") return false;
  const segments = rest
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => decodeURIComponent(segment).toLowerCase());
  return GITHUB_PUBLIC_AREAS.some((area) =>
    area.length === 0
      ? segments.length === 0
      : area.every((segment, index) => segments[index] === segment),
  );
}

/** What a read beyond the public areas leaves the reader holding, for its tool answers and record. */
export function projectReadHeld(rest: string): string {
  const area = rest.split("/").slice(0, 2).join("/");
  // i18n-exempt: served to the crewmate as a tool answer
  return area
    ? `its project's ${area}, which the public may not see`
    : "its project's own settings, which the public may not see";
}
