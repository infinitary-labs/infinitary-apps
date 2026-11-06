import type { ComputerForges } from "@shared/signIns";
import { describe, expect, it, type MockInstance, vi } from "vitest";
import type { PlacedHome } from "../../../tests/helpers/placedHome";
import {
  adoptHere,
  CODEX_MEDIUM_STARTER,
  computerAccount,
  feed,
  GROK_THERE,
  gate,
  gitProject,
  model,
  placedWorldHooks,
  THIS_MAC_ON_CODEX,
  THIS_MAC_ON_NEWER_CODEX,
  world,
} from "../../../tests/helpers/placedWorld";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedTask } from "../tasks/seedTask";
import { git } from "../workspace/git";

/**
 * A task that runs on a computer that runs work (`tests/helpers/placedWorld.ts`):
 * a project's and a task's Runs on.
 */

// Integration budget (docs/test-cohorts.md): real git on the computer and
// here, the slowest test 1.28 s at its fastest of nineteen runs on an Apple
// silicon Mac, with git unclamped as below. A poll waits for work that
// crosses the connection and runs git on both sides - a closed task's
// working copy kept, brought home and deleted took 0.46 s alone and 1.7 s
// with sixteen copies of this file running at once - so it waits for the
// rest of the test's budget, never Vitest's 1 s (tests/helpers/waitWindow.ts).
vi.setConfig({ testTimeout: 10_000 });

// On a Mac the product runs every git below the UI (`taskpolicy -c
// utility`, utilityQos.ts), where it yields to every busier process. A case
// here runs up to about a hundred gits one after another, so on a Mac
// loaded by other runs it waited on that load rather than its own work and
// ran past its budget. This file is about placed tasks, not that clamp
// (utilityQos.test.ts holds it), so its git runs as on a Mac without
// taskpolicy, at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The home's one clock: the wall clock, moved on when a case waits out a backoff. */
let ahead = 0;
const now = () => Date.now() + ahead;
placedWorldHooks({
  now,
  reset: () => {
    ahead = 0;
  },
});

/**
 * Holds the home's next read of a computer - the models it serves, or its
 * own sign-ins - until the case releases it: a wait a queued task's start
 * makes on that computer before it claims the task.
 */
function holdNext(placed: PlacedHome["placed"], read: "served" | "signInsOf") {
  const reached = gate();
  const release = gate();
  const real = placed[read].bind(placed) as (machine: string) => Promise<unknown>;
  const spy = vi.spyOn(placed, read) as unknown as MockInstance<
    (machine: string) => Promise<unknown>
  >;
  spy.mockImplementationOnce(async (machine) => {
    reached.open();
    await release.held;
    return real(machine);
  });
  return { reached: reached.held, release: release.open };
}

