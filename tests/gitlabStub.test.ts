import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeChange } from "../src/core/forge/forge";
import { readGitLabOpenChanges } from "../src/core/forge/providers/gitlab/changes";
import { GitLabForge } from "../src/core/forge/providers/gitlab/gitlabForge";
import {
  GITLAB_STUB_KEY,
  GITLAB_STUB_PROJECT,
  type GitLabStub,
  type GitLabStubPipeline,
  startGitLabStub,
} from "./e2e/gitlabStub";

/**
 * The GitLab stand-in the e2e journeys deliver through
 * (`tests/e2e/gitlabStub.ts`), driven by the app's real GitLab forge rather
 * than by the stand-in's own accessors: what a journey relies on is what the
 * forge reads from it and asks of it - on gitlab.com and on a self-hosted
 * server alike. The branch heads are this test's map, standing in for a
 * repository's branches, so nothing here spawns git.
 */

/** A commit id as git would print one, distinct per name. */
const sha = (name: string) => createHash("sha1").update(name).digest("hex");

const TITLE = "fix: the meter reads on time";
const BODY = "## Intent\nThe meter reads on time.";
const BRANCH = "fm/task-meter";

let gitlab: GitLabStub | undefined;

afterEach(async () => {
  await gitlab?.close();
  gitlab = undefined;
});

async function forgeOver(host: string, heads: Record<string, string>) {
  const stub = await startGitLabStub(host);
  gitlab = stub;
  stub.headOf((branch) => {
    const head = heads[branch];
    if (!head) throw new Error(`no branch ${branch}`);
    return head;
  });
  const [owner, name] = [
    GITLAB_STUB_PROJECT.slice(0, GITLAB_STUB_PROJECT.lastIndexOf("/")),
    GITLAB_STUB_PROJECT.slice(GITLAB_STUB_PROJECT.lastIndexOf("/") + 1),
  ];
  const forge = new GitLabForge(
    { kind: "gitlab", host, owner, name, dir: "/r" },
    { token: async () => GITLAB_STUB_KEY, apiBaseUrl: stub.url },
  );
  return { gitlab: stub, forge };
}

/** The forge's reading of an opened merge request, under these pipelines and this history. */
async function readingOf(
  pipelines: GitLabStubPipeline[],
  history: { ref: string; source: string }[] = [],
) {
  const head = sha("meter head");
  const { gitlab, forge } = await forgeOver("gitlab.com", { [BRANCH]: head });
  gitlab.setPipelines(pipelines);
  gitlab.setHistory(history);
  const change = await forge.openChange({ branch: BRANCH, title: TITLE, body: BODY });
  return forge.checks(change);
}

const states = (items: { name: string; state: string }[]) =>
  items.map((item) => `${item.name}: ${item.state}`);

describe.each(["gitlab.com", "gitlab.example.com"])(
  "the GitLab stand-in on %s, through the app's forge",
  (host) => {
    it("opens one merge request for a pushed branch, finds it by its branch, and closes it", async () => {
      const head = sha("meter head");
      const { gitlab, forge } = await forgeOver(host, { [BRANCH]: head });
      await expect(
        forge.openChange({ branch: "fm/never-pushed", title: TITLE, body: BODY }),
      ).rejects.toMatchObject({ failure: "refused" });
      const opened = await forge.openChange({ branch: BRANCH, title: TITLE, body: BODY });
      expect(opened).toEqual({
        number: 1,
        url: `https://${host}/${GITLAB_STUB_PROJECT}/-/merge_requests/1`,
        branch: BRANCH,
        headSha: head,
        title: TITLE,
        body: BODY,
      });
      expect(forge.label(opened)).toBe("!1");
      expect(forge.place).toBe(host === "gitlab.com" ? "GitLab" : host);
      expect(await forge.changeFor(BRANCH)).toEqual(opened);
      expect(await forge.defaultBranch()).toBe("main");
      await forge.close(opened);
      expect(await forge.changeFor(BRANCH)).toBeNull();
      expect(await forge.pull(1)).toMatchObject({ state: "closed", merged: false });
      // Every request named the project by its whole nested path, encoded once.
      expect(gitlab.requests()).toContain(
        `POST /api/v4/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}/merge_requests`,
      );
    });

    it("squash-merges only at the checked head, under its title and description", async () => {
      const heads = { [BRANCH]: sha("meter head") };
      const { gitlab, forge } = await forgeOver(host, heads);
      const change = await forge.openChange({ branch: BRANCH, title: TITLE, body: BODY });
      expect(await forge.checks(change)).toMatchObject({ overall: "green" });
      expect(await forge.pull(1)).toMatchObject({
        state: "open",
        merged: false,
        headSha: change.headSha,
        base: "main",
        readiness: "clean",
      });

      // The branch moved on after its checks were read: GitLab refuses the stale head.
      heads[BRANCH] = sha("one more commit");
      await expect(forge.putIn(change, change.headSha)).rejects.toMatchObject({
        failure: "refused",
        message: expect.stringContaining("409"),
      });
      expect(gitlab.merges()).toEqual([]);
      expect((await forge.pull(1)).headSha).toBe(heads[BRANCH]);

      // A head that conflicts with newer work on main is refused, and reads as a conflict.
      const moved = { ...change, headSha: heads[BRANCH] as string };
      gitlab.conflicts(() => true);
      await expect(forge.putIn(moved, moved.headSha)).rejects.toMatchObject({
        failure: "refused",
        message: expect.stringContaining("Branch cannot be merged"),
      });
      expect((await forge.pull(1)).readiness).toBe("conflict");
      expect(gitlab.merges()).toEqual([]);

      gitlab.conflicts(() => false);
      const receipt = await forge.putIn(moved, moved.headSha);
      expect(gitlab.merges()).toEqual([
        { iid: 1, sha: moved.headSha, squash: true, message: `${TITLE}\n\n${BODY}` },
      ]);
      const merged = await forge.pull(1);
      expect(merged).toMatchObject({ state: "closed", merged: true, headSha: moved.headSha });
      expect(receipt).toEqual({ sha: merged.mergedSha });
      expect(await forge.changeFor(BRANCH)).toBeNull();
      // A merge request no longer open is refused, never merged twice.
      await expect(forge.putIn(moved, moved.headSha)).rejects.toMatchObject({
        failure: "refused",
      });
      expect(gitlab.merges()).toHaveLength(1);
    });

    it("refuses an unconventional title before asking GitLab to merge", async () => {
      const { gitlab, forge } = await forgeOver(host, { [BRANCH]: sha("meter head") });
      const change = await forge.openChange({ branch: BRANCH, title: "Meter fix", body: BODY });
      await expect(forge.putIn(change, change.headSha)).rejects.toThrow(/Meter fix/);
      expect(gitlab.requests().filter((line) => line.endsWith("/merge"))).toEqual([]);
    });
  },
);

