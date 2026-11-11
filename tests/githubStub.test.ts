import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RISK_DIMENSIONS, type RiskDeclaration } from "@shared/risk";
import { afterEach, describe, expect, it } from "vitest";
import { readPresentationRegion } from "../src/core/forge";
import { ForgeError } from "../src/core/forge/forge";
import { readOpenChanges } from "../src/core/forge/providers/github/changes";
import { GitHubForge } from "../src/core/forge/providers/github/githubForge";
import { requestDeviceCode } from "../src/core/forge/providers/github/oauth";
import { ChangePresentations } from "../src/core/orchestrator/changePresentations";
import { stageChangePresentation } from "../src/core/pi/changePresentation";
import { openDatabase } from "../src/core/storage/db";
import { seedTask } from "../src/core/tasks/seedTask";
import { TaskService } from "../src/core/tasks/taskService";
import { DEMO_POSTER, DEMO_RECORDING } from "./e2e/demoFixtures";
import { type GitHubStub, STUB_USER_CODE, startGitHubStub } from "./e2e/githubStub";
import { expectBytesEqual } from "./helpers/expectBytes";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The GitHub stand-in the e2e journeys put changes in through
 * (`tests/e2e/githubStub.ts`), driven by the app's real GitHub forge rather
 * than by the stand-in's own accessors: what a journey relies on is what the
 * forge reads from it and asks of it. The branch heads are this test's map,
 * standing in for a repository's branches, so nothing here spawns git.
 */

/** A commit id as git would print one, distinct per name. */
const sha = (name: string) => createHash("sha1").update(name).digest("hex");

const TITLE = "fix: the meter reads on time";
const BODY = "## Intent\nThe meter reads on time.";

let github: GitHubStub | undefined;

afterEach(async () => {
  await github?.close();
  github = undefined;
});

async function forgeOver(heads: Record<string, string>) {
  const stub = await startGitHubStub();
  github = stub;
  stub.headOf((branch) => {
    const head = heads[branch];
    if (!head) throw new Error(`no branch ${branch}`);
    return head;
  });
  const forge = new GitHubForge(
    { kind: "github", host: "github.com", owner: "octo", name: "meterlab", dir: "/r" },
    { token: async () => "gho_e2e_sign_in", apiBaseUrl: stub.url },
  );
  return { github: stub, forge };
}

const mergeRequests = (stub: GitHubStub) =>
  stub.requests().filter((line) => line.endsWith("/merge"));

