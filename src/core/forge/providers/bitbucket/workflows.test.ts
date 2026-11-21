import { describe, expect, it, vi } from "vitest";
import { failedRunJobs, runFinished } from "../../../orchestrator/runWatch";
import type { ForgeWorkflows } from "../../workflows";
import { BitbucketForge } from "./bitbucketForge";

// The task's intent (the captain's "adding bitbucket as another forge
// integration just like github and gitlab, reaching parity as much as
// possible"; its plan's piece 4): read_workflow reads a Bitbucket pipeline's
// steps and a step's log, and download_artifact says plainly that Bitbucket
// offers no artifact download. Answers follow Bitbucket Pipelines' published
// shapes: a pipeline by its build number, steps by UUID, and a log that may
// come from storage through a redirect.
const API = "https://api.bitbucket.org/2.0";
const KEY = "ATATT3xFfGF0disposable_test-key=0A1B2C3D";
const REPO = "/repositories/field-team/field-notes";
const PIPELINE = "{6a1c2a3e-5c0b-4b7e-9d43-1f0f2b9a7c11}";
const BUILD = "{0b5d2f61-8d2a-4c3e-b6a4-2e9f1d7c3b20}";
const TEST = "{9e4c1a77-1b3f-4e2d-8c5a-6f0d3b2a1e98}";
const HEAD = "4f1c2a9be07d3c55a1e8b2f06d9c4a7e3b5d1f20";
const LOG_STORE = "https://bbpipelines-logs.s3.amazonaws.com/steps/test.log?X-Amz-Signature=abc";

const pipeline = {
  type: "pipeline",
  uuid: PIPELINE,
  build_number: 57,
  run_number: 2,
  state: {
    name: "COMPLETED",
    type: "pipeline_state_completed",
    result: { name: "FAILED", type: "pipeline_state_completed_failed" },
  },
  target: {
    type: "pipeline_ref_target",
    ref_type: "branch",
    ref_name: "inf/add-field-notes",
    commit: { type: "commit", hash: HEAD },
    selector: { type: "branches", pattern: "inf/*" },
  },
  created_on: "2026-11-19T18:02:11.412Z",
  completed_on: "2026-11-19T18:06:40.118Z",
};

const steps = {
  pagelen: 100,
  page: 1,
  values: [
    {
      type: "pipeline_step",
      uuid: BUILD,
      name: "Build",
      state: {
        name: "COMPLETED",
        result: { name: "SUCCESSFUL", type: "pipeline_state_completed_successful" },
      },
    },
    {
      type: "pipeline_step",
      uuid: TEST,
      name: "Test",
      state: {
        name: "COMPLETED",
        result: { name: "FAILED", type: "pipeline_state_completed_failed" },
      },
    },
  ],
};

function standIn(logLocation: string | null) {
  const sent: { url: string; key: string | null }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    sent.push({ url, key: new Headers(init?.headers).get("Authorization") });
    const path = url.startsWith(API) ? url.slice(API.length) : url;
    if (path === `${REPO}/pipelines/57`) return Response.json(pipeline);
    if (path === `${REPO}/pipelines/${encodeURIComponent(PIPELINE)}/steps?pagelen=100`)
      return Response.json(steps);
    if (
      path ===
      `${REPO}/pipelines/${encodeURIComponent(PIPELINE)}/steps/${encodeURIComponent(TEST)}/log`
    )
      return logLocation
        ? new Response(null, { status: 307, headers: { location: logLocation } })
        : new Response("\u001b[32m+ pnpm test\u001b[0m\nFAIL notes.test.ts\n");
    if (url === LOG_STORE) return new Response("+ pnpm test\nFAIL notes.test.ts\n");
    return Response.json({ type: "error" }, { status: 404 });
  });
  const forge = new BitbucketForge(
    { kind: "bitbucket", host: "bitbucket.org", owner: "field-team", name: "field-notes", dir: "" },
    { token: async () => KEY, apiBaseUrl: API, fetch: fetcher },
  );
  return { workflows: forge.workflows, sent };
}

describe("Bitbucket Pipelines for the crewmate's evidence tools", () => {
  it("reads a pipeline by its build number as a finished, failed run with its page", async () => {
    const { workflows } = standIn(null);
    const run = await workflows.run(57);
    expect(run).toMatchObject({
      id: 57,
      headSha: HEAD,
      branch: "inf/add-field-notes",
      attempt: 2,
      status: "completed",
      conclusion: "failure",
      url: "https://bitbucket.org/field-team/field-notes/pipelines/results/57",
    });
    expect(runFinished(run)).toBe(true);
  });

  it("lists the steps by their place, and the run watch names the failed one", async () => {
    const { workflows } = standIn(null);
    const list = await workflows.jobs(57);
    expect(list).toEqual({
      jobs: [
        { id: 1, name: "Build", status: "completed", conclusion: "success", failedAt: null },
        { id: 2, name: "Test", status: "completed", conclusion: "failure", failedAt: null },
      ],
      total: 2,
      complete: true,
    });
    expect(failedRunJobs(list).map((job) => job.name)).toEqual(["Test"]);
  });

  it("reads a step's log as plain lines", async () => {
    const { workflows } = standIn(null);
    const { job, text } = await workflows.jobLog(57, 2);
    expect(job).toMatchObject({ id: 2, runId: 57, name: "Test", conclusion: "failure" });
    expect(text).toBe("+ pnpm test\nFAIL notes.test.ts\n");
  });

  it("follows a log's redirect to storage without the key, and refuses one anywhere else", async () => {
    const stored = standIn(LOG_STORE);
    expect((await stored.workflows.jobLog(57, 2)).text).toContain("FAIL notes.test.ts");
    expect(stored.sent.at(-1)).toEqual({ url: LOG_STORE, key: null });
    const elsewhere = standIn("https://logs.example.com/test.log");
    await expect(elsewhere.workflows.jobLog(57, 2)).rejects.toThrow("unsafe download address");
    expect(elsewhere.sent.some((entry) => entry.url.startsWith("https://logs.example.com"))).toBe(
      false,
    );
  });

  it("names how steps are numbered when asked for one past the last", async () => {
    const { workflows } = standIn(null);
    await expect(workflows.jobLog(57, 3)).rejects.toThrow("has 2 steps");
  });

  it("answers that Bitbucket offers no artifact download, without a request", async () => {
    const { workflows, sent } = standIn(null);
    await expect((workflows as ForgeWorkflows).download(57, 1)).rejects.toMatchObject({
      failure: "unsupported",
      message: expect.stringContaining("offers no download of a pipeline's artifacts"),
    });
    expect(sent).toEqual([]);
  });
});
