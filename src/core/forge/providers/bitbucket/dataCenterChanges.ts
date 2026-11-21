import type { ForgeChangeRow } from "@shared/forges";
import { ForgeError } from "../../forge";
import { DataCenterClient, type DataCenterOptions } from "./dataCenterClient";

/**
 * The person's open pull requests on a Bitbucket Data Center server, newest
 * first, with the build statuses on each one's head - the `forge.changes`
 * panel read (`docs/forge.md`). The server's dashboard lists the pull
 * requests the person wrote across every repository in one read; the
 * statuses of each are read a few at a time. A read the server refuses or
 * answers unreadably fails the whole host, never a row's guess.
 */

type PullRequestJson = {
  id?: number;
  title?: string;
  draft?: boolean;
  updatedDate?: number;
  fromRef?: { latestCommit?: string } | null;
  toRef?: { repository?: { slug?: string; project?: { key?: string } | null } | null } | null;
  links?: { self?: { href?: string }[] } | null;
};

type StatusJson = { key?: string; state?: string; updatedDate?: number; dateAdded?: number };

/** As many as GitHub's read shows. */
const SHOWN = 20;
/** Pull requests read at once for their statuses. */
const AT_ONCE = 5;

export async function readDataCenterOpenChanges(
  options: { host: string } & DataCenterOptions,
): Promise<ForgeChangeRow[]> {
  const client = new DataCenterClient(options.host, options);
  const read = await client.get<{ values?: PullRequestJson[] } | null>(
    `/rest/api/latest/dashboard/pull-requests?state=OPEN&role=AUTHOR&order=NEWEST&limit=${SHOWN}`,
  );
  if (!Array.isArray(read?.values)) throw unreadable(client.place);
  const newest = read.values
    .filter(
      (request) =>
        Number.isSafeInteger(request.id) &&
        typeof request.title === "string" &&
        typeof request.toRef?.repository?.slug === "string" &&
        typeof request.toRef.repository.project?.key === "string",
    )
    .sort((a, b) => (b.updatedDate ?? 0) - (a.updatedDate ?? 0))
    .slice(0, SHOWN);
  const rows: ForgeChangeRow[] = [];
  for (let start = 0; start < newest.length; start += AT_ONCE) {
    rows.push(
      ...(await Promise.all(
        newest.slice(start, start + AT_ONCE).map(async (request) => {
          const head = request.fromRef?.latestCommit;
          let statuses: StatusJson[] = [];
          if (typeof head === "string" && /^[0-9a-f]{40,64}$/i.test(head)) {
            const listed = await client.get<{ values?: StatusJson[] } | null>(
              `/rest/build-status/latest/commits/${encodeURIComponent(head)}?orderBy=NEWEST&limit=100`,
            );
            if (!Array.isArray(listed?.values)) throw unreadable(client.place);
            statuses = listed.values;
          }
          return rowOf(options.host, request, statuses);
        }),
      )),
    );
  }
  return rows;
}

function rowOf(host: string, request: PullRequestJson, statuses: StatusJson[]): ForgeChangeRow {
  const number = request.id as number;
  const key = request.toRef?.repository?.project?.key as string;
  const slug = request.toRef?.repository?.slug as string;
  const page = request.links?.self?.[0]?.href;
  return {
    host,
    project: `${key}/${slug}`,
    number,
    label: `#${number}`,
    title: request.title as string,
    url:
      typeof page === "string" && page
        ? page
        : `https://${host}/projects/${encodeURIComponent(key)}/repos/${encodeURIComponent(slug)}/pull-requests/${number}`,
    draft: request.draft === true,
    checks: checksOf(statuses),
    updatedAt:
      typeof request.updatedDate === "number" ? new Date(request.updatedDate).toISOString() : null,
  };
}

/** The newest build status of each key, as the one reading a row needs: none is no checks. */
function checksOf(statuses: StatusJson[]): ForgeChangeRow["checks"] {
  const newest = new Map<string, StatusJson>();
  for (const status of statuses) {
    const key = status.key ?? "build";
    const kept = newest.get(key);
    const when = (row: StatusJson) => row.updatedDate ?? row.dateAdded ?? 0;
    if (!kept || when(status) > when(kept)) newest.set(key, status);
  }
  const states = [...newest.values()].map((status) => status.state);
  if (states.length === 0) return "none";
  if (states.some((state) => state === "FAILED" || state === "CANCELLED")) return "failed";
  if (states.every((state) => state === "SUCCESSFUL")) return "passed";
  return "pending";
}

function unreadable(place: string): ForgeError {
  return new ForgeError(
    "transient",
    `${place}'s answer about your pull requests could not be read.`,
  );
}
