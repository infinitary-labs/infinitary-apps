import type { ApiRoute } from "./api";
import { ForgeError } from "./forge";

/** Raw API writes never substitute for the version-pinned merge card. */
export const MERGE_WRITE_REFUSAL =
  "Merging or moving or deleting the default branch requires the merge card. Prepare a review with check_change pull, then ask with request_merge; github_write cannot send it.";

/**
 * Recognize typed API operations, not the crewmate's words. Scope and path
 * validation run first. Read the default branch fresh only for a write that
 * could move it; an unreadable destination refuses the write, never guesses.
 */
export async function guardApiWrite(
  kind: "github" | "gitlab",
  route: ApiRoute,
  body: unknown,
  defaultBranch: () => Promise<string>,
): Promise<void> {
  const rest = route.rest
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/")
    .replace(/\/+$/, "");
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  // GitHub's contents writes take branch from JSON, not a query parameter.
  const branchInput =
    kind === "github"
      ? data.branch
      : (data.branch ?? new URLSearchParams(route.path.split("?")[1]).get("branch"));
  let destination: Promise<string> | undefined;
  const readDefault = () =>
    (destination ??= defaultBranch().catch((caught: unknown) => {
      if (caught instanceof ForgeError && caught.failure === "sign-in") throw caught;
      throw new ForgeError(
        "refused",
        `The default branch could not be read. ${MERGE_WRITE_REFUSAL}`,
      );
    }));
  const refuse = (): never => {
    throw new ForgeError("refused", MERGE_WRITE_REFUSAL);
  };
  if (
    (kind === "github" &&
      (/^pulls\/\d+\/(?:merge(?:-async)?|update-branch)(?:\/|$)/.test(rest) ||
        rest === "merges" ||
        rest === "merge-upstream")) ||
    (kind === "gitlab" && /^merge_requests\/\d+\/merge(?:\/|$)/.test(rest)) ||
    (rest === "" && "default_branch" in data)
  )
    refuse();

  let branch: string | undefined;
  if (kind === "github") {
    if (/^git\/refs\/heads\//.test(rest)) branch = rest.slice("git/refs/heads/".length);
    else if (
      rest === "git/refs" &&
      typeof data.ref === "string" &&
      data.ref.startsWith("refs/heads/")
    )
      branch = data.ref.slice("refs/heads/".length);
    else if (/^branches\/.+\/rename$/.test(rest)) {
      branch = rest.slice("branches/".length, -"/rename".length);
      // Renaming another branch onto the default branch is also a move.
      const name = await readDefault();
      if (branch === name || data.new_name === name) refuse();
      return;
    } else if (/^contents(?:\/|$)/.test(rest)) {
      branch = typeof branchInput === "string" ? branchInput : await readDefault();
    }
  } else {
    if (/^repository\/branches\//.test(rest)) branch = rest.slice("repository/branches/".length);
    else if (/^repository\/(?:commits|files(?:\/|$))/.test(rest)) {
      branch = typeof branchInput === "string" ? branchInput : await readDefault();
    } else if (rest === "repository/branches" && typeof data.branch === "string") {
      branch = data.branch;
    }
  }
  if (branch !== undefined) {
    const name = branch.replace(/^refs\/heads\//, "");
    if (name === "HEAD" || name === (await readDefault())) refuse();
  }
}
