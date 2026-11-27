import { BATCH_BRANCH_PREFIX } from "@shared/batches";
import * as m from "@shared/i18n/messages.generated";
import {
  allowanceResetOf,
  checkTimes,
  type ForgeChange,
  type ForgeCheck,
  type ForgeCheckState,
  ForgeError,
  isSignInForgeFailure,
  isTransientForgeFailure,
  ownChecksOf,
} from "../../forge";

type CheckRunJson = {
  name: string;
  status: string;
  conclusion: string | null;
  check_suite?: { id: number } | null;
  app?: { slug?: string };
  pull_requests?: { number: number }[];
  started_at?: string | null;
  completed_at?: string | null;
};

/** A commit status: posted at `created_at`, last changed at `updated_at`. */
type StatusJson = {
  id?: number;
  context: string;
  state: string;
  description?: string | null;
  target_url?: string | null;
  created_at?: string;
  updated_at?: string;
};

/** The workflow run a check suite belongs to, as far as superseding needs it. */
type SuiteRunJson = {
  id?: number;
  name?: string;
  check_suite_id: number;
  workflow_id: number;
  event: string;
  run_number: number;
  status: string;
  run_started_at?: string | null;
  head_branch?: string | null;
  head_repository?: RunRepository | null;
  pull_requests?: (Pick<BranchRequest, "number"> & Partial<Pick<BranchRequest, "head">>)[];
};

type RunRepository = { id?: number; full_name?: string };

type BranchRequest = {
  number: number;
  head: { ref: string; sha?: string; repo?: RunRepository | null };
};

function repositoryMatch(
  run: RunRepository | null | undefined,
  request: RunRepository | null | undefined,
) {
  if (run?.id !== undefined && request?.id !== undefined) return run.id === request.id;
  if (run?.full_name && request?.full_name)
    return run.full_name.toLowerCase() === request.full_name.toLowerCase();
  return undefined;
}

type CheckReads = {
  place: string;
  repoPath: string;
  source: string;
  read: (path: string) => Promise<unknown>;
  pages: <T>(
    path: string,
    itemsOf: (page: unknown) => T[],
  ) => Promise<{ items: T[]; complete: boolean }>;
};

export class GitHubChecks {
  constructor(private readonly options: CheckReads) {}

