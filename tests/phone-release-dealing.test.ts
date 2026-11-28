import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PHONE_PARTS, partDevices } from "../scripts/phone-test-plan";
import { loadYamlFile, root, workflowString, workflowValue } from "./helpers/releaseWorkflows";

// INF-7079's fix 5, the captain's words: "Split TestFlight's every-device phone check into jobs of about 20 minutes
// that run side by side, as branch phone checks already are". This runs the phone release call's own dealing step,
// the chooser at the project's source, and hands its output to phone.yml's native job as GitHub would.

type Step = { id?: string; run?: string };
type Job = {
  outputs: Record<string, string>;
  steps: Step[];
  strategy: { "fail-fast": string; matrix: { include: string } };
  "timeout-minutes": string;
};
const workflow = loadYamlFile(".github/workflows/phone.yml") as { jobs: Record<string, Job> };
const RELEASE_SELECT = "release-select";

describe("the phone release's dealt call", () => {
  it("deals every part on every device its row names into side-by-side jobs that all run to their end", () => {
    const dir = mkdtempSync(join(tmpdir(), "phone-release-"));
    try {
      const output = join(dir, "output");
      writeFileSync(output, "");
      const request = workflow.jobs.request!;
      execFileSync(
        "bash",
        ["-e", "-c", request.steps.find((step) => step.id === RELEASE_SELECT)!.run!],
        {
          cwd: root,
          env: { ...process.env, RUNNER_TEMP: dir, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "" },
          stdio: ["ignore", "ignore", "inherit"],
        },
      );
      const lines = readFileSync(output, "utf8").trim().split("\n");
      // The jobs alone: no stop_early, so the release keeps full discovery.
      expect(lines.map((line) => line.split("=")[0])).toEqual(["jobs"]);
      const jobs = JSON.parse(lines[0]!.slice("jobs=".length)) as {
        key: string;
        passes: { part: string; device: string; round: number }[];
      }[];
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
});
