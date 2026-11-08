import { afterEach, describe, expect, it, vi } from "vitest";
import { GitLabForge } from "../src/core/forge/providers/gitlab/gitlabForge";
import {
  GITLAB_STUB_KEY,
  GITLAB_STUB_PROJECT,
  type GitLabStub,
  startGitLabStub,
} from "./e2e/gitlabStub";
import { type FakeForge, insertDirectPrTask, setup } from "./helpers/prCiHarness";

// Integration cohort (docs/test-cohorts.md): a real `git init` for the task's
// project at the run's own priority, as in src/core/orchestrator/mergeReviews.test.ts.
vi.mock("../src/core/utilityQos", async (importOriginal) =>
  (await import("./helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The version the merge request's branch is at. */
const HEAD = "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39";

// A user's report on a self-hosted GitLab: a merge request from a branch in
// the same project, a project that intentionally has no hosted CI, and a
// head-bound absence declaration refused as a fork. Expected: "accept a valid
// head-bound absence declaration for a verified same-project merge request,
// while continuing to reject forks and unknown identity" - the forge's own
// test pins which merge requests it names as the project's.
describe("a same-project GitLab merge request, through the real GitLab forge and its stand-in", () => {
  let gitlab: GitLabStub | undefined;
  afterEach(async () => {
    await gitlab?.close();
    gitlab = undefined;
  });

  it("stores a head-bound absence declaration by number and for the task's own, and the merge card's gate passes", async () => {
    const branch = "fm/task-ab12cd34";
    gitlab = await startGitLabStub("gitlab.example.com");
    gitlab.headOf((name) => {
      if (name !== branch) throw new Error(`no branch ${name}`);
      return HEAD;
    });
    gitlab.setPipelines([]);
    const split = GITLAB_STUB_PROJECT.lastIndexOf("/");
    const forge = new GitLabForge(
      {
        kind: "gitlab",
        host: "gitlab.example.com",
        owner: GITLAB_STUB_PROJECT.slice(0, split),
        name: GITLAB_STUB_PROJECT.slice(split + 1),
        dir: "/r",
      },
      { token: async () => GITLAB_STUB_KEY, apiBaseUrl: gitlab.url },
    );
    const { service, tasks, repos } = setup({ forgeFor: () => forge as unknown as FakeForge });
    await insertDirectPrTask(tasks, repos, { branch });
    const task = tasks.get("ab12cd34");
    if (!task?.repoId) throw new Error("the task was not seeded");
    repos.configure(task.repoId, {
      origin: `https://gitlab.example.com/${GITLAB_STUB_PROJECT}.git`,
    });
    const opened = await forge.openChange({ branch, title: "fix: the meter", body: "Why" });
    const absentChecks = {
      headSha: HEAD,
      evidence:
        "The project has no pipeline configuration; GitLab lists no pipeline for this head.",
      localGate: "The project's local checks passed at this version.",
    };

    expect(
      await service.checkTool.checkForCrew(task.id, { pull: opened.number, absentChecks }),
    ).toContain("Absence evidence stored for this version.");
    expect(await service.checkTool.checkForCrew(task.id, { absentChecks })).toContain(
      "Absence evidence stored for this version.",
    );
    const reviews = tasks.get(task.id)?.delivery?.mergeReviews ?? [];
    expect(reviews.map((review) => review.absentChecks?.headSha)).toEqual([HEAD, HEAD]);
    for (const review of reviews)
      expect(await service.reviews.reviewGate(task.id, review.id)).toBeUndefined();
  });
});
