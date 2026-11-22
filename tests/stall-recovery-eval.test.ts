import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { approvalHost } from "../scripts/evals/host";
import { evaluationLimits, planAllowances, promptBytes } from "../scripts/evals/runner";
import { evaluation, recoveryCases } from "../scripts/evals/stallRecovery";
import { scratchDir } from "./helpers/scratchDirs";

// Real git for the disposable project's committed work (docs/test-cohorts.md, "Budgets").
vi.setConfig({ testTimeout: 25_000 });

const head = (dir: string) =>
  execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const startedCopy = (host: Awaited<ReturnType<typeof approvalHost>>, id: string) =>
  vi.waitFor(() => {
    const task = host.tasks.get(id);
    if (!task?.worktreeDir || !existsSync(task.worktreeDir)) throw new Error("not started yet");
    return task;
  });

// INF-1550 F9: prepare real disposable effects without using any account or model session.
// These are fixture/host checks, never evidence of real-model recovery judgment.
describe("stall recovery evaluation preparation", () => {
  it("prepares every bounded case with only disconnected production tools", async () => {
    const root = scratchDir("stall-recovery-cases-");
    for (const test of recoveryCases) {
      const host = await approvalHost(
        test,
        join(root, test.id),
        { provider: "openai-codex", id: "fixture" },
        [],
      );
      try {
        expect(host.spec.builtins).toBe("none");
        expect(host.spec.tools.some(({ name }) => /bash|exec|github|sign_in/.test(name))).toBe(
          false,
        );
        expect(host.state().openCards).toEqual([]);
        // The builder preset needs one inert setup dispatch; no model is connected.
        expect(host.starts).toEqual(test.role === "builder" ? ["BUILD"] : []);
        expect(test.maxCalls).toBeGreaterThan(0);
        const limits = evaluationLimits(evaluation);
        expect(test.maxCalls).toBeLessThanOrEqual(
          test.role === "firstmate" ? limits.firstmateCalls : limits.builderCalls,
        );
      } finally {
        await host.close();
      }
    }
  });

  // Source: the captain's fix-and-rerun choice on INF-1641's second live run, whose
  // investigator spent four requests reading, noting and reporting before the runner cut
  // its closing reply. The choice allowed at most 23 requests for the next run.
  it("plans the investigator a request for its closing reply, inside the allowed run", async () => {
    const root = scratchDir("stall-recovery-plan-");
    const measured: {
      role: (typeof recoveryCases)[number]["role"];
      bytes: number;
      maxCalls?: number;
    }[] = [];
    for (const test of recoveryCases) {
      const host = await approvalHost(
        test,
        join(root, test.id),
        { provider: "openai-codex", id: "fixture" },
        [],
      );
      try {
        measured.push({ role: test.role, bytes: promptBytes(host), maxCalls: test.maxCalls });
      } finally {
        await host.close();
      }
    }
    const plan = planAllowances(measured, evaluationLimits(evaluation));
    const investigator = recoveryCases.findIndex(({ role }) => role === "builder");
    expect(plan[investigator]?.calls).toBe(4 + 1);
    expect(plan.reduce((sum, row) => sum + row.calls, 0)).toBeLessThanOrEqual(23);
  });

  it.each(recoveryCases.filter(({ next }) => next === "VERIFY"))(
    "$id can start the already authorized alternative and read its actual result",
    async (test) => {
      const host = await approvalHost(
        test,
        scratchDir("stall-recovery-next-"),
        { provider: "openai-codex", id: "fixture" },
        [],
      );
      try {
        const update = host.spec.tools.find(({ name }) => name === "update_task")!;
        const args = {
          task: "VERIFY",
          start_now: true,
          verdict: "Inspect the retained commit instead of repeating the refused action.",
        };
        const output = await update.run(args);
        expect(host.effect("update_task", args, output), output.text).toBe("success");
        expect(host.starts).toEqual(["VERIFY"]);
        const read = host.spec.tools.find(({ name }) => name === "tasks")!;
        const record = await read.run({ key: "VERIFY" });
        const rows = JSON.parse(record.text.slice(record.text.indexOf("\n") + 1));
        expect(rows).toMatchObject([
          { task_id: host.ids.VERIFY, status: "idle", assignee: expect.any(String) },
        ]);
        // The row stays active; the inert owner has already returned and reads as idle.
        expect(host.state().graph?.find(({ id }) => id === "VERIFY")?.status).toBe("active");
        expect(host.state().openCards).toEqual([]);
        // R5 of INF-1644: the inspection's working copy holds the retained commit it names.
        const build = host.tasks.get(host.ids.BUILD!)!;
        const verify = await startedCopy(host, host.ids.VERIFY!);
        expect(head(verify.worktreeDir)).toBe(head(build.worktreeDir));
        expect(readFileSync(join(verify.worktreeDir, "meter.ts"), "utf8")).toBe(
          test.tasks.BUILD!.committed!["meter.ts"],
        );
      } finally {
        await host.close();
      }
    },
  );

  // Source: R5 of INF-1644. Run 6's investigation spawn was refused because the fixture's
  // retained commit did not exist. These are that real model call's arguments; the project
  // is the one the corrected records show, since the old fixture had none to name.
  it("dispatches run 6's recorded investigation from the stalled task's committed branch", async () => {
    const test = recoveryCases.find(({ id }) => id === "bounded-read-only-investigation")!;
    const host = await approvalHost(
      test,
      scratchDir("stall-recovery-branch-"),
      { provider: "openai-codex", id: "fixture" },
      [],
    );
    try {
      const build = host.tasks.get(host.ids.BUILD!)!;
      expect(build).toMatchObject({ repoId: host.ids.PROJECT, workspaceState: "present" });
      const args = {
        title: "Find ways past the host-record refusal",
        goal: "Find recovery ways today, without a new build, for delivering the committed meter change whose next delivery action the installed host record refuses.",
        user_words: "Continue the committed meter change",
        constraints: [
          { kind: "read-only" },
          {
            kind: "free",
            text: "Inspect the retained commit on the BUILD branch and its refusal record (readable without sign-in). Resume, direct-delivery and takeover were already tried and hit the identical host-record refusal; do not repeat them. Return recovery_ways, each declaring approach: workaround, pass-hold or stronger-model, with evidence. No card, no edits; stop after reporting.",
          },
        ],
        shape: { kind: "research", internal_step: true },
        branch_from: host.ids.BUILD,
        repo_id: host.ids.PROJECT,
      };
      const spawn = host.spec.tools.find(({ name }) => name === "spawn_crewmate")!;
      const output = await spawn.run(args);
      expect(host.effect("spawn_crewmate", args, output), output.text).toBe("success");
      const spawned = host.tasks.list().find(({ title }) => title === args.title)!;
      expect(spawned.shape).toMatchObject({ branch_from: build.key, internal_step: true });
      const copy = await startedCopy(host, spawned.id);
      expect(head(copy.worktreeDir)).toBe(head(build.worktreeDir));
      expect(readFileSync(join(copy.worktreeDir, "meter.ts"), "utf8")).toBe(
        test.tasks.BUILD!.committed!["meter.ts"],
      );
      expect(host.state().openCards).toEqual([]);
    } finally {
      await host.close();
    }
  });
});
