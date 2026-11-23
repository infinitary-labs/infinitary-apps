import { checkTimes, ForgeError } from "../../forge";
import {
  type ForgeWorkflows,
  WORKFLOW_JOB_PAGES,
  WORKFLOW_JOBS_PER_PAGE,
  WORKFLOW_LOG_MAX_BYTES,
  type WorkflowArtifact,
  type WorkflowJob,
  type WorkflowJobLine,
  type WorkflowJobList,
  type WorkflowRun,
} from "../../workflows";
import { plainLog } from "../gitlab/workflows";
import type { BitbucketClient } from "./client";

/**
 * Bitbucket Pipelines as the crewmate's evidence tools read them
 * (`docs/forge.md`, "Workflow logs and artifacts"): a run is a pipeline, by
 * its build number, the number Bitbucket shows on its page; a job is one of
 * its steps, by the step's place in the pipeline, counting from 1, since
 * Bitbucket names a step by a UUID alone. Bitbucket offers no download of a
 * pipeline's artifacts through its API, so `download` answers that plainly.
 */

type StateJson = {
  name?: string;
  result?: { name?: string } | null;
} | null;

type PipelineJson = {
  uuid?: string;
  build_number?: number;
  run_number?: number;
  state?: StateJson;
  target?: {
    ref_name?: string;
    commit?: { hash?: string } | null;
    selector?: { pattern?: string } | null;
  } | null;
  created_on?: string | null;
  completed_on?: string | null;
};

type StepJson = {
  uuid?: string;
  name?: string | null;
  state?: StateJson;
};

const RESULTS: Record<string, string> = {
  SUCCESSFUL: "success",
  FAILED: "failure",
  ERROR: "failure",
  STOPPED: "cancelled",
  EXPIRED: "cancelled",
  NOT_RUN: "skipped",
};

export class BitbucketWorkflows implements ForgeWorkflows {
  constructor(
    private readonly client: BitbucketClient,
    private readonly repositoryPath: () => string,
    private readonly webPath: () => string,
  ) {}

  async run(id: number): Promise<WorkflowRun> {
    const pipeline = await this.pipeline(id);
    const state = stateOf(pipeline.state);
    return {
      id,
      // i18n-exempt: served to the crewmate in read_workflow's answer
      name: pipeline.target?.selector?.pattern
        ? `pipeline #${id} (${pipeline.target.selector.pattern})`
        : `pipeline #${id}`,
      headSha: pipeline.target?.commit?.hash ?? "",
      branch: pipeline.target?.ref_name ?? null,
      attempt:
        Number.isSafeInteger(pipeline.run_number) && (pipeline.run_number ?? 0) > 0
          ? (pipeline.run_number as number)
          : 1,
      status: state.status,
      conclusion: state.conclusion,
      url: `${this.webPath()}/pipelines/results/${id}`,
      ...checkTimes(pipeline.created_on, state.conclusion ? pipeline.completed_on : null),
    };
  }

  /** The pipeline's steps in order, each numbered by its place, 100 a page, up to ten pages. */
  async jobs(runId: number): Promise<WorkflowJobList> {
    const pipeline = await this.pipeline(runId);
    const { steps, complete } = await this.steps(pipeline, runId);
    return {
      jobs: steps.map((step, index) => lineOf(step, index + 1)),
      total: complete ? steps.length : null,
      complete,
    };
  }

  async jobLog(runId: number, jobId: number): Promise<{ job: WorkflowJob; text: string }> {
    const pipeline = await this.pipeline(runId);
    const { steps } = await this.steps(pipeline, runId);
    const step = steps[jobId - 1];
    if (!Number.isSafeInteger(jobId) || jobId < 1 || !step?.uuid) {
      throw new ForgeError(
        "not-found",
        `Pipeline #${runId} has ${steps.length} step${steps.length === 1 ? "" : "s"}; a step is named by its place, from 1.`,
      );
    }
    const bytes = await this.client.download(
      `${this.pipelinePath(pipeline)}/steps/${encodeURIComponent(step.uuid)}/log`,
      WORKFLOW_LOG_MAX_BYTES,
      // i18n-exempt: served to the crewmate in read_workflow's answer
      "step log",
    );
    const state = stateOf(step.state);
    return {
      job: {
        id: jobId,
        runId,
        headSha: pipeline.target?.commit?.hash ?? "",
        attempt: 1,
        // i18n-exempt: served to the crewmate in read_workflow's answer
        name: step.name || `step ${jobId}`,
        status: state.status,
        conclusion: state.conclusion,
        steps: [],
      },
      text: plainLog(new TextDecoder().decode(bytes)),
    };
  }

  async download(): Promise<{ artifact: WorkflowArtifact; bytes: Uint8Array }> {
    throw new ForgeError(
      "unsupported",
      `${this.client.place} offers no download of a pipeline's artifacts through its API. Read the step's log instead.`,
    );
  }

  private async pipeline(id: number): Promise<PipelineJson> {
    const pipeline = await this.client.get<PipelineJson | null>(
      `${this.repositoryPath()}/pipelines/${id}`,
    );
    if (!pipeline || pipeline.build_number !== id || typeof pipeline.uuid !== "string") {
      // i18n-exempt: served to the crewmate in read_workflow's answer
      throw unreadable(this.client.place, `pipeline #${id}`);
    }
    return pipeline;
  }

  private pipelinePath(pipeline: PipelineJson): string {
    return `${this.repositoryPath()}/pipelines/${encodeURIComponent(pipeline.uuid ?? "")}`;
  }

  private async steps(
    pipeline: PipelineJson,
    runId: number,
  ): Promise<{ steps: StepJson[]; complete: boolean }> {
    const steps: StepJson[] = [];
    let link: string | undefined =
      `${this.pipelinePath(pipeline)}/steps?pagelen=${WORKFLOW_JOBS_PER_PAGE}`;
    for (let page = 0; link && page < WORKFLOW_JOB_PAGES; page++) {
      const read: { values?: StepJson[]; next?: string } | null = await this.client.get(link);
      if (!Array.isArray(read?.values)) {
        // i18n-exempt: served to the crewmate in read_workflow's answer
        throw unreadable(this.client.place, `pipeline #${runId}'s steps`);
      }
      steps.push(...read.values);
      link = typeof read.next === "string" && read.next ? read.next : undefined;
    }
    return { steps, complete: link === undefined };
  }
}

/**
 * A pipeline's or step's state in the shared words: `completed` with its
 * result once Bitbucket gave one, otherwise its state in lower case
 * (`pending`, `in_progress`) and no conclusion.
 */
function stateOf(state: StateJson | undefined): { status: string; conclusion: string | null } {
  const name = typeof state?.name === "string" ? state.name : "";
  const result = typeof state?.result?.name === "string" ? state.result.name : "";
  if (name === "COMPLETED" || result) {
    return { status: "completed", conclusion: RESULTS[result] ?? (result.toLowerCase() || null) };
  }
  return { status: name ? name.toLowerCase() : "unknown", conclusion: null };
}

function lineOf(step: StepJson, id: number): WorkflowJobLine {
  const state = stateOf(step.state);
  return {
    id,
    // i18n-exempt: served to the crewmate in read_workflow's answer
    name: step.name || `step ${id}`,
    status: state.status,
    conclusion: state.conclusion,
    failedAt: null,
  };
}

function unreadable(place: string, what: string): ForgeError {
  return new ForgeError("transient", `${place}'s answer about ${what} could not be read.`);
}
