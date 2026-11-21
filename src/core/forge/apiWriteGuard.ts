import { fixedHoldWords } from "@shared/holds";
import type { ApiRoute, RawApiKind } from "./api";
import { ForgeError } from "./forge";

/** Raw API writes never substitute for the version-pinned merge card. */
export const MERGE_WRITE_REFUSAL = `Merging or moving or deleting the default branch requires the merge card. Prepare a review with check_change pull, then ask on your merge card; github_write cannot send it. ${fixedHoldWords("recorded-path")}`;

/** What one kind of host's REST paths say about a write. */
type WriteGrammar = {
  /** A merge, or a branch update the merge card owns. */
  merges: (rest: string) => boolean;
  /**
   * The branch a write moves, read from its path, body or query; undefined
   * when it moves none, or when the grammar already judged it in full.
   */
  branchOf: (write: {
    rest: string;
    data: Record<string, unknown>;
    query: URLSearchParams;
    readDefault: () => Promise<string>;
    refuse: () => never;
  }) => Promise<string | undefined>;
};

const WRITE_GRAMMAR: Record<RawApiKind, WriteGrammar> = {
  github: {
    merges: (rest) =>
      /^pulls\/\d+\/(?:merge(?:-async)?|update-branch)(?:\/|$)/.test(rest) ||
      rest === "merges" ||
      rest === "merge-upstream",
    branchOf: async ({ rest, data, readDefault, refuse }) => {
      if (/^git\/refs\/heads\//.test(rest)) return rest.slice("git/refs/heads/".length);
      if (rest === "git/refs" && typeof data.ref === "string" && data.ref.startsWith("refs/heads/"))
        return data.ref.slice("refs/heads/".length);
      if (/^branches\/.+\/rename$/.test(rest)) {
        const branch = rest.slice("branches/".length, -"/rename".length);
        // Renaming another branch onto the default branch is also a move.
        const name = await readDefault();
        if (branch === name || data.new_name === name) refuse();
        return undefined;
      }
      // GitHub's contents writes take branch from JSON, not a query parameter.
      if (/^contents(?:\/|$)/.test(rest))
        return typeof data.branch === "string" ? data.branch : await readDefault();
      return undefined;
    },
  },
  gitlab: {
    merges: (rest) => /^merge_requests\/\d+\/merge(?:\/|$)/.test(rest),
    branchOf: async ({ rest, data, query, readDefault }) => {
      if (/^repository\/branches\//.test(rest)) return rest.slice("repository/branches/".length);
      if (/^repository\/(?:commits|files(?:\/|$))/.test(rest)) {
        const branchInput = data.branch ?? query.get("branch");
        return typeof branchInput === "string" ? branchInput : await readDefault();
      }
      if (rest === "repository/branches" && typeof data.branch === "string") return data.branch;
      return undefined;
    },
  },
  bitbucket: {
    merges: (rest) => /^pullrequests\/\d+\/merge(?:\/|$)/.test(rest),
    branchOf: async ({ rest, data, query, readDefault, refuse }) => {
      // The repository's own write names its main branch in `mainbranch`.
      if (rest === "" && "mainbranch" in data) refuse();
      if (/^refs\/branches\/.+/.test(rest)) return rest.slice("refs/branches/".length);
      if (rest === "refs/branches" && typeof data.name === "string") return data.name;
      // A commit through `src` lands on the branch it names, or the main branch.
      if (rest === "src") {
        const branchInput = data.branch ?? query.get("branch");
        return typeof branchInput === "string" ? branchInput : await readDefault();
      }
      return undefined;
    },
  },
};

/**
 * Recognize typed API operations, not the crewmate's words. Scope and path
 * validation run first. Read the default branch fresh only for a write that
 * could move it; an unreadable destination refuses the write, never guesses.
 */
export async function guardApiWrite(
  kind: RawApiKind,
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
  const grammar = WRITE_GRAMMAR[kind];
  if (grammar.merges(rest) || (rest === "" && "default_branch" in data)) refuse();
  const branch = await grammar.branchOf({
    rest,
    data,
    query: new URLSearchParams(route.path.split("?")[1]),
    readDefault,
    refuse,
  });
  if (branch !== undefined) {
    const name = branch.replace(/^refs\/heads\//, "");
    if (name === "HEAD" || name === (await readDefault())) refuse();
  }
}
