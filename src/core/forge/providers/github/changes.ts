import type { ForgeChangeRow } from "@shared/forges";
import { ForgeError } from "../../forge";
import { githubGraphqlUrl } from "./githubForge";

/**
 * The person's open pull requests across GitHub, newest first, with each
 * one's check rollup - the `forge.changes` panel read (git integration PR
 * 1.2). One GraphQL request per GitHub host - github.com's, or a GitHub
 * Enterprise host's own `/api/graphql` - so a panel that refreshes every
 * few minutes costs one call, not one per row. Read with the app's own sign-in; a 401
 * is a sign-in fact like every other GitHub request.
 */

const QUERY = `query {
  viewer {
    pullRequests(first: 20, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        url
        isDraft
        updatedAt
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

type Node = {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt?: string;
  repository: { nameWithOwner: string };
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] };
};

/** GitHub's rollup state as the one reading a row needs. */
function checksOf(state: string | undefined): ForgeChangeRow["checks"] {
  if (!state) return "none";
  if (state === "SUCCESS") return "passed";
  if (state === "FAILURE" || state === "ERROR") return "failed";
  return "pending";
}

export async function readOpenChanges(options: {
  host: string;
  token: string;
  apiBaseUrl: string;
  fetch?: typeof fetch;
}): Promise<ForgeChangeRow[]> {
  const fetcher = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(githubGraphqlUrl(options.apiBaseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: QUERY }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new ForgeError("transient", `could not reach GitHub: ${message}`);
  }
  if (response.status === 401)
    throw new ForgeError("sign-in", "GitHub answered 401 to POST /graphql");
  if (!response.ok) {
    throw new ForgeError("transient", `GitHub answered ${response.status} to POST /graphql`);
  }
  const body = (await response.json()) as {
    data?: { viewer?: { pullRequests?: { nodes?: Node[] } } };
  };
  const nodes = body.data?.viewer?.pullRequests?.nodes ?? [];
  return nodes.map((node) => ({
    host: options.host,
    project: node.repository.nameWithOwner,
    number: node.number,
    label: `#${node.number}`,
    title: node.title,
    url: node.url,
    draft: node.isDraft === true,
    checks: checksOf(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state),
    updatedAt: node.updatedAt ?? null,
  }));
}
