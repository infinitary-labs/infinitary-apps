import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { afterEach, describe, expect, it } from "vitest";
import { presentationCommitMessage, presentationRegionMarkers } from "../src/core/forge";
import type { ForgeChange } from "../src/core/forge/forge";
import { GITLAB_PRIVATE_MEDIA_REFUSAL } from "../src/core/forge/providers/gitlab/attachments";
import { readGitLabOpenChanges } from "../src/core/forge/providers/gitlab/changes";
import { GitLabForge } from "../src/core/forge/providers/gitlab/gitlabForge";
import { ChangePresentations } from "../src/core/orchestrator/changePresentations";
import type { MediaProbe } from "../src/core/pi/cardImages";
import { stageChangePresentation } from "../src/core/pi/changePresentation";
import { openDatabase } from "../src/core/storage/db";
import { seedTask } from "../src/core/tasks/seedTask";
import { TaskService } from "../src/core/tasks/taskService";
import { readDemoVideo } from "../src/core/videoFormat";
import { DEMO_POSTER, DEMO_RECORDING } from "./e2e/demoFixtures";
import {
  GITLAB_STUB_KEY,
  GITLAB_STUB_PROJECT,
  type GitLabStub,
  type GitLabStubPipeline,
  startGitLabStub,
} from "./e2e/gitlabStub";
import { expectBytesEqual } from "./helpers/expectBytes";
import { BUNDLED_NAMING } from "./helpers/namingRunbook";
import { scratchDir } from "./helpers/scratchDirs";

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
  // The app's forge reads its active naming runbook's rule; this is the bundled one, on by default.
  const forge = new GitLabForge(
    { kind: "gitlab", host, owner, name, dir: "/r" },
    { token: async () => GITLAB_STUB_KEY, apiBaseUrl: stub.url, namingRule: () => BUNDLED_NAMING },
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
    // Approved contribution change: ordinary GitLab delivery stays available during discovery.
    it("lets contribution inspection read the ordinary GitLab project", async () => {
      const { forge } = await forgeOver(host, {});
      await expect(forge.contributions.inspect()).resolves.toMatchObject({
        project: { fullName: GITLAB_STUB_PROJECT },
        owned: false,
        canPush: true,
      });
    });

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
        // The forge carries the branch a merge request targets (INF-1873).
        base: "main",
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
      expect((await forge.checks(change)).items[0]?.state).toBe("success");
      expect(await forge.pull(1)).toMatchObject({
        state: "open",
        merged: false,
        headSha: change.headSha,
        base: "main",
        readiness: "clean",
      });

      // The branch moved on after its checks were read: GitLab refuses the stale head.
      heads[BRANCH] = sha("one more commit");
      await expect(forge.putIn(change, change.headSha, "squash")).rejects.toMatchObject({
        failure: "refused",
        message: expect.stringContaining("409"),
      });
      expect(gitlab.merges()).toEqual([]);
      expect((await forge.pull(1)).headSha).toBe(heads[BRANCH]);

      // A head that conflicts with newer work on main is refused, and reads as a conflict.
      const moved = { ...change, headSha: heads[BRANCH] as string };
      gitlab.conflicts(() => true);
      await expect(forge.putIn(moved, moved.headSha, "squash")).rejects.toMatchObject({
        failure: "refused",
        message: expect.stringContaining("Branch cannot be merged"),
      });
      expect((await forge.pull(1)).readiness).toBe("conflict");
      expect(gitlab.merges()).toEqual([]);

      gitlab.conflicts(() => false);
      const receipt = await forge.putIn(moved, moved.headSha, "squash");
      expect(gitlab.merges()).toEqual([
        { iid: 1, sha: moved.headSha, squash: true, message: `${TITLE}\n\n${BODY}` },
      ]);
      const merged = await forge.pull(1);
      expect(merged).toMatchObject({ state: "closed", merged: true, headSha: moved.headSha });
      expect(receipt).toEqual({ sha: merged.mergedSha });
      expect(await forge.changeFor(BRANCH)).toBeNull();
      // A merge request no longer open is refused, never merged twice.
      await expect(forge.putIn(moved, moved.headSha, "squash")).rejects.toMatchObject({
        failure: "refused",
      });
      expect(gitlab.merges()).toHaveLength(1);
    });

    it("refuses a title the naming runbook refuses before asking GitLab to merge", async () => {
      const { gitlab, forge } = await forgeOver(host, { [BRANCH]: sha("meter head") });
      const change = await forge.openChange({ branch: BRANCH, title: "Meter fix", body: BODY });
      await expect(forge.putIn(change, change.headSha, "squash")).rejects.toThrow(/Meter fix/);
      expect(gitlab.requests().filter((line) => line.endsWith("/merge"))).toEqual([]);
    });
  },
);

