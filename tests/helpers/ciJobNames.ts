import { loadYamlFile, workflowString, workflowValue } from "./releaseWorkflows";

/**
 * The jobs one workflow run shows, by GitHub's full names, evaluated from the
 * workflow files themselves (INF-2413; docs/testing.md, "CI job names"): each
 * job whose condition holds, once per matrix entry, and a called workflow's
 * jobs under their caller's name, with the inputs the caller passes. A
 * condition that reads something the scenario does not give counts as held.
 * Shared by the readers' tests, so a name they read is the one the workflow
 * writes, never a copy.
 */
export type Scenario = {
  github: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  vars?: Record<string, unknown>;
  /** Each job's result and outputs, by job id, within any workflow of the run. */
  needs?: Record<string, { result?: string; outputs?: Record<string, string> }>;
};

type Job = {
  name?: string;
  if?: string | boolean;
  uses?: string;
  with?: Record<string, unknown>;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  strategy?: { matrix?: unknown };
};

type Workflow = {
  on: Record<string, { inputs?: Record<string, { default?: unknown }> } | null>;
  jobs: Record<string, Job>;
};

const status = { success: true, failure: false, always: true, cancelled: false };

function held(condition: Job["if"], contexts: Record<string, unknown>): boolean {
  if (condition === undefined || condition === true) return true;
  if (condition === false) return false;
  try {
    return Boolean(workflowValue(String(condition), contexts, status));
  } catch {
    return true;
  }
}

function matrixEntries(job: Job, contexts: Record<string, unknown>): Record<string, unknown>[] {
  let matrix = job.strategy?.matrix;
  if (matrix === undefined) return [{}];
  if (typeof matrix === "string") matrix = workflowValue(matrix, contexts);
  const { include: listed, exclude, ...axes } = matrix as Record<string, unknown>;
  if (exclude !== undefined) throw new Error("A matrix exclude is not read here");
  // A list the workflow computes, as source-journeys.yml's groups (INF-2987).
  const include = typeof listed === "string" ? workflowValue(listed, contexts) : listed;
  let entries: Record<string, unknown>[] = [{}];
  for (const [key, raw] of Object.entries(axes)) {
    const values = typeof raw === "string" ? workflowValue(raw, contexts) : raw;
    if (!Array.isArray(values)) throw new Error(`Matrix axis ${key} is not a list`);
    entries = entries.flatMap((entry) => values.map((value) => ({ ...entry, [key]: value })));
  }
  if (Array.isArray(include)) {
    entries = Object.keys(axes).length === 0 ? include : [...entries, ...include];
  }
  return entries;
}

function inputDefaults(workflow: Workflow, event: string): Record<string, unknown> {
  const inputs = workflow.on[event]?.inputs ?? {};
  return Object.fromEntries(
    Object.entries(inputs).map(([key, input]) => [key, input.default ?? null]),
  );
}

function evaluated(value: unknown, contexts: Record<string, unknown>): unknown {
  if (typeof value !== "string") return value;
  const whole = /^\$\{\{([\s\S]*)\}\}$/.exec(value.trim());
  return whole && !whole[1]?.includes("}}")
    ? workflowValue(value, contexts)
    : workflowString(value, contexts);
}

/**
 * Each job's outputs that read only the run itself (the event, the inputs and
 * the variables), under the scenario's own: a release's `resolve` job says
 * what started it once, and every later job's name reads it from there. An
 * output that reads a step stays the scenario's to give.
 */
function jobOutputs(workflow: Workflow, scenario: Scenario, run: Record<string, unknown>) {
  const needs: NonNullable<Scenario["needs"]> = {};
  for (const [id, job] of Object.entries(workflow.jobs)) {
    const outputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(job.outputs ?? {})) {
      try {
        outputs[key] = workflowString(String(value), run);
      } catch {
        // Reads a step: the scenario supplies it or it stays unset.
      }
    }
    const given = scenario.needs?.[id];
    if (given === undefined && Object.keys(outputs).length === 0) continue;
    needs[id] = { ...given, outputs: { ...outputs, ...given?.outputs } };
  }
  return needs;
}

/** The full name of every job a run of `file` shows in `scenario`. */
export function runJobNames(file: string, scenario: Scenario, called = false): string[] {
  const workflow = loadYamlFile(`.github/workflows/${file}`) as unknown as Workflow;
  const event = called ? "workflow_call" : String(scenario.github.event_name);
  const inputs = { ...inputDefaults(workflow, event), ...scenario.inputs };
  const run = { github: scenario.github, inputs, vars: scenario.vars ?? {} };
  const base = { ...run, needs: jobOutputs(workflow, scenario, run) };
  return Object.entries(workflow.jobs).flatMap(([id, job]) => {
    const entries = matrixEntries(job, base);
    return entries.flatMap((matrix, index) => {
      const contexts = {
        ...base,
        matrix,
        strategy: { "job-index": index, "job-total": entries.length },
      };
      if (!held(job.if, contexts)) return [];
      const name = job.name === undefined ? id : workflowString(job.name, contexts);
      if (!job.uses) return [name];
      const child = job.uses.replace(/^\.\/\.github\/workflows\//, "");
      const passed = Object.fromEntries(
        Object.entries(job.with ?? {}).map(([key, value]) => [key, evaluated(value, contexts)]),
      );
      return runJobNames(child, { ...scenario, inputs: passed }, true).map(
        (each) => `${name} / ${each}`,
      );
    });
  });
}
