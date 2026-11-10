import { describe, expect, it } from "vitest";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";

/**
 * INF-3380 (the captain's direction A, "the workflow files cancel the older run
 * themselves"): a newer request of the same check, on the same task branch and with the same selection, cancels the older run
 * through the workflow's own group. Main, a rerun and every call keep a group of
 * their own run. The requests below are real runs, their inputs read from each
 * run's request job log.
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

describe("journeys.yml's request group", () => {
  const group = groupOf(".github/workflows/journeys.yml");
  const cancels = cancelsIn(".github/workflows/journeys.yml");
  const request = (inputs: Record<string, unknown>) => ({
    mac_runner: "",
    platforms: "linux",
    base: "origin/main",
    mac_all: false,
    starve: false,
    perf: false,
    ...inputs,
  });
  const branch = { workflow: "journeys", ref: "refs/heads/fm/task-10a3f943" };

  it("replaces a task branch's older request only when it names the same journeys", () => {
    const older: Run = { ...branch, run_id: "1", inputs: request({ files: "now-panel" }) };
    expect(group({ ...older, run_id: "2" })).toBe(group(older));
    expect(cancels(older)).toBe(true);
    expect(group({ ...older, run_id: "2", inputs: request({ files: "task-crewmate" }) })).not.toBe(
      group(older),
    );
    expect(
      group({ ...older, run_id: "2", inputs: request({ files: "now-panel", platforms: "mac" }) }),
    ).not.toBe(group(older));
    expect(group({ ...older, run_attempt: "2" })).not.toBe(group({ ...older, run_id: "2" }));
  });

  it("never lets one request on main cancel another (INF-941)", () => {
    // On 2026-10-22 another task's request on main (39867018455) cancelled
    // INF-933's (39865801314) in the shared group journeys-refs/heads/main.
    const main = { workflow: "journeys", ref: "refs/heads/main" };
    const inputs = request({ files: "keyboard-routing" });
    expect(group({ ...main, run_id: "39865801314", inputs })).not.toBe(
      group({ ...main, run_id: "39867018455", inputs }),
    );
  });
});

describe("verify.yml's request group", () => {
  const group = groupOf(".github/workflows/verify.yml");
  const cancels = cancelsIn(".github/workflows/verify.yml");
  const request = (ref: string, inputs: Record<string, unknown>) => ({
    full_system: false,
    mac_only: false,
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
