/**
 * How the crew takes in new work (docs/task-record.md, docs/programs.md
 * "Filing a program"; `TaskIntake`). These cases pin the behaviour no other
 * test reaches: a commission's refusals before a row exists, a
 * start_after's waits, an escalation that queues, the task graph's drop
 * and carry-on, a parent that closes when everything under it has, and a
 * program declared on a plan. Each drives a public door of the supervisor or
 * its intake and reads the refusal, the receipt, the feed line and the
 * record.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HostChildSpawner } from "@core/host";
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { CrewMachines } from "../placed/crewMachines";
import { seedTask } from "../tasks/seedTask";
import { seedProject } from "../workspace/seedProject";
import { OUTSIDE_READER_WORDS, parseSpawnIntent, type SpawnIntent } from "./intentBrief";
import { OUTSIDE_READER_ANSWERS, OUTSIDE_READER_PROJECT } from "./workShape";

fakeCrewTimersEachTest();

/** A program process for a plan that is refused before anything spawns. */
const NEVER_SPAWNED: HostChildSpawner = {
  spawn: () => {
    throw new Error("a refused program never starts its process");
  },
};

/** The feed lines the supervisor broadcast, in order. */
function notes(events: { type: string; text?: string }[]): string[] {
  return events.flatMap((event) =>
    event.type === "firstmate_note" && event.text ? [event.text] : [],
  );
}

/** A supervisor with "meter", a project of the captain's that merges nothing. */
async function withProject(extras: Parameters<typeof setup>[1] = {}) {
  const h = setup(fakeCrewmate(), extras);
  const repo = seedProject(h.db, {
    id: "meter",
    name: "meter",
    path: join(h.paths.fleetDir, "meter"),
    setupKind: "init",
  });
  return { ...h, repo };
}

