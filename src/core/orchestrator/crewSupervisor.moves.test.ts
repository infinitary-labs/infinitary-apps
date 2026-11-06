/**
 * How the crew supervisor moves a started task (docs/helper.md, "Moving a
 * started task"; INF-849 for a move to another provider): where a task
 * could move now and why each other computer cannot take it, the refusals
 * a move to a computer or a provider meets before anything is written, a
 * move cancelled before it crosses, and the move facts a task's record
 * shows. INF-2625's plan, the crew supervisor's eighth step, moves this
 * code out of the supervisor into an owner of its own; these cases pin,
 * before it moves, the behaviour no other test reaches. The move itself,
 * carrying real work between computers, stays pinned by the real-git
 * journey in crewSupervisor.test.ts. Each case drives a public door of the
 * supervisor and reads its answer and the record.
 */

import { HERE } from "@shared/deviceNames";
import type { ComputerMove } from "@shared/placement";
import { moveOutOfReach } from "@shared/recordBar";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import type { WorkShape } from "@shared/routingPolicy";
import { describe, expect, it, vi } from "vitest";
import { fakeCrewmate, intentOf, setup, tick } from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { CrewMachines } from "../placed/crewMachines";
import type { TaskRecord } from "../storage/taskStore";
import { seedTask } from "../tasks/seedTask";
import { describeStatus } from "./settleService";

const MINI = "mini-device";
const AIR = "air-device";
const OLD = "old-device";
const AWAY = "away-device";
const NAMES: Record<string, string> = {
  [MINI]: "Studio Mac mini",
  [AIR]: "Travel MacBook Air",
  [OLD]: "Office iMac",
  [AWAY]: "Spare MacBook Pro",
};
const CODEX = { provider: "openai-codex", id: "gpt-6.1-sol" };

/**
 * Four computers that run work: the Mac mini takes the task, the MacBook
 * Air has no account that serves its model, the iMac runs a version that
 * cannot take a started task, and the MacBook Pro is out of reach, so its
 * version cannot be read either. Nothing here crosses: `moveIn` is never
 * reached by a refusal.
 */
function computers() {
  const moveIn = vi.fn(async () => {
    throw new Error("a refused move never crosses");
  });
  const machines = {
    computers: () => [MINI, AIR, OLD, AWAY],
    ready: (id: string) => id !== AWAY,
    takesMoves: (id: string) => id !== OLD && id !== AWAY,
    nameOf: (id: string) => NAMES[id],
    served: async (id: string) => ({
      accounts: { has: () => id === MINI },
      modelAccounts: { has: () => id === MINI },
    }),
    moveIn,
  } as unknown as CrewMachines;
  return { machines, moveIn };
}

/** A supervisor over those computers, with "meter", a project of the captain's. */
async function withComputers() {
  const { machines, moveIn } = computers();
  const h = setup(fakeCrewmate(), { machines });
  const { repo } = await h.repos.setup({ kind: "init", name: "meter" });
  return { ...h, repo, moveIn };
}

/** A started task with a working copy of its own, idle between turns. */
function started(
  h: Awaited<ReturnType<typeof withComputers>>,
  id: string,
  fields: {
    shape?: WorkShape;
    deviceId?: string;
    repoId?: string;
    status?: "completed" | "queued" | "cancelled";
  } = {},
): TaskRecord {
  return seedTask(h.tasks, {
    id,
    title: "Fix the meter",
    repoId: fields.repoId ?? h.repo.id,
    branch: `fm/task-${id}`,
    worktreeDir: `/work/${id}`,
    sessionFile: `/sessions/${id}.jsonl`,
    model: CODEX,
    status: fields.status ?? "completed",
    ...(fields.shape ? { shape: fields.shape } : {}),
    ...(fields.deviceId ? { deviceId: fields.deviceId } : {}),
  });
}

/** The record's handle in the supervisor's refusals. */
function handle(record: TaskRecord | undefined): string {
  return `${record?.key || record?.id} "${record?.title}"`;
}

function move(fields: Partial<ComputerMove>): ComputerMove {
  return { from: RUNS_ON_THIS_MAC, to: MINI, by: "captain", at: 1, phase: "waiting", ...fields };
}

