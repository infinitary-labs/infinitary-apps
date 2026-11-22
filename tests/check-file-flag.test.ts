import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkFilesIn, flag, flagComment, LABEL } from "../scripts/check-file-flag.mjs";
import { loadYamlFile } from "./helpers/releaseWorkflows";

// Part A of INF-3559's approved plan (the captain's pick "Check setup,
// scripts, package and lock files, and packaging settings"): an outside pull
// request that edits check files is labeled, with the files named, before
// anyone approves a run of its checks (docs/public-ci.md, "Outside
// contributors").

const project = { owner: "infinitary-labs", repo: "infinitary-apps" };
const bot = { login: "github-actions[bot]", type: "Bot" };

/** A changed-file list in the shape GitHub's list of a pull request's files returns. */
const listed = (lines: string) =>
  lines
    .trim()
    .split("\n")
    .map((line) => {
      const [status, filename = ""] = line.split("\t");
      return { status: status === "A" ? "added" : "modified", filename };
    });
// The changed files of this project's change that split the branch check
// into three jobs ("perf(ci): split the branch check into three side-by-side
// jobs"), and of one that edits no check file ("fix(composer): write a plain
// letter key in lower case in the message hint").
const editsChecks = listed(`
M\t.github/workflows/ci.yml
M\tAGENTS.md
M\tdocs/public-ci.md
M\tdocs/testing.md
A\trelease-notes/changes/branch-check-split.json
M\tscripts/check-changed.ts
M\tscripts/checks-mode.ts
M\tscripts/pr-paths.ts
M\ttests/batch-pull.test.ts
M\ttests/batch.test.ts
M\ttests/checks-mode.test.ts
M\ttests/release-workflows-pr-checks.test.ts
M\ttests/release-workflows-runners.test.ts
M\ttests/unit-repeats-workflow.test.ts
M\ttests/workflow-hygiene.test.ts`);
const editsNone = listed(`
A\trelease-notes/changes/message-hint-plain-letter.json
A\trelease-notes/pictures/message-hint-plain-letter-dark.webp
A\trelease-notes/pictures/message-hint-plain-letter-light.webp
M\tsrc/renderer/src/app/HomePrompt.tsx
M\tsrc/renderer/src/app/dictation.test.ts`);

describe("the check files", () => {
  it("names a change's check files and nothing else", () => {
    expect(checkFilesIn(editsChecks)).toEqual([
      ".github/workflows/ci.yml",
      "scripts/check-changed.ts",
      "scripts/checks-mode.ts",
      "scripts/pr-paths.ts",
    ]);
    expect(checkFilesIn(editsNone)).toEqual([]);
  });

  it("covers package and lock files at any depth, patches, packaging and the packaging settings", () => {
    const files = [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "docs-site/package.json",
      "docs-site/pnpm-lock.yaml",
      "patches/electron.patch",
      "packaging/release-identity.json",
      "electron-builder.yml",
      "electron-builder.win.yml",
      "docs/linux-packages.md",
      "src/scripts/readme.md",
    ].map((filename) => ({ filename }));
    expect(checkFilesIn(files)).toEqual([
      "docs-site/package.json",
      "docs-site/pnpm-lock.yaml",
      "electron-builder.win.yml",
      "electron-builder.yml",
      "package.json",
      "packaging/release-identity.json",
      "patches/electron.patch",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ]);
  });

  it("counts a file moved out of a check folder by its old name", () => {
    expect(
      checkFilesIn([{ filename: "tools/pr-paths.ts", previous_filename: "scripts/pr-paths.ts" }]),
    ).toEqual(["scripts/pr-paths.ts"]);
  });
});

type Pull = ReturnType<typeof pullRequest>;
function pullRequest({ own = false, labels = [] as string[] } = {}) {
  return {
    number: 40,
    user: { login: "octo-contributor", id: 98765432, type: "User" },
    labels: labels.map((name) => ({ name })),
    head: {
      ref: own ? "infinitary-batch/3f81080a" : "fix-typo",
      repo: {
        full_name: own ? "infinitary-labs/infinitary-apps" : "octo-contributor/infinitary-apps",
      },
    },
  };
}

/** GitHub's API for one pull request, in memory: its files, labels and comments. */
function gitHub(pull: Pull, files: { filename: string }[]) {
  const labels = new Set(pull.labels.map((label) => label.name));
  const comments: { id: number; user: typeof bot; body: string }[] = [];
  let writes = 0;
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { ...pull, labels: [...labels].map((name) => ({ name })) } }),
        listFiles: async () => ({ data: files }),
      },
      issues: {
        listComments: async () => ({ data: comments }),
        createComment: async ({ body }: { body: string }) => {
          writes++;
          comments.push({ id: comments.length + 1, user: bot, body });
          return { data: {} };
        },
        updateComment: async ({ comment_id, body }: { comment_id: number; body: string }) => {
          writes++;
          const comment = comments.find((each) => each.id === comment_id);
          if (comment) comment.body = body;
          return { data: {} };
        },
        addLabels: async ({ labels: added }: { labels: string[] }) => {
          writes++;
          for (const name of added) labels.add(name);
          return { data: {} };
        },
        removeLabel: async ({ name }: { name: string }) => {
          writes++;
          labels.delete(name);
          return { data: {} };
        },
      },
    },
    paginate: async <T>(list: (params: T) => Promise<{ data: unknown[] }>, params: T) =>
      (await list(params)).data,
  };
  return { github, labels, comments, writes: () => writes };
}

