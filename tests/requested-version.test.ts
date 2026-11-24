import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { hostEnv } from "../src/core/hostEnv";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * A check requested by hand runs only a version a branch of this project
 * holds (docs/public-ci.md, "A check requested by hand"). Every workflow a
 * request can name a version to opens with the same step, run here as a
 * runner runs it against a real git repository standing in for GitHub's
 * address. Like GitHub, the stand-in hands a commit only a pull request holds
 * to anyone who names it, so a refusal here is the step's, not the stand-in's.
 */

type Step = {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: string;
};
type Job = { needs?: string | string[]; if?: string; steps?: Step[] };
type Inputs = Record<string, { type?: string }>;
type Workflow = {
  name: string;
  on: {
    workflow_dispatch?: { inputs?: Inputs } | null;
    workflow_call?: { inputs?: Inputs } | null;
  };
  jobs: Record<string, Job>;
};

const GUARD = "Check a branch of this project holds the requested version";
const WORKFLOWS = ".github/workflows";
// Each workflow whose request names the version it checks out, and the job
// that refuses one no branch holds.
const REQUESTS = [
  { file: "verify.yml", job: "request" },
  { file: "source-journeys.yml", job: "source-desktop" },
  { file: "windows.yml", job: "build" },
  { file: "linux-packages.yml", job: "build" },
];

const workflow = (file: string) => loadYamlFile(`${WORKFLOWS}/${file}`) as unknown as Workflow;
const guardOf = (file: string, job: string) => {
  const step = workflow(file).jobs[job]?.steps?.find((candidate) => candidate.name === GUARD);
  if (!step) throw new Error(`${file}'s ${job} job has no step "${GUARD}"`);
  return step;
};
const needsOf = (job: Job) => (job.needs === undefined ? [] : [job.needs].flat());