describe("the GitHub stand-in, through the app's forge", () => {
  // The approved queue protocol writes trusted merge words before a waiting
  // mark. Regression: the journeys' API lacked this comment endpoint entirely.
  it("queues approved words and reads their trusted revocation back", async () => {
    const branch = "fm/task-meter";
    const head = sha("meter head");
    const { github, forge } = await forgeOver({ [branch]: head });
    const change = await forge.openChange({ branch, title: TITLE, body: BODY });
    if (change.number === undefined) throw new Error("GitHub did not number the opened change");
    await forge.markQueued(head, {
      number: change.number,
      title: TITLE,
      message: BODY,
      naming: null,
    });
    expect(github.statuses(head)).toMatchObject([{ state: "pending" }]);
    await forge.removeQueued(head, change.number);
    expect(github.statuses(head)).toMatchObject([{ state: "error" }]);
    const writes = () =>
      github
        .requests()
        .filter((line) => line === `POST /repos/octo/meterlab/issues/${change.number}/comments`);
    expect(writes()).toHaveLength(2);
    // A second read sees the persisted revocation rather than approving anew.
    await forge.removeQueued(head, change.number);
    expect(writes()).toHaveLength(2);
  });
  // INF-285 F4: the existing endpoint override keeps real evidence bytes off GitHub.
  it("uploads and reads back pictures and recordings entirely through the local API override", async () => {
    github = await startGitHubStub();
    const stub = github;
    const forge = new GitHubForge(
      { kind: "github", host: "github.com", owner: "octo", name: "meterlab", dir: "/r" },
      {
        token: async () => "gho_e2e_sign_in",
        apiBaseUrl: `${stub.url}/`,
        fetch: (input, init) => {
          // A red run fails here instead of contacting the production upload endpoint.
          expect(new URL(String(input)).origin).toBe(stub.url);
          return fetch(input, init);
        },
      },
    );
    const attachments = forge.attachments;
    if (!attachments) throw new Error("GitHub must offer native attachments");
    const destination = await attachments.destination();
    for (const file of [
      { bytes: DEMO_POSTER.bytes, mediaType: "image/png" },
      { bytes: DEMO_RECORDING.bytes, mediaType: "video/mp4" },
    ] as const) {
      if (!file.bytes) throw new Error("The fixture needs real media bytes");
      const receipt = await attachments.upload(destination, {
        bytes: file.bytes,
        mediaType: file.mediaType,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      });
      expect(receipt.url).toMatch(/^https:\/\/github\.com\/user-attachments\/assets\//);
      const readback = await fetch(`${stub.url}${new URL(receipt.url).pathname}`, {
        headers: { Authorization: "Bearer gho_e2e_sign_in" },
      });
      expect(readback.status).toBe(200);
      expect(readback.headers.get("content-type")).toBe(file.mediaType);
      expectBytesEqual(new Uint8Array(await readback.arrayBuffer()), file.bytes);
    }
    expect(stub.requests().filter((line) => line === "POST /user-attachments/assets")).toHaveLength(
      2,
    );
    expect(stub.requests().some((line) => line.endsWith("/pulls"))).toBe(false);
  });

  it("serves the current user-facing code through the real device-flow reader", async () => {
    github = await startGitHubStub();
    const options = { baseUrl: github.url };
    expect(await requestDeviceCode(options)).toMatchObject({
      userCode: STUB_USER_CODE,
      verificationUri: `${github.url}/login/device`,
    });
    github.device.setCode("FRESH-CODE");
    expect(await requestDeviceCode(options)).toMatchObject({
      userCode: "FRESH-CODE",
      verificationUri: `${github.url}/login/device`,
    });
  });

  it("serves the destination, branch and updated body needed by saved stories (INF-228 F1)", async () => {
    const branch = "fm/task-story";
    const head = sha("saved story");
    const { forge } = await forgeOver({ [branch]: head });
    expect(await forge.attachments?.destination()).toMatchObject({
      fullName: "octo/meterlab",
      visibility: "private",
    });
    expect(await forge.branchHead(branch)).toBe(head);
    const change = await forge.openChange({ branch, title: TITLE, body: BODY });
    const replacement = `${BODY}\n\nThe same story now names its verification.`;
    await forge.updateChangeBody(change, replacement);
    expect(await forge.changeFor(branch)).toMatchObject({ ...change, body: replacement });
    await forge.close(change);
    expect(await forge.changeFor(branch)).toBeNull();
  });

  it("accepts verification only for a pushed branch and lists its queued run at that version", async () => {
    const branch = "fm/task-verify";
    const { github, forge } = await forgeOver({ [branch]: sha("verification") });
    const path = "/repos/octo/meterlab/actions/workflows/verify.yml/dispatches";
    expect((await forge.api.call("POST", path, JSON.stringify({ ref: "missing" }))).status).toBe(
      422,
    );
    expect(github.dispatches()).toEqual([]);
    expect(
      (
        await forge.api.call(
          "POST",
          path,
          JSON.stringify({ ref: branch, inputs: { profile: "alpha", perf: true } }),
        )
      ).status,
    ).toBe(204);
    const result = await forge.api.call(
      "GET",
      `/repos/octo/meterlab/actions/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch`,
    );
    expect(JSON.parse(result.body)).toMatchObject({
      total_count: 1,
      workflow_runs: [
        {
          head_sha: sha("verification"),
          head_branch: branch,
          event: "workflow_dispatch",
          status: "queued",
          conclusion: null,
        },
      ],
    });
    expect(github.dispatches()).toEqual([
      {
        workflow: "verify.yml",
        ref: branch,
        headSha: sha("verification"),
        inputs: { profile: "alpha", perf: true },
      },
    ]);
    expect(
      (await forge.api.call("POST", "/repos/octo/meterlab/actions/runs/1000/cancel")).status,
    ).toBe(202);
    const cancelled = await forge.api.call(
      "GET",
      `/repos/octo/meterlab/actions/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch`,
    );
    expect(JSON.parse(cancelled.body).workflow_runs[0]).toMatchObject({
      status: "completed",
      conclusion: "cancelled",
    });
    const absent = await forge.api.call(
      "GET",
      "/repos/octo/meterlab/actions/runs?branch=other&event=workflow_dispatch",
    );
    expect(JSON.parse(absent.body)).toEqual({ total_count: 0, workflow_runs: [] });
  });

  it("keeps the title and body a change was opened with, follows its branch's head, and squashes at the head asked for", async () => {
    const branch = "fm/task-meter";
    const heads = { [branch]: sha("first") };
    const { github, forge } = await forgeOver(heads);

    const opened = await forge.openChange({ branch, title: TITLE, body: BODY });
    expect(opened).toMatchObject({
      number: 100,
      branch,
      headSha: sha("first"),
      title: TITLE,
      body: BODY,
    });
    expect(await forge.changeFor(branch)).toEqual(opened);

    // The crewmate pushes again: the change's head is its branch's new commit.
    heads[branch] = sha("second");
    const read = await forge.changeFor(branch);
    expect(read).toMatchObject({ headSha: sha("second"), title: TITLE, body: BODY });

    await forge.putIn(read as NonNullable<typeof read>, sha("second"));
    expect(github.merges()).toEqual([
      { number: 100, sha: sha("second"), method: "squash", title: TITLE, message: BODY },
    ]);
    // A change that went in is no longer open for its branch.
    expect(await forge.changeFor(branch)).toBeNull();
  });

  it("serves a seeded change with its own title and body, for the one branch it belongs to", async () => {
    const { github, forge } = await forgeOver({ "fm/task-a": sha("a"), "fm/task-b": sha("b") });
    github.servePull({ number: 55, title: "feat: the crewmate's work", body: "Why it matters." });

    expect(await forge.changeFor("fm/task-a")).toEqual({
      number: 55,
      url: "https://github.com/octo/meterlab/pull/55",
      branch: "fm/task-a",
      headSha: sha("a"),
      title: "feat: the crewmate's work",
      body: "Why it matters.",
    });
    // Another branch has no change: one change never answers for two.
    expect(await forge.changeFor("fm/task-b")).toBeNull();
  });

  it("lists each open change the app opened by its own title", async () => {
    const { github, forge } = await forgeOver({ "fm/task-meter": sha("first") });
    await forge.openChange({ branch: "fm/task-meter", title: TITLE, body: BODY });
    const rows = await readOpenChanges({
      host: "github.com",
      token: "gho_e2e_sign_in",
      apiBaseUrl: github.url,
    });
    expect(rows.map((row) => [row.number, row.title])).toEqual([[100, TITLE]]);
  });

  describe("refuses what GitHub refuses, and records no merge", () => {
    it("a put-in at a head the change has moved on from (409)", async () => {
      const branch = "fm/task-meter";
      const heads = { [branch]: sha("checked") };
      const { github, forge } = await forgeOver(heads);
      const checked = await forge.openChange({ branch, title: TITLE, body: BODY });
      heads[branch] = sha("pushed-after");

      const refusal = await forge.putIn(checked, sha("checked")).catch((caught: unknown) => caught);
      expect(refusal).toBeInstanceOf(ForgeError);
      expect(refusal).toMatchObject({ failure: "refused" });
      expect(String((refusal as Error).message)).toContain("409");
      expect(mergeRequests(github)).toHaveLength(1);
      expect(github.merges()).toEqual([]);
    });

    it("a change in conflict with newer work (405), until a later head carries that work - read back by its number", async () => {
      const branch = "fm/task-meter";
      const heads = { [branch]: sha("approved") };
      const { github, forge } = await forgeOver(heads);
      const change = await forge.openChange({ branch, title: TITLE, body: BODY });
      github.conflicts((head) => head === sha("approved"));
      // GitHub's mergeability read lags: only the merge request finds the conflict.
      expect(await forge.pull(change.number as number)).toMatchObject({
        state: "open",
        merged: false,
        headSha: sha("approved"),
        base: "main",
        readiness: "clean",
      });
      await expect(forge.putIn(change, sha("approved"))).rejects.toMatchObject({
        failure: "refused",
        message: expect.stringContaining("405"),
      });
      expect(github.merges()).toEqual([]);
      // INF-1342: after the refused send, a repair's background-job idle
      // boundary must read the known conflict, not a forever-clean fiction.
      expect(await forge.pull(change.number as number)).toMatchObject({ readiness: "conflict" });
      heads[branch] = sha("repaired");
      expect(await forge.pull(change.number as number)).toMatchObject({ readiness: "clean" });
      const repaired = (await forge.changeFor(branch)) as NonNullable<
        Awaited<ReturnType<typeof forge.changeFor>>
      >;
      await expect(forge.putIn(repaired, sha("repaired"))).resolves.toEqual({
        sha: sha("repaired"),
      });
      expect(github.merges().map((merge) => merge.sha)).toEqual([sha("repaired")]);
      // Merged, it reads closed and merged by its number, no longer open for its branch.
      expect(await forge.pull(change.number as number)).toMatchObject({
        state: "closed",
        merged: true,
      });
      expect(await forge.changeFor(branch)).toBeNull();
    });

    it("a push that lands between the check and the put-in", async () => {
      const branch = "fm/task-meter";
      const heads = { [branch]: sha("checked") };
      const { github, forge } = await forgeOver(heads);
      const checked = await forge.openChange({ branch, title: TITLE, body: BODY });
      github.onMergeRequest(() => {
        heads[branch] = sha("late-push");
      });

      await expect(forge.putIn(checked, sha("checked"))).rejects.toMatchObject({
        failure: "refused",
      });
      expect(github.merges()).toEqual([]);
      // Still open, now at the late push: nothing went in.
      expect(await forge.changeFor(branch)).toMatchObject({ headSha: sha("late-push") });
    });

    it("a change GitHub has no record of", async () => {
      const { github, forge } = await forgeOver({ "fm/task-meter": sha("first") });
      await expect(
        forge.putIn(
          { number: 99, url: null, branch: "fm/task-meter", headSha: sha("first"), title: TITLE },
          sha("first"),
        ),
      ).rejects.toMatchObject({ failure: "not-found" });
      expect(github.merges()).toEqual([]);
    });

    it("hands back an unconventional title as it was, so the app's own guard sees it and never asks to merge", async () => {
      const { github, forge } = await forgeOver({ "fm/task-meter": sha("first") });
      github.servePull({ number: 55, title: "Crewmate's work" });
      const change = await forge.changeFor("fm/task-meter");
      expect(change?.title).toBe("Crewmate's work");

      await expect(forge.putIn(change as NonNullable<typeof change>, sha("first"))).rejects.toThrow(
        /conventional name/,
      );
      expect(mergeRequests(github)).toEqual([]);
    });

    it("reads failing checks as red", async () => {
      const { github, forge } = await forgeOver({ "fm/task-meter": sha("first") });
      github.servePull({ number: 55, title: TITLE });
      github.setChecks([{ name: "linux-checks", status: "completed", conclusion: "failure" }]);
      const change = await forge.changeFor("fm/task-meter");
      expect((await forge.checks(change as NonNullable<typeof change>)).items).toContainEqual(
        expect.objectContaining({ state: "failure" }),
      );
    });
  });
});

// INF-717: PR #138's story gained its breaking marker, but republishing it left the old title,
// which the squash merge uses; a person's own rename is said, never overwritten.
describe("a saved story's title through the real GitHub forge and the stand-in", () => {
  const TASK = "ab12cd34";
  const STORY_BRANCH = `fm/task-${TASK}`;
  const HEAD = sha("story head");
  const FIRST = "feat(cards): show live validation proof";
  const BREAKING = "feat(cards)!: show live validation proof";
  const risk = Object.fromEntries(
    RISK_DIMENSIONS.map((dimension) => [
      dimension,
      { level: "low", why: `The ${dimension} assessment for this fixture.` },
    ]),
  ) as RiskDeclaration;
  const closes: (() => void)[] = [];
  afterEach(() => {
    for (const close of closes.splice(0)) close();
  });

  async function arrange() {
    const { github, forge } = await forgeOver({ [STORY_BRANCH]: HEAD });
    const root = scratchDir("infinitary-github-story-title-");
    const media = join(root, "cards");
    const worktree = join(root, "work");
    mkdirSync(media);
    mkdirSync(worktree);
    const db = openDatabase(join(root, "data"));
    closes.push(() => db.close());
    const tasks = new TaskService({ db, strict: true });
    seedTask(tasks, {
      id: TASK,
      title: "Show live validation proof",
      prompt: "Share the evidence",
      branch: STORY_BRANCH,
      worktreeDir: worktree,
      repoDir: worktree,
      status: "idle",
    });
    const service = new ChangePresentations({
      tasks,
      mediaDir: () => media,
      head: async () => HEAD,
    });
    const draft = {
      title: FIRST,
      base: HEAD,
      head: HEAD,
      publishable: true as const,
      why: ["Careful changes should show their live proof before they merge."],
      whatChanged: ["The task record shows each live validation run."],
      before: ["The record showed no live proof."],
      after: ["The record shows each run and its result."],
      views: [],
      noPicture: "This fixture publishes the story's words, not a screen.",
      checked: [{ check: "Publication", result: "The story and the pull request agree." }],
      verification: ["Read the pull request back from the stand-in."],
      risk,
      requiredActions: [],
      unfinished: [],
      projectText: "",
    };
    /** Prepare a story as a crewmate does, then open or replace its pull request under that title. */
    const publish = async (story: typeof draft) => {
      const staged = await stageChangePresentation(story, { taskId: TASK, worktree, dir: media });
      const revision = await service.prepare(TASK, staged, forge);
      return service.publish(TASK, revision, forge, STORY_BRANCH, story.title);
    };
    const writes = () => github.requests().filter((line) => /^(POST|PATCH|PUT) \/repos/.test(line));
    return { github, forge, draft, publish, writes };
  }

  it("renames the pull request to a republished story's new title, in the same write as the story", async () => {
    const at = await arrange();
    const opened = await at.publish(at.draft);
    expect(opened.title).toBe(FIRST);
    const republished = await at.publish({
      ...at.draft,
      title: BREAKING,
      after: ["The record shows each run, and the protocol moves to its next major version."],
    });
    const read = await at.forge.changeFor(STORY_BRANCH);
    expect(read).toMatchObject({ number: opened.number, title: BREAKING });
    expect(republished.title).toBe(BREAKING);
    expect(readPresentationRegion(read?.body ?? "", TASK)).toContain("next major version");
    // The title went with the story: one replacement, never a second write for the title.
    expect(at.writes()).toEqual([
      "POST /repos/octo/meterlab/pulls",
      `PATCH /repos/octo/meterlab/pulls/${opened.number}`,
    ]);
  });

  it("sends nothing when a person renamed the pull request, and says both titles", async () => {
    const at = await arrange();
    const opened = await at.publish(at.draft);
    const person = "feat(cards): show live validation proof on the task record";
    // Someone renames it on GitHub's own page.
    await at.forge.api.call(
      "PATCH",
      `/repos/octo/meterlab/pulls/${opened.number}`,
      JSON.stringify({ title: person }),
    );
    const sent = at.writes();
    await expect(at.publish({ ...at.draft, title: BREAKING })).rejects.toThrow(
      `Nothing was sent: the pull request's title on GitHub reads "${person}", not the story's "${BREAKING}". The app last left "${FIRST}" there, so someone renamed it.`,
    );
    expect(await at.forge.changeFor(STORY_BRANCH)).toMatchObject({
      title: person,
      body: opened.body,
    });
    expect(at.writes()).toEqual(sent);
    // Keeping the person's title is a story with that title: aligned, so no rename is sent.
    const kept = await at.publish({ ...at.draft, title: person });
    expect(kept.title).toBe(person);
  });
});
