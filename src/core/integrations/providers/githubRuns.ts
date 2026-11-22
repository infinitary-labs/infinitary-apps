import type { GithubReadInput } from "../../forge";
import type { IntegrationEventItem, IntegrationEventSpec, IntegrationLook } from "../binding";

/**
 * GitHub's events (docs/integrations.md, "GitHub's events"): a workflow
 * run that fails, and one that finishes, in one repository, read on the
 * app's tick through the captain's GitHub sign-in. Each item is one run by
 * its id, with the run's typed facts in its summary; what to do about it is
 * the rule's own words, never this file's.
 */

export const WORKFLOW_RUN_FAILED = "workflow_run_failed";
export const WORKFLOW_RUN_FINISHED = "workflow_run_finished";

const FILTERS = [
  { name: "repository", label: "Repository (owner/name)", required: true },
  { name: "workflow", label: "Workflow (name or file; empty for every one)" },
  { name: "branch", label: "Branch (empty for every one)" },
] as const;

export const GITHUB_RUN_EVENTS: readonly IntegrationEventSpec[] = [
  {
    name: WORKFLOW_RUN_FAILED,
    label: "A workflow run fails",
    description:
      "A GitHub Actions run in the repository fails: told once per run, at its first failed job while it still runs, or when it ends failed, timed out or unable to start, or cancelled after a job failed. Filter by workflow (its name, its file such as build.yml, or the file without .yml) and branch. The summary carries the run's id, workflow, branch, event, attempt, version, each failed job with its failed step, the newest passing run of that workflow on that branch and its version, and the run's page. Runs from a fork are left out.",
    every: 2,
    filters: FILTERS,
  },
  {
    name: WORKFLOW_RUN_FINISHED,
    label: "A workflow run finishes",
    description:
      "A GitHub Actions run in the repository ends, whatever its conclusion: told once per run. Filter by workflow (its name, its file such as build.yml, or the file without .yml) and branch. The summary carries the run's id, workflow, branch, event, attempt, version and conclusion, each failed job with its failed step, the newest passing run of that workflow on that branch when this one did not pass, and the run's page. Runs from a fork are left out.",
    every: 2,
    filters: FILTERS,
  },
];

/** A read through the sign-in, answered as the gateway renders it. */
export type GithubLookRead = (input: GithubReadInput) => Promise<string>;

type Run = {
  id: number;
  name?: string | null;
  path?: string | null;
  head_branch?: string | null;
  head_sha: string;
  status: string | null;
  conclusion: string | null;
  html_url?: string;
  created_at: string;
  run_attempt?: number;
  event?: string;
  workflow_id?: number;
  repository?: { full_name?: string };
  head_repository?: { full_name?: string } | null;
};

type Job = {
  name: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
};

/** Conclusions GitHub gives a run or job that did not pass for a reason of its own. */
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The page's answer: its status, body and the next page, or a throw that says why. */
async function get(read: GithubLookRead, path: string) {
  const text = await read({ path });
  let answer: { status?: number; body?: unknown; nextPath?: string | null };
  try {
    answer = JSON.parse(text);
  } catch {
    throw new Error(text);
  }
  if (typeof answer.status !== "number" || answer.status >= 300)
    throw new Error(`GitHub answered ${answer.status ?? "nothing"} for ${path}.`);
  return answer as { status: number; body: unknown; nextPath?: string | null };
}

/** Every page from `path` on, by each answer's next page. */
async function every<T>(
  read: GithubLookRead,
  path: string,
  items: (body: unknown) => T[] | undefined,
): Promise<T[]> {
  const all: T[] = [];
  let next: string | null | undefined = path;
  while (next) {
    const page = await get(read, next);
    all.push(...(items(page.body) ?? []));
    next = page.nextPath;
  }
  return all;
}

