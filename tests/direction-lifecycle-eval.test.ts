import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { directionCases } from "../scripts/evals/directionLifecycle";
import { approvalHost } from "../scripts/evals/host";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1256 item 8: validation must observe real disposable effects, not proposed calls.
describe("direction lifecycle evaluation isolation", () => {
  it("serves all five cases with current directions and no setup dispatch", async () => {
    const dir = scratchDir("direction-lifecycle-");
    for (const test of directionCases) {
      const host = await approvalHost(
        test,
        join(dir, test.id),
        { provider: "openai-codex", id: "fixture" },
        [],
      );
      try {
        expect(host.starts).toEqual([]);
        expect(host.state().directions).toMatchObject(
          test.directions!.map(({ id, text }) => ({ id: `d:${id}`, text, revision: 1 })),
        );
        expect(host.state().graph).toHaveLength(Object.keys(test.tasks).length);
        expect(host.spec.tools.some(({ name }) => name === "app_change")).toBe(true);
      } finally {
        await host.close();
      }
    }
  });

  it("observes the effective autonomy policy after a direction-attributed edit and start", async () => {
    // INF-1278: live direction-fulfilled changed policies, not the original spawn ask.
    const test = directionCases.find(({ id }) => id === "direction-fulfilled");
    if (!test) throw new Error("Missing fulfilled-direction case");
    const host = await approvalHost(
      test,
      scratchDir("direction-policy-"),
      { provider: "openai-codex", id: "fixture" },
      [],
    );
    try {
      const update = host.spec.tools.find(({ name }) => name === "update_task");
      if (!update) throw new Error("Missing native update_task");
      const autonomy = () => host.state().graph?.find(({ id }) => id === "BUILD")?.autonomy;
      expect(autonomy()).toBe(false);
      const edit = { task: "BUILD", autonomy: "on", direction: "d:fixture-test-policy" };
      const edited = await update.run(edit);
      expect(host.effect("update_task", edit, edited), edited.text).toBe("success");
      expect(autonomy()).toBe(true);
      const start = { task: "BUILD", start_now: true };
      const started = await update.run(start);
      expect(host.effect("update_task", start, started), started.text).toBe("success");
      expect(host.starts).toEqual(["BUILD"]);
      expect(autonomy()).toBe(true);
    } finally {
      await host.close();
    }
  });

  it("executes native direction retirement only in the disposable collection and records its actual state", async () => {
    const host = await approvalHost(
      directionCases[0]!,
      scratchDir("direction-retire-"),
      { provider: "openai-codex", id: "fixture" },
      [],
    );
    try {
      const change = host.spec.tools.find(({ name }) => name === "app_change")!;
      const args = {
        action: "direction",
        value: { op: "retire", id: "d:fixture-local-time", expectedRevision: 1 },
        evidence: "Fictional captain chose Retire after seeing the covered rule.",
      };
      const output = await change.run(args);
      expect(host.effect("app_change", args, output), output.text).toBe("success");
      expect(host.state().directions).toEqual([]);
      expect(host.starts).toEqual([]);
      const blocked = {
        action: "notifications",
        value: {},
        evidence: "Not allowed in this evaluation",
      };
      const refused = await change.run(blocked);
      expect(host.effect("app_change", blocked, refused)).toBe("refused");
    } finally {
      await host.close();
    }
  });
});