describe("a check requested by hand", () => {
  it("refuses a version in every workflow a request names one to, before anything checks it out", () => {
    const named = readdirSync(WORKFLOWS)
      .filter((file) => file.endsWith(".yml"))
      .filter((file) => workflow(file).on.workflow_dispatch?.inputs?.ref !== undefined)
      .toSorted();
    expect(named).toEqual(REQUESTS.map(({ file }) => file).toSorted());

    for (const { file, job } of REQUESTS) {
      const { name, jobs } = workflow(file);
      const steps = jobs[job]?.steps ?? [];
      const guard = steps.findIndex((step) => step.name === GUARD);
      const checkout = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
      expect(guard, file).toBeGreaterThanOrEqual(0);
      if (checkout >= 0) expect(guard, file).toBeLessThan(checkout);

      // Every other job waits for the refusing one, directly or through another.
      const reaches = (id: string, seen = new Set<string>()): boolean =>
        id === job ||
        needsOf(jobs[id] ?? {}).some((need) => !seen.has(need) && reaches(need, seen.add(need)));
      for (const id of Object.keys(jobs)) expect(reaches(id), `${file}: ${id}`).toBe(true);

      // It reads the workflow's own request; a caller chose the version it passes.
      const runs = (github: Record<string, string>) =>
        workflowValue(guardOf(file, job).if ?? "", { github });
      expect(runs({ event_name: "workflow_dispatch", workflow: name }), file).toBe(true);
      for (const caller of ["verify", "release", "main"].filter((other) => other !== name)) {
        expect(runs({ event_name: "workflow_dispatch", workflow: caller }), file).toBe(false);
      }
      expect(runs({ event_name: "push", workflow: name }), file).toBe(false);
      expect(runs({ event_name: "pull_request", workflow: name }), file).toBe(false);
    }
  });

  it("lets nothing check out or run a version it refused", () => {
    // A failed step leaves later steps and jobs to their conditions: one that
    // names no status function needs success(), and the rest are read here
    // with every request's choice switched on.
    const afterRefusal = { success: false, failure: true, always: true, cancelled: false };
    const condition = (value = "") => {
      const expression = value.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1") || "true";
      return /\b(success|failure|always|cancelled)\(\)/.test(expression)
        ? expression
        : `success() && (${expression})`;
    };
    for (const { file, job } of REQUESTS) {
      const { on, jobs } = workflow(file);
      const inputs = Object.fromEntries(
        Object.entries({ ...on.workflow_call?.inputs, ...on.workflow_dispatch?.inputs }).map(
          ([input, { type }]) => [input, type === "boolean" ? true : "chosen"],
        ),
      );
      const contexts = (steps: Record<string, unknown>, needs: Record<string, unknown>) => ({
        github: { event_name: "workflow_dispatch" },
        inputs,
        matrix: {},
        steps,
        needs,
        env: {},
        vars: {},
        runner: {},
      });

      const steps = jobs[job]?.steps ?? [];
      const guard = steps.findIndex((step) => step.name === GUARD);
      const outcomes = Object.fromEntries(
        steps.flatMap((step, index) =>
          step.id
            ? [[step.id, { outcome: index < guard ? "success" : "skipped", outputs: {} }]]
            : [],
        ),
      );
      for (const step of steps.slice(guard + 1)) {
        if (!step.uses?.startsWith("actions/checkout@")) continue;
        if (!String(step.with?.ref ?? "").includes("inputs.ref")) continue;
        const runs = workflowValue(condition(step.if), contexts(outcomes, {}), afterRefusal);
        expect(runs, `${file}: ${step.name}`).toBeFalsy();
      }

      for (const [id, other] of Object.entries(jobs)) {
        if (id === job) continue;
        const needs = Object.fromEntries(
          needsOf(other).map((need) => [
            need,
            { result: need === job ? "failure" : "skipped", outputs: {} },
          ]),
        );
        const runs = workflowValue(condition(other.if), contexts({}, needs), afterRefusal);
        expect(runs, `${file}: ${id}`).toBeFalsy();
      }
    }
  });

  it("is the same step in each of them", () => {
    const [first, ...rest] = REQUESTS.map(({ file, job }) => guardOf(file, job));
    for (const step of rest) {
      expect(step.env).toEqual(first?.env);
      expect(step.run).toEqual(first?.run);
    }
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the workflow's own expression, matched literally.
    expect(first?.env?.VERSION).toBe("${{ inputs.ref }}");
  });

  describe("against a stand-in for GitHub's address", () => {
    const step = guardOf("verify.yml", "request");
    const env = { ...hostEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=Stand-in", "-c", "user.email=stand-in@example.com", ...args],
        {
          cwd,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ).trim();
    let server = "";
    const versions: Record<string, string> = {};

    beforeAll(() => {
      server = scratchDir("infinitary-requested-version-");
      const origin = join(server, "origin.git");
      const work = join(server, "work");
      git(server, "init", "--quiet", "--bare", origin);
      // GitHub serves partial fetches and any commit its refs reach, pull requests' included.
      git(origin, "config", "uploadpack.allowFilter", "true");
      git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
      git(server, "init", "--quiet", "--initial-branch=main", work);
      // Each version carries a file of its own, which the step must never fetch.
      const commit = (message: string) => {
        writeFileSync(join(work, "version.txt"), `${message}\n`);
        git(work, "add", "version.txt");
        git(work, "commit", "--quiet", "-m", message);
        return git(work, "rev-parse", "HEAD");
      };
      versions.older = commit("older");
      versions.main = commit("main");
      git(work, "tag", "light");
      git(work, "tag", "-a", "-m", "annotated", "annotated");
      git(work, "checkout", "--quiet", "-b", "side");
      versions.side = commit("side");
      git(work, "checkout", "--quiet", "--detach", versions.main);
      versions.pull = commit("only a pull request holds this");
      git(work, "checkout", "--quiet", "--detach", versions.main);
      versions.tagged = commit("only a tag holds this");
      git(work, "tag", "stray");
      git(
        work,
        "push",
        "--quiet",
        origin,
        `${versions.main}:refs/heads/main`,
        `${versions.side}:refs/heads/side`,
        `${versions.pull}:refs/pull/7/head`,
        "refs/tags/light",
        "refs/tags/annotated",
        "refs/tags/stray",
      );
    });

    function request(ref: string) {
      const temp = scratchDir("infinitary-requested-version-run-");
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.run ?? ""],
        {
          cwd: temp,
          env: {
            ...env,
            RUNNER_TEMP: temp,
            ...Object.fromEntries(
              Object.entries(step.env ?? {}).map(([key, value]) => [
                key,
                workflowString(value, {
                  inputs: { ref },
                  github: {
                    server_url: `file://${server}`,
                    repository: "origin.git",
                    token: "stand-in",
                  },
                }),
              ]),
            ),
          },
          encoding: "utf8",
        },
      );
      // The copy the step read, if it made one.
      const copy = readdirSync(temp, { withFileTypes: true }).find((entry) => entry.isDirectory());
      return { ...result, copy: copy ? join(temp, copy.name) : undefined };
    }

    it("passes a version a branch holds, by id or by name, and a request that names none", () => {
      const held = [
        ["", ""],
        [versions.main, "main"],
        [versions.older, "main"],
        [versions.side, "side"],
        [versions.side?.toUpperCase(), "side"],
        ["main", "main"],
        ["refs/heads/side", "side"],
        ["light", "main"],
        ["annotated", "main"],
        ["refs/tags/annotated", "main"],
      ] as const;
      for (const [ref, branch] of held) {
        const result = request(ref ?? "");
        expect(result.status, `${ref}: ${result.stdout}${result.stderr}`).toBe(0);
        if (ref) expect(result.stdout).toContain(`Branch ${branch} holds ${ref}.`);
      }
    });

    it("refuses a version only a pull request or a tag holds, or a name no branch has", () => {
      const refused = [
        versions.pull,
        "refs/pull/7/head",
        "pull/7/head",
        "REFS/PULL/7/HEAD",
        versions.tagged,
        "stray",
        "refs/tags/stray",
        versions.main?.slice(0, 12),
        "no-such-branch",
        "--upload-pack=touch uploaded",
      ];
      for (const ref of refused) {
        const result = request(ref ?? "");
        expect(result.status, `${ref}: ${result.stdout}${result.stderr}`).toBe(1);
        expect(result.stdout).toContain(`No branch of origin.git holds ${ref}`);
      }

      // GitHub would have handed it out: a fetch that names it gets it.
      const fetcher = scratchDir("infinitary-requested-version-fetch-");
      git(fetcher, "init", "--quiet");
      git(fetcher, "fetch", "--quiet", join(server, "origin.git"), versions.pull ?? "");
      expect(git(fetcher, "cat-file", "-t", versions.pull ?? "")).toBe("commit");
    });

    it("reads the branches' and tags' commits alone, never a file or the named commit", () => {
      const result = request(versions.pull ?? "");
      expect(result.status).toBe(1);
      expect(result.copy).toBeDefined();
      const kinds = new Set(
        git(result.copy ?? "", "cat-file", "--batch-all-objects", "--batch-check=%(objecttype)")
          .split("\n")
          .filter(Boolean),
      );
      expect([...kinds].toSorted()).toEqual(["commit", "tag"]);
      const named = spawnSync("git", ["cat-file", "-e", versions.pull ?? ""], {
        cwd: result.copy,
        env: { ...env, GIT_NO_LAZY_FETCH: "1" },
      });
      expect(named.status).not.toBe(0);
    });
  });
});
