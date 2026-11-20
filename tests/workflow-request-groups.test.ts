import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  githubScript,
  loadYamlFile,
  read,
  workflowString,
  workflowValue,
} from "./helpers/releaseWorkflows";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * INF-3380 (the captain's direction A, "the workflow files cancel the older run
 * themselves"): a newer request of the same check, on the same task branch and with the same selection, cancels the older run
 * through the workflow's own group, or for journeys.yml its own first job (INF-3635).
 * Main, a rerun and every call keep a group of their own run. The requests below are
 * real runs, their inputs read from each run's request job log.
 */
type Concurrency = { group: string; "cancel-in-progress": string | boolean };
const concurrency = (path: string) =>
  (loadYamlFile(path) as { concurrency: Concurrency }).concurrency;

type Run = {
  workflow: string;
  ref: string;
  run_id: string;
  run_attempt?: string;
  inputs: Record<string, unknown>;
};
const reading = (run: Run) => ({
  github: {
    workflow: run.workflow,
    ref: run.ref,
    run_id: run.run_id,
    run_attempt: run.run_attempt ?? "1",
  },
  inputs: run.inputs,
});
const groupOf = (path: string) => (run: Run) =>
  workflowString(concurrency(path).group, reading(run));
const cancelsIn = (path: string) => (run: Run) =>
  workflowValue(String(concurrency(path)["cancel-in-progress"]), reading(run));

/** A phone request's inputs as GitHub fills the dispatch form's defaults. */
const phoneRequest = (inputs: Record<string, unknown>) => ({
  affected: false,
  base: "origin/main",
  parts: "",
  device: "",
  starve: false,
  waits: false,
  perf: false,
  recording: false,
  guest_observer: false,
  evidence_run: "",
  task: "",
  reason: "",
  ...inputs,
});

describe("phone.yml's request group", () => {
  const group = groupOf(".github/workflows/phone.yml");
  const cancels = cancelsIn(".github/workflows/phone.yml");
  // PR #1324: 42692536816 at the older version, then 42698344711 after a push
  // that changed only the test the iPad failed in. Their reasons differ.
  const older: Run = {
    workflow: "phone",
    ref: "refs/heads/fm/task-10a3f943",
    run_id: "42692536816",
    inputs: phoneRequest({
      affected: true,
      task: "INF-3110",
      reason: "Brought up to date with main, whose card thread change overlaps PhoneCards.swift",
    }),
  };
  const newer: Run = {
    ...older,
    run_id: "42698344711",
    inputs: phoneRequest({
      affected: true,
      task: "INF-3110",
      reason: "The cards journey now waits for the card's slider after the swipe back",
    }),
  };

  it("lets the next same-selection request on a task branch cancel the older run", () => {
    expect(group(newer)).toBe(group(older));
    expect(cancels(newer)).toBe(true);
  });

  it("runs a request of another selection beside the older one", () => {
    // INF-3205's three requests on one branch at one version: an iPad-only
    // replacement proof and a one-part diagnostic beside the full request.
    const branch = { workflow: "phone", ref: "refs/heads/fm/task-7071f277" };
    const runs: Run[] = [
      {
        ...branch,
        run_id: "42557363881",
        inputs: phoneRequest({ affected: true, device: "ipad" }),
      },
      {
        ...branch,
        run_id: "42557369568",
        inputs: phoneRequest({ parts: "address", device: "ipad" }),
      },
      { ...branch, run_id: "42557371746", inputs: phoneRequest({ affected: true }) },
    ];
    expect(new Set(runs.map(group)).size).toBe(3);
    // Another task's branch never shares PR #1324's group.
    expect(group({ ...older, ref: branch.ref })).not.toBe(group(older));
  });

  it("gives main, a rerun and each of the phone release's calls a group of their own", () => {
    const main: Run = { ...older, ref: "refs/heads/main", inputs: phoneRequest({}) };
    expect(group(main)).not.toBe(group({ ...main, run_id: "42698344711" }));
    // A rerun keeps its run's inputs and ref, so a shared group would cancel the newer request.
    const rerun = { ...older, run_attempt: "2" };
    expect(group(rerun)).not.toBe(group(newer));
    expect(group(rerun)).not.toBe(group({ ...rerun, run_attempt: "3" }));
    // The phone release is itself a manual run that calls this workflow once per device,
    // so github.workflow names the caller and the two calls share a run and attempt.
    const call = (device: string): Run => ({
      workflow: "ios-release",
      ref: "refs/heads/main",
      run_id: "42700000000",
      inputs: { trigger: "Phone release", source_commit: "c".repeat(40), device },
    });
    expect(group(call("ipad"))).not.toBe(group(call("iphone")));
    expect(cancels(call("ipad"))).toBe(false);
    // A call from a task branch still belongs to its caller's run.
    expect(group({ ...call("ipad"), ref: older.ref })).not.toBe(
      group({ ...call("ipad"), ref: older.ref, run_id: "42700000001" }),
    );
  });
});

/**
 * INF-3635: journeys.yml's request carries no group, since a group named for
 * its file list failed a request of twenty-one journeys at creation; its first
 * job names the request by a hash, marks the run and cancels the older run of
 * that mark. The requests below are real runs, and the readings are GitHub's
 * answers to the proof's own requests (tests/fixtures/journeys-request/).
 */
describe("journeys.yml's request replacement", () => {
  type Step = {
    id?: string;
    name?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  };
  type Job = { if?: string; concurrency?: { group?: string }; steps?: Step[] };
  const journeys = () =>
    loadYamlFile(".github/workflows/journeys.yml") as {
      concurrency?: { group?: string };
      jobs: Record<string, Job>;
    };
  const replace = () => journeys().jobs["replace-older-request"] as Job;
  const step = (find: (step: Step) => boolean) => {
    const found = replace().steps?.find(find);
    if (!found) throw new Error("journeys.yml's replace-older-request lacks a step");
    return found;
  };
  const request = (inputs: Record<string, unknown>) => ({
    mac_runner: "",
    platforms: "linux",
    base: "origin/main",
    mac_all: false,
    starve: false,
    perf: false,
    ...inputs,
  });
  const recorded = JSON.parse(read("tests/fixtures/journeys-request/replaced-run.json")) as {
    ref: string;
    inputs: Record<string, unknown>;
    marks: { id: number; name: string; workflow_run: { id: number; head_branch: string } }[];
    runs: { id: number; status: string; run_attempt: number; head_branch: string }[];
  };
  // INF-3538's request at 29c321a, run 42947213424, and its first half, run 42947452880,
  // whose chooser log records the names it was given.
  const all = recorded.inputs;
  const firstHalf = request({
    files:
      "card-demo card-thread-place tool-repetition validation-checklist first-launch operation-deliverable task-move retrieval-routing card-threads claude-crew-turn",
    platforms: "both",
  });
  const branch = (ref: string, inputs: Record<string, unknown>): Run => ({
    workflow: "journeys",
    ref,
    run_id: "1",
    inputs,
  });

  /** The mark step as the runner runs it: its env evaluated, its script with GitHub's helpers. */
  const mark = async (run: Run) => {
    const marking = step((candidate) => candidate.id === "mark");
    const temp = scratchDir("journeys-request-mark-");
    const outputs: Record<string, string> = {};
    await githubScript(String(marking.with?.script), ["core", "context", "process", "require"])(
      {
        setOutput: (name: string, value: unknown) => (outputs[name] = String(value)),
        info: () => undefined,
      },
      { ref: run.ref },
      {
        env: {
          SELECTION: workflowString(String(marking.env?.SELECTION), reading(run)),
          RUNNER_TEMP: temp,
        },
      },
      createRequire(import.meta.url),
    );
    const saved = JSON.parse(readFileSync(join(temp, "journeys-request.json"), "utf8"));
    return { name: outputs.name ?? "", saved };
  };

  it("starts a request naming twenty-one journeys, which a group named for them failed", async () => {
    // GitHub failed run 42980703839 at creation for a 400-character group and started
    // run 42980783026 for a 399-character one; INF-3538's request named a 461-character one.
    const refused = 400;
    const long = branch(recorded.ref, all);
    const { jobs, concurrency: run } = journeys();
    for (const group of [run, ...Object.values(jobs).map((job) => job.concurrency)])
      if (group?.group)
        expect(workflowString(group.group, reading(long)).length).toBeLessThan(refused);
    // The mark the run is replaced by never grows with the selection.
    const named = await mark(long);
    expect(named.name).toHaveLength(
      (await mark(branch(recorded.ref, request({ files: "now-panel" })))).name.length,
    );
    expect(named.name.length).toBeLessThan(refused);
    expect(named.saved).toEqual({ ref: recorded.ref, inputs: all });
    expect(recorded.marks.map((mark) => mark.name)).toContain(named.name);
  });

  it("marks a task branch's request the same only when it names the same selection", async () => {
    const older = await mark(branch(recorded.ref, all));
    expect((await mark(branch(recorded.ref, { ...all }))).name).toBe(older.name);
    // The proof's request left mac_runner unset, which GitHub leaves out of inputs;
    // a request sending it empty is the same request, as the old group read it.
    expect(all).not.toHaveProperty("mac_runner");
    expect((await mark(branch(recorded.ref, { ...all, mac_runner: "" }))).name).toBe(older.name);
    expect((await mark(branch(recorded.ref, firstHalf))).name).not.toBe(older.name);
    expect((await mark(branch(recorded.ref, { ...all, platforms: "linux" }))).name).not.toBe(
      older.name,
    );
    expect((await mark(branch("refs/heads/fm/task-949a2d1a", all))).name).not.toBe(older.name);
  });

  /** The cancel step against GitHub's recorded answers, as the run `runId` runs it. */
  const cancel = async (
    runId: number,
    runs: typeof recorded.runs,
    answer: (run_id: number) => Promise<void> = async () => undefined,
  ) => {
    const cancelling = step(
      (candidate) => candidate.name === "Cancel the older requests of this selection",
    );
    const cancelled: number[] = [];
    const github = {
      paginate: async (
        method: (
          parameters: Record<string, unknown>,
        ) => Promise<{ data: { artifacts: unknown[] } }>,
        parameters: Record<string, unknown>,
      ) => (await method(parameters)).data.artifacts,
      rest: {
        actions: {
          listArtifactsForRepo: async (parameters: Record<string, unknown>) => {
            expect(parameters).toMatchObject({ name: recorded.marks[0]?.name });
            return { data: { total_count: recorded.marks.length, artifacts: recorded.marks } };
          },
          getWorkflowRun: async ({ run_id }: { run_id: number }) => {
            const run = runs.find((candidate) => candidate.id === run_id);
            if (!run) throw new Error(`no recorded reading of run ${run_id}`);
            return { data: run };
          },
          cancelWorkflowRun: async ({ run_id }: { run_id: number }) => {
            cancelled.push(run_id);
            await answer(run_id);
          },
        },
      },
    };
    await githubScript(String(cancelling.with?.script), ["core", "github", "context", "process"])(
      { info: () => undefined },
      github,
      { runId, repo: { owner: "example", repo: "project" } },
      { env: { MARK: recorded.marks[0]?.name } },
    );
    return cancelled;
  };

  it("cancels the older request of a selection, waiting or running, whichever run looks last", async () => {
    const [older, newer] = recorded.runs.toSorted((a, b) => a.id - b.id);
    if (!older || !newer) throw new Error("the proof recorded two runs");
    expect(await cancel(newer.id, recorded.runs)).toEqual([older.id]);
    // The older run, looking after the newer one marked itself, stops itself.
    expect(await cancel(older.id, recorded.runs)).toEqual([older.id]);
    // An older run that ended, or that is being rerun, keeps its place.
    for (const kept of [{ status: "completed" }, { run_attempt: 2 }]) {
      const runs = recorded.runs.map((run) => (run.id === older.id ? { ...run, ...kept } : run));
      expect(await cancel(newer.id, runs)).toEqual([]);
    }
    // A run that ends between the reading and the cancel answers 409.
    const ended = Object.assign(new Error("Cannot cancel a workflow run that is completed."), {
      status: 409,
    });
    expect(
      await cancel(newer.id, recorded.runs, async () => {
        throw ended;
      }),
    ).toEqual([older.id]);
  });

  it("never replaces a request on main or a rerun (INF-941)", () => {
    // On 2026-10-22 another task's request on main (39867018455) cancelled
    // INF-933's (39865801314) in the shared group journeys-refs/heads/main.
    const runs = (run: Run) => workflowValue(String(replace().if), reading(run));
    const inputs = request({ files: "keyboard-routing" });
    expect(runs({ ...branch("refs/heads/main", inputs), run_id: "39867018455" })).toBe(false);
    expect(runs({ ...branch(recorded.ref, all), run_attempt: "2" })).toBe(false);
    expect(runs(branch(recorded.ref, all))).toBe(true);
  });
});

describe("verify.yml's request group", () => {
  const group = groupOf(".github/workflows/verify.yml");
  const cancels = cancelsIn(".github/workflows/verify.yml");
  const request = (ref: string, inputs: Record<string, unknown>) => ({
    full_system: false,
    mac_only: false,
    linux_only: false,
    task: "INF-1",
    reason: "a named exception",
    mac_runner: "",
    profile: "stable",
    installer_only: false,
    installer_reuse: "",
    installer_chip: "both",
    perf: false,
    all_journeys: false,
    ref,
    ...inputs,
  });
  const branch = { workflow: "verify", ref: "refs/heads/fm/task-10a3f943" };

  it("names a task branch's request by its branch and selection, not its exact version", () => {
    const older: Run = {
      ...branch,
      run_id: "1",
      inputs: request("a".repeat(40), { full_system: true }),
    };
    const newer: Run = {
      ...branch,
      run_id: "2",
      inputs: request("b".repeat(40), { full_system: true }),
    };
    expect(group(newer)).toBe(group(older));
    expect(cancels(newer)).toBe(true);
    const macOnly: Run = { ...newer, inputs: request("b".repeat(40), { mac_only: true }) };
    expect(group(macOnly)).not.toBe(group(older));
    const linuxOnly: Run = { ...newer, inputs: request("b".repeat(40), { linux_only: true }) };
    expect(group(linuxOnly)).not.toBe(group(older));
    expect(group(linuxOnly)).not.toBe(group(macOnly));
    expect(group({ ...older, run_attempt: "2" })).not.toBe(group(newer));
  });

  it("keeps main's requests apart", () => {
    const main = { workflow: "verify", ref: "refs/heads/main" };
    const inputs = request("c".repeat(40), { full_system: true });
    expect(group({ ...main, run_id: "1", inputs })).not.toBe(
      group({ ...main, run_id: "2", inputs }),
    );
  });
});
