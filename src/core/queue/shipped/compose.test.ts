import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  githubScript,
  loadYamlFile,
  workflowString,
} from "../../../../tests/helpers/releaseWorkflows";
import { scratchDir } from "../../../../tests/helpers/scratchDirs";
import { GITHUB_QUEUE_PART, shippedFiles } from "../shipped";
import { QUEUE, queueKind, readComposition, WAITING } from "./rules.mjs";

// INF-2952 piece 1, the captain's approved merge-route answer: "the queue
// composes it in each check job". The form job composes the batch onto the
// default branch as it stands after the queue read its changes, and every
// check job applies the same batch onto that same version, even after the
// default branch moved on, and must build the tree the form job named. Real
// git on a scratch project: a default branch, approved changes as branches,
// and each job's shallow clone, as actions/checkout leaves it.
const compose = fileURLToPath(new URL("./compose.sh", import.meta.url));
const shipped = fileURLToPath(new URL("./", import.meta.url));
/** A job of the shipped workflow, as far as the form job's test runs it. */
type Job = {
  outputs: Record<string, string>;
  steps: { id?: string; env?: Record<string, string>; run?: string; with?: { script?: string } }[];
};
const git = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const identity = ["-c", "user.name=crewmate", "-c", "user.email=crewmate@localhost"];
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", [...identity, ...args], { cwd, env: git, encoding: "utf8" }).trim();

function project() {
  const root = scratchDir("infinitary-queue-compose-");
  const origin = join(root, "origin");
  run(root, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "notes.md"), "one\ntwo\nthree\n");
  run(origin, "add", ".");
  run(origin, "commit", "-q", "-m", "main");
  const change = (branch: string, file: string, contents: string) => {
    run(origin, "checkout", "-q", "-b", branch, "main");
    writeFileSync(join(origin, file), contents);
    run(origin, "add", ".");
    run(origin, "commit", "-q", "-m", branch);
    run(origin, "checkout", "-q", "main");
    return run(origin, "rev-parse", branch);
  };
  const changes = {
    first: change("first", "notes.md", "ONE\ntwo\nthree\n"),
    second: change("second", "added.md", "new file\n"),
    // Edits the line the first change edits: it merges onto main alone.
    third: change("third", "notes.md", "uno\ntwo\nthree\n"),
  };
  const job = () => {
    const clone = join(scratchDir("infinitary-queue-job-"), "checkout");
    run(root, "clone", "-q", "--depth", "1", "--branch", "main", `file://${origin}`, clone);
    return clone;
  };
  return { origin, changes, job };
}

const script = (cwd: string, ...args: string[]) =>
  spawnSync("bash", ["--noprofile", "--norc", compose, ...args], {
    cwd,
    env: git,
    encoding: "utf8",
  });