  async read(change: ForgeChange, movedPast?: string) {
    const head = movedPast ?? change.headSha;
    const sha = encodeURIComponent(head);
    const runs = await this.options.pages<CheckRunJson>(
      `${this.options.repoPath}/commits/${sha}/check-runs`,
      (page) => (page as { check_runs?: CheckRunJson[] }).check_runs ?? [],
    );
    const statuses = await this.options.pages<StatusJson>(
      `${this.options.repoPath}/commits/${sha}/status`,
      (page) => (page as { statuses?: StatusJson[] }).statuses ?? [],
    );
    // Waiting jobs can have no check yet. Read the workflow runs once for
    // both that gap and the checks a later run decides. Preserve a refused side list's
    // reason with the partial facts; existing sign-in/transient boundaries stay intact.
    let workflowRuns: { total_count?: number; workflow_runs?: SuiteRunJson[] } | null = null;
    let problem: string | undefined;
    let scoped: SuiteRunJson[] = [];
    try {
      workflowRuns = (await this.options.read(
        `${this.options.repoPath}/actions/runs?head_sha=${sha}&per_page=100`,
      )) as { total_count?: number; workflow_runs?: SuiteRunJson[] };
      const ownership = await this.scopeWorkflows(change, head, workflowRuns.workflow_runs ?? []);
      scoped = ownership.runs;
      if (ownership.ambiguous) problem = m.taskChecksUnattributed({ host: this.options.place });
    } catch (caught) {
      // F25: a passing network error is not a lasting refusal, with or without cancellations.
      if (
        isSignInForgeFailure(caught) ||
        isTransientForgeFailure(caught) ||
        allowanceResetOf(caught) !== undefined
      )
        throw caught;
      const why = caught instanceof Error ? caught.message : String(caught);
      // i18n-exempt: the forge gateway diagnostic retained verbatim for tool reads
      problem =
        caught instanceof ForgeError && caught.failure === "permission"
          ? `${this.options.place} refused access to the remaining checks. ${why}`
          : `${this.options.place} could not provide all check runs: ${why}`;
    }
    const workflows = workflowRuns?.workflow_runs ?? [];
    const listedSuites = new Set(workflows.map((run) => run.check_suite_id));
    const scopedSuites = new Set(scoped.map((run) => run.check_suite_id));
    const jobs =
      change.number === undefined
        ? runs.items
        : runs.items.filter((job) => {
            if (job.check_suite && listedSuites.has(job.check_suite.id))
              return scopedSuites.has(job.check_suite.id);
            if (job.pull_requests?.length)
              return job.pull_requests.some((pull) => pull.number === change.number);
            if (job.app?.slug !== "github-actions") return true;
            problem ??= m.taskChecksUnattributed({ host: this.options.place });
            return false;
          });
    const read: ForgeCheck[] = [
      ...this.withoutSupersededRuns(jobs, scoped),
      ...statuses.items.map((status) => {
        const state = STATUS_STATES[status.state] ?? ("pending" as const);
        // A status starts when it was first posted; a settled one finished at its last change.
        return {
          name: status.context,
          state,
          ...checkTimes(status.created_at, state === "pending" ? null : status.updated_at),
          ...(status.description ? { detail: status.description } : {}),
          ...(status.target_url ? { link: status.target_url } : {}),
        };
      }),
    ];
    for (const run of scoped) {
      if (run.status !== "completed") {
        read.push({
          name: `${run.name ?? "workflow"} (run ${run.run_number})`,
          state: "pending",
          summary: true,
          run: run.id,
          workflow: run.workflow_id,
          event: run.event,
          ...checkTimes(run.run_started_at, null),
        });
      }
    }
    // A pull request's checks are the runs it started (INF-1891), and a
    // batch's the runs its own pushed branch started too; a branch's own
    // checks, read with no number, keep every run at its version.
    const items =
      change.number !== undefined
        ? ownChecksOf(read, change.branch.startsWith(BATCH_BRANCH_PREFIX))
        : read;
    return {
      items,
      ...(problem ? { problem } : {}),
      complete:
        !problem &&
        runs.complete &&
        statuses.complete &&
        workflowRuns !== null &&
        (workflowRuns.total_count ?? workflows.length) <= workflows.length,
    };
  }

  /** GitHub can omit the PR links even for same-repository Actions runs. */
  private async scopeWorkflows(change: ForgeChange, head: string, runs: SuiteRunJson[]) {
    if (change.number === undefined) return { runs, ambiguous: false };
    const { source } = this.options;
    const sameSource = (repo: string | undefined) => repo?.toLowerCase() === source.toLowerCase();
    const [owner] = source.split("/");
    const batch = change.branch.startsWith(BATCH_BRANCH_PREFIX);
    const matched: SuiteRunJson[] = [];
    const unlinked: SuiteRunJson[] = [];
    let ambiguous = false;
    for (const run of runs) {
      if (run.event === "push" && batch) {
        if (
          run.head_branch === change.branch &&
          (!run.head_repository || sameSource(run.head_repository.full_name))
        )
          matched.push(run);
        continue;
      }
      if (run.event !== "pull_request" && run.event !== "pull_request_target") continue;
      const linked = run.pull_requests ?? [];
      if (linked.length && !linked.some((pull) => pull.number === change.number)) continue;
      const runSource = run.head_repository?.full_name;
      if (
        (run.head_branch && run.head_branch !== change.branch) ||
        (runSource && !sameSource(runSource))
      )
        continue;
      if (linked.length === 1) {
        matched.push(run);
        continue;
      }
      if (run.head_branch !== change.branch || !sameSource(runSource)) {
        ambiguous = true;
        continue;
      }
      if (!linked.length) {
        unlinked.push(run);
        continue;
      }
      // GitHub links requests by SHA or branch, so some links name a different source.
      const candidates = linked.filter(
        ({ head }) =>
          (!head?.ref || head.ref === change.branch) &&
          repositoryMatch(run.head_repository, head?.repo) !== false,
      );
      if (
        candidates.length === 1 &&
        candidates[0]?.number === change.number &&
        candidates[0].head?.ref === change.branch &&
        repositoryMatch(run.head_repository, candidates[0].head.repo) === true
      )
        matched.push(run);
      else ambiguous = true;
    }
    if (unlinked.length) {
      const branch = encodeURIComponent(`${owner}:${change.branch}`);
      const requests = (await this.options.read(
        `${this.options.repoPath}/pulls?head=${branch}&state=all&per_page=100`,
      )) as BranchRequest[];
      // Include closed requests at this commit: a source branch can target two bases.
      const candidates = requests.filter(
        (pull) =>
          (pull.head.sha === undefined || pull.head.sha === head) &&
          pull.head.ref === change.branch &&
          (!pull.head.repo?.full_name || sameSource(pull.head.repo.full_name)),
      );
      if (
        requests.length < 100 &&
        candidates.length === 1 &&
        candidates[0]?.number === change.number &&
        candidates[0].head.sha === head &&
        sameSource(candidates[0].head.repo?.full_name)
      )
        matched.push(...unlinked);
      else ambiguous = true;
    }
    return { runs: matched, ambiguous };
  }

