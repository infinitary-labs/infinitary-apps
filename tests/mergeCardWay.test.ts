import { createHash } from "node:crypto";
import type { MergeWays } from "@shared/batches";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubForge } from "../src/core/forge/providers/github/githubForge";
import { GitLabForge } from "../src/core/forge/providers/gitlab/gitlabForge";
import { type GitHubStub, startGitHubStub } from "./e2e/githubStub";
import {
  GITLAB_STUB_KEY,
  GITLAB_STUB_PROJECT,
  type GitLabStub,
  startGitLabStub,
} from "./e2e/gitlabStub";
import { BUNDLED_NAMING } from "./helpers/namingRunbook";
import { type FakeForge, insertDirectPrTask, setup } from "./helpers/prCiHarness";

// Integration cohort (docs/test-cohorts.md): a real `git init` for the task's
// project at the run's own priority, and the GitHub and GitLab stand-ins on local ports.
vi.mock("../src/core/utilityQos", async (importOriginal) =>
  (await import("./helpers/unclampedQos")).unclampedQos(importOriginal),
);

/**
 * A merge card's click sends only a merge the project allows (the bug: both
 * clicks sent a squash to a project that allows merge commits only, and
 * GitLab refused it). The plain change's click and a reviewed pull
 * request's click read the project's allowed merges where it lives, and hold
 * with nothing sent when none of them fits.
 */
const sha = (name: string) => createHash("sha1").update(name).digest("hex");
const BRANCH = "fm/task-ab12cd34";
const OTHER = "feature/meter-on-time";
const HEAD = sha("task head");
const OTHER_HEAD = sha("other head");
const TITLE = "fix: the meter reads on time";
const MERGE_ONLY: MergeWays = { squash: false, merge: true, rebase: false };

/** Every merge request body the forge put on the wire, as it sent it. */
function recorder() {
  const sent: unknown[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (init?.method === "PUT" && /\/merge(-async)?$/.test(url.pathname))
      sent.push(init.body ? JSON.parse(String(init.body)) : undefined);
    return fetch(input, init);
  }) as typeof fetch;
  return { sent, fetcher };
}

describe("a merge card's click on GitHub", () => {
  let github: GitHubStub | undefined;
  afterEach(async () => {
    await github?.close();
    github = undefined;
  });

  async function onGitHub(buttons: MergeWays) {
    github = await startGitHubStub();
    const stub = github;
    stub.headOf((branch) => {
      if (branch === BRANCH) return HEAD;
      if (branch === OTHER) return OTHER_HEAD;
      throw new Error(`no branch ${branch}`);
    });
    stub.setMergeButtons(buttons);
    const wire = recorder();
    const forge = new GitHubForge(
      { kind: "github", host: "github.com", owner: "octo", name: "meterlab", dir: "/r" },
      {
        token: async () => "gho_e2e_sign_in",
        apiBaseUrl: stub.url,
        namingRule: () => BUNDLED_NAMING,
        fetch: wire.fetcher,
      },
    );
    const harness = setup({ forgeFor: () => forge as unknown as FakeForge });
    await insertDirectPrTask(harness.tasks, harness.repos, { branch: BRANCH });
    const task = harness.tasks.get("ab12cd34");
    if (!task?.repoId) throw new Error("the task was not seeded");
    harness.repos.configure(task.repoId, { origin: "https://github.com/octo/meterlab.git" });
    return { ...harness, stub, forge, task, wire };
  }

  const methods = (sent: unknown[]) =>
    sent.map((body) => (body as { merge_method?: string }).merge_method);

  it("plain change: a project allowing merge commits only gets a merge commit", async () => {
    const { stub, forge, service, task, wire } = await onGitHub(MERGE_ONLY);
    const opened = await forge.openChange({ branch: BRANCH, title: TITLE, body: "Why" });
    const outcome = await service.merges.merge(task.id);
    expect(methods(wire.sent)).toEqual(["merge"]);
    expect(outcome.ok).toBe(true);
    expect(stub.merges().map((merge) => merge.number)).toEqual([opened.number]);
  });

  it("reviewed pull request: a project allowing merge commits only gets a merge commit", async () => {
    const { stub, service, task, tasks, wire } = await onGitHub(MERGE_ONLY);
    stub.serveNumbered({
      number: 151,
      branch: OTHER,
      title: TITLE,
      body: "Why",
      headSha: OTHER_HEAD,
    });
    const answer = await service.checkTool.checkForCrew(task.id, { pull: 151 });
    const review = tasks.get(task.id)?.delivery?.mergeReviews?.find((item) => !item.skips);
    if (!review) throw new Error(`no review stored: ${answer}`);
    const outcome = await service.reviews.mergeReview(task.id, review.id);
    expect(methods(wire.sent)).toEqual(["merge"]);
    expect(outcome.ok).toBe(true);
    expect(stub.merges().map((merge) => merge.number)).toEqual([151]);
  });

  it("plain change: a project allowing no merge holds with its words and sends nothing", async () => {
    const { stub, forge, service, task, wire } = await onGitHub({
      squash: false,
      merge: false,
      rebase: false,
    });
    await forge.openChange({ branch: BRANCH, title: TITLE, body: "Why" });
    const outcome = await service.merges.merge(task.id);
    expect(wire.sent).toEqual([]);
    expect(stub.merges()).toEqual([]);
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(
      /settings on GitHub allow none of a squash, a rebase merge or a merge commit/,
    );
  });
});