describe("a project that runs on a computer that runs work", () => {
  it("waits for that computer, says so once and again after a day, and starts its next task there once it is back", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);

    // Out of reach: the task waits as queued work, placed there, and the
    // feed says so once however often the sweep looks.
    seedTask(home.tasks, { id: "t-next", title: "footer", status: "queued", repoId: repo.id });
    await home.supervisor.dispatchQueuedTask("t-next");
    await home.supervisor.dispatchQueuedTask("t-next");
    expect(home.tasks.get("t-next")).toMatchObject({
      status: "open",
      deviceId: at.deviceId,
      worktreeDir: "",
    });
    const waits = () => feed(home).filter((line) => line.includes("next task"));
    expect(waits()).toEqual([
      "home's next task waits for Builder. It never runs on this computer instead.",
    ]);
    expect(await home.supervisor.startQueuedNow("t-next")).toBe(
      `${home.tasks.get("t-next")?.key} "footer" waits for Builder, which is out of reach. It never runs on this computer instead.`,
    );
    expect(home.tasks.get("t-next")?.status).toBe("open");

    // A day later the feed says it once more, with the way to run it here.
    ahead += 24 * 60 * 60 * 1000;
    await home.supervisor.dispatchQueuedTask("t-next");
    await home.supervisor.dispatchQueuedTask("t-next");
    expect(waits().slice(1)).toEqual([
      "Running as Builder has been out of reach for a day. home's next task still waits.",
    ]);
    expect(feed(home)).toContain("To run it here instead, set home to run on this computer.");

    // Back: it starts there, in a working copy that computer made, and its
    // cards name where it runs.
    model([
      { tools: [{ name: "emit_card", args: { title: "Footer started", body: "<p>On it.</p>" } }] },
      { text: "Started on the footer." },
    ]);
    await home.listen();
    await at.inReach("t-next");
    // Its coming back runs the ready sweep, which starts the task.
    await home.supervisor.dispatchQueuedTask("t-next");
    await expect.poll(() => home.tasks.get("t-next")?.branch).toBe("fm/task-t-next");
    expect(home.tasks.get("t-next")).toMatchObject({
      status: "active",
      deviceId: at.deviceId,
      branch: "fm/task-t-next",
      worktreeDir: "",
    });
    expect(waits().at(-1)).toBe("home's next task started as Builder.");
    // Where it runs rides beside the task's title, never inside it, so a
    // long title gives way and the place stays whole.
    await expect
      .poll(() => home.cards().find((card) => card.title === "Footer started"))
      .toMatchObject({ meta: "footer", place: "as Builder" });
    expect(await git(at.folders("t-next").work, ["symbolic-ref", "--short", "HEAD"])).toBe(
      "fm/task-t-next",
    );

    // Moved back here: the started task stays there, and the next one starts here.
    home.repos.setRunsOn(repo.id, null);
    seedTask(home.tasks, { id: "t-after", title: "header", status: "queued", repoId: repo.id });
    await home.supervisor.dispatchQueuedTask("t-after");
    expect(home.tasks.get("t-next")?.deviceId).toBe(at.deviceId);
    expect(home.tasks.get("t-after")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-after")?.gate?.reason).toBe(
      "A placed task asked this Mac's workspace for createTaskWorktree.",
    );
  });

  it("queues a task commissioned while that computer is out of reach, and a task moved back here before it starts runs here", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);

    const { taskId, crewmate } = await home.supervisor.intake.commission({
      title: "footer",
      intent: { goal: "Make the footer blue.", userWords: "make the footer blue" },
      repoId: repo.id,
    });
    expect(crewmate).toBe("queued");
    expect(home.tasks.get(taskId)).toMatchObject({ status: "open", deviceId: at.deviceId });
    expect(feed(home)).toContain(
      "home's next task waits for Builder. It never runs on this computer instead.",
    );

    // The captain sets it to run here before it starts: it starts here.
    home.repos.setRunsOn(repo.id, null);
    await home.supervisor.dispatchQueuedTask(taskId);
    expect(home.tasks.get(taskId)?.deviceId ?? null).toBeNull();
    // This test's home keeps no working copies, so the start here is refused there.
    expect(home.tasks.get(taskId)?.gate?.reason).toBe(
      "A placed task asked this Mac's workspace for createTaskWorktree.",
    );
  });

  it("starts a project kept on this Mac only here, and refuses to move it", async () => {
    const at = await world();
    const home = at.home();
    const { repo } = await home.repos.setup({ kind: "init", name: "notes" });
    expect(() => home.repos.setRunsOn(repo.id, at.deviceId)).toThrow(
      "notes: Kept on this computer only, so its tasks run here.",
    );
    seedTask(home.tasks, { id: "t-notes", title: "notes", status: "queued", repoId: repo.id });
    await home.supervisor.dispatchQueuedTask("t-notes");
    // It started here: this test's home keeps no working copies of its own,
    // so this Mac's workspace refusing to make one is the start here.
    expect(home.tasks.get("t-notes")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-notes")?.gate?.reason).toBe(
      "A placed task asked this Mac's workspace for createTaskWorktree.",
    );
  });
});

/**
 * A project's Runs on (docs/helper.md, "Runs on"): the project's next task
 * starts on the computer it names, waits while that computer is out of
 * reach and says so once, and never runs here instead; moving the project
 * leaves a started task where it is.
 */

/**
 * The captain's word on where a filed task runs, as update_task's runs_on
 * carries it (the Firstmate's update delegate): refused in plain words, or
 * kept on the record, and the task and its parts that have not started go
 * there. Answers the refusal, or the change the record keeps.
 */
function askRunsOn(home: PlacedHome, taskId: string, ask: string | null): string {
  const refused = home.supervisor.placement.runsOnRefusal(taskId, ask);
  if (refused) return refused;
  const words = home.supervisor.placement.runsOnWords(taskId, ask);
  const changes = home.tasks.updateFields(taskId, { runsOn: { ask, words } }, "firstmate");
  home.supervisor.placement.runsOnChanged(taskId);
  return changes.join(", ");
}

