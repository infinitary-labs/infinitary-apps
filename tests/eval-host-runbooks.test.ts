import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalCases } from "../scripts/evals/approvalHandoff";
import { approvalHost } from "../scripts/evals/host";
import { crewmateProcedureFor } from "../src/core/pi/piResources";
import { crewRunbookText, Runbooks } from "../src/core/runbooks/runbooks";
import { openInMemoryDatabase } from "../src/core/storage/db";
import { SettingsStore } from "../src/core/storage/settingsStore";
import { effectiveTaskPolicies } from "../src/shared/taskPolicies";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1862: a live evaluation measures the guidance the app serves, read from the
// bundle's runbooks with a fresh app's switches, never the retired built-in copy
// a first mate or crew without runbooks falls back to. Replay shares this wiring.
describe("evaluation host guidance", () => {
  const app = () =>
    new Runbooks(
      join(process.cwd(), "resources/runbooks"),
      new SettingsStore(openInMemoryDatabase()),
    );
  const model = { provider: "openai-codex", id: "fixture" };

  it("serves the first mate the app's runbook guidance", async () => {
    const test = approvalCases.find(({ role }) => role === "firstmate");
    if (!test) throw new Error("Missing first mate case");
    const host = await approvalHost(test, scratchDir("eval-runbooks-firstmate-"), model, []);
    try {
      expect(host.spec.instructions.served).toMatchObject(app().firstmate());
    } finally {
      await host.close();
    }
  });

  it("serves a builder the runbook crew section and skills its task's facts select", async () => {
    const test = approvalCases.find(({ role }) => role === "builder");
    if (!test) throw new Error("Missing builder case");
    const host = await approvalHost(test, scratchDir("eval-runbooks-builder-"), model, []);
    try {
      const build = host.tasks.get(host.ids.BUILD ?? "");
      if (!build) throw new Error("Missing builder task");
      const procedure = crewmateProcedureFor(effectiveTaskPolicies(build));
      const served = app().crew({
        kind: build.shape?.kind ?? "unclear",
        place: "project",
        delivery: procedure.delivery,
        care: procedure.rigor,
        backend: "pi",
      });
      expect(host.spec.instructions.base).toContain(crewRunbookText(served));
      expect(host.spec.runbookSkills).toEqual(served.skills);
    } finally {
      await host.close();
    }
  });
});