/** A second-precision instant, as GitHub's `created` search takes it. */
function instant(at: number): string {
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function sinceOf(cursor: string): string | undefined {
  try {
    const since = (JSON.parse(cursor) as { since?: unknown }).since;
    return typeof since === "string" && !Number.isNaN(Date.parse(since)) ? since : undefined;
  } catch {
    return undefined;
  }
}

const cursorOf = (since: string) => JSON.stringify({ since });

/** The workflow filter names a run's workflow by its name, its file, or its file's stem. */
function workflowMatches(run: Run, workflow: string | undefined): boolean {
  if (!workflow) return true;
  const file = (run.path ?? "").split("@")[0]?.split("/").pop() ?? "";
  return [run.name ?? "", file, file.replace(/\.ya?ml$/, "")].includes(workflow);
}

/**
 * Look for one of GitHub's run events since the cursor. A first look
 * finds its place at now. Each look lists the repository's runs created
 * since the cursor; the cursor moves to the oldest matching run still
 * going, so it is read again until it is told, or else to the newest run
 * listed. A run is told by its id, so the rule's own record never sends it twice.
 */
export async function lookForRuns(
  read: GithubLookRead,
  event: string,
  cursor: string | null,
  filter: Record<string, string> | undefined,
  now: number,
): Promise<IntegrationLook> {
  const repository = filter?.repository?.trim() ?? "";
  if (!REPOSITORY.test(repository))
    throw new Error("Name the repository as owner/name to listen to its workflow runs.");
  const workflow = filter?.workflow?.trim() || undefined;
  const branch = filter?.branch?.trim() || undefined;
  const since = cursor === null ? undefined : sinceOf(cursor);
  if (since === undefined)
    return {
      cursor: cursorOf(instant(now)),
      items: [],
      ...(cursor === null ? {} : { resynced: true }),
    };
  const base = `/repos/${repository}`;
  const query = new URLSearchParams({
    per_page: "10",
    exclude_pull_requests: "true",
    created: `>=${since}`,
  });
  if (branch) query.set("branch", branch);
  const runs = await every<Run>(
    read,
    `${base}/actions/runs?${query}`,
    (body) => (body as { workflow_runs?: Run[] })?.workflow_runs,
  );
  const items: IntegrationEventItem[] = [];
  const going: string[] = [];
  for (const run of runs) {
    const fork =
      run.head_repository?.full_name &&
      run.repository?.full_name &&
      run.head_repository.full_name !== run.repository.full_name;
    if (fork || !workflowMatches(run, workflow) || (branch && run.head_branch !== branch)) continue;
    const ended = run.status === "completed";
    if (event === WORKFLOW_RUN_FINISHED) {
      if (!ended) {
        going.push(run.created_at);
        continue;
      }
      const jobs = run.conclusion === "success" ? [] : await failedJobs(read, base, run.id);
      items.push(await told(read, base, run, jobs, ended));
      continue;
    }
    if (ended) {
      // A run that stops its own jobs once one fails, such as a merge
      // batch's or an alpha cut's, ends cancelled: its failed job still
      // makes it a failed run. One cancelled with no failed job is not.
      if (FAILED.has(run.conclusion ?? "")) {
        items.push(await told(read, base, run, await failedJobs(read, base, run.id), ended));
      } else if (run.conclusion === "cancelled") {
        const jobs = await failedJobs(read, base, run.id);
        if (jobs.length > 0) items.push(await told(read, base, run, jobs, ended));
      }
      continue;
    }
    // A run still going is told at its first failed job.
    const jobs = run.status === "in_progress" ? await failedJobs(read, base, run.id) : [];
    if (jobs.length > 0) items.push(await told(read, base, run, jobs, ended));
    else going.push(run.created_at);
  }
  const listed = runs.map((run) => run.created_at).sort();
  const next = going.sort()[0] ?? listed.at(-1) ?? since;
  return { cursor: cursorOf(next), items };
}

/** The latest attempt's failed jobs, each with its first failed step. */
async function failedJobs(read: GithubLookRead, base: string, runId: number): Promise<Job[]> {
  const jobs = await every<Job>(
    read,
    `${base}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    (body) => (body as { jobs?: Job[] })?.jobs,
  );
  return jobs.filter((job) => FAILED.has(job.conclusion ?? ""));
}

/** The newest passing run of the same workflow on the same branch, when GitHub has one. */
async function newestPassing(
  read: GithubLookRead,
  base: string,
  run: Run,
): Promise<Run | undefined> {
  if (run.workflow_id === undefined) return undefined;
  const query = new URLSearchParams({
    status: "success",
    per_page: "1",
    exclude_pull_requests: "true",
  });
  if (run.head_branch) query.set("branch", run.head_branch);
  const page = await get(read, `${base}/actions/workflows/${run.workflow_id}/runs?${query}`);
  return (page.body as { workflow_runs?: Run[] })?.workflow_runs?.[0];
}

/** One run as its item: its id, and its typed facts in one line. */
async function told(
  read: GithubLookRead,
  base: string,
  run: Run,
  jobs: Job[],
  ended: boolean,
): Promise<IntegrationEventItem> {
  const where = [
    `Run ${run.id} of workflow "${run.name ?? "unnamed"}"`,
    run.path ? ` (${run.path.split("@")[0]})` : "",
    ` in ${base.slice("/repos/".length)}`,
    run.head_branch ? ` on branch ${run.head_branch}` : "",
    run.event ? `, from ${run.event}` : "",
  ].join("");
  const state = ended
    ? `ended ${run.conclusion ?? "with no conclusion"}`
    : "has a failed job and is still running";
  const failed = jobs.length
    ? ` Failed jobs: ${jobs
        .map((job) => {
          const step = job.steps?.find((s) => FAILED.has(s.conclusion ?? ""));
          return step ? `${job.name} at step "${step.name}"` : job.name;
        })
        .join("; ")}.`
    : "";
  let passing = "";
  if (!(ended && run.conclusion === "success")) {
    const found = await newestPassing(read, base, run);
    passing = found
      ? ` Newest passing run of this workflow${run.head_branch ? ` on ${run.head_branch}` : ""}: ${found.id} at version ${found.head_sha}.`
      : ` No passing run of this workflow${run.head_branch ? ` on ${run.head_branch}` : ""} was found.`;
  }
  return {
    id: String(run.id),
    summary: `${where}: ${state}, attempt ${run.run_attempt ?? 1}, at version ${run.head_sha}.${failed}${passing}${run.html_url ? ` ${run.html_url}` : ""}`,
  };
}