describe("composing a batch of the shipped queue", () => {
  it("composes what merges in batch order and names each conflict", () => {
    const { origin, changes, job } = project();
    run(origin, "checkout", "-q", "-b", "stale", "main");
    writeFileSync(join(origin, "notes.md"), "one\ntwo\ntres\n");
    run(origin, "commit", "-q", "-am", "stale");
    run(origin, "checkout", "-q", "main");
    const stale = run(origin, "rev-parse", "stale");
    // The default branch moves on after the changes branched.
    writeFileSync(join(origin, "notes.md"), "one\ntwo\nTHREE\n");
    run(origin, "commit", "-q", "-am", "main moves");
    const members = [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
      { number: 903, head: changes.third },
      { number: 904, head: stale },
    ];
    const result = script(job(), "compose", "main", ...members.map((m) => `${m.number}:${m.head}`));
    expect(result.status, result.stderr).toBe(0);
    const composed = readComposition(result.stdout, members);
    expect(composed.merged.map((m) => m.number)).toEqual([901, 902]);
    expect(composed.conflictsBatch.map((m) => m.number)).toEqual([903]);
    expect(composed.conflictsMain.map((m) => m.number)).toEqual([904]);
  });

  it("applies the batch in every check job onto the version it formed on, after the default branch moves", () => {
    const { origin, changes, job } = project();
    const form = job();
    const heads = [`901:${changes.first}`, `902:${changes.second}`];
    const members = [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
    ];
    const { base, tree } = readComposition(
      script(form, "compose", "main", ...heads).stdout,
      members,
    );
    expect(base).toBe(run(origin, "rev-parse", "main"));
    // A teammate's change merges while the checks wait for a runner.
    writeFileSync(join(origin, "later.md"), "later\n");
    run(origin, "add", ".");
    run(origin, "commit", "-q", "-m", "a later merge");
    const commits = [job(), job()].map((clone) => {
      const applied = script(clone, "apply", base, tree, ...heads);
      expect(applied.status, applied.stderr).toBe(0);
      expect(run(clone, "rev-parse", "HEAD^{tree}")).toBe(tree);
      expect(run(clone, "show", "HEAD:notes.md")).toBe("ONE\ntwo\nthree");
      expect(run(clone, "show", "HEAD:added.md")).toBe("new file");
      expect(spawnSync("git", ["cat-file", "-e", "HEAD:later.md"], { cwd: clone }).status).not.toBe(
        0,
      );
      return run(clone, "rev-parse", "HEAD");
    });
    expect(commits[0]).toBe(commits[1]);
  });

  it("fails a check job whose batch is not the one the queue composed", () => {
    const { changes, job } = project();
    const form = job();
    const heads = [`901:${changes.first}`, `902:${changes.second}`];
    const { base, tree } = readComposition(script(form, "compose", "main", ...heads).stdout, [
      { number: 901, head: changes.first },
      { number: 902, head: changes.second },
    ]);
    const short = script(job(), "apply", base, tree, heads[0] as string);
    expect(short.status).toBe(1);
    expect(short.stdout).toContain("Batch composed differently");
    const conflict = script(job(), "apply", base, tree, ...heads, `903:${changes.third}`);
    expect(conflict.status).toBe(1);
    expect(conflict.stdout).toContain("Batch did not compose");
  });

  // INF-3053: batch run 43 checked out main, then a change green in the
  // previous batch merged, then the queue read the open changes. The merged
  // change was no longer open, so nothing held the batch, and the batch
  // composed onto the checkout's version without it: it passed on files main
  // never reached once its own change merged.
  it("composes onto the default branch as it stands after the queue read, with a change that merged since the checkout", () => {
    const { origin, changes, job } = project();
    const form = job();
    const checkedOut = run(form, "rev-parse", "HEAD");
    // The previous batch's green change merges after the form job checked out.
    run(origin, "merge", "-q", "--no-ff", "-m", "#902", "second");
    const main = run(origin, "rev-parse", "main");
    const members = [{ number: 901, head: changes.first }];
    const result = script(form, "compose", "main", `901:${changes.first}`);
    expect(result.status, result.stderr).toBe(0);
    const { base, tree, merged } = readComposition(result.stdout, members);
    expect(base).not.toBe(checkedOut);
    expect(base).toBe(main);
    expect(merged).toEqual(members);
    // A check job builds the same tree on that base, with the merged change's file.
    const check = job();
    const applied = script(check, "apply", base, tree, `901:${changes.first}`);
    expect(applied.status, applied.stderr).toBe(0);
    expect(run(check, "show", "HEAD:added.md")).toBe("new file");
    // Once the batch's own change merges, main has exactly the batch's tree.
    run(origin, "merge", "-q", "--no-ff", "-m", "#901", "first");
    expect(run(origin, "rev-parse", "main^{tree}")).toBe(tree);
  });

  // The same race through the shipped workflow's own form job, step by
  // step: its checkout, the merge, the form step reading the queue through a
  // stand-in of GitHub's API, the compose step's shell and the mark step,
  // with the project's stamped files in the checkout.
  it("runs the GitHub form job onto the default branch as it stands after its form step reads the queue", async () => {
    const { origin, changes, job } = project();
    const workspace = job();
    for (const file of shippedFiles(shipped, GITHUB_QUEUE_PART)) {
      mkdirSync(dirname(join(workspace, file.path)), { recursive: true });
      writeFileSync(join(workspace, file.path), file.text);
    }
    const checkedOut = run(workspace, "rev-parse", "HEAD");
    // #902, green in the previous batch, merges: GitHub lists it open no more.
    run(origin, "merge", "-q", "--no-ff", "-m", "#902", "second");
    const statuses = new Map<string, Record<string, string>[]>([
      [
        changes.first,
        [
          {
            context: QUEUE,
            state: "pending",
            description: WAITING,
            target_url: "",
            created_at: "2026-11-08T07:30:00Z",
          },
        ],
      ],
    ]);
    const github = {
      paginate: async (
        method: (params: Record<string, unknown>) => Promise<{ data: unknown[] }>,
        params: Record<string, unknown>,
      ) => (await method(params)).data,
      rest: {
        pulls: {
          list: async () => ({
            data: [
              { number: 901, head: { sha: changes.first }, base: { ref: "main" }, labels: [] },
            ],
          }),
        },
        repos: {
          listCommitStatusesForRef: async ({ ref }: { ref: string }) => ({
            data: statuses.get(ref) ?? [],
          }),
          createCommitStatus: async (write: Record<string, string>) => {
            const status = {
              ...write,
              target_url: write.target_url ?? "",
              created_at: "2026-11-08T07:34:30Z",
            };
            statuses.set(write.sha as string, [
              status,
              ...(statuses.get(write.sha as string) ?? []),
            ]);
          },
        },
      },
    };
    const formJob = (
      loadYamlFile("src/core/queue/shipped/workflow.yml") as { jobs: Record<string, Job> }
    ).jobs.form as Job;
    const runner = scratchDir("infinitary-queue-runner-");
    const outputs: Record<string, { outputs: Record<string, string> }> = {};
    const contexts = () => ({
      github: { event: { repository: { default_branch: "main" } } },
      steps: outputs,
    });
    const stepEnv = (id: string) => {
      const step = formJob.steps.find((candidate) => candidate.id === id);
      expect(step, id).toBeDefined();
      const env = Object.entries(step?.env ?? {}).map(([key, value]) => [
        key,
        workflowString(value, contexts()),
      ]);
      return { step, env: Object.fromEntries(env) as Record<string, string> };
    };
    const githubStep = async (id: string) => {
      const { step, env } = stepEnv(id);
      const set: Record<string, string> = {};
      outputs[id] = { outputs: set };
      await githubScript(step?.with?.script ?? "", [
        "github",
        "context",
        "core",
        "require",
        "process",
      ])(
        github,
        {
          repo: { owner: "acme", repo: "shop" },
          runId: 43,
          serverUrl: "https://github.com",
          payload: { repository: { default_branch: "main" } },
        },
        { notice: () => {}, setOutput: (key: string, value: string) => (set[key] = value) },
        createRequire(import.meta.url),
        { env: { GITHUB_WORKSPACE: workspace, RUNNER_TEMP: runner, ...env } },
      );
    };

    await githubStep("form");
    const { step: compose, env } = stepEnv("compose");
    outputs.compose = { outputs: {} };
    const composed = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", compose?.run ?? ""], {
      cwd: workspace,
      env: { ...git, RUNNER_TEMP: runner, ...env },
      encoding: "utf8",
    });
    expect(composed.status, composed.stderr).toBe(0);
    await githubStep("mark");
    const formed = Object.fromEntries(
      Object.entries(formJob.outputs).map(([key, value]) => [
        key,
        workflowString(value, contexts()),
      ]),
    );

    expect(formed.run).toBe("true");
    expect(formed.heads).toBe(`901:${changes.first}`);
    expect(formed.base).not.toBe(checkedOut);
    expect(formed.base).toBe(run(origin, "rev-parse", "main"));
    const [newest] = statuses.get(changes.first) ?? [];
    expect(queueKind(newest?.state ?? "", newest?.description ?? "")).toEqual({
      kind: "in-batch",
      run: 43,
    });
    // The batch checks build that batch, and once #901 merges main has its tree.
    const check = job();
    const applied = script(
      check,
      "apply",
      formed.base ?? "",
      formed.tree ?? "",
      formed.heads ?? "",
    );
    expect(applied.status, applied.stderr).toBe(0);
    expect(run(check, "show", "HEAD:added.md")).toBe("new file");
    run(origin, "merge", "-q", "--no-ff", "-m", "#901", "first");
    expect(run(origin, "rev-parse", "main^{tree}")).toBe(formed.tree);
  });

  it("composes nothing when it cannot read the default branch", () => {
    const { changes, job } = project();
    const result = script(job(), "compose", "no-such-branch", `901:${changes.first}`);
    expect(result.status).not.toBe(0);
    expect(() => readComposition(result.stdout, [{ number: 901, head: changes.first }])).toThrow(
      "no base",
    );
  });
});
