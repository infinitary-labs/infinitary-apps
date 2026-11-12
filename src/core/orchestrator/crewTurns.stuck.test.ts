/**
 * A crewmate stuck at its provider (INF-3714's direction A, approved by the
 * captain with "Approve and build": "Ask the first mate, and stop the retry
 * after three identical refusals"; docs/inbox.md, "Stuck at its provider").
 * Each case replays INF-3570's shape - a stand-in provider answering 400
 * "Bad Request" to every request - through a real CrewSupervisor and its
 * inbox (tests/helpers/idleLadderHarness.ts), and reads the feed, the
 * status, the first mate's wakes and the prompts the crewmate was sent.
 */
import { AT_PROVIDER_WORDS, workPostureLabel } from "@shared/workPosture";
import { describe, expect, it } from "vitest";
import { endTurn, fakeCrewmate, fakeCrewTimersEachTest } from "../../../tests/helpers/crewHarness";
import {
  failTurn,
  idleLadderHarness,
  idleWakes,
  minutes,
  settle,
} from "../../../tests/helpers/idleLadderHarness";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import type { CrewMachines } from "../placed/crewMachines";
import type { SessionSpec } from "../session/session";
import { ActivityStore } from "../storage/activityStore";
import { STUCK_REFUSAL_LIMIT } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import { recentFeed } from "../tasks/taskFeed";

fakeCrewTimersEachTest();

/** INF-3570's provider words, each of its eight refusals. */
const REFUSAL = '{"detail":"Bad Request"}';