describe("pipelines read as checks on the merge request's head", () => {
  it("reads a branch pipeline and its jobs, and names each", async () => {
    const checks = await readingOf([{ status: "success" }]);
    expect(checks.overall).toBe("green");
    expect(states(checks.items)).toEqual(["pipeline #101 (branch): success", "test: success"]);
  });

  it("holds a running or queued job pending and a failed job red", async () => {
    const running = await readingOf([
      {
        status: "running",
        jobs: [
          { name: "lint", status: "success" },
          { name: "test", status: "running" },
          { name: "deploy", status: "created" },
        ],
      },
    ]);
    expect(running.overall).toBe("pending");
    expect(states(running.items)).toEqual([
      "pipeline #101 (branch): pending",
      "lint: success",
      "test: pending",
      "deploy: pending",
    ]);
    const failed = await readingOf([
      { status: "failed", jobs: [{ name: "test", status: "failed" }] },
    ]);
    expect(failed.overall).toBe("red");
    expect(states(failed.items)).toEqual(["pipeline #101 (branch): failure", "test: failure"]);
  });

  it("never reads a manual job someone must start as passed, but lets an optional one and an allowed failure pass", async () => {
    const blocked = await readingOf([
      {
        status: "manual",
        jobs: [
          { name: "test", status: "success" },
          { name: "approve", status: "manual" },
        ],
      },
    ]);
    // Held, not failed: nothing will finish on its own, so nothing is watched.
    expect(blocked.overall).toBe("pending");
    expect(blocked.items.some((item) => item.state === "pending")).toBe(false);
    expect(states(blocked.items)).toContain(
      "approve (manual: waits for someone to start it): neutral",
    );
    const optional = await readingOf([
      {
        status: "success",
        jobs: [
          { name: "test", status: "success" },
          { name: "lint", status: "failed", allow_failure: true },
          { name: "deploy", status: "manual", allow_failure: true },
        ],
      },
    ]);
    expect(optional.overall).toBe("green");
    expect(states(optional.items)).toEqual([
      "pipeline #101 (branch): success",
      "test: success",
      "lint (failed, allowed to fail): skipped",
      "deploy (manual, optional, not started): skipped",
    ]);
  });

  it("counts a merged-results pipeline for the head beside the branch pipeline, and never one for an earlier head", async () => {
    const failedMerge = await readingOf([
      { status: "success" },
      { kind: "merge", status: "failed", jobs: [{ name: "test", status: "failed" }] },
    ]);
    expect(failedMerge.overall).toBe("red");
    expect(states(failedMerge.items)).toEqual([
      "pipeline #101 (branch): success",
      "test [branch]: success",
      "pipeline #102 (merged result): failure",
      "test [merged result]: failure",
    ]);
    // The merged result ran for an earlier head: this head's has not started.
    const earlier = await readingOf([
      { status: "success" },
      { kind: "merge", status: "success", head: sha("earlier head") },
    ]);
    expect(earlier.overall).toBe("pending");
    expect(states(earlier.items)).toEqual([
      "pipeline #101 (branch): success",
      "test: success",
      "the merge request pipeline for this version has not started yet: pending",
    ]);
  });

  it("reads an empty list as not started on a project that runs pipelines, and as no checks on one that runs none", async () => {
    expect(await readingOf([])).toEqual({ overall: "green", items: [] });
    expect(await readingOf([], [{ ref: "main", source: "push" }])).toEqual({
      overall: "green",
      items: [],
    });
    for (const history of [
      [{ ref: "refs/merge-requests/9/head", source: "merge_request_event" }],
      [{ ref: "feature", source: "push" }],
    ]) {
      expect(await readingOf([], history)).toEqual({
        overall: "pending",
        items: [{ name: "the pipeline for this version has not started yet", state: "pending" }],
      });
    }
    // A failed pipeline on an earlier head is no reading of this one.
    expect(await readingOf([{ status: "failed", head: sha("earlier head") }])).toMatchObject({
      overall: "pending",
    });
  });
});

