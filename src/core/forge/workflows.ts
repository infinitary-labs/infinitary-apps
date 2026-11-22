/**
 * Read-only evidence from hosted workflows; every id is scoped to this
 * forge's project. On GitHub a run is an Actions workflow run, a job one of
 * its jobs and an artifact one the run uploaded; on GitLab a run is a
 * pipeline, a job one of its jobs, and an artifact a job's artifacts
 * archive, named by that job's id.
 */
export type WorkflowRun = {
  id: number;
  name: string;
  headSha: string;
  branch: string | null;
  attempt: number;
  status: string;
  conclusion: string | null;
  url: string;
  /**
   * When the host says the run (its latest attempt) started, and when a
   * finished run finished, epoch ms; absent where the host gives none.
   */
  startedAt?: number;
  finishedAt?: number;
};

export type WorkflowJob = {
  id: number;
  runId: number;
  headSha: string;
  attempt: number;
  name: string;
  /** GitLab's stage for the job; GitHub has steps instead. */
  stage?: string;
  status: string;
  conclusion: string | null;
  steps: { name: string; number: number; status: string; conclusion: string | null }[];
};

export type WorkflowArtifact = {
  id: number;
  name: string;
  sizeBytes: number;
  expired: boolean;
  /** When the host removes it; null where it is kept until someone removes it. */
  expiresAt: string | null;
};

export type WorkflowJobLine = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** A failed step's name on GitHub, or GitLab's failure reason, when the host named one. */
  failedAt: string | null;
  /** GitLab names allowed failures; GitHub's jobs API supplies no equivalent flag. */
  allowedToFail?: boolean;
};

/**
 * The latest attempt's jobs.
 * `total` is the host's count when it gave one; `complete` is false when the
 * read stopped before that count, and the short read then says how many it left out.
 */
export type WorkflowJobList = {
  jobs: WorkflowJobLine[];
  total: number | null;
  complete: boolean;
};

/** Both hosts list 100 jobs a page; ten pages is the read, and a remainder is named. */
export const WORKFLOW_JOB_PAGES = 10;
export const WORKFLOW_JOBS_PER_PAGE = 100;

/**
 * What the crewmate's job-log and artifact tools need beyond the JSON gateway:
 * GitHub answers both with a redirect to signed storage, and GitLab its
 * archive, which `github_read` never follows; neither is JSON. Listing
 * runs and artifacts is `github_read`'s job. A named run's jobs are `jobs`.
 */
export interface ForgeWorkflows {
  run(id: number): Promise<WorkflowRun>;
  /** Latest-attempt jobs: GitHub `?filter=latest`, GitLab's list with retried jobs left out. */
  jobs(runId: number): Promise<WorkflowJobList>;
  jobLog(runId: number, jobId: number): Promise<{ job: WorkflowJob; text: string }>;
  download(
    runId: number,
    artifactId: number,
  ): Promise<{ artifact: WorkflowArtifact; bytes: Uint8Array }>;
  /**
   * The artifact's archive read in parts from signed storage, for listing
   * its files and saving selected ones; absent where the host cannot.
   */
  archive?(
    runId: number,
    artifactId: number,
  ): Promise<{ artifact: WorkflowArtifact; archive: ArchiveRanges }>;
}

/** An archive read in parts: storage answers each with exactly the bytes asked for. */
export type ArchiveRanges = {
  /** The whole archive's size in bytes. */
  size: number;
  /** Bytes `start` to `end` (exclusive) of the archive. */
  read(start: number, end: number): Promise<Uint8Array>;
};

export type ReadWorkflowInput = {
  runId: number;
  /** Omit for the short read of the run and its jobs. */
  jobId?: number;
  offset?: number;
  limit?: number;
};

export type DownloadArtifactInput = {
  runId: number;
  artifactId: number;
  /** One exact member to unpack into task evidence, streamed rather than held in memory. */
  file?: string;
  /** Answer the archive's files instead of saving anything. */
  list?: boolean;
  /** Paths inside the archive; a folder's path takes everything under it. */
  files?: string[];
  /** The listing's first file, 1-based; only with `list`. */
  offset?: number;
};

export const WORKFLOW_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const WORKFLOW_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