// Accepted contributor-story proof: source identity and notes belong to the
// fixture's host owner, not a journey-specific endpoint in product code.
it("keeps a fork's story notes separate from its merge request text", async () => {
  const head = sha("comment contribution");
  const { gitlab: stub, forge } = await forgeOver("gitlab.com", { contribution: head });
  const number = stub.openMergeRequest({
    branch: "contribution",
    title: "Fix typo",
    description: BODY,
    sourceProjectId: 99,
  });
  expect(await forge.pull(number)).toMatchObject({
    headRepo: "gitlab-project:99",
    headRepoId: 99,
    title: "Fix typo",
  });
  expect(await forge.changeFor("contribution")).toBeNull();
  const api = forge.api;
  if (!api) throw new Error("The fixture needs its API");
  const path = `/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}/merge_requests/${number}/notes`;
  const created = JSON.parse(
    (await api.call("POST", path, JSON.stringify({ body: "The crew's story." }))).body,
  );
  await api.call(
    "PUT",
    `${path}/${created.id}`,
    JSON.stringify({ body: "The verified crew story." }),
  );
  expect(JSON.parse((await api.call("GET", `${path}?per_page=100`)).body)).toEqual([
    { ...created, body: "The verified crew story." },
  ]);
  expect(stub.comments(number)).toEqual([{ id: created.id, body: "The verified crew story." }]);
  expect(stub.requestText(number)).toEqual({ title: "Fix typo", description: BODY });
  // A no-op native write still logs the full API path and must be caught by the journey.
  const nativePath = path.slice(0, -"/notes".length);
  await api.call("PUT", nativePath, JSON.stringify({ title: "Fix typo" }));
  expect(stub.requests()).toContain(`PUT /api/v4${nativePath}`);
  expect(stub.requestText(number)).toEqual({ title: "Fix typo", description: BODY });
});