describe("a crewmate stuck at its provider", () => {
  const { clock, stopped, sweepWhenDue } = idleLadderHarness();

  /** The task's own feed lines, newest last, as Activity reads them back. */
  function feedOf(harness: Awaited<ReturnType<typeof stopped>>) {
    const key = harness.tasks.get(harness.taskId)?.key;
    return recentFeed(harness.tasks, new ActivityStore(harness.db), 200)
      .filter((line) => line.taskKey === key)
      .map((line) => line.text);
  }

  /** The status words the task's tile and record read. */
  function statusOf(harness: Awaited<ReturnType<typeof stopped>>) {
    const record = harness.tasks.get(harness.taskId) as TaskRecord;
    return workPostureLabel(harness.supervisor.postures.workPosture(record));
  }

  const stuckWakes = (ops: string[]) => ops.filter((op) => op.includes("is stuck at its provider"));

  /** Fail the lane's turns until it is stuck, sweeping each retry when due. */
  async function refuseUntilStuck(harness: Awaited<ReturnType<typeof stopped>>) {
    for (let refusal = 1; refusal <= STUCK_REFUSAL_LIMIT; refusal++) {
      if (refusal > 1) await sweepWhenDue(harness, harness.taskId);
      await failTurn(harness.crewmate, harness.taskId, REFUSAL);
    }
  }

  it("retries in plain words, stops at the third identical refusal and tells the first mate once", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, taskId, tasks, inbox, ops } = harness;
    await supervisor.steer.steerCrewmate(taskId, "carry on with the handoff");
    await settle();
    const prompts = crewmate.promptCalls.length;

    await failTurn(crewmate, taskId, REFUSAL);
    // The feed says what happened and that the app retries on its own,
    // never asking anyone to try again; the status says it retries.
    const first = feedOf(harness).at(-1) ?? "";
    expect(first).toMatch(
      /^Problem: the provider refused the crewmate's request - the app tries again on its own \(1 try failed since .+\)$/,
    );
    expect(first).not.toMatch(/\btry again\b/);
    expect(statusOf(harness)).toBe(AT_PROVIDER_WORDS.retrying);
    expect(ops.filter((op) => op.includes("failed at the provider"))).toHaveLength(1);

    await sweepWhenDue(harness, taskId);
    await failTurn(crewmate, taskId, REFUSAL);
    await sweepWhenDue(harness, taskId);
    await failTurn(crewmate, taskId, REFUSAL);
    expect(crewmate.promptCalls).toHaveLength(prompts + 2);

    // Stuck: the status and one updated feed line say so, the timeline keeps
    // each refusal in the provider's own words, and the first mate hears once.
    expect(statusOf(harness)).toBe(AT_PROVIDER_WORDS.stuck);
    const outageLines = feedOf(harness).filter((line) => line.includes("provider refused"));
    expect(outageLines).toHaveLength(1);
    expect(outageLines[0]).toMatch(
      /^Stuck at its provider: the provider refused the crewmate's request, 3 tries in a row since .+ - the app stopped retrying, and your first mate is choosing what to do$/,
    );
    expect(
      tasks.timeline(taskId).filter((event) => event.text === `hit a problem: ${REFUSAL}`),
    ).toHaveLength(3);
    expect(stuckWakes(ops)).toHaveLength(1);
    expect(stuckWakes(ops)[0]).toContain(
      `update_task task ${tasks.get(taskId)?.key} unstick restart`,
    );
    // No other provider serves in this harness, so no move is offered.
    expect(stuckWakes(ops)[0]).not.toContain("unstick move");
    // The guidance is kept.
    expect(inbox.allFor(taskId)).toHaveLength(1);

    // No fourth try however long it waits, and no still-failing wake. With
    // no answer the task counts as idle (INF-3714's plan), so the idle
    // ladder's reminder follows.
    expect(idleWakes(ops)).toEqual([]);
    clock.now += minutes(60);
    supervisor.watch.reconcileIdle(clock.now);
    await supervisor.watch.sweepInbox(clock.now);
    await settle();
    expect(crewmate.promptCalls).toHaveLength(prompts + 2);
    expect(ops.filter((op) => op.includes("still failing at the provider"))).toEqual([]);
    expect(stuckWakes(ops)).toHaveLength(1);
    expect(inbox.allFor(taskId)).toHaveLength(1);
    expect(idleWakes(ops)).toHaveLength(1);
    expect(idleWakes(ops)[0]).toContain('"held": "idle-stall"');
    expect(idleWakes(ops)[0]).toContain(`Its last turn hit a problem: ${REFUSAL}`);
  });

  it("counts only identical refusals in a row, and never stops an outage's retry", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, taskId, inbox, ops } = harness;
    await supervisor.steer.steerCrewmate(taskId, "carry on with the handoff");
    await settle();
    await failTurn(crewmate, taskId, REFUSAL);
    await sweepWhenDue(harness, taskId);
    await failTurn(crewmate, taskId, REFUSAL);
    await sweepWhenDue(harness, taskId);
    // An outage in between starts the count again: only refusals count.
    await failTurn(crewmate, taskId, "upstream 529 overloaded");
    await sweepWhenDue(harness, taskId);
    await failTurn(crewmate, taskId, REFUSAL);
    expect(inbox.stuck(taskId)).toBeUndefined();
    expect(stuckWakes(ops)).toEqual([]);
    expect(statusOf(harness)).toBe(AT_PROVIDER_WORDS.retrying);
    // An outage in the same words, however often, keeps the honest retry.
    for (let outage = 0; outage < STUCK_REFUSAL_LIMIT + 1; outage++) {
      await sweepWhenDue(harness, taskId);
      await failTurn(crewmate, taskId, "upstream 529 overloaded");
    }
    expect(inbox.stuck(taskId)).toBeUndefined();
    expect(stuckWakes(ops)).toEqual([]);
    expect(inbox.pending(taskId, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
  });

  it("stops a Claude crewmate's identical refusals too, whatever request id each carries", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, taskId, inbox, ops } = harness;
    await supervisor.steer.steerCrewmate(taskId, "carry on with the handoff");
    await settle();
    // The Claude client's result text for a 400; each response has its own id.
    const claudeRefusal = (n: number) =>
      `API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3: tool_use ids must be unique"},"request_id":"req_011CV${n}"}`;
    for (let refusal = 1; refusal <= STUCK_REFUSAL_LIMIT; refusal++) {
      if (refusal > 1) await sweepWhenDue(harness, taskId);
      await failTurn(crewmate, taskId, claudeRefusal(refusal));
    }
    expect(inbox.stuck(taskId)).toMatchObject({ refusals: STUCK_REFUSAL_LIMIT });
    expect(stuckWakes(ops)).toHaveLength(1);
    expect(statusOf(harness)).toBe(AT_PROVIDER_WORDS.stuck);
  });

  it("takes a steer as the answer, and tells the first mate at once when it meets the same refusal", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, taskId, inbox, ops } = harness;
    await supervisor.steer.steerCrewmate(taskId, "carry on with the handoff");
    await settle();
    await refuseUntilStuck(harness);
    const prompts = crewmate.promptCalls.length;

    await supervisor.steer.steerCrewmate(taskId, "skip the pictures and read the summary");
    await settle();
    // The steer carries the kept guidance with it.
    expect(crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(crewmate.promptCalls.at(-1)).toContain("carry on with the handoff");
    expect(crewmate.promptCalls.at(-1)).toContain("skip the pictures and read the summary");
    expect(inbox.stuck(taskId)).toBeUndefined();

    await failTurn(crewmate, taskId, REFUSAL);
    expect(stuckWakes(ops)).toHaveLength(2);
    expect(stuckWakes(ops)[1]).toContain("the same way 4 times in a row");
    expect(statusOf(harness)).toBe(AT_PROVIDER_WORDS.stuck);

    // A turn that goes through ends it all, and the feed says so.
    await supervisor.steer.steerCrewmate(taskId, "answer with what you have");
    await settle();
    await endTurn(crewmate, taskId, "Read the summary; the handoff is done.");
    expect(inbox.stuck(taskId)).toBeUndefined();
    expect(inbox.allFor(taskId)).toEqual([]);
    expect(statusOf(harness)).not.toMatch(/at its provider/);
    expect(feedOf(harness)).toContain("Answering again after 4 failed tries at its provider");
  });

  it("restarts in a fresh conversation on the first mate's answer, delivering the kept guidance", async () => {
    const harness = await stopped();
    const { supervisor, crewmate, taskId, inbox, specs } = harness;
    await supervisor.steer.steerCrewmate(taskId, "carry on with the handoff");
    await settle();
    // A task that is not stuck is refused, and nothing changes.
    expect(await supervisor.turns.unstick(taskId, "restart")).toMatchObject({ ok: false });
    await refuseUntilStuck(harness);
    const prompts = crewmate.promptCalls.length;
    const sessions = specs.length;

    const answer = await supervisor.turns.unstick(taskId, "restart");
    expect(answer).toMatchObject({ ok: true });
    await settle();
    // A new conversation, told why, with the guidance it kept.
    expect(specs.length).toBe(sessions + 1);
    expect(specs.at(-1)?.resumeToken).toBeUndefined();
    expect(crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(crewmate.promptCalls.at(-1)).toContain(
      "the provider refused your earlier conversation's requests the same way several times in a row",
    );
    expect(crewmate.promptCalls.at(-1)).toContain("carry on with the handoff");

    await endTurn(crewmate, taskId, "Picked the handoff up again and finished it.");
    expect(inbox.allFor(taskId)).toEqual([]);
    expect(statusOf(harness)).not.toMatch(/at its provider/);
  });

  it("moves to the app's pick off the refusing provider on the first mate's answer", async () => {
    const codex = { provider: "openai-codex", id: "gpt-6.1-sol" };
    const claude = { provider: "anthropic-claude", id: "claude-opus-5-5" };
    const moved = fakeCrewmate({ model: claude });
    const harness = await stopped(
      {
        routedModel: codex,
        crewmates: [moved],
        accounts: {
          selectForSpawn: (_taskId, provider) =>
            provider === claude.provider ? "acct_claude" : "acct_codex",
          reselectForResume: () => ({ changed: false }),
          labelOf: () => undefined,
        },
        movePick: (_shape, options) =>
          options.withoutProvider === codex.provider ? claude : undefined,
        modelName: (model) => (model.id === claude.id ? "Claude Opus 5.5" : "GPT-6.1 Sol"),
      },
      fakeCrewmate({ model: codex }),
    );
    const { supervisor, crewmate, taskId, tasks, inbox, ops } = harness;
    await supervisor.steer.steerCrewmate(taskId, "carry on with the handoff");
    await settle();
    await refuseUntilStuck(harness);
    // Only now that another model serves is the move offered.
    expect(stuckWakes(ops)[0]).toContain("unstick move, to move it to Claude Opus 5.5");

    expect(await supervisor.turns.unstick(taskId, "move")).toMatchObject({ ok: true });
    await settle();
    await settle();
    expect(tasks.get(taskId)?.model).toBe("anthropic-claude/claude-opus-5-5");
    expect(moved.promptCalls.join("\n")).toContain("carry on with the handoff");
    expect(crewmate.promptCalls.length).toBeGreaterThan(0);
    await endTurn(moved, taskId, "Finished the handoff on the other model.");
    expect(inbox.allFor(taskId)).toEqual([]);
  });

  // INF-3714's piece 2: a task on a computer that runs work is offered, and
  // makes, the move among that computer's own sign-ins, never this Mac's.
  it("offers and makes the move among a computer's own sign-ins for a task that runs there", async () => {
    const codex = { provider: "openai-codex", id: "gpt-6.1-sol" };
    const claude = { provider: "anthropic-claude", id: "claude-opus-5-5" };
    const grok = { provider: "xai", id: "grok-5" };
    const MINI = "mini-device";
    const moved = fakeCrewmate({ model: claude });
    const opened: SessionSpec[] = [];
    const factory = {
      backend: "claude" as const,
      controlProfile: PI_CONTROL_PROFILE,
      open: async (spec: SessionSpec) => {
        opened.push(spec);
        return moved;
      },
    };
    // The Mac mini serves Codex and Claude under its own accounts; this Mac's would pick Grok.
    const machines = {
      computers: () => [MINI],
      ready: () => true,
      takesMoves: () => true,
      nameOf: () => "Studio Mac mini",
      placeOf: () => ({ label: "Studio Mac mini", where: "on Studio Mac mini" }),
      signInWait: () => undefined,
      folders: () => ({ work: "/work/there", sessions: "/sessions/there" }),
      factories: () => ({ claude: factory, pi: { ...factory, backend: "pi" as const } }),
      served: async () => ({
        available: [codex, claude],
        catalog: [],
        note: "Studio Mac mini's own sign-ins (openai-codex, anthropic-claude): 2 models",
        accounts: new Map([
          [codex.provider, "mini-codex"],
          [claude.provider, "mini-claude"],
        ]),
        modelAccounts: new Map([[`${claude.provider}/${claude.id}`, "mini-claude"]]),
      }),
      servingAccount: () => undefined,
      accountOf: () => undefined,
      cutOffOf: () => undefined,
      knows: () => false,
    } as unknown as CrewMachines;
    const harness = await stopped(
      {
        machines,
        routedModel: codex,
        movePick: (_shape, options) =>
          (options.pool?.available ?? [grok]).find(
            (model) => model.provider !== options.withoutProvider,
          ),
        modelName: (model) => (model.id === claude.id ? "Claude Opus 5.5" : model.id),
      },
      fakeCrewmate({ model: codex }),
    );
    const { supervisor, taskId, tasks, inbox, ops } = harness;
    // Its conversation is held on the Mac mini.
    tasks.placement.setDevice(taskId, MINI);
    await supervisor.steer.steerCrewmate(taskId, "carry on with the handoff");
    await settle();
    await refuseUntilStuck(harness);
    expect(stuckWakes(ops)).toHaveLength(1);
    expect(stuckWakes(ops)[0]).toContain("unstick move, to move it to Claude Opus 5.5 off Codex");

    expect(await supervisor.turns.unstick(taskId, "move")).toMatchObject({ ok: true });
    await settle();
    await settle();
    // It reopened on the Mac mini, on Claude under the Mac mini's own account.
    expect(opened.at(-1)).toMatchObject({ machine: MINI, model: claude });
    expect(opened.at(-1)?.binding).toMatchObject({ accountId: "mini-claude" });
    expect(tasks.get(taskId)?.model).toBe("anthropic-claude/claude-opus-5-5");
    expect(tasks.get(taskId)?.deviceId).toBe(MINI);
    expect(moved.promptCalls.join("\n")).toContain("carry on with the handoff");
    await endTurn(moved, taskId, "Finished the handoff on the other model.");
    expect(inbox.allFor(taskId)).toEqual([]);
  });
});