  /**
   * A later run of the same workflow, started by the same event at this
   * version, decides each check of the same name an earlier run left,
   * whatever that earlier check read: a duplicate the later run cancelled
   * (captain F26), or a failed request retried by a new one (INF-4584), as a
   * rerun's newest attempt decides inside one run. While the later run has
   * not created that check it reads pending; finished without one, the
   * earlier check counts as it reads. A check the app cannot place in a
   * workflow run counts as it reads, facts preserved.
   */
  private withoutSupersededRuns(runs: CheckRunJson[], workflowRuns: SuiteRunJson[]): ForgeCheck[] {
    const read = runs.map((run) => {
      const workflow = workflowRuns.find((item) => item.check_suite_id === run.check_suite?.id);
      return {
        run,
        check: {
          name: run.name,
          state: runState(run),
          status: run.status,
          conclusion: run.conclusion,
          ...checkTimes(run.started_at, run.completed_at),
          ...(workflow
            ? { run: workflow.id, workflow: workflow.workflow_id, event: workflow.event }
            : {}),
        },
      };
    });
    const bySuite = new Map(workflowRuns.map((run) => [run.check_suite_id, run]));
    const origin = (run: CheckRunJson) =>
      run.check_suite ? bySuite.get(run.check_suite.id) : undefined;
    return read.flatMap(({ run, check }): ForgeCheck[] => {
      const from = origin(run);
      if (!from) return [check];
      const later = workflowRuns.filter(
        (next) =>
          next.workflow_id === from.workflow_id &&
          next.event === from.event &&
          next.run_number > from.run_number,
      );
      if (later.length === 0) return [check];
      const decided = runs.some((other) => {
        const next = origin(other);
        return other.name === run.name && next !== undefined && later.includes(next);
      });
      if (decided) return [];
      // The later run holds no check of this name yet: pending until it
      // does, and as it read if the later run finished without one.
      return later.some((next) => next.status !== "completed")
        ? [{ name: check.name, state: "pending" }]
        : [check];
    });
  }
}

function runState(run: { status: string; conclusion: string | null }): ForgeCheckState {
  if (run.status !== "completed") return "pending";
  return RUN_CONCLUSIONS[run.conclusion ?? ""] ?? "pending";
}

const RUN_CONCLUSIONS: Record<string, ForgeCheckState> = {
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  timed_out: "timed_out",
  action_required: "action_required",
  startup_failure: "startup_failure",
  stale: "stale",
  skipped: "skipped",
  neutral: "neutral",
};

const STATUS_STATES: Record<string, ForgeCheckState> = {
  success: "success",
  failure: "failure",
  error: "error",
  pending: "pending",
};
