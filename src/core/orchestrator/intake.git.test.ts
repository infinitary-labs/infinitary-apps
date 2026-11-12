/**
 * How the crew takes in work on a real project folder (`TaskIntake`):
 * the settle facts naming a change's pull request and checks, task-level
 * delivery overrides, typed results and branch_from.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 * The cases drive real git.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SETTLE_FACT_VALUE_CLASS } from "@shared/cards";
import { RIGOR_REFERENCE_WORD, RIGOR_WORDS } from "@shared/vocabulary";
import { describe, expect, it, vi } from "vitest";
import {
  completionBody,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  SETTLE_DISCARD,
  SETTLE_MERGE,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { gitRepo } from "../../../tests/helpers/crewHarnessGit";
import { fakeSessionFactory } from "../../../tests/helpers/fakeSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { hostEnv } from "../hostEnv";
import { crewmateHandoverDir, crewmateTempDir } from "../paths";
import { NOTHING_SPAWNED } from "../pi/crewTools";
import type { ModelRuntime } from "../pi/types";
import { SettingsStore } from "../storage/settingsStore";
import { keepHandoverFiles } from "../tasks/handoverFiles";
import { seedTask } from "../tasks/seedTask";
import { RESULT_WORDS } from "../tasks/taskResult";
import type { CrewmateSpec } from "./crewSession";
import { FirstmateAgent } from "./firstmateAgent";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

describe("the task graph (task-system P2)", () => {
  it("names the project, PR number and CI state on a direct-pr task's settle card", async () => {
    const { dir } = gitRepo();
    // It lives on GitHub: the proposed change gets a link in the strip.
    execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/o/r.git"]);
    try {
      const crewmate = fakeCrewmate();
      const { supervisor, specs, cards, tasks, repos } = setup(crewmate);
      const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "firstmate-3000" });
      repos.configure(repo.id, { delivery: "direct-pr", rigor: "quick" });
      // The captain asked for standard care on a quick-care project: the
      // completion strip must read the tier stamped on the task, not the
      // project's standing setting.
      const { taskId } = await supervisor.intake.commission({
        title: "Fix smoke",
        intent: intentOf("Fix the flaky package-smoke."),
        repoId: repo.id,
        shape: { rigor_ask: "standard" },
      });
      await tick();
      const emit = () =>
        (specs[0] as CrewmateSpec).onCard?.({
          requiredActions: [],
          id: "done",
          title: "The smoke test is fixed",
          // The facts line under test follows the card body.
          body: completionBody(
            [
              "<h3>Intent</h3><p>The smoke test passes ten runs in a row.</p>",
              "<h3>What changed</h3><p>The smoke test waits for the app.</p>",
              "<h3>Verified</h3><p>Reran the suite.</p>",
              "<h3>Risk</h3><p>Low.</p>",
              "<h3>Not done</h3><p>Nothing.</p>",
            ].join(""),
          ),
          actions: [
            { id: "merge", label: "Merge PR", default: true, effect: SETTLE_MERGE },
            { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
          ],
        });
      emit();
      await tick();
      const body = () => cards().find((card) => card.title === "The smoke test is fixed")?.body;
      // Before any CI read the strip says so, instead of inventing a state.
      expect(body()).toContain(
        `<span data-fact="project"><span class="${SETTLE_FACT_VALUE_CLASS}">firstmate-3000</span></span>`,
      );
      // The care level shows only when it is not Default (the captain's
      // answer on INF-3709's plan).
      expect(body()).not.toContain('data-fact="care"');
      expect(body()).not.toContain(">Goes in<");
      expect(body()).not.toContain(">On its own<");
      expect(body()).toContain("not read yet");
      // The branch dropped off the facts at v2.7 (captain, 2026-09-19).
      expect(body()).not.toContain(`fm/task-${taskId}`);
      seedDelivery(tasks, taskId, {
        prUrl: "https://github.com/o/r/pull/55",
        prNumber: 55,
        ci: "green",
        ciAt: Date.now() - 3 * 60_000,
        ciStartedAt: Date.now() - 20 * 60_000,
        ciFinishedAt: Date.now() - 6 * 60_000,
      });
      // A revision under the same id re-renders the facts from the record:
      // the PR is its number, never the raw URL; the checks' state and how
      // long ago they finished show in the open, and how long they took
      // (INF-587), their start and the reading ride the state's title
      // (INF-3709's plan: counts and durations on rest).
      emit();
      await tick();
      expect(body()).toContain('<a href="https://github.com/o/r/pull/55">#55</a>');
      expect(body()).toContain('passed<span class="inf-foot-age"> · 6m ago</span>');
      expect(body()).toMatch(/title="Passed in 14m · started [^"]+ · read [^"]+"/);
      expect(body()).not.toContain("not read yet");
      expect(cards().filter((card) => card.title === "The smoke test is fixed")).toHaveLength(1);
      // Saved round fields remain history; they add no counter cells, marks
      // or cap titles to the current facts.
      seedDelivery(tasks, taskId, {
        ciRounds: 2,
        ciRedHead: "9f3c1ab0000000000000000000000000000000ee",
      });
      emit();
      await tick();
      expect(body()).toContain('passed<span class="inf-foot-age"> · 6m ago</span>');
      expect(body()).toMatch(/title="Passed in 14m · started [^"]+ · read [^"]+"/);
      expect(body()).not.toContain('data-fact="check-rounds"');
      expect(body()).not.toContain('data-fact="look-rounds"');
      expect(body()).not.toContain('aria-label="round');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("crew_status names where each change goes in the person's word for the host, and nothing for work kept here (git integration PR 1.3)", async () => {
    const hosted = (name: string, origin?: string) => {
      const dir = scratchDir(`infinitary-goes-in-${name}-`);
      execFileSync("git", ["-C", dir, "init", "--initial-branch=main"]);
      if (origin) execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
      return dir;
    };
    const crewmate = fakeCrewmate();
    const { supervisor, repos, tasks } = setup(crewmate);
    const onGitHub = await repos.setup({
      kind: "adopt",
      path: hosted("gh", "https://github.com/o/meter.git"),
      name: "meter",
    });
    const onPlainHost = await repos.setup({
      kind: "adopt",
      path: hosted("plain", "https://git.example.com/o/ledger.git"),
      name: "ledger",
    });
    const keptHere = await repos.setup({
      kind: "adopt",
      path: hosted("kept", "https://github.com/o/notes.git"),
      name: "notes",
    });
    repos.configure(keptHere.repo.id, { delivery: "local-only" });
    const local = await repos.setup({ kind: "init", name: "sketch" });
    const commission = (repoId: string, title: string) =>
      supervisor.intake.commission({
        title,
        intent: intentOf(title),
        repoId,
        shape: { rigor_ask: "quick" },
      });
    const ids = {
      github: (await commission(onGitHub.repo.id, "Fix the meter")).taskId,
      plain: (await commission(onPlainHost.repo.id, "Fix the ledger")).taskId,
      kept: (await commission(keptHere.repo.id, "Tidy the notes")).taskId,
      local: (await commission(local.repo.id, "Draw the sketch")).taskId,
    };
    await tick();
    const entry = (taskId: string) => supervisor.facts.crewStatus(taskId)[0];
    expect(entry(ids.github)).toMatchObject({ delivery: "direct-pr", goesIn: "GitHub" });
    expect(entry(ids.plain)).toMatchObject({ delivery: "direct-pr", goesIn: "git.example.com" });
    // A project on GitHub the captain keeps on this Mac never names it.
    expect(entry(ids.kept)?.delivery).toBe("local-only");
    expect(entry(ids.kept)).not.toHaveProperty("goesIn");
    expect(entry(ids.local)).not.toHaveProperty("goesIn");

    // With nothing to put a change in through, the refusal names where the
    // project lives rather than assuming GitHub.
    seedTask(tasks, {
      id: "ledgeridle",
      title: "Ledger totals",
      status: "idle",
      repoId: onPlainHost.repo.id,
      worktreeDir: "/work",
    });
    const refusal = await supervisor.settling.settle.settleTask(
      "ledgeridle",
      "merge-pr",
      undefined,
      "captain",
    );
    expect(refusal).toContain("git.example.com is not reachable from here");
    expect(refusal).not.toContain("GitHub");
  });

  it("names a plain Git host's change by the label the forge gave it, with no link to parse (git integration PR 1.1)", async () => {
    const { dir } = gitRepo();
    execFileSync("git", [
      "-C",
      dir,
      "remote",
      "add",
      "origin",
      "ssh://git@git.example.com/me/meter.git",
    ]);
    try {
      const crewmate = fakeCrewmate();
      const { supervisor, specs, cards, tasks, repos } = setup(crewmate);
      const { repo } = await repos.setup({ kind: "adopt", path: dir, name: "meter" });
      expect(repo.delivery).toBe("direct-pr");
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter",
        intent: intentOf("Fix the meter."),
        repoId: repo.id,
        shape: { rigor_ask: "quick" },
      });
      await tick();
      // What check_pr_ci records for a working copy sent up to a plain host.
      seedDelivery(tasks, taskId, {
        changeLabel: `fm/task-${taskId}`,
        ci: "green",
        ciAt: Date.now(),
      });
      const intermediate = (specs[0] as CrewmateSpec).onCard?.({
        id: "question",
        title: "Which meter?",
        body: "<p>Which meter needs attention?</p><p>The readings differ.</p>",
        actions: [
          { id: "first", label: "The first meter", default: true },
          { id: "second", label: "The second meter" },
        ],
      });
      expect(intermediate).toContain(`No button on this card can merge fm/task-${taskId}`);
      const completion = (specs[0] as CrewmateSpec).onCard?.({
        requiredActions: [],
        id: "done",
        title: "The meter is fixed",
        body: completionBody("<p>The meter reads on time.</p><ul><li>Checked by hand.</li></ul>"),
        actions: [
          { id: "merge", label: "Put it in", default: true, effect: SETTLE_MERGE },
          { id: "discard", label: "Discard", danger: true, effect: SETTLE_DISCARD },
        ],
      });
      expect(completion).not.toContain("No button on this card");
      await tick();
      const body = cards().find((card) => card.title === "The meter is fixed")?.body ?? "";
      expect(body).toContain(
        `<span data-fact="care"><span class="${SETTLE_FACT_VALUE_CLASS}">${RIGOR_WORDS.quick}</span> ${RIGOR_REFERENCE_WORD}</span>`,
      );
      expect(body).toContain(
        `<span data-fact="change"><span class="${SETTLE_FACT_VALUE_CLASS}">fm/task-${taskId}</span></span>`,
      );
      expect(body).not.toContain("GitHub");
      expect(body).not.toContain("<a ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("task-level delivery override", () => {
  it("inherits the repository when the captain said nothing about delivery", async () => {
    const repo = gitRepo("meterlab");
    try {
      const crewmate = fakeCrewmate();
      const { supervisor, repos } = setup(crewmate);
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter",
        intent: intentOf("fix the meter"),
        repoId: view.id,
      });
      await tick();
      expect(supervisor.facts.taskDelivery(taskId)).toBe("direct-pr");
      expect(repos.get(view.id)?.delivery).toBe("direct-pr");
      expect(crewmate.promptCalls[0]).toContain("Delivery: direct-pr");
    } finally {
      repo.dispose();
    }
  });

  it("ships one task local-only on a direct-pr repo when the captain asked, and leaves the repo alone", async () => {
    const repo = gitRepo("meterlab");
    try {
      const crewmate = fakeCrewmate();
      const { supervisor, tasks, repos } = setup(crewmate);
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter",
        intent: intentOf("fix it but don't open a PR"),
        repoId: view.id,
        shape: { delivery_ask: "local-only" },
      });
      await tick();
      expect(tasks.get(taskId)?.shape).toMatchObject({ delivery_ask: "local-only" });
      expect(supervisor.facts.taskDelivery(taskId)).toBe("local-only");
      expect(repos.get(view.id)?.delivery).toBe("direct-pr");
      expect(crewmate.promptCalls[0]).toContain("Delivery: local-only");
      expect(crewmate.promptCalls[0]).not.toContain("Delivery: direct-pr");
    } finally {
      repo.dispose();
    }
  });

  it("opens a PR for one task on a local-only repo that has a remote", async () => {
    const repo = gitRepo("meterlab");
    execFileSync("git", [
      "-C",
      repo.dir,
      "remote",
      "add",
      "origin",
      "https://example.com/owner/meterlab.git",
    ]);
    try {
      const crewmate = fakeCrewmate();
      const { supervisor, repos } = setup(crewmate);
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "local-only" });
      expect(repos.get(view.id)?.origin).toBeTruthy();
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter",
        intent: intentOf("open a PR for this one"),
        repoId: view.id,
        shape: { delivery_ask: "direct-pr" },
      });
      await tick();
      expect(supervisor.facts.taskDelivery(taskId)).toBe("direct-pr");
      expect(supervisor.facts.crewStatus(taskId)[0]?.delivery).toBe("direct-pr");
      expect(repos.get(view.id)?.delivery).toBe("local-only");
      expect(crewmate.promptCalls[0]).toContain("Delivery: direct-pr");
    } finally {
      repo.dispose();
    }
  });

  it("refuses a direct-pr ask with no repo, and on a repo with no remote", async () => {
    const repo = gitRepo("meterlab");
    try {
      const crewmate = fakeCrewmate();
      const { supervisor, repos } = setup(crewmate);
      await expect(
        supervisor.intake.commission({
          title: "Scratch PR",
          intent: intentOf("open a PR"),
          shape: { delivery_ask: "direct-pr" },
        }),
      ).rejects.toThrow(/managed repository/);
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      expect(repos.get(view.id)?.origin).toBeNull();
      await expect(
        supervisor.intake.commission({
          title: "Local PR",
          intent: intentOf("open a PR"),
          repoId: view.id,
          shape: { delivery_ask: "direct-pr" },
        }),
      ).rejects.toThrow(/remote/);
      expect(crewmate.promptCalls).toEqual([]);
      // Restating direct-pr needs a truthful approved address, just as its first choice does.
      const origin = scratchDir("delivery-override-origin-");
      execFileSync("git", ["-C", origin, "init", "--bare", "--initial-branch=main"], {
        env: hostEnv(),
      });
      execFileSync("git", ["-C", view.path, "remote", "add", "origin", origin], {
        env: hostEnv(),
      });
      repos.configure(view.id, { delivery: "direct-pr", origin });
      const restated = await supervisor.intake.commission({
        title: "Same posture",
        intent: intentOf("open a PR"),
        repoId: view.id,
        shape: { delivery_ask: "direct-pr" },
      });
      await tick();
      expect(supervisor.facts.taskDelivery(restated.taskId)).toBe("direct-pr");
    } finally {
      repo.dispose();
    }
  });

  it("escalates with the previous task's delivery_ask so the brief matches", async () => {
    const repo = gitRepo("meterlab");
    try {
      const crewmate = fakeCrewmate();
      const { supervisor, tasks, repos } = setup(crewmate, {
        routedModel: { provider: "openai-codex", id: "gpt-6-astra" },
      });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "direct-pr" });
      const previous = seedTask(tasks, {
        id: "attempt1",
        title: "Fix the meter",
        status: "completed",
        difficulty: "medium",
        repoId: view.id,
        worktreeDir: "/w/attempt1",
        branch: "fm/task-attempt1",
        shape: {
          kind: "fix",
          kind_source: "classifier:test",
          delivery_ask: "local-only",
        },
        outcome: "I disabled the assertion.",
      });
      const { taskId } = await supervisor.intake.commission({
        title: "Fix the meter",
        intent: intentOf("that is not a fix, try again"),
        repoId: view.id,
        shape: { escalate_from: previous.key },
      });
      await tick();
      expect(tasks.get(taskId)?.shape?.delivery_ask).toBe("local-only");
      expect(supervisor.facts.taskDelivery(taskId)).toBe("local-only");
      expect(crewmate.promptCalls[0]).toContain("Delivery: local-only");
      expect(crewmate.promptCalls[0]).not.toContain("Delivery: direct-pr");
    } finally {
      repo.dispose();
    }
  });

  it("treats every delivery_note as a refinement: only delivery_ask overrides the posture", async () => {
    const repo = gitRepo("meterlab");
    execFileSync("git", [
      "-C",
      repo.dir,
      "remote",
      "add",
      "origin",
      "https://example.com/owner/meterlab.git",
    ]);
    try {
      const asked = fakeCrewmate();
      const noted = fakeCrewmate();
      const { supervisor, tasks, repos } = setup(asked, { crewmates: [noted] });
      const { repo: view } = await repos.setup({ kind: "adopt", path: repo.dir, name: repo.name });
      repos.configure(view.id, { delivery: "local-only" });

      const asked_ = await supervisor.intake.commission({
        title: "PR this",
        intent: { goal: "g", userWords: "ship a PR" },
        repoId: view.id,
        shape: { delivery_ask: "direct-pr" },
      });
      await tick();
      expect(tasks.get(asked_.taskId)?.shape).toMatchObject({ delivery_ask: "direct-pr" });
      expect(supervisor.facts.taskDelivery(asked_.taskId)).toBe("direct-pr");
      expect(asked.promptCalls[0]).toContain("Delivery: direct-pr");

      // A note that happens to read like a posture is still only a note:
      // the posture-token convention went with `deliveryAskFromNote`.
      const refined = await supervisor.intake.commission({
        title: "Stack it",
        intent: {
          goal: "g",
          userWords: "stack on the open PR",
          deliveryNote: "direct-pr",
        },
        repoId: view.id,
      });
      await tick();
      expect(tasks.get(refined.taskId)?.shape?.delivery_ask).toBeUndefined();
      expect(supervisor.facts.taskDelivery(refined.taskId)).toBe("local-only");
      expect(noted.promptCalls[0]).toContain("Delivery: local-only");
      expect(noted.promptCalls[0]).toContain("Delivery note: direct-pr");
    } finally {
      repo.dispose();
    }
  });
});

// INF-799 piece 1, the captain's Approve and build on "Plan task-graph
// programs, typed results first": answer 4, the host checks a step's result
// and refuses a mismatch naming the first failing field; answer 3, a step
// delivers its branch and its typed result, and the next one branches from it.
describe("typed results and branch_from (INF-799 piece 1)", () => {
  const REAL_GIT_WAIT = { timeout: 20_000, interval: 25 };
  /** What a review program's finder hands on: the files it found and why. */
  const FINDINGS = {
    type: "object",
    required: ["files", "summary"],
    properties: {
      files: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
    },
  };
  const FOUND = {
    files: ["src/core/tasks/taskResult.ts", "src/core/orchestrator/intentBrief.ts"],
    summary: "Two modules render the result; neither caps its size.",
  };

  async function finder() {
    const crewmate = fakeCrewmate();
    const harness = setup(crewmate);
    const { taskId } = await harness.supervisor.intake.commission({
      title: "Find where results are rendered",
      intent: intentOf("Find where a typed result is rendered."),
      shape: { result_schema: FINDINGS },
    });
    await tick();
    /** The report tool's answer, a refusal's words included. */
    const report = async (declared?: Parameters<NonNullable<CrewmateSpec["onReport"]>>[2]) => {
      try {
        return await harness.specs[0]!.onReport!("Found the two renderers.", undefined, declared);
      } catch (error) {
        return (error as Error).message;
      }
    };
    return { ...harness, crewmate, taskId, report };
  }

  it("prints the result shape in the brief and refuses a report that misses or misfits it, naming the first failing field", async () => {
    const { crewmate, report } = await finder();
    expect(crewmate.promptCalls[0]).toContain(
      "Result shape: your report carries a typed result, the result field of the report tool",
    );
    expect(crewmate.promptCalls[0]).toContain(JSON.stringify(FINDINGS));
    expect(await report()).toContain("Report refused: result is missing.");
    expect(await report({ result: { files: [42], summary: FOUND.summary } })).toContain(
      "Report refused: result.files[0] ",
    );
    expect(await report({ result: { files: FOUND.files } })).toContain(
      "Report refused: result.summary is missing.",
    );
    // A report that hands the turn on to the first mate is taken without one.
    expect(await report({ needsFirstmate: "start the verifier" })).toContain("Reported.");
  });

  it("takes a report waiting on the captain without a result", async () => {
    const { report } = await finder();
    expect(await report({ wait: { reason: "He picks which renderer to cap." } })).toContain(
      "Reported.",
    );
  });

  it("keeps a fitting result on the report and the record, reads it by key, and carries it on the wake", async () => {
    const { crewmate, specs, tasks, ops, taskId, report } = await finder();
    expect(await report({ result: FOUND })).toContain("Reported.");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const event = tasks
      .timeline(taskId)
      .filter((entry) => entry.kind === "report")
      .at(-1);
    expect(event?.data).toMatchObject({ result: FOUND });
    const read = await specs[0]?.onQueryTasks?.({ key: tasks.get(taskId)?.key });
    expect(read?.rows[0]).toMatchObject({ result: FOUND, result_schema: FINDINGS });
    const wake = ops.find((line) => line.includes("reported on task")) ?? "";
    expect(wake).toContain(`${RESULT_WORDS} ${JSON.stringify(FOUND)}`);
  });

  it("prints a basis's result in the next brief, after its report", async () => {
    const { supervisor, tasks, crewmate, taskId, report } = await finder();
    await report({ result: FOUND });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    tasks.close(taskId, { status: "done", reason: "answered", actor: "host" });
    await supervisor.intake.commission({
      title: "Cap the rendered result",
      intent: intentOf("Cap what the brief renders."),
      shape: { basis: tasks.get(taskId)!.key },
    });
    await tick();
    expect(crewmate.promptCalls.at(-1)).toContain(
      `Found the two renderers.\n\n${RESULT_WORDS}\n${JSON.stringify(FOUND)}`,
    );
  });

  it("refuses a result shape without an object at its root, filing nothing", async () => {
    const { supervisor, tasks } = setup(fakeCrewmate());
    expect(() =>
      supervisor.intake.plan({
        title: "Count findings",
        intent: intentOf("Count them."),
        shape: { result_schema: { type: "array", items: { type: "string" } } },
      }),
    ).toThrow('result_schema must have an object at its root: give it "type": "object".');
    expect(tasks.list()).toHaveLength(0);
  });

  // Real git, so the same limit as the file's other real-git groups.
  describe("branch_from", { timeout: 60_000 }, () => {
    function git(dir: string, ...args: string[]) {
      return execFileSync(
        "git",
        ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
        { encoding: "utf8" },
      ).trim();
    }
    function projectRepo() {
      return gitRepo().dir;
    }

    /** A first stage that committed its migration on its branch. */
    async function firstStage() {
      const crewmate = fakeCrewmate();
      const harness = setup(crewmate, { realWorkspace: true });
      const { repo } = await harness.repos.setup({
        kind: "adopt",
        path: projectRepo(),
        name: "meterlab",
      });
      const { taskId } = await harness.supervisor.intake.commission({
        title: "Migrate the meter module",
        intent: intentOf("Migrate the meter module."),
        repoId: repo.id,
      });
      const first = await vi.waitFor(() => {
        const current = harness.tasks.get(taskId);
        if (!current?.worktreeDir || !existsSync(current.worktreeDir)) throw new Error("not yet");
        return current;
      }, REAL_GIT_WAIT);
      await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
      crewmate.finishPrompt();
      await vi.waitFor(
        () => expect(harness.tasks.get(taskId)?.activity).toBe("idle"),
        REAL_GIT_WAIT,
      );
      writeFileSync(join(first.worktreeDir, "meter.ts"), "export const meter = 2;\n");
      git(first.worktreeDir, "add", "meter.ts");
      git(first.worktreeDir, "commit", "-m", "refactor: migrate the meter");
      const head = git(first.worktreeDir, "rev-parse", "HEAD");
      return { ...harness, crewmate, repoId: repo.id, first, head };
    }

    async function startSecond(harness: Awaited<ReturnType<typeof firstStage>>, from: string) {
      const second = harness.supervisor.intake.plan({
        title: "Migrate the meter's callers",
        intent: intentOf("Migrate the callers."),
        repoId: harness.repoId,
        shape: { branch_from: from },
      });
      await harness.supervisor.starts.startQueuedNow(second.key);
      return vi.waitFor(() => {
        const current = harness.tasks.get(second.id);
        if (!current?.worktreeDir || !existsSync(current.worktreeDir)) throw new Error("not yet");
        return current;
      }, REAL_GIT_WAIT);
    }

    it("starts the next stage's working copy at the first stage's branch head", async () => {
      const harness = await firstStage();
      const { tasks, crewmate, first, head } = harness;
      const second = await startSecond(harness, first.id);
      expect(tasks.get(second.id)?.shape?.branch_from).toBe(first.key);
      expect(git(second.worktreeDir, "rev-parse", "HEAD")).toBe(head);
      await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(2), REAL_GIT_WAIT);
      expect(crewmate.promptCalls[1]).toContain(
        `Your working copy starts at ${first.key} "Migrate the meter module"'s last commit (${first.branch}), not at the default branch`,
      );
    });

    it("INF-1550: takes over a host-blocked branch without a merge or captain card, keeping the origin's evidence", async () => {
      const h = await firstStage();
      // The origin's own check evidence: a failed check at its committed version.
      h.tasks.delivery.recordChangeEvidence(h.first.id, {
        ciRepair: {
          failures: [{ headSha: h.head, checks: ["unit-tests"] }],
          diagnoses: [],
          repairs: [],
        },
      });
      h.tasks.turns.recordReport(h.first.id, {
        text: "The running host record blocks this task; use branch_from instead of waiting for an alpha.",
      });
      const original = h.tasks.get(h.first.id);
      const { taskId } = await h.supervisor.intake.commission({
        title: "Take over the blocked branch",
        intent: original?.intent ?? intentOf("Migrate the meter module."),
        repoId: h.repoId,
        shape: { branch_from: h.first.key },
      });
      const next = await vi.waitFor(() => {
        const task = h.tasks.get(taskId);
        if (!task?.worktreeDir || !existsSync(task.worktreeDir)) throw new Error("not started");
        return task;
      }, REAL_GIT_WAIT);
      await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(2), REAL_GIT_WAIT);
      expect(git(next.worktreeDir, "rev-parse", "HEAD")).toBe(h.head);
      expect(readFileSync(join(next.worktreeDir, "meter.ts"), "utf8")).toBe(
        "export const meter = 2;\n",
      );
      expect(h.tasks.get(h.first.id)?.delivery?.ciRepair).toEqual(original?.delivery?.ciRepair);
      expect(h.tasks.get(h.first.id)?.status).toBe("active");
      expect(h.supervisor.cards.snapshot()).toEqual([]);
      console.info(
        "[recovery] branch takeover:",
        JSON.stringify({
          original: h.first.key,
          takeover: next.key,
          sameCommittedWork: git(next.worktreeDir, "rev-parse", "HEAD") === h.head,
          originalEvidenceKept:
            JSON.stringify(h.tasks.get(h.first.id)?.delivery?.ciRepair) ===
            JSON.stringify(original?.delivery?.ciRepair),
          cards: h.supervisor.cards.snapshot().length,
        }),
      );
    });

    it("INF-1550 F9: runs the served spawn, file-steer and relationship tools for an immediate takeover", async () => {
      const h = await firstStage();
      // The origin's own check evidence: a failed check at its committed version.
      h.tasks.delivery.recordChangeEvidence(h.first.id, {
        ciRepair: {
          failures: [{ headSha: h.head, checks: ["unit-tests"] }],
          diagnoses: [],
          repairs: [],
        },
      });
      h.tasks.turns.recordReport(h.first.id, {
        text: "The host record refused further work; the committed meter change can continue in a fresh task.",
      });
      const original = h.tasks.get(h.first.id)!;
      const artifact = join(scratchDir("infinitary-takeover-reading-"), "host-reading.txt");
      writeFileSync(
        artifact,
        "The host record refused further work; the committed meter change is retained.\n",
      );
      const [kept] = await keepHandoverFiles([artifact], crewmateHandoverDir(h.paths, h.first.id));
      if (!kept) throw new Error("the source reading was not retained");
      const seat = fakeSessionFactory("pi");
      const firstmate = new FirstmateAgent({
        paths: h.paths,
        inbox: h.inbox,
        settings: new SettingsStore(h.db),
        modelRuntime: {} as ModelRuntime,
        availableModels: () => [{ provider: "fm-mock", id: "mock-1" }],
        quotaModels: () => undefined,
        quotaLine: () => "",
        repos: h.repos,
        supervisor: h.supervisor,
        tasks: h.tasks,
        broadcastEvent: () => {},
        selfSourceDir: join(h.paths.userData, "self-source"),
        seats: { pi: seat },
      });
      try {
        await firstmate.rebind("isolated-takeover");
        const tools = seat.specs[0]?.tools;
        const run = async (name: string, args: Record<string, unknown>) => {
          const tool = tools?.find((entry) => entry.name === name);
          if (!tool) throw new Error(`the production first mate did not serve ${name}`);
          const result = await tool.run(args);
          expect(result.details?.refusal).toBeUndefined();
          return result;
        };
        const title = "Take over: blocked meter branch";
        await run("spawn_crewmate", {
          title,
          goal: original.intent!.goal,
          user_words: original.intent!.userWords,
          constraints: [],
          repo_id: h.repoId,
          branch_from: h.first.key,
        });
        const next = await vi.waitFor(() => {
          const task = h.tasks.list().find((entry) => entry.title === title);
          if (!task?.worktreeDir || !existsSync(task.worktreeDir)) throw new Error("not started");
          return task;
        }, REAL_GIT_WAIT);
        await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(2), REAL_GIT_WAIT);
        await run("steer_crewmate", {
          task_id: next.id,
          message:
            "Continue the existing authorized meter change and inspect the retained host reading.",
          files_from: h.first.key,
        });
        await run("link_tasks", { from: h.first.key, to: next.key, type: "related" });
        // The old task waits for its successor, never the other way round.
        await run("link_tasks", { from: next.key, to: h.first.key, type: "blocks" });
        const delivered = join(crewmateTempDir(h.paths, next.id), "handover", kept.file);
        // The steer answers before the files cross, which they do next (INF-3060).
        await vi.waitFor(() => expect(existsSync(delivered)).toBe(true), REAL_GIT_WAIT);
        expect(readFileSync(delivered)).toEqual(readFileSync(artifact));
        expect(git(next.worktreeDir!, "rev-parse", "HEAD")).toBe(h.head);
        expect(readFileSync(join(next.worktreeDir!, "meter.ts"), "utf8")).toBe(
          "export const meter = 2;\n",
        );
        expect(h.tasks.graph.blockers(next.id)).toEqual([]);
        expect(h.tasks.graph.blockers(h.first.id).map((task) => task.id)).toContain(next.id);
        expect(h.tasks.graph.linksFrom(h.first.id)).toContainEqual(
          expect.objectContaining({ type: "related", fromId: h.first.id, toId: next.id }),
        );
        expect(h.tasks.get(h.first.id)).toMatchObject({
          status: "active",
          delivery: original.delivery,
        });
        expect(h.supervisor.cards.snapshot()).toEqual([]);
        console.info(
          "[recovery] served takeover tools:",
          JSON.stringify({
            started: next.status,
            committedWorkPreserved: git(next.worktreeDir!, "rev-parse", "HEAD") === h.head,
            handoverBytesPreserved: readFileSync(delivered).equals(readFileSync(artifact)),
            successorBlockers: h.tasks.graph.blockers(next.id).length,
            originWaitsForSuccessor: h.tasks.graph
              .blockers(h.first.id)
              .some((task) => task.id === next.id),
            captainCards: h.supervisor.cards.snapshot().length,
          }),
        );
      } finally {
        firstmate.dispose();
      }
    });

    it("starts at the kept ref once the first stage's working copy is gone", async () => {
      const harness = await firstStage();
      const { supervisor, tasks, first, head } = harness;
      await supervisor.sessions.interruptCrewmate(first.id, "cancel");
      await vi.waitFor(
        () => expect(tasks.get(first.id)?.workspaceState).not.toBe("present"),
        REAL_GIT_WAIT,
      );
      await harness.realWorkspace?.deletionsSettled();
      expect(existsSync(first.worktreeDir)).toBe(false);
      const second = await startSecond(harness, first.key);
      // The save is a commit on top of the branch's work, so that work is beneath it.
      expect(git(second.worktreeDir, "merge-base", "--is-ancestor", head, "HEAD")).toBe("");
      expect(readFileSync(join(second.worktreeDir, "meter.ts"), "utf8")).toBe(
        "export const meter = 2;\n",
      );
    });

    it("refuses an unknown task, another project's task, and a finished task with no work, filing nothing", async () => {
      const harness = await firstStage();
      const { supervisor, tasks, repos, repoId, first } = harness;
      const plan =
        (branch_from: string, project = repoId) =>
        () =>
          supervisor.intake.plan({
            title: "Migrate the callers",
            intent: intentOf("Migrate the callers."),
            repoId: project,
            shape: { branch_from },
          });
      expect(plan("INF-404")).toThrow('Unknown branch_from "INF-404"');
      const { repo: other } = await repos.setup({
        kind: "adopt",
        path: projectRepo(),
        name: "otherlab",
      });
      expect(plan(first.key, other.id)).toThrow(`branch_from ${first.key} is in another project`);
      const answered = supervisor.intake.plan({
        title: "Decide the callers' order",
        intent: intentOf("Decide it."),
        repoId,
      });
      tasks.close(answered.id, { status: "done", reason: "answered", actor: "host" });
      const count = tasks.list().length;
      expect(plan(answered.key)).toThrow(
        `branch_from ${answered.key} has no branch or saved work to start from`,
      );
      expect(tasks.list()).toHaveLength(count);
      // A spawn reads the same refusal, and spawns nothing.
      await expect(
        supervisor.intake.commission({
          title: "Migrate the callers now",
          intent: intentOf("Migrate the callers."),
          repoId,
          shape: { branch_from: "INF-404" },
        }),
      ).rejects.toThrow(`${NOTHING_SPAWNED} Unknown branch_from "INF-404"`);
      // A started task's shape is the one its crewmate was briefed with.
      expect(() => tasks.updateFields(first.id, { resultSchema: FINDINGS }, "firstmate")).toThrow(
        "A result shape or branch_from can only change on open work that has not started.",
      );
      expect(tasks.list()).toHaveLength(count);
    });
  });
});