/** The task's record, which the case knows exists. */
function recordOf(home: PlacedHome, taskId: string) {
  const record = home.tasks.get(taskId);
  if (!record) throw new Error(`No task ${taskId}`);
  return record;
}

/** Where this Mac's workspace refused to start a task here: this test's home keeps no working copies. */
const STARTED_HERE = "A placed task asked this Mac's workspace for createTaskWorktree.";

/**
 * A task's own Runs on (docs/helper.md, "A task's own Runs on"): the
 * captain tells Firstmate where one task runs, before it starts. It wins
 * over its project's Runs on, for the task and each part of it with none
 * of its own, and stays when the project moves.
 */
describe("a task's own Runs on", () => {
  // INF-1582: a named computer starts real placed work, not merely a queued row.
  it("starts work by computer name and keeps its stable device ID", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    model([
      {
        tools: [
          { name: "emit_card", args: { title: "Named computer started", body: "<p>On it.</p>" } },
        ],
      },
      { text: "Started on the named computer." },
    ]);
    const { taskId, crewmate } = await home.supervisor.intake.commission({
      title: "named footer",
      intent: { goal: "Make the footer blue.", userWords: "make the footer blue on Mac mini" },
      repoId: repo.id,
      shape: { runs_on_ask: "Mac mini" },
    });
    expect(crewmate).not.toBe("queued");
    await expect.poll(() => home.tasks.get(taskId)?.branch).toBe(`fm/task-${taskId}`);
    expect(home.tasks.get(taskId)).toMatchObject({
      status: "active",
      deviceId: at.deviceId,
      shape: expect.objectContaining({ runs_on_ask: at.deviceId }),
    });
    await expect
      .poll(() => home.cards().find((card) => card.title === "Named computer started"))
      .toMatchObject({ place: "as Builder" });
    console.log(
      "Named placement proof",
      JSON.stringify({
        selected: "Mac mini",
        storedComputer: home.tasks.get(taskId)?.deviceId,
        branch: home.tasks.get(taskId)?.branch,
        result: "The placed crewmate emitted its card.",
      }),
    );
  });

  it("starts a task on the computer the captain named while its project runs here, and its card says where", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    expect(home.repos.get(repo.id)?.runsOn).toBeNull();
    model([
      { tools: [{ name: "emit_card", args: { title: "Footer started", body: "<p>On it.</p>" } }] },
      { text: "Started on the footer." },
    ]);
    const { taskId, crewmate } = await home.supervisor.intake.commission({
      title: "footer",
      intent: { goal: "Make the footer blue.", userWords: "make the footer blue on the mini" },
      repoId: repo.id,
      shape: { runs_on_ask: at.deviceId },
    });
    expect(crewmate).not.toBe("queued");
    await expect.poll(() => home.tasks.get(taskId)?.branch).toBe(`fm/task-${taskId}`);
    expect(home.tasks.get(taskId)).toMatchObject({
      status: "active",
      deviceId: at.deviceId,
      worktreeDir: "",
    });
    await expect
      .poll(() => home.cards().find((card) => card.title === "Footer started"))
      .toMatchObject({ meta: "footer", place: "as Builder" });
    expect(home.supervisor.placement.runsOnFact(recordOf(home, taskId))).toEqual({
      label: "Running as Builder",
      source: "task",
    });
    // Started, it finishes there.
    expect(askRunsOn(home, taskId, "this-mac")).toBe(
      `${recordOf(home, taskId).key} "footer" has started, so it finishes where it started, as Builder.`,
    );

    // The project's next task, with nothing said, starts here as before.
    seedTask(home.tasks, { id: "t-here", title: "header", status: "queued", repoId: repo.id });
    expect(home.supervisor.placement.runsOnFact(recordOf(home, "t-here"))).toEqual({
      label: "This computer",
      source: "project",
    });
    await home.supervisor.dispatchQueuedTask("t-here");
    expect(home.tasks.get("t-here")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-here")?.gate?.reason).toBe(STARTED_HERE);
  });

  it("waits by its own name for the computer the captain named, stays when its project moves, and runs here once reset", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    seedTask(home.tasks, { id: "t-own", title: "footer", status: "queued", repoId: repo.id });
    seedTask(home.tasks, { id: "t-follows", title: "header", status: "queued", repoId: repo.id });

    expect(askRunsOn(home, "t-own", at.deviceId)).toBe("Runs on: Running as Builder (This task)");
    // The record keeps it, and the feed shows it as it shows a policy edit.
    expect(home.tasks.timeline("t-own").at(-1)).toMatchObject({
      actor: "firstmate",
      text: "updated: Runs on: Running as Builder (This task)",
      feed: true,
    });

    // Out of reach, it waits as queued work, and the feed names the task.
    await home.supervisor.dispatchQueuedTask("t-own");
    await home.supervisor.dispatchQueuedTask("t-own");
    expect(home.tasks.get("t-own")).toMatchObject({ status: "open", deviceId: at.deviceId });
    const waits = () => feed(home).filter((line) => line.includes('"footer"'));
    expect(waits()).toEqual([
      '"footer" waits for Builder. It never runs on this computer instead.',
    ]);
    expect(await home.supervisor.startQueuedNow("t-own")).toBe(
      `${recordOf(home, "t-own").key} "footer" waits for Builder, which is out of reach. It never runs on this computer instead.`,
    );
    ahead += 24 * 60 * 60 * 1000;
    await home.supervisor.dispatchQueuedTask("t-own");
    await home.supervisor.dispatchQueuedTask("t-own");
    expect(waits().slice(1)).toEqual([
      'Running as Builder has been out of reach for a day. "footer" still waits.',
      'To run it here instead, ask your first mate to run "footer" on this computer.',
    ]);

    // The project moves there and back: the captain's word stands, and the
    // task he said nothing about follows its project.
    home.repos.setRunsOn(repo.id, at.deviceId);
    expect(home.tasks.get("t-follows")?.deviceId).toBe(at.deviceId);
    home.repos.setRunsOn(repo.id, null);
    expect(home.tasks.get("t-follows")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-own")?.deviceId).toBe(at.deviceId);

    // project: it follows its project again, which runs here, and starts here.
    expect(askRunsOn(home, "t-own", null)).toBe("Runs on: This computer (Project setting)");
    expect(home.tasks.get("t-own")?.shape?.runs_on_ask).toBeUndefined();
    await home.supervisor.dispatchQueuedTask("t-own");
    expect(home.tasks.get("t-own")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-own")?.gate?.reason).toBe(STARTED_HERE);
  });

  it("keeps a task on this Mac when the captain says so while its project runs on the computer", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    seedTask(home.tasks, { id: "t-stays", title: "footer", status: "queued", repoId: repo.id });
    expect(home.supervisor.placement.runsOnFact(recordOf(home, "t-stays"))).toEqual({
      label: "Running as Builder",
      source: "project",
    });
    expect(askRunsOn(home, "t-stays", "this-mac")).toBe("Runs on: This computer (This task)");
    await home.supervisor.dispatchQueuedTask("t-stays");
    expect(home.tasks.get("t-stays")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-stays")?.gate?.reason).toBe(STARTED_HERE);
  });

  // Intent: INF-409's goal - a Runs on changed while a start waits on a
  // computer starts the task where it now runs, routed among that place's
  // own subscriptions, never with a route chosen for the computer it left.
  it("routes among this Mac's subscriptions and starts here when the captain runs it here while it waited for that computer's (INF-409)", async () => {
    // This Mac serves the starter map's medium Codex model, which routing
    // takes here; that computer's Codex account serves GPT-6 Sol alone.
    const at = await world(undefined, {
      routing: THIS_MAC_ON_NEWER_CODEX,
      signedInTo: [computerAccount("acct_codex_there", "openai-codex")],
      served: [
        {
          accountId: "acct_codex_there",
          models: [{ provider: "openai-codex", id: "gpt-6-sol", name: "GPT-6 Sol" }],
        },
      ],
    });
    const home = at.home();
    seedTask(home.tasks, {
      id: "t-moved",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      deviceId: at.deviceId,
    });
    const held = holdNext(home.placed, "served");
    const starting = home.supervisor.dispatchQueuedTask("t-moved");
    await held.reached;
    expect(askRunsOn(home, "t-moved", "this-mac")).toBe("Runs on: This computer (This task)");
    held.release();
    await starting;
    expect(home.decisions.latestRouting("t-moved")).toMatchObject({
      provider: "openai-codex",
      model: CODEX_MEDIUM_STARTER,
    });
    expect(home.tasks.get("t-moved")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-moved")?.gate?.reason).toBe(STARTED_HERE);
    // Nothing was tried there.
    expect(at.bound).toEqual([]);
    expect(at.holds()).toEqual({ tasks: [], workingCopies: [] });
  });

  it("is never held for that computer's GitHub sign-in once the captain runs it here while that computer's sign-ins were read (INF-409)", async () => {
    // That computer offers a GitHub sign-in from here and has none yet.
    const forges: ComputerForges = { hosts: [{ host: "github.com", name: "GitHub" }], signIns: [] };
    const at = await world(undefined, {
      routing: THIS_MAC_ON_CODEX,
      signedInTo: [computerAccount("acct_grok_there", "xai")],
      served: GROK_THERE,
      forges: () => forges,
    });
    const home = at.home();
    const project = await gitProject();
    await git(project.home, ["remote", "set-url", "origin", "https://github.com/octo/website.git"]);
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.setRunsOn(repo.id, at.deviceId);
    seedTask(home.tasks, {
      id: "t-github",
      title: "website",
      prompt: "Fix the footer.",
      status: "queued",
      repoId: repo.id,
    });
    const held = holdNext(home.placed, "signInsOf");
    const starting = home.supervisor.dispatchQueuedTask("t-github");
    await held.reached;
    expect(askRunsOn(home, "t-github", "this-mac")).toBe("Runs on: This computer (This task)");
    held.release();
    await starting;
    // Tried here, never held behind that computer's own GitHub sign-in
    // (whose wait its project, still set to run there, says by itself).
    expect(home.tasks.get("t-github")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-github")?.gate?.reason).toBe(STARTED_HERE);
    expect(at.holds()).toEqual({ tasks: [], workingCopies: [] });
  });

  it("gives each part its parent's Runs on unless the part has its own", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    const queued = { status: "queued", repoId: repo.id, startPolicy: "on-request" } as const;
    seedTask(home.tasks, { id: "t-parent", title: "site", ...queued });
    seedTask(home.tasks, { id: "t-part", title: "footer", parentId: "t-parent", ...queued });
    seedTask(home.tasks, { id: "t-own-part", title: "header", parentId: "t-parent", ...queued });

    expect(askRunsOn(home, "t-own-part", "this-mac")).toBe("Runs on: This computer (This task)");
    expect(askRunsOn(home, "t-parent", at.deviceId)).toBe(
      "Runs on: Running as Builder (This task)",
    );
    expect(home.tasks.get("t-part")?.deviceId).toBe(at.deviceId);
    expect(home.tasks.get("t-own-part")?.deviceId ?? null).toBeNull();
    expect(home.supervisor.placement.runsOnFact(recordOf(home, "t-part"))).toEqual({
      label: "Running as Builder",
      source: "parent",
    });
    expect(home.supervisor.placement.runsOnFact(recordOf(home, "t-own-part"))).toEqual({
      label: "This computer",
      source: "task",
    });

    // A part commissioned under it later waits for the same computer.
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    const { taskId, crewmate } = await home.supervisor.intake.commission({
      title: "nav",
      intent: { goal: "Fix the nav.", userWords: "fix the nav" },
      repoId: repo.id,
      parent: "t-parent",
    });
    expect(crewmate).toBe("queued");
    expect(home.tasks.get(taskId)?.deviceId).toBe(at.deviceId);
  });

  it("forgets the captain's word for a computer being removed, so the task and its parts follow the project", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    const queued = { status: "queued", repoId: repo.id, startPolicy: "on-request" } as const;
    seedTask(home.tasks, { id: "t-parent", title: "site", ...queued });
    seedTask(home.tasks, { id: "t-part", title: "footer", parentId: "t-parent", ...queued });
    askRunsOn(home, "t-parent", at.deviceId);
    expect(home.tasks.get("t-part")?.deviceId).toBe(at.deviceId);

    await home.supervisor.stopTasksOn(at.deviceId);
    expect(home.tasks.get("t-parent")?.shape?.runs_on_ask).toBeUndefined();
    expect(home.tasks.get("t-parent")?.deviceId ?? null).toBeNull();
    expect(home.tasks.get("t-part")?.deviceId ?? null).toBeNull();
    expect(home.tasks.timeline("t-parent").at(-1)?.text).toBe(
      "Runs on: the computer it named was removed, so it runs where its parent or project says",
    );
  });

  it("keeps the captain's word on where a task runs through Start again and a stronger-model retry", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)));
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    const own = { kind: "fix", runs_on_ask: at.deviceId } as const;

    seedTask(home.tasks, {
      id: "t-dropped",
      title: "footer",
      status: "cancelled",
      repoId: repo.id,
      shape: own,
    });
    const again = home.supervisor.startAgain("t-dropped");
    if (!again.ok) throw new Error(again.text);
    expect(again.task.shape?.runs_on_ask).toBe(at.deviceId);
    expect(await again.started).toContain("waits for Builder, which is out of reach");
    expect(home.tasks.get(again.task.id)).toMatchObject({ status: "open", deviceId: at.deviceId });

    seedTask(home.tasks, {
      id: "t-tried",
      title: "header",
      status: "completed",
      outcome: "Made the header blue.",
      repoId: repo.id,
      shape: own,
    });
    const retry = await home.supervisor.intake.commission({
      title: "header",
      intent: { goal: "Make the header blue.", userWords: "not good enough, try a stronger one" },
      shape: { escalate_from: "t-tried" },
    });
    expect(retry.crewmate).toBe("queued");
    expect(home.tasks.get(retry.taskId)).toMatchObject({
      repoId: repo.id,
      deviceId: at.deviceId,
      shape: expect.objectContaining({ runs_on_ask: at.deviceId }),
    });
  });

  it("refuses in plain words a started task, the personal workspace, a project kept here, a review, a task with no project and a computer that runs no work", async () => {
    const project = await gitProject();
    const at = await world();
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    const { repo: notes } = await home.repos.setup({ kind: "init", name: "notes" });
    const personal = home.repos.ensurePersonal(scratchDir("infinitary-placed-personal-"));
    const refusal = (id: string, ask: string | null = at.deviceId) =>
      home.supervisor.placement.runsOnRefusal(id, ask)?.replace(recordOf(home, id).key, "KEY");

    seedTask(home.tasks, { id: "t-going", title: "footer", status: "running", repoId: repo.id });
    expect(refusal("t-going")).toBe(
      'KEY "footer" has started, so it finishes where it started, on this computer.',
    );
    expect(refusal("t-going", null)).toBe(
      'KEY "footer" has started, so it finishes where it started, on this computer.',
    );
    seedTask(home.tasks, { id: "t-panel", title: "panel", status: "queued", repoId: personal.id });
    expect(refusal("t-panel")).toBe(
      'KEY "panel" builds in your personal workspace, which stays on this computer.',
    );
    seedTask(home.tasks, { id: "t-notes", title: "notes", status: "queued", repoId: notes.id });
    expect(refusal("t-notes")).toBe(
      'KEY "notes" is in notes. Kept on this computer only, so its tasks run here.',
    );
    seedTask(home.tasks, {
      id: "t-review",
      title: "review",
      status: "queued",
      repoId: repo.id,
      shape: { kind: "review" },
    });
    expect(refusal("t-review")).toBe(
      'KEY "review" is a review and follows its builder\'s computer; its location cannot be chosen separately.',
    );
    seedTask(home.tasks, { id: "t-loose", title: "loose", status: "queued" });
    expect(refusal("t-loose")).toBeUndefined();
    expect(refusal("t-loose", "a-mac-that-only-controls")).toBe(
      "No computer that runs work has that deviceId. Look with app_state.",
    );
    seedTask(home.tasks, { id: "t-fine", title: "fine", status: "queued", repoId: repo.id });
    expect(refusal("t-fine", "a-mac-that-only-controls")).toBe(
      "No computer that runs work has that deviceId. Look with app_state.",
    );
    expect(refusal("t-fine")).toBeUndefined();
    expect(refusal("t-fine", "this-mac")).toBeUndefined();
    expect(refusal("t-fine", null)).toBeUndefined();

    // Asked at the spawn, a refusal starts nothing.
    const before = home.tasks.list().length;
    await expect(
      home.supervisor.intake.commission({
        title: "notes",
        intent: { goal: "Tidy the notes.", userWords: "tidy the notes on the mini" },
        repoId: notes.id,
        shape: { runs_on_ask: at.deviceId },
      }),
    ).rejects.toThrow(
      'Nothing was spawned. "notes" is in notes. Kept on this computer only, so its tasks run here.',
    );
    await expect(
      home.supervisor.intake.commission({
        title: "review",
        intent: { goal: "Review the footer.", userWords: "review the footer on the mini" },
        repoId: repo.id,
        shape: { review_of: "t-going", runs_on_ask: at.deviceId },
      }),
    ).rejects.toThrow(
      "Nothing was spawned. A review follows its builder's computer; omit runs_on_ask.",
    );
    expect(home.tasks.list()).toHaveLength(before);
  });
});
