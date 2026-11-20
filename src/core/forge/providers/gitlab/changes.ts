import type { ForgeChangeRow } from "@shared/forges";
import { ForgeError } from "../../forge";
import { GITLAB_READ_MAX_BYTES, GitLabClient, type GitLabOptions } from "./client";

/**
 * The person's open merge requests on one GitLab host, newest first, with
 * each one's head pipeline - the `forge.changes` panel read
 * (`docs/forge.md`). GitLab's list names no pipeline, so each merge
 * request's own read gives its head pipeline: one list and up to twenty
 * reads, a few at a time, with the key made there. A read GitLab refuses
 * or answers unreadably fails the whole host, never a row's guess.
 */

type MergeRequestJson = {
  iid: number;
  project_id: number;
  title: string;
  web_url: string;
  draft?: boolean;
  work_in_progress?: boolean;
  updated_at?: string | null;
  references?: { full?: string } | null;
  head_pipeline?: { status?: string } | null;
};

/** As many as GitHub's read shows. */
const SHOWN = 20;
/** Merge requests read at once for their head pipelines. */
const AT_ONCE = 5;

export async function readGitLabOpenChanges(
  options: { host: string } & GitLabOptions,
): Promise<ForgeChangeRow[]> {
  const client = new GitLabClient(options.host, options);
  const listed = await client.request(
    "GET",
    `/merge_requests?scope=created_by_me&state=opened&order_by=updated_at&sort=desc&per_page=${SHOWN}`,
    undefined,
    GITLAB_READ_MAX_BYTES,
  );
  if (!Array.isArray(listed)) throw unreadable(client.place);
  const requests = (listed as MergeRequestJson[]).slice(0, SHOWN);
  const rows: ForgeChangeRow[] = [];
  for (let start = 0; start < requests.length; start += AT_ONCE) {
    rows.push(
      ...(await Promise.all(
        requests.slice(start, start + AT_ONCE).map(async (request) => {
          const own = await client.request(
            "GET",
            `/projects/${request.project_id}/merge_requests/${request.iid}`,
            undefined,
            GITLAB_READ_MAX_BYTES,
          );
          if (!own || typeof own !== "object") throw unreadable(client.place);
          return rowOf(options.host, request, (own as MergeRequestJson).head_pipeline?.status);
        }),
      )),
    );
  }
  return rows;
}

function rowOf(host: string, request: MergeRequestJson, pipeline?: string): ForgeChangeRow {
  return {
    host,
    project: projectOf(request),
    number: request.iid,
    label: `!${request.iid}`,
    title: request.title,
    url: request.web_url,
    draft: request.draft === true || request.work_in_progress === true,
    checks: checksOf(pipeline),
    updatedAt: request.updated_at ?? null,
  };
}

/** The project's full path: GitLab's own reference (`group/name!4`), else its page's address. */
function projectOf(request: MergeRequestJson): string {
  const reference = request.references?.full?.replace(/![0-9]+$/, "");
  if (reference) return reference;
  try {
    return new URL(request.web_url).pathname.replace(/^\/|\/-\/merge_requests\/\d+$/g, "");
  } catch {
    return String(request.project_id);
  }
}

/** The head pipeline's status as the one reading a row needs; no pipeline is no checks. */
function checksOf(status: string | undefined): ForgeChangeRow["checks"] {
  if (!status) return "none";
  if (status === "success" || status === "skipped") return "passed";
  if (status === "failed" || status === "canceled") return "failed";
  return "pending";
}

function unreadable(place: string): ForgeError {
  return new ForgeError(
    "transient",
    `${place}'s answer about your merge requests could not be read.`,
  );
}
