/**
 * How a started task moves (docs/helper.md, "Moving a started task";
 * INF-849 for a move to another provider; `TaskMoves`): where a task
 * could move now and why each other computer cannot take it, the refusals
 * a move to a computer or a provider meets before anything is written, a
 * move cancelled before it crosses, and the move facts a task's record
 * shows. These cases pin the behaviour no other test reaches. The move
 * itself, carrying real work between computers, stays pinned by the
 * real-git journey in taskMoves.computer.test.ts. Each case drives a public
 * door of the supervisor's moves and reads its answer and the record.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { HERE } from "@shared/deviceNames";
import type { ComputerMove } from "@shared/placement";
import { moveOutOfReach } from "@shared/recordBar";
import { RUNS_ON_THIS_MAC } from "@shared/repos";
import type { WorkShape } from "@shared/routingPolicy";
import { describe, expect, it, vi } from "vitest";
import {
  catalogLessRouter,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { pngImage } from "../../../tests/helpers/images";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { keepImages } from "../attachments";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import type { CrewMachines } from "../placed/crewMachines";
import type { SessionSpec } from "../session/session";
import type { TaskRecord } from "../storage/taskRecords";
import { seedTask } from "../tasks/seedTask";
import { seedProject } from "../workspace/seedProject";
import { describeStatus } from "./settleService";

fakeCrewTimersEachTest();

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

async function withComputers() {
  const { machines, moveIn } = computers();
  const h = setup(fakeCrewmate(), { machines });
  const repo = seedProject(h.db, {
    id: "meter",
    name: "meter",
    path: join(h.paths.fleetDir, "meter"),
    setupKind: "init",
  });
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

describe("a started task's move", () => {
  it("lists every other computer a task could move to, each with why it cannot take it", async () => {
    const h = await withComputers();
    started(h, "t1");

    expect(await h.supervisor.moves.moveOptions("t1")).toEqual({
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
    expect(await h.supervisor.moves.moveOptions("nope")).toEqual({
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
      expect(await h.supervisor.moves.moveOptions(id)).toEqual({ ok: false, text });
      expect(await h.supervisor.moves.requestComputerMove(id, MINI, "captain")).toEqual({
        ok: false,
        text,
      });
    }
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

    expect(await h.supervisor.moves.moveOptions("waiting")).toEqual({
      ok: false,
      text: `${handle(waiting)} is already moving to Studio Mac mini.`,
    });
    expect(await h.supervisor.moves.moveOptions("finishing")).toEqual({
      ok: false,
      text: `${handle(finishing)} is still finishing its last move; try again once it has.`,
    });
    expect(await h.supervisor.moves.moveOptions("on-old")).toEqual({
      ok: false,
      text: "Infinitary on Office iMac cannot move a started task yet. Update it first.",
    });
    // Out of reach and holding none of its commits here, nothing could continue elsewhere
    // (docs/helper.md, "Moving a task off a computer that is out of reach").
    expect(await h.supervisor.moves.moveOptions("on-away")).toEqual({
      ok: false,
      text: `${handle(onAway)} stays on Spare MacBook Pro: ${moveOutOfReach("Spare MacBook Pro")} ${HERE.This} holds none of its commits, so nothing could continue elsewhere. Wait for Spare MacBook Pro to be back, or drop the task.`,
    });
    expect(h.supervisor.moves.computerMoveFacts(h.tasks.get("waiting") as TaskRecord)).toEqual({
      computerMove: { from: HERE.this, to: "Studio Mac mini", state: "waiting", waitingFor: [] },
    });
    expect(h.supervisor.moves.computerMoveFacts(onOld)).toEqual({});
    expect(h.supervisor.moves.computerMoveFacts(onAway)).toEqual({});
  });

  it("refuses a move to a computer it cannot name, to Automatic, to where it runs, or that keeps files outside its copy", async () => {
    const h = await withComputers();
    const record = started(h, "t1");
    const ask = (to: string, keep: string[] = []) =>
      h.supervisor.moves.requestComputerMove("t1", to, "firstmate", keep);

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
    expect(await h.supervisor.moves.requestComputerMove("nope", MINI, "captain")).toEqual({
      ok: false,
      text: 'Unknown task "nope".',
    });
    expect(h.tasks.get("t1")?.shape?.computer_move).toBeUndefined();
    expect(h.supervisor.moves.computerMoveFacts(h.tasks.get("t1") as TaskRecord)).toEqual({
      movable: true,
    });
    expect(h.moveIn).not.toHaveBeenCalled();
  });

  it("cancels only a move still waiting for its pause, and says why it cannot cancel any other", async () => {
    const h = await withComputers();
    const record = started(h, "t1");
    expect(h.supervisor.moves.cancelComputerMove("t1", "captain")).toEqual({
      ok: false,
      text: `${handle(record)} is not moving to another computer.`,
    });
    h.tasks.placement.setComputerMove("t1", move({ phase: "undoing" }), {
      text: "its move did not finish",
      actor: "host",
    });
    expect(h.supervisor.moves.cancelComputerMove("t1", "captain")).toEqual({
      ok: false,
      text: `${handle(record)} is not moving to another computer.`,
    });
    // A move that did not finish shows nothing on the record while its copy goes.
    expect(h.supervisor.moves.computerMoveFacts(h.tasks.get("t1") as TaskRecord)).toEqual({});
    h.tasks.placement.setComputerMove(
      "t1",
      move({ phase: "moving", problem: "the disk is full" }),
      {
        text: "it is moving",
        actor: "host",
      },
    );
    expect(h.supervisor.moves.cancelComputerMove("t1", "firstmate")).toEqual({
      ok: false,
      text: `${handle(record)} is already moving to Studio Mac mini, so the move can no longer be cancelled.`,
    });
    expect(h.supervisor.moves.computerMoveFacts(h.tasks.get("t1") as TaskRecord)).toEqual({
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
    expect(h.supervisor.moves.cancelComputerMove("t1", "firstmate")).toEqual({
      ok: true,
      text: `${handle(record)} stays on ${HERE.this}.`,
    });
    expect(h.tasks.get("t1")?.shape?.computer_move).toBeUndefined();
    expect(h.tasks.timeline("t1").at(-1)).toMatchObject({
      actor: "firstmate",
      text: `the first mate cancelled its move to Studio Mac mini; it stays on ${HERE.this}`,
    });
    expect(h.supervisor.moves.cancelComputerMove("nope", "captain")).toEqual({
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
    expect(h.supervisor.moves.computerMoveFacts(record)).toEqual({});
    expect(await h.supervisor.moves.moveOptions("t1")).toEqual({
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
    const { taskId } = await h.supervisor.intake.commission({
      title: "t",
      intent: intentOf("work"),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    const record = h.tasks.get(taskId);

    expect(await h.supervisor.moves.requestMove("nope", { by: "captain" })).toEqual({
      ok: false,
      text: 'Unknown task "nope".',
    });
    const notStarted = await h.supervisor.moves.requestMove("queued", { by: "captain" });
    expect(notStarted).toEqual({
      ok: false,
      text: `${handle(queued)} is ${describeStatus(queued)}; only started work moves.`,
    });
    // Its conversation would reopen on a computer this app cannot reach (INF-3714, piece 2).
    expect(await h.supervisor.moves.requestMove("elsewhere", { by: "captain" })).toEqual({
      ok: false,
      text: `${handle(elsewhere)} stays where it runs: ${moveOutOfReach("the other computer")}`,
    });
    expect(
      await h.supervisor.moves.requestMove(taskId, { by: "firstmate", model: "xai/grok-5" }),
    ).toEqual({
      ok: false,
      text: `xai/grok-5 cannot take ${handle(record)} now, so it stays where it runs.`,
    });
    expect(
      await h.supervisor.moves.requestMove(taskId, {
        by: "firstmate",
        model: "github-copilot/gpt-5.1",
      }),
    ).toEqual({
      ok: false,
      text: `${handle(record)} already runs on github-copilot/gpt-5.1.`,
    });
    // A move asked mid-turn is taken and waits for the turn to end; what it
    // says then is taskMoves.computer.test.ts's.
    const asked = await h.supervisor.moves.requestMove(taskId, { by: "captain" });
    expect(asked.ok).toBe(true);
    expect(h.tasks.get(taskId)?.model).toBe("github-copilot/gpt-5.1");
    expect(crewmate.aborts).toEqual([]);
    await tick();
  });

  // A move routed without the task's pictures, so a task with a screenshot
  // could move to a model that takes text only and fail its next turn.
  it("moves a task whose brief carries pictures only to a model that reads them", async () => {
    vi.useRealTimers();
    // Three providers' models, each def as its catalog lists it; the one
    // that takes text only sits at the level the task asks for.
    const textOnly = { provider: "openrouter", id: "deepseek/deepseek-v4-pro" };
    const readsPictures = { provider: "xai", id: "grok-4.7" };
    const defs = new Map([
      [CODEX.id, { reasoning: true, input: ["text", "image"], contextWindow: 500_000 }],
      [textOnly.id, { reasoning: true, input: ["text"], contextWindow: 1_048_576 }],
      [readsPictures.id, { reasoning: true, input: ["text", "image"], contextWindow: 500_000 }],
    ]);
    const slots = (model: { id: string }) =>
      model.id === readsPictures.id ? (["medium"] as const) : (["high"] as const);
    const crewmate = fakeCrewmate();
    const h = setup(crewmate, {
      realRouter: (db) =>
        catalogLessRouter(db, [CODEX, textOnly, readsPictures], {
          capabilityFor: (ref) => defs.get(ref.id),
          slotsFor: slots,
        }),
    });
    const attachments = keepImages(randomUUID(), [{ ...pngImage, name: "dialog.png" }]);
    const words = "fix the dialog in this picture";
    const { taskId } = await h.supervisor.intake.commission({
      title: "Fix the dialog",
      intent: intentOf(words),
      attachments,
      shape: { intelligence: "high" },
    });
    // The captain's message attaches to the task once its spawn returns.
    h.tasks.capture.openAsk({ id: "dialog", text: words, attachments });
    h.tasks.capture.attachAsk("dialog", taskId, "tool:create_task");
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    expect(h.sessionSpecs[0]?.model).toEqual(CODEX);

    // Off Codex, the one model left at its level takes text only, so the
    // move goes a level lower to the model that reads pictures.
    const plan = await h.supervisor.moves.planMove(taskId);
    expect(plan).toMatchObject({ choice: readsPictures });
    expect("preview" in plan && plan.preview.reasons).toContain(
      "skipped openrouter/deepseek/deepseek-v4-pro: the turn carries images and its def takes text only",
    );
  });

  it("says on the timeline and the feed when a move between turns cannot reopen the task", async () => {
    const copilot = { provider: "github-copilot", id: "gpt-5.1" };
    const crewmate = fakeCrewmate({ model: copilot });
    const h = setup(crewmate, {
      routedModel: copilot,
      movePick: () => ({ provider: "openai-codex", id: "gpt-6.1-sol" }),
    });
    const { taskId } = await h.supervisor.intake.commission({
      title: "t",
      intent: intentOf("work"),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    crewmate.finishPrompt();
    await tick();
    h.sessions.open.mockRejectedValueOnce(new Error("Codex did not answer"));
    expect((await h.supervisor.moves.requestMove(taskId, { by: "captain" })).ok).toBe(true);
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
    expect(await h.supervisor.moves.requestMove("bare", { by: "firstmate" })).toEqual({
      ok: false,
      text: `${handle(record)} has no provider on its record to move off.`,
    });
  });

  /**
   * INF-3714's piece 2, approved by the captain ("Ask the first mate, and
   * stop the retry after three identical refusals"): a started task on a
   * computer that runs work moves in place to another model among that
   * computer's own sign-ins, so the sign-in card's Move and the first
   * mate's answer to a stuck task work there too. This Mac's own sign-ins
   * would pick Grok; only the Mac mini's sign-ins hold Claude.
   */
  describe("on a computer that runs work (INF-3714)", () => {
    const COPILOT = { provider: "github-copilot", id: "gpt-5.1" };
    const CLAUDE = { provider: "anthropic-claude", id: "claude-fable-5" };
    const GROK = { provider: "xai", id: "grok-5" };

    function onTheMini(reach: { ready: boolean; said: boolean }) {
      const moved = fakeCrewmate({ model: CLAUDE, sessionId: "s-moved-there" });
      const opened: SessionSpec[] = [];
      const factory = {
        backend: "pi" as const,
        controlProfile: PI_CONTROL_PROFILE,
        open: async (spec: SessionSpec) => {
          opened.push(spec);
          return moved;
        },
      };
      // What the Mac mini last said it serves: Copilot, where the task runs,
      // and Claude under its own account.
      const pool = {
        available: [COPILOT, CLAUDE],
        catalog: [],
        note: "Studio Mac mini's own sign-ins (github-copilot, anthropic-claude): 2 models",
        place: "Studio Mac mini",
        accounts: new Map([
          ["github-copilot", "mini-copilot"],
          ["anthropic-claude", "mini-claude"],
        ]),
        modelAccounts: new Map([
          ["github-copilot/gpt-5.1", "mini-copilot"],
          ["anthropic-claude/claude-fable-5", "mini-claude"],
        ]),
      };
      // A computer that has said nothing of its sign-ins serves an empty pool,
      // as PlacedAccounts.served builds it.
      const silent = {
        ...pool,
        available: [],
        accounts: new Map<string, string>(),
        modelAccounts: new Map<string, string>(),
      };
      const served = vi.fn(async () => (reach.said ? pool : silent));
      const machines = {
        computers: () => [MINI],
        ready: () => reach.ready,
        takesMoves: () => true,
        nameOf: (id: string) => NAMES[id],
        placeOf: (id: string) => ({ label: NAMES[id], where: `on ${NAMES[id]}` }),
        signInWait: () => undefined,
        folders: () => ({ work: "/work/there", sessions: "/sessions/there" }),
        factories: () => ({ pi: factory, claude: { ...factory, backend: "claude" as const } }),
        served,
        servingAccount: () => undefined,
        accountOf: () => undefined,
        cutOffOf: () => undefined,
        knows: () => false,
      } as unknown as CrewMachines;
      const selectForSpawn = vi.fn(() => "home-account");
      const h = setup(fakeCrewmate({ model: COPILOT }), {
        machines,
        routedModel: COPILOT,
        accounts: {
          selectForSpawn,
          reselectForResume: () => ({ changed: false }),
          labelOf: () => "Personal",
        },
        movePick: (_shape, options) =>
          (options.pool?.available ?? [GROK]).find(
            (model) => model.provider !== options.withoutProvider,
          ),
      });
      const record = seedTask(h.tasks, {
        id: "there",
        title: "Fix the meter",
        branch: "fm/task-there",
        sessionFile: "/sessions/there/s-there.jsonl",
        model: COPILOT,
        status: "completed",
        deviceId: MINI,
      });
      return { h, record, opened, moved, served, selectForSpawn };
    }

    it("moves it to a model that computer's own sign-ins serve, bound to its account there", async () => {
      const { h, record, opened, selectForSpawn } = onTheMini({ ready: true, said: true });
      const plan = await h.supervisor.moves.planMove(record.id);
      expect("refused" in plan ? plan.refused : plan.choice).toEqual(CLAUDE);
      const asked = await h.supervisor.moves.requestMove(record.id, {
        by: "firstmate",
        from: COPILOT.provider,
        offered: "anthropic-claude/claude-fable-5",
      });
      expect(asked).toEqual({
        ok: true,
        text: `Moving ${handle(record)} to claude-fable-5 on Claude; it keeps its key, branch and working copy.`,
      });
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      expect(opened[0]).toMatchObject({ machine: MINI, model: CLAUDE });
      expect(opened[0]?.binding).toMatchObject({ accountId: "mini-claude" });
      // No account of this Mac's is chosen or recorded for it.
      expect(selectForSpawn).not.toHaveBeenCalled();
      const after = h.tasks.get(record.id);
      expect(after?.model).toBe("anthropic-claude/claude-fable-5");
      expect(after?.accountId).toBeNull();
      expect(after?.deviceId).toBe(MINI);
      expect(h.tasks.timeline(record.id).map((event) => [event.actor, event.text])).toContainEqual([
        "firstmate",
        "the first mate moved it from Copilot to claude-fable-5 on Claude",
      ]);
    });

    it("refuses in words while that computer is out of reach or serves no other model", async () => {
      const away = onTheMini({ ready: false, said: true });
      expect(await away.h.supervisor.moves.requestMove(away.record.id, { by: "captain" })).toEqual({
        ok: false,
        text: `${handle(away.record)} stays where it runs: ${moveOutOfReach(NAMES[MINI] ?? "")}`,
      });
      const silent = onTheMini({ ready: true, said: false });
      expect(
        await silent.h.supervisor.moves.requestMove(silent.record.id, { by: "captain" }),
      ).toEqual({
        ok: false,
        text: `No other provider signed in on ${NAMES[MINI]} can take ${handle(silent.record)} now, so it stays on Copilot.`,
      });
      for (const { h, record, opened } of [away, silent]) {
        expect(opened).toEqual([]);
        expect(h.tasks.get(record.id)?.model).toBe("github-copilot/gpt-5.1");
      }
    });
  });
});
