import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import {
  endPhoneGate,
  PHONE_DEVICES,
  PHONE_PART_TIMES,
  PHONE_PARTS,
  type PhoneJob,
  type PhonePassEnd,
  type PhonePassTimes,
  partDevices,
  phonePasses,
  phonePassMs,
  phonePassName,
} from "../scripts/phone-test-plan";
import { loadYamlFile, root, workflowString, workflowValue } from "./helpers/releaseWorkflows";

// INF-7079's fix 5, the captain's words: "Split TestFlight's every-device phone check into jobs of about 20 minutes
// that run side by side, as branch phone checks already are". This runs the phone release call's own dealing step,
// the chooser at the project's source, and hands its output to phone.yml's native job as GitHub would.

type Step = {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
type Job = {
  if?: string;
  outputs: Record<string, string>;
  steps: Step[];
  strategy: { "fail-fast": string; matrix: { include: string } };
  "timeout-minutes": string;
};
const workflow = loadYamlFile(".github/workflows/phone.yml") as { jobs: Record<string, Job> };
const RELEASE_SELECT = "release-select";
type Dealt = { key: string; passes: PhoneJob[] };

// The release-select step's output lines, from a run in `dir` as GitHub runs it.
function releaseSelect(dir: string): string[] {
  const output = join(dir, "output");
  writeFileSync(output, "");
  execFileSync(
    "bash",
    ["-e", "-c", workflow.jobs.request!.steps.find((step) => step.id === RELEASE_SELECT)!.run!],
    {
      cwd: root,
      env: { ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" },
      stdio: ["ignore", "ignore", "inherit"],
    },
  );
  return readFileSync(output, "utf8").trim().split("\n");
}

describe("the phone release's dealt call", () => {
  it("deals every part on every device its row names into side-by-side jobs that all run to their end", () => {
    const dir = mkdtempSync(join(tmpdir(), "phone-release-"));
    try {
      const request = workflow.jobs.request!;
      const lines = releaseSelect(dir);
      // The jobs alone: no stop_early, so the release keeps full discovery.
      expect(lines.map((line) => line.split("=")[0])).toEqual(["jobs"]);
      const jobs = JSON.parse(lines[0]!.slice("jobs=".length)) as Dealt[];
      expect(jobs.length).toBeGreaterThan(1);
      expect(jobs.map((job) => job.key)).toEqual(jobs.map((_, index) => `job-${index + 1}`));
      expect(
        jobs
          .flatMap((job) => job.passes)
          .map((pass) => `${pass.part} ${pass.device} ${pass.round}`)
          .sort(),
      ).toEqual(
        PHONE_PARTS.flatMap(({ name }) =>
          partDevices(name).map((device) => `${name} ${device} 1`),
        ).sort(),
      );
      const native = workflow.jobs["native-phone"]!;
      const handed = workflowString(request.outputs.jobs!, {
        steps: {
          "request-select": { outputs: {} },
          [RELEASE_SELECT]: { outputs: { jobs: JSON.stringify(jobs) } },
        },
      });
      const needs = { request: { outputs: { jobs: handed, stop_early: "" } } };
      expect(
        workflowValue(native.strategy.matrix.include, { inputs: { device: "" }, needs }),
      ).toEqual(jobs);
      expect(workflowValue(native.strategy["fail-fast"], { needs })).toBe(false);
      // Each is a dealt job, stopped at the dealt limits: 46 minutes for the first, which builds and shares the app.
      expect(
        jobs.map((matrix) =>
          workflowValue(native["timeout-minutes"], {
            matrix,
            strategy: { "job-total": jobs.length },
          }),
        ),
      ).toEqual(jobs.map((_, index) => (index === 0 ? 46 : 34)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // INF-7175: dealt, no job's gate writes the record of every part's time on every device that the release's one job
  // wrote, so the part-times job joins the times each job kept. Each job's gate keeps them where its upload reads them,
  // the join's download lays each job's artifact in a folder of its name, and the join step runs as GitHub runs it.
  // The minutes are the recorded part times the chooser deals by.
  it("joins the times its dealt jobs kept into one part-times.json of every part on every device", () => {
    const dir = mkdtempSync(join(tmpdir(), "phone-release-"));
    try {
      const jobs = JSON.parse(releaseSelect(dir)[0]!.slice("jobs=".length)) as Dealt[];
      const native = workflow.jobs["native-phone"]!;
      const joinJob = workflow.jobs["part-times"]!;
      const inputs = { trigger: "Requested TestFlight", source_commit: "a".repeat(40), device: "" };
      const needs = { request: { outputs: { jobs: JSON.stringify(jobs) } } };
      const ran = { success: false, failure: true, always: true, cancelled: false };
      // It runs once the dealt jobs end, a failed one among them, and not in a cancelled run.
      expect(workflowValue(joinJob.if!, { inputs, needs }, ran)).toBe(true);
      expect(workflowValue(joinJob.if!, { inputs, needs }, { ...ran, cancelled: true })).toBe(
        false,
      );
      // A call naming a device deals no jobs, and its one gate keeps its own part-times.json.
      const undealt = { request: { outputs: { jobs: "" } } };
      expect(
        workflowValue(joinJob.if!, { inputs: { ...inputs, device: "ipad" }, needs: undealt }, ran),
      ).toBe(false);

      const upload = native.steps.find((step) => step.with?.name?.startsWith("phone-pass-times-"))!;
      const fetch = joinJob.steps.find((step) =>
        step.uses?.startsWith("actions/download-artifact@"),
      )!;
      const joining = joinJob.steps.find((step) =>
        step.run?.includes("scripts/join-phone-part-times.ts"),
      )!;
      const keep = joinJob.steps.find((step) => step.with?.name === "phone-part-times")!;
      const runner = { temp: join(dir, "join") };
      const fetched = workflowString(fetch.with!.path!, { runner });
      const recorded = JSON.parse(
        readFileSync(join(root, PHONE_PART_TIMES), "utf8"),
      ) as PhonePassTimes;
      const end = (pass: PhoneJob): PhonePassEnd => ({
        outcome: "passed",
        ms: phonePassMs(pass, recorded),
      });
      for (const matrix of jobs) {
        expect(Boolean(workflowValue(upload.if!, { matrix }))).toBe(true);
        // The gate step's evidence folder is the runner's phone folder.
        const job = { temp: join(dir, matrix.key) };
        const evidence = join(job.temp, "phone");
        mkdirSync(evidence, { recursive: true });
        endPhoneGate(matrix.passes, matrix.passes.map(end), evidence);
        const name = workflowString(upload.with!.name!, { matrix });
        expect(matchesGlob(name, fetch.with!.pattern!)).toBe(true);
        const uploaded = workflowString(upload.with!.path!, { runner: job });
        mkdirSync(join(fetched, name), { recursive: true });
        copyFileSync(uploaded, join(fetched, name, basename(uploaded)));
      }
      const joinTimes = () =>
        execFileSync("bash", ["-e", "-c", joining.run!], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            RUNNER_TEMP: runner.temp,
            ...Object.fromEntries(
              Object.entries(joining.env!).map(([key, value]) => [
                key,
                workflowString(value, { needs }),
              ]),
            ),
          },
        });
      joinTimes();
      const kept = workflowString(keep.with!.path!, { runner });
      const times = JSON.parse(readFileSync(kept, "utf8")) as PhonePassTimes;
      const every = phonePasses([...PHONE_DEVICES], { parts: PHONE_PARTS.map(({ name }) => name) });
      expect(Object.keys(times).toSorted()).toEqual(PHONE_PARTS.map(({ name }) => name).toSorted());
      for (const pass of every)
        expect(times[pass.part]![pass.device], phonePassName(pass)).toBe(end(pass).ms);
      for (const [part, devices] of Object.entries(times))
        expect(Object.keys(devices).toSorted(), part).toEqual(partDevices(part).toSorted());

      // A job whose times never arrived, such as one stopped at its limit, leaves the record out and names its passes.
      rmSync(kept);
      const lost = jobs.at(-1)!;
      rmSync(join(fetched, workflowString(upload.with!.name!, { matrix: lost })), {
        recursive: true,
      });
      const warning = joinTimes();
      expect(existsSync(kept)).toBe(false);
      for (const pass of lost.passes) expect(warning).toContain(phonePassName(pass));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