describe("new work", () => {
  it("refuses a commission whose shape cannot be met before any row exists", async () => {
    const h = await withProject();
    const personal = h.repos.ensurePersonal(scratchDir("infinitary-personal-"));
    seedTask(h.tasks, { id: "builder1", title: "Correct the meter", status: "running" });
    const commission = (repoId: string | undefined, shape: Record<string, unknown>) =>
      h.supervisor.intake.commission({
        title: "Read the meter",
        intent: intentOf("read what the meter shows"),
        ...(repoId ? { repoId } : {}),
        shape,
      });

    await expect(commission(h.repo.id, { review_of: "builder1", in_folder: true })).rejects.toThrow(
      "A review reads its builder's branch; omit in_folder.",
    );
    await expect(commission(undefined, { in_folder: true })).rejects.toThrow(
      "in_folder needs a project: pass the repo_id of the project whose folder the task works in.",
    );
    await expect(commission(personal.id, { in_folder: true })).rejects.toThrow(
      "The personal workspace already builds in place; omit in_folder.",
    );
    await expect(
      commission(h.repo.id, { in_folder: true, delivery_ask: "local-only" }),
    ).rejects.toThrow(
      "Folder work runs on the computer keeping meter's folder and ships nothing; omit delivery_ask.",
    );
    await expect(commission(h.repo.id, { runs_on_ask: "Basement Mac" })).rejects.toThrow(
      /^Nothing was spawned\./,
    );
    // Only the seeded builder is on the record: no refusal left a row behind.
    expect(h.tasks.list().map((row) => row.id)).toEqual(["builder1"]);
  });

  /**
   * INF-6388: an outside reader reads words strangers can write, so it only
   * answers, only in a project of the captain's other than the personal
   * workspace, and starts on this computer with a fenced session even when
   * the project's Runs on names another one (docs/agents-reach.md, "An
   * outside reader").
   */
  it("starts an outside reader only as a read-only answer in its own project, on this computer", async () => {
    const machines = {
      computers: () => ["mini-device"],
      ready: () => false,
      nameOf: () => "Mac mini",
      placeOf: () => ({ label: "Mac mini", where: "on the Mac mini" }),
      signInWait: () => undefined,
    } as unknown as CrewMachines;
    const crewmate = fakeCrewmate();
    const h = { ...setup(crewmate, { machines }) };
    const folder = join(h.paths.fleetDir, "meter");
    mkdirSync(join(folder, ".git"), { recursive: true });
    const repo = seedProject(h.db, { id: "meter", name: "meter", path: folder, setupKind: "init" });
    h.repos.configure(repo.id, { origin: "https://github.com/octo/meter.git" });
    h.repos.setRunsOn(repo.id, "mini-device");
    const personal = h.repos.ensurePersonal(scratchDir("infinitary-personal-"));
    const readOnly = {
      ...intentOf("read the waiting issues and say which are real"),
      constraints: [{ kind: "read-only" as const }],
    };
    const commission = (repoId: string | undefined, intent: SpawnIntent = readOnly) =>
      h.supervisor.intake.commission({
        title: "Read the waiting issues",
        intent,
        ...(repoId ? { repoId } : {}),
        shape: { outside_reader: true },
      });

    await expect(commission(undefined)).rejects.toThrow(OUTSIDE_READER_PROJECT);
    await expect(commission(personal.id)).rejects.toThrow(OUTSIDE_READER_PROJECT);
    await expect(commission(repo.id, intentOf("fix the waiting issues"))).rejects.toThrow(
      OUTSIDE_READER_ANSWERS,
    );
    expect(h.tasks.list()).toEqual([]);

    const { taskId } = await commission(repo.id);
    await tick();
    expect(h.tasks.get(taskId)?.shape).toMatchObject({
      deliverable: "answer",
      outside_reader: true,
    });
    expect(h.tasks.get(taskId)?.deviceId ?? null).toBeNull();
    const spec = h.specs.at(-1);
    expect(spec?.fenced).toBe(true);
    expect(spec?.onReadCard).toBeUndefined();
    expect(spec?.onQueryTasks).toBeUndefined();
    expect(h.sessionSpecs.at(-1)?.fenced).toBe(true);
    expect(crewmate.promptCalls.at(-1)).toContain(OUTSIDE_READER_WORDS);
  });

  it("refuses a start_after that names no task, no known allowance or nothing at all", async () => {
    const h = await withProject({ quotaGateRefValid: (ref) => ref === "bucket:high" });
    const queue = (startAfter: { afterTask?: string; whenQuotaResets?: string; at?: number }) =>
      h.supervisor.intake.commission({
        title: "Read the meter",
        intent: intentOf("read what the meter shows"),
        repoId: h.repo.id,
        startAfter,
      });

    await expect(queue({ afterTask: "NOPE-9" })).rejects.toThrow(
      'Unknown task "NOPE-9" in start_after. Use a task id from crew_status.',
    );
    // The refusal's wording is starts.classify.test.ts's; this case owns that it names the scope.
    await expect(queue({ whenQuotaResets: "openai" })).rejects.toThrow('"openai"');
    await expect(queue({})).rejects.toThrow(
      "start_after needs after_task, when_quota_resets, or at_time.",
    );
    expect(h.tasks.list()).toEqual([]);
  });

  it("queues a commission behind both its allowance or its time and the tasks it names", async () => {
    const h = await withProject({ quotaGateRefValid: () => true });
    const first = seedTask(h.tasks, { id: "first001", title: "Measure", status: "queued" });
    const second = seedTask(h.tasks, { id: "second01", title: "Calibrate", status: "queued" });

    const quota = await h.supervisor.intake.commission({
      title: "Read the meter",
      intent: intentOf("read what the meter shows"),
      repoId: h.repo.id,
      blockedBy: [first.key],
      startAfter: { afterTask: second.id, whenQuotaResets: "bucket:high" },
    });
    expect(quota.crewmate).toBe("queued");
    expect(h.tasks.get(quota.taskId)?.gate).toEqual({ kind: "quota-reset", ref: "bucket:high" });
    expect(h.tasks.graph.blockers(quota.taskId).map((row) => row.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(notes(h.events).at(-1)).toBe(
      'Queued "Read the meter" - starts when a high model has allowance again.',
    );

    const until = Date.UTC(2031, 0, 2, 3, 4);
    const timed = await h.supervisor.intake.commission({
      title: "Read it later",
      intent: intentOf("read what the meter shows later"),
      repoId: h.repo.id,
      startAfter: { afterTask: first.key, at: until },
    });
    expect(h.tasks.get(timed.taskId)?.gate).toEqual({ kind: "at-time", until });
    expect(h.tasks.graph.blockers(timed.taskId).map((row) => row.id)).toEqual([first.id]);
    expect(h.sessions.open).not.toHaveBeenCalled();
  });

  it("queues an escalation that waits, closing the attempt it replaces and linking the two", async () => {
    const h = await withProject();
    const previous = seedTask(h.tasks, {
      id: "attempt1",
      title: "Correct the meter",
      status: "idle",
      repoId: h.repo.id,
      difficulty: "medium",
      branch: "fm/task-attempt1",
      worktreeDir: "/w/attempt1",
    });

    const fresh = await h.supervisor.intake.commission({
      title: "Correct the meter again",
      intent: intentOf("correct the meter with a stronger model"),
      shape: { escalate_from: previous.key },
      startAfter: { at: Date.UTC(2031, 0, 2) },
    });
    await tick();

    expect(fresh.crewmate).toBe("queued");
    const row = h.tasks.get(fresh.taskId);
    // The lineage stays in the attempt's project.
    expect(row).toMatchObject({ status: "open", repoId: h.repo.id });
    expect(h.tasks.get(previous.id)).toMatchObject({
      status: "dropped",
      closedReason: "superseded",
    });
    expect(h.tasks.graph.discoveredOrigins(fresh.taskId).map((origin) => origin.id)).toEqual([
      previous.id,
    ]);
    expect(h.sessions.open).not.toHaveBeenCalled();
  });

  it("keeps the words the attempt was asked with when a stronger-model retry carries none (INF-1939)", async () => {
    const h = await withProject();
    const previous = seedTask(h.tasks, {
      id: "attempt2",
      title: "Correct the meter",
      status: "idle",
      repoId: h.repo.id,
      difficulty: "medium",
      intent: { goal: "The meter reads right", userWords: "correct the meter" },
    });
    const fresh = await h.supervisor.intake.commission({
      title: "Correct the meter again",
      intent: parseSpawnIntent({ goal: "The meter reads right" }),
      shape: { escalate_from: previous.key },
      startAfter: { at: Date.UTC(2031, 0, 2) },
    });
    const row = h.tasks.get(fresh.taskId);
    expect(row?.intent?.userWords).toBe("correct the meter");
    expect(row?.prompt).toMatch(/^The user's words, verbatim[^\n]*\ncorrect the meter\n\nGoal: /);
  });

  it("refuses to drop a closed task or a parent whose child has started, and drops a carried-on open task done", async () => {
    const h = await withProject();
    const closed = seedTask(h.tasks, { id: "closed01", title: "Old meter", status: "cancelled" });
    expect(h.supervisor.intake.dropTask(closed.key, { reason: "gone" })).toBe(
      `${closed.key} "Old meter" is already cancelled.`,
    );

    const parent = h.supervisor.intake.plan({
      title: "Rework the meter",
      intent: intentOf("rework the meter"),
      repoId: h.repo.id,
    });
    const child = seedTask(h.tasks, {
      id: "child001",
      title: "Rewire the gauge",
      status: "running",
      parentId: parent.id,
    });
    // The refusal's wording is intake.taskGraph.test.ts's; this case owns that it names the started child.
    expect(
      h.supervisor.intake.dropTask(parent.key, { reason: "changed course", confirm: true }),
    ).toContain(`${child.key} "Rewire the gauge"`);
    expect(h.tasks.get(parent.id)?.status).toBe("open");

    const planned = h.supervisor.intake.plan({
      title: "Label the meter",
      intent: intentOf("label the meter"),
      repoId: h.repo.id,
    });
    const carrier = h.supervisor.intake.plan({
      title: "Label every gauge",
      intent: intentOf("label every gauge"),
      repoId: h.repo.id,
    });
    expect(
      (
        await h.supervisor.settling.done.close(planned.key, {
          why: "carried_on",
          carriedBy: carrier.key,
        })
      ).text,
    ).toBe(`Closed ${planned.key} "Label the meter" as done: ${carrier.key} carries on its work.`);
    // INF-3169 piece 2: one close as done, its record reading the carrier, as a started task's does.
    expect(h.tasks.get(planned.id)).toMatchObject({ status: "done", closedReason: "superseded" });
    expect(h.tasks.graph.replacementOf(planned.id)).toBe(carrier.key);
  });

  it("leaves a parent whose children have all closed open while it has a card of its own, and closes it once the card goes", async () => {
    const h = await withProject();
    const carded = h.supervisor.intake.plan({
      title: "Carded parent",
      intent: intentOf("hold a card"),
      repoId: h.repo.id,
    });
    const kid = h.supervisor.intake.plan({
      title: "Its child",
      intent: intentOf("do the child's work"),
      repoId: h.repo.id,
      parent: carded.key,
    });
    const cardId = h.supervisor.addFirstmateCard({
      title: "Which meter?",
      body: "<p>Which meter does this rework?</p>",
      taskId: carded.id,
      actions: [
        { id: "gauge", label: "The gauge", default: true },
        { id: "dial", label: "The dial" },
      ],
    });
    h.tasks.close(kid.id, { status: "done", reason: "finished", actor: "host" });
    await h.supervisor.watch.sweepGates(Date.now());
    expect(h.tasks.get(carded.id)?.status).toBe("open");

    h.supervisor.closeCard(cardId, { kind: "firstmate" });
    await h.supervisor.watch.sweepGates(Date.now());
    expect(h.tasks.get(carded.id)).toMatchObject({ status: "done", closedReason: "finished" });
  });

  it("refuses a program on a plan this app cannot run, one that branches, or one whose script cannot be filed", async () => {
    const without = await withProject();
    const plan =
      (h: Awaited<ReturnType<typeof withProject>>, shape: Record<string, unknown>) => () =>
        h.supervisor.intake.plan({
          title: "Cap results",
          intent: intentOf("cap what the meter renders"),
          repoId: h.repo.id,
          shape,
        });
    expect(plan(without, { program: { script: "return 1;", bound: 1 } })).toThrow(
      "Nothing was filed. This app cannot run a program.",
    );

    const h = await withProject({ programProcess: NEVER_SPAWNED });
    const personal = h.repos.ensurePersonal(scratchDir("infinitary-personal-"));
    seedTask(h.tasks, {
      id: "source01",
      title: "Source",
      status: "completed",
      repoId: h.repo.id,
      branch: "fm/task-source01",
      worktreeDir: "/w/source01",
    });
    expect(() =>
      h.supervisor.intake.plan({
        title: "Cap results",
        intent: intentOf("cap what the meter renders"),
        repoId: personal.id,
        shape: { program: { script: "return 1;", bound: 1 } },
      }),
    ).toThrow("not the personal workspace");
    expect(
      plan(h, { program: { script: "return 1;", bound: 1 }, branch_from: "source01" }),
    ).toThrow(
      "Nothing was filed. A program has no working copy of its own; give branch_from to its parts.",
    );
    expect(plan(h, { program: { script: "const x = await import('fs');", bound: 1 } })).toThrow(
      "Nothing was filed. program.script imports code; a program has only task(), ask(), log(), phase() and args.",
    );
    expect(plan(h, { program: { script: "return 1;", bound: 0 } })).toThrow(
      "Nothing was filed. program.bound must be your proposed upper bound",
    );
    expect(h.tasks.list().map((row) => row.id)).toEqual(["source01"]);
  });
});
