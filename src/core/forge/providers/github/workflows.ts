import { checkTimes, ForgeError } from "../../forge";
import {
  type ArchiveRanges,
  type ForgeWorkflows,
  WORKFLOW_ARTIFACT_MAX_BYTES,
  WORKFLOW_JOB_PAGES,
  WORKFLOW_JOBS_PER_PAGE,
  WORKFLOW_LOG_MAX_BYTES,
  type WorkflowArtifact,
  type WorkflowJob,
  type WorkflowJobLine,
  type WorkflowJobList,
  type WorkflowRun,
} from "../../workflows";

type RunJson = {
  id: number;
  name: string;
  head_sha: string;
  head_branch: string | null;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at?: string | null;
  /** The latest attempt's start; a rerun moves it. */
  run_started_at?: string | null;
  /** A run has no completed_at: once it is completed, its last update is its end. */
  updated_at?: string | null;
};
type JobJson = {
  id: number;
  run_id: number;
  head_sha: string;
  run_attempt: number;
  name: string;
  status: string;
  conclusion: string | null;
  steps?: WorkflowJob["steps"];
};
type ArtifactJson = {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  expires_at: string;
  workflow_run?: { id: number };
};

/** GitHub Actions reads share the forge's app-owned sign-in and typed failures. */
export class GitHubWorkflows implements ForgeWorkflows {
  constructor(
    private readonly repoPath: () => string,
    private readonly json: (path: string) => Promise<unknown>,
    private readonly bytes: (path: string, maxBytes: number) => Promise<Uint8Array>,
    private readonly ranges: (path: string, size: number) => Promise<ArchiveRanges>,
  ) {}

  async run(id: number) {
    return runOf((await this.json(`${this.repoPath()}/actions/runs/${id}`)) as RunJson);
  }

  /** Latest attempt only (`filter=latest`), 100 a page, up to ten pages. */
  async jobs(runId: number): Promise<WorkflowJobList> {
    const jobs: WorkflowJobLine[] = [];
    let total: number | null = null;
    for (let page = 1; page <= WORKFLOW_JOB_PAGES; page++) {
      const answer = (await this.json(
        `${this.repoPath()}/actions/runs/${runId}/jobs?filter=latest&per_page=${WORKFLOW_JOBS_PER_PAGE}&page=${page}`,
      )) as { total_count?: number; jobs?: JobJson[] } | null;
      if (!answer || !Array.isArray(answer.jobs)) {
        throw new ForgeError("transient", "GitHub's job list could not be read.");
      }
      if (typeof answer.total_count === "number") total = answer.total_count;
      jobs.push(...answer.jobs.map(lineOf));
      if (answer.jobs.length < WORKFLOW_JOBS_PER_PAGE || (total !== null && jobs.length >= total)) {
        return { jobs, total, complete: total === null || jobs.length >= total };
      }
    }
    return { jobs, total, complete: total !== null && jobs.length >= total };
  }

  async jobLog(runId: number, jobId: number) {
    const job = jobOf((await this.json(`${this.repoPath()}/actions/jobs/${jobId}`)) as JobJson);
    if (job.runId !== runId)
      throw new ForgeError("refused", "The job belongs to a different workflow run.");
    const bytes = await this.bytes(
      `${this.repoPath()}/actions/jobs/${jobId}/logs`,
      WORKFLOW_LOG_MAX_BYTES,
    );
    return { job, text: new TextDecoder().decode(bytes) };
  }

  async download(runId: number, artifactId: number) {
    const artifact = await this.artifactIn(runId, artifactId);
    if (artifact.sizeBytes > WORKFLOW_ARTIFACT_MAX_BYTES) {
      throw new ForgeError(
        "refused",
        "The artifact exceeds the 64 MiB download limit; list its files with list true and save the ones you need with files.",
      );
    }
    const bytes = await this.bytes(
      `${this.repoPath()}/actions/artifacts/${artifactId}/zip`,
      WORKFLOW_ARTIFACT_MAX_BYTES,
    );
    return { artifact, bytes };
  }

  /** The archive in parts, whatever its size: only what a listing or selection reads is fetched. */
  async archive(runId: number, artifactId: number) {
    const artifact = await this.artifactIn(runId, artifactId);
    const archive = await this.ranges(
      `${this.repoPath()}/actions/artifacts/${artifactId}/zip`,
      artifact.sizeBytes,
    );
    return { artifact, archive };
  }

  /** The artifact by its id, only when the run uploaded it and GitHub still keeps it. */
  private async artifactIn(runId: number, artifactId: number): Promise<WorkflowArtifact> {
    const raw = (await this.json(
      `${this.repoPath()}/actions/artifacts/${artifactId}`,
    )) as ArtifactJson;
    if (raw.workflow_run?.id !== runId) {
      throw new ForgeError("refused", "The artifact belongs to a different workflow run.");
    }
    const artifact = artifactOf(raw);
    if (artifact.expired) throw new ForgeError("not-found", "The artifact has expired on GitHub.");
    return artifact;
  }
}

function runOf(run: RunJson): WorkflowRun {
  return {
    id: run.id,
    name: run.name,
    headSha: run.head_sha,
    branch: run.head_branch,
    attempt: run.run_attempt,
    status: run.status,
    conclusion: run.conclusion,
    url: run.html_url,
    ...checkTimes(
      run.run_started_at ?? run.created_at,
      run.status === "completed" ? run.updated_at : null,
    ),
  };
}
const FAILED_JOB = new Set(["failure", "timed_out", "startup_failure", "action_required"]);
const FAILED_STEP = new Set(["failure", "timed_out"]);

function lineOf(job: JobJson): WorkflowJobLine {
  if (!job || !Number.isSafeInteger(job.id) || typeof job.name !== "string") {
    throw new ForgeError("transient", "GitHub's job list could not be read.");
  }
  const failed =
    job.conclusion && FAILED_JOB.has(job.conclusion)
      ? (job.steps?.find((step) => step.conclusion && FAILED_STEP.has(step.conclusion))?.name ??
        null)
      : null;
  return {
    id: job.id,
    name: job.name,
    status: typeof job.status === "string" ? job.status : "unknown",
    conclusion: job.conclusion ?? null,
    failedAt: failed,
  };
}

function jobOf(job: JobJson): WorkflowJob {
  return {
    id: job.id,
    runId: job.run_id,
    headSha: job.head_sha,
    attempt: job.run_attempt,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    steps: job.steps ?? [],
  };
}
function artifactOf(artifact: ArtifactJson): WorkflowArtifact {
  return {
    id: artifact.id,
    name: artifact.name,
    sizeBytes: artifact.size_in_bytes,
    expired: artifact.expired,
    expiresAt: artifact.expires_at,
  };
}