describe("a merge card's click on GitLab", () => {
  let gitlab: GitLabStub | undefined;
  afterEach(async () => {
    await gitlab?.close();
    gitlab = undefined;
  });

  async function onGitLab() {
    gitlab = await startGitLabStub("gitlab.com");
    const stub = gitlab;
    stub.headOf((name) => {
      if (name !== BRANCH) throw new Error(`no branch ${name}`);
      return HEAD;
    });
    stub.setPipelines([{ status: "success", jobs: [{ name: "test", status: "success" }] }]);
    // GitLab's squash setting "Do not allow".
    stub.setSquashOption("never");
    const wire = recorder();
    const split = GITLAB_STUB_PROJECT.lastIndexOf("/");
    const forge = new GitLabForge(
      {
        kind: "gitlab",
        host: "gitlab.com",
        owner: GITLAB_STUB_PROJECT.slice(0, split),
        name: GITLAB_STUB_PROJECT.slice(split + 1),
        dir: "/r",
      },
      {
        token: async () => GITLAB_STUB_KEY,
        apiBaseUrl: stub.url,
        namingRule: () => BUNDLED_NAMING,
        fetch: wire.fetcher,
      },
    );
    const harness = setup({ forgeFor: () => forge as unknown as FakeForge });
    await insertDirectPrTask(harness.tasks, harness.repos, { branch: BRANCH });
    const task = harness.tasks.get("ab12cd34");
    if (!task?.repoId) throw new Error("the task was not seeded");
    harness.repos.configure(task.repoId, {
      origin: `https://gitlab.com/${GITLAB_STUB_PROJECT}.git`,
    });
    return { ...harness, stub, forge, task, wire };
  }

  const squashes = (sent: unknown[]) => sent.map((body) => (body as { squash?: boolean }).squash);

  it("plain change: a project that does not allow squash merges without one", async () => {
    const { forge, service, task, wire } = await onGitLab();
    await forge.openChange({ branch: BRANCH, title: TITLE, body: "Why" });
    const outcome = await service.merges.merge(task.id);
    expect(squashes(wire.sent)).toEqual([false]);
    expect(outcome.ok).toBe(true);
  });

  it("reviewed merge request: a project that does not allow squash merges without one", async () => {
    const { forge, service, task, tasks, wire } = await onGitLab();
    const opened = await forge.openChange({ branch: BRANCH, title: TITLE, body: "Why" });
    const answer = await service.checkTool.checkForCrew(task.id, { pull: opened.number });
    const review = tasks.get(task.id)?.delivery?.mergeReviews?.find((item) => !item.skips);
    if (!review) throw new Error(`no review stored: ${answer}`);
    const outcome = await service.reviews.mergeReview(task.id, review.id);
    expect(squashes(wire.sent)).toEqual([false]);
    expect(outcome.ok).toBe(true);
  });
});
