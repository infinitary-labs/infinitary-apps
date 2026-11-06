import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadYamlFile, workflowString, workflowValue } from "./helpers/releaseWorkflows";

// INF-2055, captain: only native phone-check jobs may resolve to the rented
// phone pool, and none may read secrets. Exercise the real workflow routes;
// caller-supplied proof-run label overrides are not repository routing policy.
const pool = "mini-mac-phone";
const nativeJobs = ["native-phone"];
const allowed = nativeJobs.map((id) => `phone.yml:${id}`);
const kinds = [
  "split",
  "check",
  "journeys",
  "phone",
  "testflight",
  "build",
  "sign",
  "light",
  "release_split",
  "release_sign",
  "release_light",
];
const vars = {
  MAC_QUEUES: JSON.stringify(
    Object.fromEntries(kinds.map((kind) => [kind, `mini-mac-${kind.replaceAll("_", "-")}`])),
  ),
  MAC_RUNNER: "mini-mac-any",
  REAL_MAC_RUNNER: "mini-mac-real",
  VIRTUAL_MAC_RUNNER: "mini-mac-virtual",
};
type Job = Record<string, unknown> & {
  "runs-on"?: string | string[];
  strategy?: { matrix?: Record<string, unknown> };
};
type Workflow = { jobs: Record<string, Job>; env?: unknown; defaults?: unknown };
const workflows = () =>
  Object.fromEntries(
    readdirSync(join(__dirname, "../.github/workflows"))
      .filter((file) => /\.ya?ml$/.test(file))
      .map((file) => [file, loadYamlFile(`.github/workflows/${file}`) as unknown as Workflow]),
  );

function workflowIn(all: Record<string, Workflow>, file: string): Workflow {
  const workflow = all[file];
  if (!workflow) throw new Error(`Missing workflow fixture: ${file}`);
  return workflow;
}

function jobIn(all: Record<string, Workflow>, file: string, id: string): Job {
  const job = workflowIn(all, file).jobs[id];
  if (!job) throw new Error(`Missing job fixture: ${file}:${id}`);
  return job;
}

function secretRead(value: unknown): boolean {
  if (typeof value === "string") {
    return [...value.matchAll(/\$\{\{[\s\S]*?\}\}/g)].some(([expression]) =>
      /\bsecrets\b/i.test(expression),
    );
  }
  if (Array.isArray(value)) return value.some(secretRead);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) => key === "secrets" || secretRead(item));
  }
  return false;
}

function inspect(all: Record<string, Workflow>) {
  const selected = new Set<string>();
  const violations = new Set<string>();
  for (const [file, workflow] of Object.entries(all)) {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (!job["runs-on"]) continue; // Reusable calls have no runner of their own.
      for (const dryRun of ["true", "false"]) {
        // Both publishing paths matter: release-only queues must not join phone.
        // The alpha wait's matrix is the alpha cuts its find job listed, here
        // the one from main run 204 that a main check waited for (alpha-wait.yml).
        const contexts = {
          vars,
          inputs: {},
          needs: {
            resolve: { outputs: { dry_run: dryRun } },
            find: { outputs: { alphas: "[204]" } },
          },
          matrix: {},
        };
        const evaluate = (value: unknown): unknown =>
          typeof value === "string" && value.includes("${{")
            ? workflowValue(value, contexts)
            : value;
        const matrix = job.strategy?.matrix ?? {};
        let entries: Record<string, unknown>[] = [{}];
        for (const [axis, values] of Object.entries(matrix)) {
          if (axis === "include" || axis === "exclude") continue;
          const choices = evaluate(values);
          if (!Array.isArray(choices)) throw new Error(`${file}:${id}: unreadable matrix ${axis}`);
          entries = entries.flatMap((entry) =>
            choices.map((choice) => ({ ...entry, [axis]: choice })),
          );
        }
        if (Array.isArray(matrix.exclude)) {
          entries = entries.filter(
            (entry) =>
              !(matrix.exclude as Record<string, unknown>[]).some((excluded) =>
                Object.entries(excluded).every(([key, value]) => entry[key] === value),
              ),
          );
        }
        if (Array.isArray(matrix.include))
          entries.push(...(matrix.include as Record<string, unknown>[]));
        for (const entry of entries) {
          const labels = (Array.isArray(job["runs-on"]) ? job["runs-on"] : [job["runs-on"]]).map(
            (label) => workflowString(label, { ...contexts, matrix: entry }),
          );
          if (!labels.includes(pool)) continue;
          const name = `${file}:${id}`;
          selected.add(name);
          if (!allowed.includes(name)) violations.add(`${name}: not a native phone check`);
          if (secretRead([workflow.env, workflow.defaults, job]))
            violations.add(`${name}: reads secrets`);
        }
      }
    }
  }
  return { selected: [...selected].sort(), violations: [...violations].sort() };
}

describe("rented phone pool isolation (INF-2055)", () => {
  it("resolves only native phone checks to the live pool, without secrets", () => {
    const result = inspect(workflows());
    expect(result.selected).toEqual([...allowed].sort());
    expect(result.violations).toEqual([]);
  });

  it("rejects a journey that accidentally asks for the phone queue", () => {
    const all = workflows();
    jobIn(all, "journeys.yml", "affected-journeys")["runs-on"] =
      "${{ fromJSON(vars.MAC_QUEUES).phone }}";
    expect(inspect(all).violations).toContain(
      "journeys.yml:affected-journeys: not a native phone check",
    );
  });

  it.each(["${{ secrets.APP_STORE_CONNECT_KEY }}", "${{ secrets['APP_STORE_CONNECT_KEY'] }}"])(
    "rejects a phone check reading %s",
    (secret) => {
      const all = workflows();
      jobIn(all, "phone.yml", "native-phone").env = { SIGNING_KEY: secret };
      expect(inspect(all).violations).toContain("phone.yml:native-phone: reads secrets");
    },
  );

  it("rejects a signing job redirected to phone only during publication", () => {
    const all = workflows();
    jobIn(all, "release.yml", "release")["runs-on"] =
      "${{ needs.resolve.outputs.dry_run == 'false' && fromJSON(vars.MAC_QUEUES).phone || vars.REAL_MAC_RUNNER }}";
    expect(inspect(all).violations).toContain("release.yml:release: not a native phone check");
  });

  it("rejects a secret read in a phone check's steps", () => {
    const all = workflows();
    const job = jobIn(all, "phone.yml", "native-phone");
    job.steps = [
      ...(job.steps as unknown[]),
      { run: "echo '${{ secrets.APP_STORE_CONNECT_KEY }}'" },
    ];
    expect(inspect(all).violations).toContain("phone.yml:native-phone: reads secrets");
  });

  it("rejects a workflow-level secret inherited by the native checks", () => {
    const all = workflows();
    workflowIn(all, "phone.yml").env = { SIGNING_KEY: "${{ secrets.APP_STORE_CONNECT_KEY }}" };
    expect(inspect(all).violations).toEqual(allowed.map((name) => `${name}: reads secrets`).sort());
  });
});
