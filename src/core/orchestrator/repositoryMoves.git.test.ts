/**
 * A started task whose change lives in another repository of its project
 * moves there while it has no commits of its own (INF-6536 finding 1, the
 * captain's pick to build it). Each case drives a real CrewSupervisor
 * through the crew harness (tests/helpers/crewHarness.ts) on real git and
 * reads the record, the working copies and the crewmate's prompts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
} from "../../../tests/helpers/crewHarness";
import { gitRepo } from "../../../tests/helpers/crewHarnessGit";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

const REAL_GIT_WAIT = { timeout: 20_000, interval: 25 };

function git(dir: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args],
    { encoding: "utf8" },
  ).trim();
}

/** The repository a working copy belongs to, by its main folder. */
function repositoryOf(worktree: string): string {
  return realpathSync(join(git(worktree, "rev-parse", "--git-common-dir"), ".."));
}

/** A project of two repositories, and a task started in the app one, idle after its first turn. */
async function startedInAppRepository() {
  const crewmate = fakeCrewmate();
  const harness = setup(crewmate, { realWorkspace: true });
  const app = gitRepo("harbor-app");
  const relay = gitRepo("harbor-relay");
  const { repo: appRepo } = await harness.repos.setup({
    kind: "adopt",
    path: app.dir,
    name: "harbor-app",
  });
  const project = harness.tasks.projects.forRepo(appRepo.id);
  const { repo: relayRepo } = await harness.repos.setup({
    kind: "adopt",
    path: relay.dir,
    name: "harbor-relay",
    project: project?.key,
  });
  const { taskId } = await harness.supervisor.intake.commission({
    title: "Send card pushes to the new phone app",
    intent: intentOf("Send card pushes to the new phone app."),
    repoId: appRepo.id,
  });
  const first = await vi.waitFor(() => {
    const current = harness.tasks.get(taskId);
    if (!current?.worktreeDir || !existsSync(current.worktreeDir)) throw new Error("not yet");
    return current;
  }, REAL_GIT_WAIT);
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1), REAL_GIT_WAIT);
  crewmate.finishPrompt();
  await vi.waitFor(() => expect(harness.tasks.get(taskId)?.activity).toBe("idle"), REAL_GIT_WAIT);
  return { ...harness, crewmate, taskId, first, app, relay, appRepo, relayRepo };
}

describe("a started task moves to another repository of its project", () => {
  it("stops its crewmate, removes its empty working copy and starts it again in the named repository with its key", async () => {
    const { supervisor, tasks, crewmate, taskId, first, app, relay, relayRepo, realWorkspace } =
      await startedInAppRepository();
    expect(repositoryOf(first.worktreeDir)).toBe(realpathSync(app.dir));

    const outcome = await supervisor.repositoryMoves.move(taskId, "harbor-relay", "firstmate");

    expect(outcome).toEqual({
      ok: true,
      text: `Moved ${first.key} to the harbor-relay repository: its crewmate stopped, its empty working copy was removed, and it starts again there with its key, brief and the captain's consents.`,
    });
    await realWorkspace?.deletionsSettled();
    expect(existsSync(first.worktreeDir)).toBe(false);
    const again = await vi.waitFor(() => {
      const current = tasks.get(taskId);
      if (!current?.worktreeDir || !existsSync(current.worktreeDir)) throw new Error("not yet");
      return current;
    }, REAL_GIT_WAIT);
    expect(again).toMatchObject({ key: first.key, repoId: relayRepo.id, status: "active" });
    expect(repositoryOf(again.worktreeDir)).toBe(realpathSync(relay.dir));
    // A new conversation opened from the same brief.
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(2), REAL_GIT_WAIT);
    expect(crewmate.promptCalls[1]).toContain("Send card pushes to the new phone app.");
    expect(tasks.timeline(taskId).map((event) => event.text)).toContain(
      "Moved to the harbor-relay repository before its first commit; it starts again there",
    );
  });

  it("refuses a task with a commit of its own and changes nothing", async () => {
    const { supervisor, tasks, taskId, first, appRepo } = await startedInAppRepository();
    writeFileSync(join(first.worktreeDir, "relay.ts"), "export const relay = 1;\n");
    git(first.worktreeDir, "add", "relay.ts");
    git(first.worktreeDir, "commit", "-m", "feat: send pushes");

    const outcome = await supervisor.repositoryMoves.move(taskId, "harbor-relay", "firstmate");

    expect(outcome).toEqual({
      ok: false,
      text: `${first.key} has commits of its own, so it keeps its repository: only a task with none moves. A takeover in the harbor-relay repository carries its work.`,
    });
    expect(tasks.get(taskId)).toMatchObject({
      repoId: appRepo.id,
      status: "active",
      worktreeDir: first.worktreeDir,
    });
    expect(existsSync(first.worktreeDir)).toBe(true);
  });

  it("reads the working copy again once its crewmate stopped, and keeps an edit made as it stopped", async () => {
    const { supervisor, tasks, crewmate, taskId, first, appRepo } = await startedInAppRepository();
    const late = join(first.worktreeDir, "late.ts");
    const dispose = crewmate.dispose.getMockImplementation();
    crewmate.dispose.mockImplementation(() => {
      writeFileSync(late, "export const late = 1;\n");
      return dispose?.();
    });

    const outcome = await supervisor.repositoryMoves.move(taskId, "harbor-relay", "firstmate");

    expect(crewmate.dispose).toHaveBeenCalled();
    expect(outcome).toEqual({
      ok: false,
      text: `${first.key}'s crewmate stopped, but ${first.key} has edits of its own, so it keeps its repository: only a task with none moves. A takeover in the harbor-relay repository carries its work.`,
    });
    expect(existsSync(late)).toBe(true);
    expect(tasks.get(taskId)).toMatchObject({ repoId: appRepo.id, worktreeDir: first.worktreeDir });
  });

  it("answers a repository its project does not hold as a refusal and leaves the task where it is", async () => {
    const { supervisor, tasks, taskId, appRepo } = await startedInAppRepository();
    const project = tasks.projects.forRepo(appRepo.id);

    const outcome = await supervisor.repositoryMoves.move(taskId, "harbor-infra", "firstmate");

    // Which repositories the words list, and in what order, is moveTargetRepository's (taskService.graph.test.ts).
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(
      new RegExp(
        `^Refused: ${project?.name} holds no repository "harbor-infra"; its repositories are `,
      ),
    );
    expect(tasks.get(taskId)).toMatchObject({ repoId: appRepo.id, status: "active" });
  });
});
