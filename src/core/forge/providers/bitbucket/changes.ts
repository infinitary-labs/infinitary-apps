import type { ForgeChangeRow } from "@shared/forges";
import { ForgeError } from "../../forge";
import { BitbucketClient, type BitbucketOptions } from "./client";

/**
 * The person's open pull requests on Bitbucket Cloud, newest first, with
 * each one's build statuses - the `forge.changes` panel read
 * (`docs/forge.md`). Bitbucket lists a person's pull requests per
 * workspace (`/workspaces/{workspace}/pullrequests/{account}`), so the read
 * lists the person's workspaces, then each one's open pull requests, then
 * the statuses of the newest twenty, a few at a time. A read Bitbucket
 * refuses or answers unreadably fails the whole host, never a row's guess.
 */

type Page<T> = { values?: T[]; next?: string } | null;

type PullRequestJson = {
  id?: number;
  title?: string;
  draft?: boolean;
  updated_on?: string | null;
  destination?: { repository?: { full_name?: string } | null } | null;
  links?: { html?: { href?: string } } | null;
};

type StatusJson = { state?: string };

/** As many as GitHub's read shows. */
const SHOWN = 20;
/** Pull requests read at once for their statuses. */
const AT_ONCE = 5;
/** Pages of the person's workspaces read; a person in more is read up to here. */
const WORKSPACE_PAGES = 3;
const PULL_REQUEST_FIELDS =
  "values.id,values.title,values.draft,values.updated_on,values.destination.repository.full_name,values.links.html.href";

export async function readBitbucketOpenChanges(
  options: { host: string } & BitbucketOptions,
): Promise<ForgeChangeRow[]> {
  const client = new BitbucketClient(options.host, options);
  const user = await client.get<{ account_id?: unknown } | null>("/user?fields=account_id");
  const account = typeof user?.account_id === "string" ? user.account_id : "";
  if (!account) throw unreadable(client.place);
  const slugs: string[] = [];
  let link: string | undefined = "/user/workspaces?pagelen=100&fields=next,values.workspace.slug";
  for (let page = 0; link && page < WORKSPACE_PAGES; page++) {
    const read: Page<{ workspace?: { slug?: unknown } }> = await client.get(link);
    if (!Array.isArray(read?.values)) throw unreadable(client.place);
    for (const entry of read.values) {
      const slug = entry.workspace?.slug;
      if (typeof slug === "string" && slug) slugs.push(slug);
    }
    link = typeof read.next === "string" && read.next ? read.next : undefined;
  }
  const requests: PullRequestJson[] = [];
  for (const slug of slugs) {
    const read: Page<PullRequestJson> = await client.get(
      `/workspaces/${encodeURIComponent(slug)}/pullrequests/${encodeURIComponent(account)}?state=OPEN&pagelen=${SHOWN}&fields=${PULL_REQUEST_FIELDS}`,
    );
    if (!Array.isArray(read?.values)) throw unreadable(client.place);
    requests.push(...read.values);
  }
  const newest = requests
    .filter(
      (request) =>
        Number.isSafeInteger(request.id) &&
        typeof request.title === "string" &&
        typeof request.destination?.repository?.full_name === "string",
    )
    .sort((a, b) => (b.updated_on ?? "").localeCompare(a.updated_on ?? ""))
    .slice(0, SHOWN);
  const rows: ForgeChangeRow[] = [];
  for (let start = 0; start < newest.length; start += AT_ONCE) {
    rows.push(
      ...(await Promise.all(
        newest.slice(start, start + AT_ONCE).map(async (request) => {
          const project = request.destination?.repository?.full_name as string;
          const [workspace = "", name = ""] = project.split("/");
          const statuses: Page<StatusJson> = await client.get(
            `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(name)}/pullrequests/${request.id}/statuses?pagelen=100&fields=values.state`,
          );
          if (!Array.isArray(statuses?.values)) throw unreadable(client.place);
          return rowOf(options.host, project, request, statuses.values);
        }),
      )),
    );
  }
  return rows;
}

function rowOf(
  host: string,
  project: string,
  request: PullRequestJson,
  statuses: StatusJson[],
): ForgeChangeRow {
  const number = request.id as number;
  return {
    host,
    project,
    number,
    label: `#${number}`,
    title: request.title as string,
    url: request.links?.html?.href ?? `https://${host}/${project}/pull-requests/${number}`,
    draft: request.draft === true,
    checks: checksOf(statuses),
    updatedAt: request.updated_on ?? null,
  };
}

/** The build statuses as the one reading a row needs: none is no checks. */
function checksOf(statuses: StatusJson[]): ForgeChangeRow["checks"] {
  if (statuses.length === 0) return "none";
  if (statuses.some((status) => status.state === "FAILED" || status.state === "STOPPED"))
    return "failed";
  if (statuses.every((status) => status.state === "SUCCESSFUL")) return "passed";
  return "pending";
}

function unreadable(place: string): ForgeError {
  return new ForgeError(
    "transient",
    `${place}'s answer about your pull requests could not be read.`,
  );
}