const core = {
  failed: [] as string[],
  setFailed(why: string) {
    this.failed.push(why);
  },
  summary: { addRaw: () => core.summary, write: async () => undefined },
};
const event = (pull: Pull) => ({
  repo: project,
  eventName: "pull_request_target",
  payload: { action: "synchronize", pull_request: pull },
});
const byHand = { repo: project, eventName: "workflow_dispatch", payload: {} };

describe("the check-file flag", () => {
  it("labels an outside pull request that edits check files and names them once", async () => {
    const pull = pullRequest();
    const api = gitHub(pull, editsChecks);
    expect(await flag({ github: api.github, context: event(pull), core })).toBe("flagged 4");
    expect([...api.labels]).toEqual([LABEL]);
    expect(api.comments.map((each) => each.body)).toEqual([flagComment(checkFilesIn(editsChecks))]);
    // A later version with the same check files writes nothing again.
    const again = { ...pull, labels: [{ name: LABEL }] };
    const writes = api.writes();
    await flag({ github: api.github, context: event(again), core });
    expect(api.writes()).toBe(writes);
    expect(api.comments).toHaveLength(1);
  });

  it("changes nothing on an outside pull request that edits no check file", async () => {
    const pull = pullRequest();
    const api = gitHub(pull, editsNone);
    expect(await flag({ github: api.github, context: event(pull), core })).toBe("no check files");
    expect(api.writes()).toBe(0);
  });

  it("removes the label once a later version no longer edits check files", async () => {
    const pull = pullRequest();
    const api = gitHub(pull, editsChecks);
    await flag({ github: api.github, context: event(pull), core });
    const later = gitHub({ ...pull, labels: [{ name: LABEL }] }, editsNone);
    later.comments.push(...api.comments);
    expect(
      await flag({
        github: later.github,
        context: event({ ...pull, labels: [{ name: LABEL }] }),
        core,
      }),
    ).toBe("unflagged");
    expect([...later.labels]).toEqual([]);
    expect(later.comments.map((each) => each.body)).toEqual([flagComment([])]);
  });

  it("leaves the project's own pull requests alone on their events", async () => {
    const pull = pullRequest({ own: true });
    const api = gitHub(pull, editsChecks);
    expect(await flag({ github: api.github, context: event(pull), core })).toBe("own branch");
    expect(api.writes()).toBe(0);
  });

  it("reads any pull request it is started on by hand, the project's own included", async () => {
    const own = pullRequest({ own: true });
    const flagged = gitHub(own, editsChecks);
    expect(await flag({ github: flagged.github, context: byHand, core, pullNumber: "40" })).toBe(
      "flagged 4",
    );
    expect([...flagged.labels]).toEqual([LABEL]);
    const plain = gitHub(own, editsNone);
    expect(await flag({ github: plain.github, context: byHand, core, pullNumber: "40" })).toBe(
      "no check files",
    );
    expect(plain.writes()).toBe(0);
  });

  it("fails a hand-started run with no pull request number", async () => {
    const api = gitHub(pullRequest(), editsChecks);
    core.failed.length = 0;
    expect(await flag({ github: api.github, context: byHand, core, pullNumber: "" })).toBe(
      "no pull request",
    );
    expect(core.failed).toHaveLength(1);
    expect(api.writes()).toBe(0);
  });
});

// The workflow holds a write token on an outside pull request, so it never
// runs the pull request's own code (docs/public-ci.md, "Outside contributors").
describe("check-file-flag.yml", () => {
  type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
  const workflow = loadYamlFile(".github/workflows/check-file-flag.yml") as {
    on: Record<string, unknown>;
    jobs: Record<
      string,
      { "runs-on"?: string; permissions?: Record<string, string>; steps: Step[] }
    >;
  };
  const text = readFileSync(
    new URL("../.github/workflows/check-file-flag.yml", import.meta.url),
    "utf8",
  );
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

  it("runs from the project's default branch on GitHub's machines, never from the pull request's files", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual([
      "pull_request_target",
      "workflow_dispatch",
    ]);
    expect(Object.values(workflow.jobs).map((job) => job["runs-on"])).toEqual(["ubuntu-24.04"]);
    const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    for (const step of checkouts) {
      // No ref or repository: the event's own commit, which for a pull
      // request event is this project's base branch.
      expect(Object.keys(step.with ?? {}).toSorted()).toEqual([
        "persist-credentials",
        "sparse-checkout",
        "sparse-checkout-cone-mode",
      ]);
      expect(step.with?.["persist-credentials"]).toBe(false);
      expect(String(step.with?.["sparse-checkout"]).trim()).toBe("scripts/check-file-flag.mjs");
    }
    expect(steps.filter((step) => step.run)).toEqual([]);
  });

  it("holds only the writes it needs, and no secret", () => {
    expect(Object.values(workflow.jobs).map((job) => job.permissions)).toEqual([
      { contents: "read", issues: "write", "pull-requests": "read" },
    ]);
    expect(text).not.toMatch(/secrets\./);
    for (const step of steps)
      expect(String(step.with?.script ?? ""), step.uses).not.toContain("${{");
  });
});