describe("a started task's move, before it moves out of the crew supervisor", () => {
  it("lists every other computer a task could move to, each with why it cannot take it", async () => {
    const h = await withComputers();
    started(h, "t1");

    expect(await h.supervisor.moveOptions("t1")).toEqual({
      ok: true,
      from: HERE.this,
      destinations: [
        { id: MINI, name: "Studio Mac mini" },
        {
          id: AIR,
          name: "Travel MacBook Air",
          unavailable: "Travel MacBook Air has no signed-in account that serves gpt-6.1-sol.",
        },
        {
          id: OLD,
          name: "Office iMac",
          unavailable: "Infinitary on Office iMac cannot take a started task yet. Update it first.",
        },
        { id: AWAY, name: "Spare MacBook Pro", unavailable: moveOutOfReach("Spare MacBook Pro") },
      ],
    });
    expect(await h.supervisor.moveOptions("nope")).toEqual({
      ok: false,
      text: 'Unknown task "nope".',
    });
  });

  it("refuses to move a task with nothing of its own to carry, in each task's own words", async () => {
    const h = await withComputers();
    const personal = h.repos.ensurePersonal(scratchDir("infinitary-personal-"));
    const queued = started(h, "queued", { status: "queued" });
    const dropped = started(h, "dropped", { status: "cancelled" });
    // A conversation but no branch: nothing of its own to carry.
    const bare = seedTask(h.tasks, {
      id: "bare",
      title: "Read the meter",
      repoId: h.repo.id,
      sessionFile: "/sessions/bare.jsonl",
      status: "completed",
    });
    const mine = started(h, "mine", { repoId: personal.id });
    const folder = started(h, "folder", {
      shape: { kind: "implement", in_place: { folder: true } },
    });
    const review = started(h, "review", { shape: { kind: "review" } });
    const refusals: Record<string, string> = {
      queued: `${handle(queued)} is ${describeStatus(queued)}; only started work moves to another computer.`,
      dropped: `${handle(dropped)} is ${describeStatus(dropped)}; only started work moves to another computer.`,
      bare: `${handle(bare)} has no working copy of its own to move.`,
      mine: `${handle(mine)} builds in your personal workspace, which stays on ${HERE.this}.`,
      folder: `${handle(folder)} works in its project's own folder, which stays where it is.`,
      review: `${handle(review)} is a review and follows its builder's computer.`,
    };

    for (const [id, text] of Object.entries(refusals)) {
      expect(await h.supervisor.moveOptions(id)).toEqual({ ok: false, text });
      expect(await h.supervisor.requestComputerMove(id, MINI, "captain")).toEqual({
        ok: false,
        text,
      });
    }
    // No refusal wrote a move or reached a computer.
    expect(h.tasks.list().some((record) => record.shape?.computer_move)).toBe(false);
    expect(h.moveIn).not.toHaveBeenCalled();
  });

  it("refuses to move a task that is moving, still finishing a move, or on a computer that cannot let it go", async () => {
    const h = await withComputers();
    const waiting = started(h, "waiting");
    h.tasks.placement.setComputerMove("waiting", move({ phase: "waiting" }), {
      text: "the captain asked to move it",
      actor: "captain",
    });
    const finishing = started(h, "finishing");
    h.tasks.placement.setComputerMove("finishing", move({ phase: "retiring" }), {
      text: "it moved",
      actor: "captain",
    });
    const onOld = started(h, "on-old", { deviceId: OLD });
    const onAway = started(h, "on-away", { deviceId: AWAY });

    expect(await h.supervisor.moveOptions("waiting")).toEqual({
      ok: false,
      text: `${handle(waiting)} is already moving to Studio Mac mini.`,
    });
    expect(await h.supervisor.moveOptions("finishing")).toEqual({
      ok: false,
      text: `${handle(finishing)} is still finishing its last move; try again once it has.`,
    });
    expect(await h.supervisor.moveOptions("on-old")).toEqual({
      ok: false,
      text: "Infinitary on Office iMac cannot move a started task yet. Update it first.",
    });
    expect(await h.supervisor.moveOptions("on-away")).toEqual({
      ok: false,
      text: moveOutOfReach("Spare MacBook Pro"),
    });
    // The record shows the standing move and its pause, and nothing for a task that cannot move.
    expect(h.supervisor.computerMoveFacts(h.tasks.get("waiting") as TaskRecord)).toEqual({
      computerMove: { from: HERE.this, to: "Studio Mac mini", state: "waiting", waitingFor: [] },
    });
    expect(h.supervisor.computerMoveFacts(onOld)).toEqual({});
    expect(h.supervisor.computerMoveFacts(onAway)).toEqual({});
  });

  it("refuses a move to a computer it cannot name, to Automatic, to where it runs, or that keeps files outside its copy", async () => {
    const h = await withComputers();
    const record = started(h, "t1");
    const ask = (to: string, keep: string[] = []) =>
      h.supervisor.requestComputerMove("t1", to, "firstmate", keep);

    expect(await ask("Basement Mac")).toMatchObject({ ok: false });
    expect(await ask("automatic")).toEqual({
      ok: false,
      text: `Name the computer ${handle(record)} moves to.`,
    });
    expect(await ask(RUNS_ON_THIS_MAC)).toEqual({
      ok: false,
      text: `${handle(record)} already runs on ${HERE.this}.`,
    });
    for (const outside of ["/etc/hosts", "..", "../elsewhere/.env"])
      expect(await ask(MINI, [outside])).toEqual({
        ok: false,
        text: `${handle(record)} cannot move: ${outside} is outside its working copy; keep names files in it.`,
      });
    expect(await ask(AIR)).toEqual({
      ok: false,
      text: `${handle(record)} cannot move: Travel MacBook Air has no signed-in account that serves gpt-6.1-sol.`,
    });
    expect(await ask(AWAY)).toEqual({
      ok: false,
      text: `${handle(record)} cannot move: ${moveOutOfReach("Spare MacBook Pro")}`,
    });
    expect(await h.supervisor.requestComputerMove("nope", MINI, "captain")).toEqual({
      ok: false,
      text: 'Unknown task "nope".',
    });
    // Nothing was written: the task may still move, and stands on no move.
    expect(h.tasks.get("t1")?.shape?.computer_move).toBeUndefined();
    expect(h.supervisor.computerMoveFacts(h.tasks.get("t1") as TaskRecord)).toEqual({
      movable: true,
    });
    expect(h.moveIn).not.toHaveBeenCalled();
  });

  it("cancels only a move still waiting for its pause, and says why it cannot cancel any other", async () => {
    const h = await withComputers();
    const record = started(h, "t1");
    expect(h.supervisor.cancelComputerMove("t1", "captain")).toEqual({
      ok: false,
      text: `${handle(record)} is not moving to another computer.`,
    });
    h.tasks.placement.setComputerMove("t1", move({ phase: "undoing" }), {
      text: "its move did not finish",
      actor: "host",
    });
    expect(h.supervisor.cancelComputerMove("t1", "captain")).toEqual({
      ok: false,
      text: `${handle(record)} is not moving to another computer.`,
    });
    // A move that did not finish shows nothing on the record while its copy goes.
    expect(h.supervisor.computerMoveFacts(h.tasks.get("t1") as TaskRecord)).toEqual({});
    h.tasks.placement.setComputerMove(
      "t1",
      move({ phase: "moving", problem: "the disk is full" }),
      {
        text: "it is moving",
        actor: "host",
      },
    );
    expect(h.supervisor.cancelComputerMove("t1", "firstmate")).toEqual({
      ok: false,
      text: `${handle(record)} is already moving to Studio Mac mini, so the move can no longer be cancelled.`,
    });
    expect(h.supervisor.computerMoveFacts(h.tasks.get("t1") as TaskRecord)).toEqual({
      computerMove: {
        from: HERE.this,
        to: "Studio Mac mini",
        state: "moving",
        waitingFor: [],
        problem: "the disk is full",
      },
    });
    h.tasks.placement.setComputerMove("t1", move({ phase: "waiting" }), {
      text: "the first mate asked to move it",
      actor: "firstmate",
    });
    expect(h.supervisor.cancelComputerMove("t1", "firstmate")).toEqual({
      ok: true,
      text: `${handle(record)} stays on ${HERE.this}.`,
    });
    expect(h.tasks.get("t1")?.shape?.computer_move).toBeUndefined();
    expect(h.tasks.timeline("t1").at(-1)).toMatchObject({
      actor: "firstmate",
      text: `the first mate cancelled its move to Studio Mac mini; it stays on ${HERE.this}`,
    });
    expect(h.supervisor.cancelComputerMove("nope", "captain")).toEqual({
      ok: false,
      text: 'Unknown task "nope".',
    });
  });

  it("shows no move on a started task when no other computer runs work", async () => {
    const h = setup(fakeCrewmate());
    const record = seedTask(h.tasks, {
      id: "t1",
      title: "Fix the meter",
      branch: "fm/task-t1",
      sessionFile: "/sessions/t1.jsonl",
      status: "completed",
    });
    expect(h.supervisor.computerMoveFacts(record)).toEqual({});
    expect(await h.supervisor.moveOptions("t1")).toEqual({
      ok: true,
      from: HERE.this,
      destinations: [],
    });
  });

  it("refuses a move to another provider before it reroutes anything", async () => {
    const copilot = { provider: "github-copilot", id: "gpt-5.1" };
    const crewmate = fakeCrewmate({ model: copilot });
    const h = setup(crewmate, {
      routedModel: copilot,
      // Grok cannot take it, Copilot is where it runs, and anything else picks Codex.
      movePick: (shape) =>
        shape.override_model_id === "xai/grok-5"
          ? undefined
          : shape.override_model_id === "github-copilot/gpt-5.1"
            ? copilot
            : { provider: "openai-codex", id: "gpt-6.1-sol" },
    });
    const queued = seedTask(h.tasks, { id: "queued", title: "Read the meter", status: "queued" });
    const elsewhere = seedTask(h.tasks, {
      id: "elsewhere",
      title: "Mend the meter",
      status: "completed",
      model: copilot,
      deviceId: MINI,
    });
    const { taskId } = await h.supervisor.commission({ title: "t", intent: intentOf("work") });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    const record = h.tasks.get(taskId);

    expect(h.supervisor.requestMove("nope", { by: "captain" })).toEqual({
      ok: false,
      text: 'Unknown task "nope".',
    });
    const notStarted = h.supervisor.requestMove("queued", { by: "captain" });
    expect(notStarted).toEqual({
      ok: false,
      text: `${handle(queued)} is ${describeStatus(queued)}; only started work moves.`,
    });
    expect(h.supervisor.requestMove("elsewhere", { by: "captain" })).toEqual({
      ok: false,
      text: `${handle(elsewhere)} runs on another computer, so it stays on that computer's own subscriptions.`,
    });
    expect(h.supervisor.requestMove(taskId, { by: "firstmate", model: "xai/grok-5" })).toEqual({
      ok: false,
      text: `xai/grok-5 cannot take ${handle(record)} now, so it stays where it runs.`,
    });
    expect(
      h.supervisor.requestMove(taskId, { by: "firstmate", model: "github-copilot/gpt-5.1" }),
    ).toEqual({
      ok: false,
      text: `${handle(record)} already runs on github-copilot/gpt-5.1.`,
    });
    // A move asked mid-turn waits for the turn to end.
    const asked = h.supervisor.requestMove(taskId, { by: "captain" });
    expect(asked.ok).toBe(true);
    expect(asked.text).toContain("once its crewmate's turn ends");
    // Nothing moved: the record keeps its model and the turn was never cut.
    expect(h.tasks.get(taskId)?.model).toBe("github-copilot/gpt-5.1");
    expect(crewmate.aborts).toEqual([]);
    await tick();
  });

  it("says on the timeline and the feed when a move between turns cannot reopen the task", async () => {
    const copilot = { provider: "github-copilot", id: "gpt-5.1" };
    const crewmate = fakeCrewmate({ model: copilot });
    const h = setup(crewmate, {
      routedModel: copilot,
      movePick: () => ({ provider: "openai-codex", id: "gpt-6.1-sol" }),
    });
    const { taskId } = await h.supervisor.commission({ title: "t", intent: intentOf("work") });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    crewmate.finishPrompt();
    await tick();
    h.sessions.open.mockRejectedValueOnce(new Error("Codex did not answer"));
    expect(h.supervisor.requestMove(taskId, { by: "captain" }).ok).toBe(true);
    await vi.waitFor(() =>
      expect(h.events).toContainEqual({
        type: "firstmate_note",
        text: "Task t could not move: Codex did not answer",
        taskId,
      }),
    );
    expect(h.tasks.timeline(taskId).map((event) => event.text)).toContain(
      "its move could not reopen it: Codex did not answer",
    );
    // The record names where it moved; it reopens there when next asked.
    expect(h.tasks.get(taskId)?.model).toBe("openai-codex/gpt-6.1-sol");
  });

  it("refuses a move to another provider for a task that names none to move off", async () => {
    const h = setup(fakeCrewmate());
    const record = seedTask(h.tasks, { id: "bare", title: "Check the meter", status: "completed" });
    expect(h.supervisor.requestMove("bare", { by: "firstmate" })).toEqual({
      ok: false,
      text: `${handle(record)} has no provider on its record to move off.`,
    });
  });
});
