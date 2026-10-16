import { ForgeError } from "../../forge";
import {
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
import type { GitLabClient } from "./client";

/**
 * GitLab's pipelines as the crewmate's evidence tools read them
 * (`docs/forge.md`, "Workflow logs and artifacts"): a run is a pipeline, by
 * its id; a job is one of its jobs, by the job's id; and an artifact is a
 * job's artifacts archive, named by that job's id. Every read goes through
 * the forge's client with the key made there, and every id is checked
 * against the pipeline it is asked for.
 */

type PipelineJson = {
  id: number;
  sha: string;
  ref: string;
  status: string;
  name?: string | null;
  web_url?: string;
};

type JobJson = {
  id: number;
  name: string;
  stage?: string;
  status: string;
  pipeline?: { id?: number; sha?: string } | null;
  commit?: { id?: string } | null;
  artifacts_file?: { filename?: string; size?: number } | null;
  artifacts?: { file_type?: string; filename?: string; size?: number }[] | null;
  artifacts_expire_at?: string | null;
  failure_reason?: string | null;
  allow_failure?: boolean;
};

/** GitLab's statuses that are a pipeline's or job's last word. */
const FINISHED = new Set(["success", "failed", "canceled", "skipped"]);

export class GitLabWorkflows implements ForgeWorkflows {
  constructor(
    private readonly client: GitLabClient,
    private readonly projectPath: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  async run(id: number): Promise<WorkflowRun> {
    const pipeline = await this.client.get<PipelineJson | null>(
      `${this.projectPath()}/pipelines/${id}`,
    );
    if (!pipeline || pipeline.id !== id || typeof pipeline.sha !== "string") {
      throw unreadable(this.client.place, `pipeline #${id}`);
    }
    return {
      id: pipeline.id,
      name: pipeline.name || `pipeline #${pipeline.id}`,
      headSha: pipeline.sha,
      branch: pipeline.ref ?? null,
      attempt: 1,
      status: pipeline.status,
      conclusion: FINISHED.has(pipeline.status) ? pipeline.status : null,
      url: pipeline.web_url ?? "",
    };
  }

  /**
   * The pipeline's jobs, retried ones left out (GitLab's default), 100 a page,
   * up to ten pages. `X-Total` is the count the short read uses when it stops early.
   */
  async jobs(runId: number): Promise<WorkflowJobList> {
    const jobs: WorkflowJobLine[] = [];
    let total: number | null = null;
    for (let page = 1; page <= WORKFLOW_JOB_PAGES; page++) {
      const answer = await this.client.list<JobJson[] | null>(
        `${this.projectPath()}/pipelines/${runId}/jobs?per_page=${WORKFLOW_JOBS_PER_PAGE}&page=${page}`,
      );
      if (!Array.isArray(answer.body)) {
        throw unreadable(this.client.place, `pipeline #${runId}'s jobs`);
      }
      if (answer.total !== null) total = answer.total;
      jobs.push(...answer.body.map((job) => lineOf(job, this.client.place)));
      if (answer.body.length < WORKFLOW_JOBS_PER_PAGE || (total !== null && jobs.length >= total)) {
        return { jobs, total, complete: total === null || jobs.length >= total };
      }
    }
    return { jobs, total, complete: total !== null && jobs.length >= total };
  }

  async jobLog(runId: number, jobId: number): Promise<{ job: WorkflowJob; text: string }> {
    const job = await this.jobIn(runId, jobId);
    const bytes = await this.client.download(
      `${this.projectPath()}/jobs/${jobId}/trace`,
      WORKFLOW_LOG_MAX_BYTES,
      "The job log",
    );
    return { job: jobOf(job, runId), text: plainLog(new TextDecoder().decode(bytes)) };
  }

  async download(
    runId: number,
    artifactId: number,
  ): Promise<{ artifact: WorkflowArtifact; bytes: Uint8Array }> {
    const job = await this.jobIn(runId, artifactId);
    const archive =
      job.artifacts_file ?? job.artifacts?.find((file) => file.file_type === "archive");
    const expiresAt = job.artifacts_expire_at ?? null;
    if (!archive) {
      const gone = expiresAt !== null && Date.parse(expiresAt) <= this.now();
      throw new ForgeError(
        "not-found",
        gone
          ? `Job ${artifactId}'s artifacts have expired on ${this.client.place}.`
          : `Job ${artifactId} kept no artifacts archive on ${this.client.place}.`,
      );
    }
    const sizeBytes = archive.size ?? 0;
    if (sizeBytes > WORKFLOW_ARTIFACT_MAX_BYTES) {
      throw new ForgeError("refused", "The artifacts archive exceeds the 64 MiB download limit.");
    }
    const bytes = await this.client.download(
      `${this.projectPath()}/jobs/${artifactId}/artifacts`,
      WORKFLOW_ARTIFACT_MAX_BYTES,
      "The artifacts archive",
    );
    return {
      artifact: {
        id: job.id,
        name: archive.filename || `${job.name} artifacts`,
        sizeBytes: sizeBytes || bytes.byteLength,
        expired: false,
        expiresAt,
      },
      bytes,
    };
  }

  /** The job by its id, only when it belongs to the pipeline it is asked for. */
  private async jobIn(runId: number, jobId: number): Promise<JobJson> {
    const job = await this.client.get<JobJson | null>(`${this.projectPath()}/jobs/${jobId}`);
    if (!job || job.id !== jobId) throw unreadable(this.client.place, `job ${jobId}`);
    if (job.pipeline?.id !== runId) {
      throw new ForgeError("refused", "The job belongs to a different pipeline.");
    }
    return job;
  }
}

function lineOf(job: JobJson, place: string): WorkflowJobLine {
  if (!job || !Number.isSafeInteger(job.id) || typeof job.name !== "string") {
    throw unreadable(place, "a job");
  }
  const failed =
    job.status === "failed" && typeof job.failure_reason === "string" && job.failure_reason
      ? job.failure_reason.replace(/_/g, " ")
      : null;
  return {
    id: job.id,
    name: job.name,
    status: typeof job.status === "string" ? job.status : "unknown",
    conclusion: FINISHED.has(job.status) ? job.status : null,
    failedAt: failed,
    ...(job.allow_failure ? { allowedToFail: true } : {}),
  };
}

function jobOf(job: JobJson, runId: number): WorkflowJob {
  return {
    id: job.id,
    runId,
    headSha: job.pipeline?.sha ?? job.commit?.id ?? "",
    attempt: 1,
    name: job.name,
    ...(job.stage ? { stage: job.stage } : {}),
    status: job.status,
    conclusion: FINISHED.has(job.status) ? job.status : null,
    steps: [],
  };
}

/**
 * A GitLab job log as plain lines: GitLab keeps the terminal's colour codes
 * and its own collapsible-section markers in the log it serves; neither is
 * the job's words.
 */
export function plainLog(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what this removes
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/section_(?:start|end):\d+:[A-Za-z0-9_.-]+(?:\[[^\]\r\n]*\])?\r/g, "")
  );
}

function unreadable(place: string, what: string): ForgeError {
  return new ForgeError("transient", `${place}'s answer about ${what} could not be read.`);
}