describe("a merge request someone opened on GitLab", () => {
  it("is found for its branch and read by its number", async () => {
    const head = sha("meter head");
    const { gitlab, forge } = await forgeOver("gitlab.example.com", { [BRANCH]: head });
    const iid = gitlab.openMergeRequest({ branch: BRANCH, title: TITLE, description: BODY });
    const found = (await forge.changeFor(BRANCH)) as ForgeChange;
    expect(found).toMatchObject({ number: iid, headSha: head, title: TITLE, body: BODY });
    expect(await forge.pull(iid)).toMatchObject({ number: iid, state: "open", readiness: "clean" });
  });
});

describe.each(["gitlab.com", "gitlab.example.com"])(
  "a crewmate's evidence and the open-changes read on %s, through the app's GitLab code",
  (host) => {
    const ZIP = readFileSync("tests/fixtures/forge/measurement.zip");

    it("reads a failed job's log and saves its archive from signed storage, the key never sent there", async () => {
      const head = sha("meter head");
      const { gitlab, forge } = await forgeOver(host, { [BRANCH]: head });
      gitlab.setPipelines([
        {
          status: "failed",
          jobs: [
            {
              name: "measure",
              status: "failed",
              trace: "\u001b[32;1m$ pnpm measure\u001b[0;m\nMissing measurement input\n",
              artifacts: { zip: ZIP, filename: "measurements.zip" },
            },
          ],
        },
      ]);
      await forge.openChange({ branch: BRANCH, title: TITLE, body: BODY });
      const pipeline = await forge.workflows.run(101);
      expect(pipeline).toMatchObject({ id: 101, headSha: head, status: "failed" });
      const { job, text } = await forge.workflows.jobLog(101, 101_000);
      expect(job).toMatchObject({ id: 101_000, runId: 101, name: "measure", headSha: head });
      expect(text).toBe("$ pnpm measure\nMissing measurement input\n");
      const { artifact, bytes } = await forge.workflows.download(101, 101_000);
      expect(artifact).toMatchObject({ id: 101_000, name: "measurements.zip", expired: false });
      expect(Buffer.from(bytes)).toEqual(ZIP);
      expect(gitlab.requests()).toContain("GET /storage/job-artifacts/101000.zip");
      await expect(forge.workflows.jobLog(102, 101_000)).rejects.toThrow("different pipeline");
    });

    it("answers a retried job as a new pending job, so the merge request's checks run again", async () => {
      const head = sha("meter head");
      const { gitlab, forge } = await forgeOver(host, { [BRANCH]: head });
      gitlab.setPipelines([{ status: "failed", jobs: [{ name: "test", status: "failed" }] }]);
      const change = await forge.openChange({ branch: BRANCH, title: TITLE, body: BODY });
      expect((await forge.checks(change)).overall).toBe("red");
      const retried = await forge.api.call(
        "POST",
        `/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}/jobs/101000/retry`,
      );
      expect(retried.status).toBe(201);
      expect((await forge.checks(change)).overall).toBe("pending");
    });

    it("lists the person's open merge requests with each head pipeline and GitLab's own label", async () => {
      const head = sha("meter head");
      const { gitlab } = await forgeOver(host, { [BRANCH]: head, "fm/task-other": sha("other") });
      gitlab.setPipelines([{ head, status: "failed" }]);
      gitlab.openMergeRequest({ branch: BRANCH, title: TITLE });
      gitlab.openMergeRequest({ branch: "fm/task-other", title: "docs: a second note" });
      const rows = await readGitLabOpenChanges({
        host,
        token: async () => GITLAB_STUB_KEY,
        apiBaseUrl: gitlab.url,
      });
      expect(rows).toEqual([
        {
          host,
          project: GITLAB_STUB_PROJECT,
          number: 2,
          label: "!2",
          title: "docs: a second note",
          url: `https://${host}/${GITLAB_STUB_PROJECT}/-/merge_requests/2`,
          draft: false,
          checks: "none",
          updatedAt: "2026-10-09T12:02:00.000Z",
        },
        {
          host,
          project: GITLAB_STUB_PROJECT,
          number: 1,
          label: "!1",
          title: TITLE,
          url: `https://${host}/${GITLAB_STUB_PROJECT}/-/merge_requests/1`,
          draft: false,
          checks: "failed",
          updatedAt: "2026-10-09T12:01:00.000Z",
        },
      ]);
    });
  },
);