describe("pipelines read as checks on the merge request's head", () => {
  it("reads a branch pipeline and its jobs, and names each", async () => {
    const checks = await readingOf([{ status: "success" }]);

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

    expect(states(running.items)).toEqual([
      "pipeline #101 (branch): pending",
      "lint: success",
      "test: pending",
      "deploy: pending",
    ]);
    const failed = await readingOf([
      { status: "failed", jobs: [{ name: "test", status: "failed" }] },
    ]);

    expect(states(failed.items)).toEqual(["pipeline #101 (branch): failure", "test: failure"]);
  });

  // The captain's ask (INF-587): the checks cell counts from GitLab's own start and finish.
  it("keeps each job's start and finish as GitLab gives them", async () => {
    const checks = await readingOf([
      {
        status: "running",
        jobs: [
          {
            name: "lint",
            status: "success",
            started_at: "2026-10-09T12:01:03.512Z",
            finished_at: "2026-10-09T12:02:41.090Z",
          },
          { name: "test", status: "running", started_at: "2026-10-09T12:01:04.117Z" },
          { name: "deploy", status: "created" },
        ],
      },
    ]);
    expect(checks.items.slice(1)).toMatchObject([
      {
        name: "lint",
        state: "success",
        startedAt: Date.parse("2026-10-09T12:01:03.512Z"),
        finishedAt: Date.parse("2026-10-09T12:02:41.090Z"),
      },
      { name: "test", state: "pending", startedAt: Date.parse("2026-10-09T12:01:04.117Z") },
      { name: "deploy", state: "pending" },
    ]);
  });

  it("holds a manual job and reads a job allowed to fail as GitLab's pipeline does", async () => {
    const blocked = await readingOf([
      {
        status: "manual",
        jobs: [
          { name: "test", status: "success" },
          { name: "approve", status: "manual" },
        ],
      },
    ]);
    // Held, not failed: nothing will finish on its own, so nothing is watched;
    // the job and the pipeline it blocks wait for a person (INF-4552).

    expect(blocked.items.some((item) => item.state === "pending")).toBe(false);
    expect(blocked.items.find((item) => item.name === "approve")).toMatchObject({ manual: true });
    expect(blocked.items[0]).toMatchObject({ status: "manual", manual: true });
    const optional = await readingOf([
      {
        status: "success",
        jobs: [
          { name: "test", status: "success" },
          { name: "lint", status: "failed", allow_failure: true },
          { name: "audit", status: "canceled", allow_failure: true },
          { name: "deploy", status: "manual", allow_failure: true },
        ],
      },
    ]);

    // GitLab counts a failed or cancelled job it allows to fail as passed with
    // warnings, so its pipeline succeeds: finished, holding nothing (INF-4557).
    expect(optional.items.find((item) => item.name === "lint")).toMatchObject({
      state: "neutral",
      failureAllowed: true,
      status: "failed",
      allowFailure: true,
      run: 101,
    });
    expect(optional.items.find((item) => item.name === "audit")).toMatchObject({
      state: "neutral",
      failureAllowed: true,
      status: "canceled",
    });
    expect(states(optional.items)).toEqual([
      "pipeline #101 (branch): success",
      "test: success",
      "lint: neutral",
      "audit: neutral",
      "deploy: skipped",
    ]);
    // GitLab leaves an optional manual job out of the pipeline's status (INF-4552).
    expect(optional.items.find((item) => item.name === "deploy")).not.toHaveProperty("manual");
  });

  it("counts a merged-results pipeline for the head beside the branch pipeline, and never one for an earlier head", async () => {
    const failedMerge = await readingOf([
      { status: "success" },
      { kind: "merge", status: "failed", jobs: [{ name: "test", status: "failed" }] },
    ]);

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

    expect(states(earlier.items)).toEqual(["pipeline #101 (branch): success", "test: success"]);
  });

  it("relays an empty pipeline list without inventing a pending check (INF-1177)", async () => {
    expect(await readingOf([])).toMatchObject({ items: [], complete: true });
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
      expect((await forge.checks(change)).items).toContainEqual(
        expect.objectContaining({ name: "test", state: "failure" }),
      );

      const retried = await forge.api.call(
        "POST",
        `/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}/jobs/101000/retry`,
      );
      expect(retried.status).toBe(201);
      expect((await forge.checks(change)).items).toContainEqual(
        expect.objectContaining({ name: "test", state: "pending" }),
      );
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

// INF-223 / accepted INF-132: a gitlab.com merge request and its completion card share one
// saved story whose real pictures and recording reach GitLab's own project uploads first.
describe("a saved story through the real GitLab forge and the stand-in", () => {
  const TASK = "ab12cd34";
  const STORY_BRANCH = `fm/task-${TASK}`;
  const HEAD = sha("story head");
  const risk = Object.fromEntries(
    RISK_DIMENSIONS.map((dimension) => [
      dimension,
      { level: "low", why: `The ${dimension} assessment for this fixture.` },
    ]),
  ) as RiskDeclaration;

  async function arrange() {
    const { gitlab, forge } = await forgeOver("gitlab.com", { [STORY_BRANCH]: HEAD });
    const root = scratchDir("infinitary-gitlab-story-");
    const media = join(root, "cards");
    const worktree = join(root, "work");
    mkdirSync(media);
    mkdirSync(join(worktree, "shots"), { recursive: true });
    for (const theme of ["dark", "light"])
      copyFileSync(
        resolve(`release-notes/pictures/action-reply-line-${theme}.webp`),
        join(worktree, `${theme}.webp`),
      );
    if (!DEMO_POSTER.bytes) throw new Error("The recording fixture needs its poster");
    writeFileSync(join(worktree, DEMO_RECORDING.path), DEMO_RECORDING.bytes);
    writeFileSync(join(worktree, DEMO_POSTER.path), DEMO_POSTER.bytes);
    const db = openDatabase(join(root, "data"));
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, {
      id: TASK,
      title: "Show the change",
      prompt: "Share the evidence",
      branch: STORY_BRANCH,
      worktreeDir: worktree,
      repoDir: worktree,
      status: "idle",
    });
    const media0 = (path: string, alt: string) => ({
      path,
      alt,
      captureHead: HEAD,
      inspected: true as const,
    });
    const draft = {
      title: "feat: carry the evidence",
      base: HEAD,
      head: HEAD,
      publishable: true as const,
      why: ["The merge request should tell the same story as the merge card."],
      whatChanged: ["The description carries the selected pictures and recording."],
      before: ["The earlier description contained text alone."],
      after: ["Both views show the same evidence."],
      views: [
        {
          id: "completion",
          caption: "Completion story",
          kind: "changed" as const,
          before: [media0("dark.webp", "The existing dark completion view")],
          after: [{ ...media0("light.webp", "The inspected light completion view"), faults: [] }],
        },
        {
          id: "drag",
          caption: "The box slides right",
          kind: "new" as const,
          before: [],
          after: [
            {
              ...media0(DEMO_RECORDING.path, DEMO_POSTER.alt),
              poster: DEMO_POSTER.path,
              faults: [],
            },
          ],
        },
      ],
      checked: [{ check: "Publication", result: "The selected story and evidence agree." }],
      verification: ["Opened both pictures and played the recording."],
      risk,
      requiredActions: [],
      unfinished: [],
      projectText: "Closes #24",
    };
    // The host's isolated player decodes what the recording's boxes state, as for a sound recording.
    const probe: MediaProbe = async ({ bytes }) => {
      const read = readDemoVideo(bytes);
      return read.ok
        ? { ok: true, ...read.video }
        : { ok: false, reason: "the decoder could not open it" };
    };
    const stage = (input: typeof draft) =>
      stageChangePresentation(input, { taskId: TASK, worktree, dir: media, probe });
    const service = () =>
      new ChangePresentations({ tasks, mediaDir: () => media, head: async () => HEAD });
    return { gitlab, forge, db, tasks, draft, stage, service, worktree };
  }

  it("refuses a private project without media protection, then opens only after every upload", async () => {
    const at = await arrange();
    try {
      const project = `/api/v4/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}`;
      const first = at.service();
      const revision = await first.prepare(TASK, await at.stage(at.draft), at.forge);
      await expect(
        first.publish(TASK, revision, at.forge, STORY_BRANCH, "feat: carry the evidence"),
      ).rejects.toThrow(GITLAB_PRIVATE_MEDIA_REFUSAL);
      // Nothing left the app: no file, and no merge request, not even a draft.
      expect(at.gitlab.uploads()).toEqual([]);
      expect(at.gitlab.requests()).not.toContain(`POST ${project}/merge_requests`);
      expect(at.gitlab.requests().some((line) => line.endsWith("/uploads"))).toBe(false);

      // The project's maintainer turns the protection on in GitLab; the app never does.
      at.gitlab.protectMedia(true);
      const opened = await first.publish(
        TASK,
        revision,
        at.forge,
        STORY_BRANCH,
        "feat: carry the evidence",
      );
      const writes = at.gitlab
        .requests()
        .filter((line) => /^(POST|PUT) /.test(line))
        .map((line) => line.replace(/\d+\/uploads$/, "<id>/uploads"));
      expect(writes).toEqual([
        "POST /api/v4/projects/<id>/uploads",
        "POST /api/v4/projects/<id>/uploads",
        "POST /api/v4/projects/<id>/uploads",
        `POST ${project}/merge_requests`,
      ]);
      // Each upload is the exact retained file, served back from the address GitLab named.
      const story = at.tasks.delivery.changePresentation(TASK)?.revisions.at(-1);
      if (!story) throw new Error("The prepared story is missing");
      const uploads = at.gitlab.uploads();
      expect(uploads.map((upload) => upload.filename)).toEqual([
        "picture.webp",
        "picture.webp",
        "recording.mp4",
      ]);
      const description = at.gitlab.descriptions().get(1) ?? "";
      expect(description).toBe(opened.body);
      expect(description.startsWith("Closes #24\n\n")).toBe(true);
      for (const [index, upload] of uploads.entries()) {
        const reference = `/uploads/${upload.secret}/${upload.filename}`;
        const alt = [
          "The existing dark completion view",
          "The inspected light completion view",
          DEMO_POSTER.alt,
        ][index];
        if (upload.filename === "recording.mp4")
          expect(description).toContain(`![${alt}](${reference})`);
        else expect(description).toContain(`<img src="${reference}" alt="${alt}" width="320">`);
        const served = await fetch(
          `${new URL(at.gitlab.url).origin}/-/project/7/uploads/${upload.secret}/${upload.filename}`,
          { headers: { Authorization: `Bearer ${GITLAB_STUB_KEY}` } },
        );
        expect(served.status).toBe(200);
        const retained = story.assets.filter((asset) =>
          story.views.some((view) =>
            view.after.concat(view.before).some((m) => m.asset === asset.id),
          ),
        )[index];
        expectBytesEqual(
          new Uint8Array(await served.arrayBuffer()),
          readFileSync(join(at.worktree, "..", "cards", retained?.file ?? "missing")),
        );
      }
    } finally {
      at.db.close();
    }
  });

  // INF-290 F2/F3, the captain's ruling: a project template's quick actions are the
  // project's choice and run; the story's own words never do, and the opening still confirms.
  it("runs only the project template's quick actions and confirms the opening by its story region", async () => {
    const at = await arrange();
    try {
      at.gitlab.protectMedia(true);
      const service = at.service();
      const revision = await service.prepare(
        TASK,
        await at.stage({
          ...at.draft,
          why: ["/merge"],
          projectText: "Closes #24\n/label ~evidence",
        }),
        at.forge,
      );
      const opened = await service.publish(
        TASK,
        revision,
        at.forge,
        STORY_BRANCH,
        "feat: carry the evidence",
      );
      expect(at.gitlab.quickActions()).toEqual(["/label ~evidence"]);
      const description = at.gitlab.descriptions().get(1) ?? "";
      expect(description).toBe(opened.body);
      expect(description.startsWith("Closes #24\n\n")).toBe(true);
      expect(description.split("\n\n")).toContain("\\/merge");
      expect(at.tasks.delivery.changePresentation(TASK)).toMatchObject({
        publication: { state: "confirmed", revision },
        published: { state: "confirmed", revision, number: 1 },
      });
    } finally {
      at.db.close();
    }
  });

  it("never resends an upload whose answer was lost, until a deliberate retry names it", async () => {
    const at = await arrange();
    try {
      at.gitlab.protectMedia(true);
      let lose = true;
      // The file reaches GitLab, then the answer is lost on the way back.
      const losing = new GitLabForge(
        {
          kind: "gitlab",
          host: "gitlab.com",
          owner: GITLAB_STUB_PROJECT.slice(0, GITLAB_STUB_PROJECT.lastIndexOf("/")),
          name: GITLAB_STUB_PROJECT.slice(GITLAB_STUB_PROJECT.lastIndexOf("/") + 1),
          dir: "/r",
        },
        {
          token: async () => GITLAB_STUB_KEY,
          apiBaseUrl: at.gitlab.url,
          fetch: async (input, init) => {
            const answer = await fetch(input, init);
            if (lose && String(input).endsWith("/uploads")) {
              lose = false;
              throw new Error("socket hang up");
            }
            return answer;
          },
        },
      );
      const service = at.service();
      const revision = await service.prepare(TASK, await at.stage(at.draft), losing);
      const open = () =>
        service.publish(TASK, revision, losing, STORY_BRANCH, "feat: carry the evidence");
      await expect(open()).rejects.toThrow(/may have kept the attachment/);
      await expect(open()).rejects.toThrow(/may already exist on GitLab/);
      expect(at.gitlab.uploads()).toHaveLength(1);
      expect(at.gitlab.descriptions().size).toBe(0);
      const uncertain = at.tasks.delivery
        .changePresentation(TASK)
        ?.receipts.find((receipt) => receipt.state === "uncertain");
      if (!uncertain) throw new Error("The lost upload is not kept as uncertain");
      await service.publish(
        TASK,
        revision,
        losing,
        STORY_BRANCH,
        "feat: carry the evidence",
        "pending",
        { retryUploads: [uncertain.digest] },
      );
      // The deliberate retry sent that file once more; the possible orphan stays on its receipt.
      expect(at.gitlab.uploads()).toHaveLength(4);
      expect(
        at.tasks.delivery
          .changePresentation(TASK)
          ?.receipts.find((receipt) => receipt.digest === uncertain.digest),
      ).toMatchObject({ state: "confirmed", possibleOrphan: true });
      expect(at.gitlab.descriptions().size).toBe(1);
    } finally {
      at.db.close();
    }
  });

  it("replaces the story after a restart without another upload, keeps a person's words, and squashes its summary", async () => {
    const at = await arrange();
    try {
      at.gitlab.protectMedia(true);
      const before = at.service();
      const first = await before.prepare(TASK, await at.stage(at.draft), at.forge);
      const opened = await before.publish(
        TASK,
        first,
        at.forge,
        STORY_BRANCH,
        "feat: carry the evidence",
      );
      // A person adds words around the story on GitLab's own page.
      await fetch(
        `${at.gitlab.url}/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}/merge_requests/1`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${GITLAB_STUB_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ description: `Reviewer note: looks good.\r\n\r\n${opened.body}` }),
        },
      );
      const uploaded = at.gitlab.uploads().length;

      // A restart: a new service reads the same saved receipts.
      const after = at.service();
      const second = await after.prepare(
        TASK,
        await at.stage({
          ...at.draft,
          checked: [{ check: "Publication", result: "The selected story and evidence agree." }],
          verification: ["The pipeline passed for this version."],
        }),
        at.forge,
      );
      const replaced = await after.publish(
        TASK,
        second,
        at.forge,
        STORY_BRANCH,
        "feat: carry the evidence",
        "passed",
      );
      expect(at.gitlab.uploads()).toHaveLength(uploaded);
      const description = at.gitlab.descriptions().get(1) ?? "";
      expect(description).toBe(replaced.body);
      expect(description.startsWith("Reviewer note: looks good.\n\nCloses #24\n\n")).toBe(true);
      const { start, end } = presentationRegionMarkers(TASK);
      expect(description.split(start)).toHaveLength(2);
      expect(description.split(end)).toHaveLength(2);
      expect(description).toContain("The pipeline passed for this version\\.");
      expect(at.tasks.delivery.changePresentation(TASK)?.published?.revision).toBe(second);
      expect(description).not.toContain("Story ");

      const change = await at.forge.changeFor(STORY_BRANCH);
      if (!change) throw new Error("The merge request is not open");
      const ready = await after.assertPublished(TASK, change, at.forge);
      await at.forge.putIn(ready, ready.headSha, "squash");
      expect(at.gitlab.merges()).toEqual([
        {
          iid: 1,
          sha: HEAD,
          squash: true,
          message: `feat: carry the evidence\n\n${presentationCommitMessage({ whatChanged: at.draft.whatChanged, projectText: "Closes #24" }, BUNDLED_NAMING)}`,
        },
      ]);
    } finally {
      at.db.close();
    }
  });

  // INF-717: a republished story's new title reaches the merge request, so its squash
  // carries the breaking marker; a draft keeps GitLab's marker until it is made ready.
  it("renames a draft merge request to a republished story's title and squashes under it", async () => {
    const at = await arrange();
    try {
      const service = at.service();
      const words = { ...at.draft, views: [], noPicture: "This fixture publishes words alone." };
      const first = await service.prepare(TASK, await at.stage(words), at.forge);
      await service.publish(
        TASK,
        first,
        at.forge,
        STORY_BRANCH,
        "feat: carry the evidence",
        "pending",
        undefined,
        undefined,
        { draft: true },
      );
      const second = await service.prepare(
        TASK,
        await at.stage({ ...words, title: "feat!: carry the evidence" }),
        at.forge,
      );
      await service.publish(TASK, second, at.forge, STORY_BRANCH, "feat!: carry the evidence");
      const draft = await at.forge.changeFor(STORY_BRANCH);
      expect(draft).toMatchObject({ title: "Draft: feat!: carry the evidence", draft: true });
      const project = `/api/v4/projects/${encodeURIComponent(GITLAB_STUB_PROJECT)}`;
      expect(at.gitlab.requests().filter((line) => /^(POST|PUT) /.test(line))).toEqual([
        `POST ${project}/merge_requests`,
        `PUT ${project}/merge_requests/1`,
      ]);

      const ready = await at.forge.markReady(draft as ForgeChange, () => {});
      expect(ready).toMatchObject({ title: "feat!: carry the evidence" });
      const published = await service.assertPublished(TASK, ready, at.forge);
      await at.forge.putIn(published, published.headSha, "squash");
      expect(at.gitlab.merges()[0]?.message.split("\n")[0]).toBe("feat!: carry the evidence");
    } finally {
      at.db.close();
    }
  });
});
