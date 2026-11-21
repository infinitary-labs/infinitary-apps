import { describe, expect, it, vi } from "vitest";
import { piStubRuntime } from "../../../tests/helpers/piStubRuntime";
import type { PlacedHome } from "../../../tests/helpers/placedHome";
import {
  api,
  CODEX_MEDIUM_STARTER,
  computerAccount,
  gate,
  MODEL,
  model,
  OTHER_MODEL,
  PROVIDER,
  placedWorldHooks,
  type Step,
  said,
  THIS_MAC_ON_NEWER_CODEX,
  world,
} from "../../../tests/helpers/placedWorld";
import { DeviceOutOfReachError } from "../connection/connection";
import { CONTRACT_CHANGES } from "../connection/contractChanges";
import { backlogLeftLine } from "../orchestrator/hostOps";
import { crewmatePlacedDir } from "../paths";
import { PlacedLedger } from "./placedLedger";

// Captain's lost-turn regression: after a work computer quits mid-turn,
// steers, interrupts and a backlog restart must reach its crewmate again.
// Real supervisor, database, persisted event ledger, paired connection and Pi;
// only the model endpoint stands in. The report and tool-result boundary are
// the real protocol readings that the incident's simpler restart test omitted.
// Integration: real git and loopback transport. The reproduction took 1.2 s;
// use the placed world's 10 s budget for the complete two-computer recovery.
vi.setConfig({ testTimeout: 10_000 });
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);
placedWorldHooks({ now: Date.now, reset: () => {} });

/** That computer signed in to two Codex accounts, one serving the starter and one GPT-6 Sol. */
const SOL = { provider: "openai-codex", id: "gpt-6-sol" };
const STARTER = { provider: "openai-codex", id: CODEX_MEDIUM_STARTER };
async function codexThere() {
  const runs = await piStubRuntime(api.url, STARTER, [SOL.id]);
  return world(undefined, {
    routing: THIS_MAC_ON_NEWER_CODEX,
    signedInTo: [
      computerAccount("acct_codex_other", "openai-codex"),
      computerAccount("acct_codex_sol", "openai-codex"),
    ],
    served: [
      { accountId: "acct_codex_other", models: [{ ...STARTER, name: STARTER.id }] },
      { accountId: "acct_codex_sol", models: [{ ...SOL, name: "GPT-6 Sol" }] },
    ],
    runtime: runs,
  });
}

/** The captain takes the starter off its level and puts GPT-6 Sol there. */
function starterLeft(home: PlacedHome): void {
  const slots = home.slots;
  if (!slots) throw new Error("no levels");
  slots.setSlotMembership(`${STARTER.provider}/${STARTER.id}`, "medium", false);
  slots.setSlotMembership(`${SOL.provider}/${SOL.id}`, "medium", true);
}

/** The task's notes that it routed again because its model left every level. */
function rerouted(home: PlacedHome, taskId: string): string[] {
  return home.tasks
    .timeline(taskId)
    .filter((entry) => entry.kind === "note" && entry.data && "rerouted" in entry.data)
    .map((entry) => entry.text);
}

describe("recovery after a work computer quits mid-turn", () => {
  it.each(["steer", "interrupt", "backlog restart"] as const)(
    "releases a report-only restored turn before a subsequent %s",
    async (action) => {
      const at = await world();
      const held = gate();
      const resumed = gate();
      const taskId = "t-recovery";
      const reported = "The footer checks passed.";
      const requests = api.requests.length;
      const steps: Step[] = [
        { tools: [{ name: "report", args: { text: reported } }] },
        { held: held.held, text: "Never finished." },
        { held: resumed.held, text: "The footer is fixed." },
        { text: "The header is fixed." },
      ];
      model(steps);
      try {
        await at.start(taskId);
        // The tool result ended one model message, not the whole prompt.
        // Its kept checkpoint no longer contains that prompt's start event.
        await expect.poll(() => api.requests.length).toBe(requests + 2);
        const ledger = new PlacedLedger(crewmatePlacedDir(at.home().paths, taskId));
        const endedBefore = ledger.place().ended;
        // The work computer asks the model again without waiting for the home
        // to take in that message's end, so the home keeps its place after.
        await expect.poll(() => ledger.place().kept).toBeGreaterThan(endedBefore);
        expect(ledger.lines().some((line) => line.report?.text === reported)).toBe(true);
        await at.home().drop();
        await at.stopComputer();
        // Both sides return only after the worker has written its interrupted
        // end: the roster has no running turn whose start could be adopted.
        await at.restartHome();
        await at.restartComputer();
        await at.inReach(taskId);
        const home = at.home();
        const caughtUp = new PlacedLedger(crewmatePlacedDir(home.paths, taskId));
        await expect.poll(() => caughtUp.place().ended).toBeGreaterThan(endedBefore);
        // Ending the interrupted restored turn releases its original brief.
        // The real inbox starts that undelivered work again, rather than
        // steering words forever into a turn that no longer exists.
        await expect.poll(() => api.requests.length).toBe(requests + 3);
        expect(said(api.requests.at(-1))).toContain("Fix the footer.");

        if (action === "interrupt") {
          await home.supervisor.sessions.interruptCrewmate(taskId, "interrupt");
          await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        } else if (action === "backlog restart") {
          const result = home.supervisor.hostOps.moveToBacklog(taskId, {
            actor: "captain",
            via: "task-card",
            decision: null,
          });
          expect(result.ok).toBe(true);
          await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
          await home.supervisor.starts.startQueuedNow(taskId);
        }
        if (action !== "backlog restart")
          await home.supervisor.steer.steerCrewmate(taskId, "Fix the header too.", "captain");
        resumed.open();
        await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("The header is fixed.");
        if (action !== "backlog restart")
          expect(said(api.requests.at(-1))).toContain("Fix the header too.");
        else expect(said(api.requests.at(-1))).toContain(backlogLeftLine("firstmate"));
        expect(api.requests.length - requests).toBe(steps.length);
        expect(home.inbox.allFor(taskId)).toEqual([]);
        console.info(
          "Recovery exchange",
          JSON.stringify({
            action,
            checkpoint: caughtUp.place(),
            requestCount: api.requests.length - requests,
            received: api.requests.at(-1)?.body.messages?.at(-1),
            activity: home.tasks.get(taskId)?.activity,
            outcome: home.tasks.get(taskId)?.outcome,
            waiting: home.inbox.allFor(taskId),
          }),
        );
      } finally {
        held.open();
        resumed.open();
      }
    },
  );
});

// A model that left every level (docs/helper.md, "A model that left every
// level"): the conversation a computer's restart opens again opens on the
// model the task routed to, and the move is recorded only once that
// computer answers it open on that model; a wait opens nothing there.
describe("reopening after a work computer restarts, when the task's model left every level", () => {
  it("records the move only once that computer answers the conversation open on the new model", async () => {
    const at = await world();
    const taskId = "t-rerouted";
    model([{ text: "Started on it." }, { text: "On the other model." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    const commit = vi.fn(async () => "committed" as const);
    const asked = vi.spyOn(home.supervisor, "reopenModel").mockResolvedValue({
      model: { provider: PROVIDER, id: OTHER_MODEL },
      thinking: { level: "off" },
      commit,
      passOver: vi.fn(),
    });

    await at.restartComputer();
    await at.inReach(taskId);
    await expect.poll(() => commit.mock.calls.length).toBe(1);
    // A conversation opened anew, not one reattached to.
    expect(asked).toHaveBeenCalledWith(taskId, expect.any(String), false);
    const requests = api.requests.length;
    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => api.requests.length).toBeGreaterThan(requests);
    expect(api.requests.at(-1)?.body.model).toBe(OTHER_MODEL);
  });

  // INF-5438 round 11 finding 4: the reopen after that computer restarts asks
  // it to say when an open left nothing new there; a routed pick it could not
  // open there is passed over - never committed - before the session is let
  // go, so the task's next open routes among the rest.
  it("passes a routed pick over when that computer answers its reopen opened nothing", async () => {
    const at = await world();
    const taskId = "t-not-opened";
    model([{ text: "Started on it." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    const commit = vi.fn(async () => "committed" as const);
    const passOver = vi.fn();
    vi.spyOn(home.supervisor, "reopenModel").mockResolvedValue({
      model: { provider: PROVIDER, id: OTHER_MODEL },
      thinking: { level: "off" },
      commit,
      passOver,
    });
    const letGo = vi.spyOn(home.supervisor, "placedLetGo");
    at.refuseOpens(true);

    await at.restartComputer();
    await at.inReach(taskId);
    await expect.poll(() => passOver.mock.calls.length).toBe(1);
    await expect.poll(() => letGo.mock.calls.length).toBeGreaterThan(0);
    expect(commit).not.toHaveBeenCalled();
    expect(at.bound.at(-1)?.provider).toBe(PROVIDER);
  });

  // INF-5438 round 12 finding 4: a notOpened answer that arrives after this
  // Mac let the session go changes nothing in the next selection.
  it("passes nothing over for a reopen's notOpened answer that arrives after its session went", async () => {
    const at = await world();
    const taskId = "t-late-not-opened";
    model([{ text: "Started on it." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    const passOver = vi.fn();
    vi.spyOn(home.supervisor, "reopenModel").mockResolvedValue({
      model: { provider: PROVIDER, id: OTHER_MODEL },
      thinking: { level: "off" },
      commit: vi.fn(async () => "committed" as const),
      passOver,
    });
    const ask = home.devices.ask.bind(home.devices);
    const answered = vi.fn();
    vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
      const answer = await ask(device, channel, args);
      if (
        channel === "inf:session:open" &&
        (args as [{ spec: { reattach?: boolean } }])[0].spec.reattach !== true
      ) {
        // This Mac let the session go while that computer answered.
        home.supervisor.placedLetGo(taskId);
        answered();
      }
      return answer;
    });
    at.refuseOpens(true);

    await at.restartComputer();
    await at.inReach(taskId);
    await expect.poll(() => answered.mock.calls.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(passOver).not.toHaveBeenCalled();
  });

  // INF-5438 round 11 finding 1: a context restart asks that computer for a
  // fresh conversation, and it replaces the idle one it holds - opened with
  // the same model and contract - instead of answering it.
  it("opens a context restart's new conversation there in place of the one it holds", async () => {
    const at = await world();
    const taskId = "t-fresh";
    model([{ text: "Started on it." }, { text: "In the new conversation." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    const from = home.tasks.get(taskId)?.sessionFile as string;
    home.supervisor.placedLetGo(taskId);

    await home.supervisor.sessions.resumeTask(taskId, undefined, { from, changed: "context" });
    const now = home.tasks.get(taskId)?.sessionFile;
    expect(now).toBeTruthy();
    expect(now).not.toBe(from);
  });

  // INF-5438 round 11 finding 2: an older computer, which does not know a
  // fresh open, answers a context restart with the conversation it still
  // holds; the home confirms the conversation is another before any branch
  // accepts it, so that one takes no words and the restart stays on its lane.
  it("takes no words from a context restart an older computer answers on the conversation it replaces", async () => {
    const older = CONTRACT_CHANGES.names.filter((name) => name !== "fresh-open");
    const at = await world(undefined, { changes: older });
    const taskId = "t-fresh-older";
    model([{ text: "Started on it." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    const from = home.tasks.get(taskId)?.sessionFile;
    expect(from).toBeTruthy();
    home.supervisor.placedLetGo(taskId);
    const requests = api.requests.length;

    await expect(
      home.supervisor.sessions.resumeTask(taskId, undefined, {
        from: from as string,
        changed: "context",
      }),
    ).rejects.toThrow("opened on another model or conversation");
    expect(api.requests.length).toBe(requests);
    // The restart is still on its lane, so the next open starts fresh.
    expect(
      home.inbox.allFor(taskId).some((row) => row.facts?.kind === "conversation-restart"),
    ).toBe(true);
    // A rerouted one is confirmed the same way, before its move commits.
    const commit = vi.fn(async () => "committed" as const);
    vi.spyOn(home.supervisor.moves, "routeAgainIfLeft").mockResolvedValueOnce({
      model: { provider: PROVIDER, id: MODEL },
      thinkingLevel: "low",
      providerName: "Stub",
      commit,
      passOver: vi.fn(),
    });
    await expect(
      home.supervisor.sessions.resumeTask(taskId, undefined, {
        from: from as string,
        changed: "context",
      }),
    ).rejects.toThrow("opened on another model or conversation");
    expect(commit).not.toHaveBeenCalled();
    expect(api.requests.length).toBe(requests);
  });

  // INF-5438 round 7 finding 12: the real router, the home's read of that
  // computer's subscriptions and the computer's own sign-ins, joined. The
  // task's model leaves every level while it idles; after that computer
  // restarts, the next words reach the model a level holds, on an account
  // there that serves it, and the move records that account.
  it("sends the next words to the model a level holds, on an account there that serves it", async () => {
    const at = await codexThere();
    const taskId = "t-left";
    model([{ text: "Started on it." }, { text: "On GPT-6 Sol." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    expect(api.requests.at(-1)?.body.model).toBe(STARTER.id);
    expect(at.bound.map((binding) => binding.accountId)).toEqual(["acct_codex_other"]);
    starterLeft(home);

    await at.restartComputer();
    await at.inReach(taskId);
    await expect.poll(() => home.decisions.latestRouting(taskId)?.model).toBe(SOL.id);
    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("On GPT-6 Sol.");
    expect(api.requests.at(-1)?.body.model).toBe(SOL.id);
    expect(said(api.requests.at(-1))).toContain("Carry on.");
    // Bound there to the one account that serves it, and recorded with it.
    expect(at.bound.map((binding) => binding.accountId)).toEqual([
      "acct_codex_other",
      "acct_codex_sol",
    ]);
    const routed = home.decisions.latestRouting(taskId);
    expect(routed).toMatchObject({ provider: SOL.provider, model: SOL.id });
    expect(routed && home.decisions.routingFacts(routed.id)).toMatchObject({
      accountId: "acct_codex_sol",
    });
    // Said once, on the task's record.
    expect(rerouted(home, taskId)).toHaveLength(1);
  });

  // INF-5438 round 7 findings 6 and 12: this Mac reattaches to the live
  // conversation its computer holds on another model than its newest routing
  // names, so no open is confirmed; when that computer restarts, nothing
  // reopens on the model it held, and the next words open a conversation on
  // the model a level holds.
  it("reopens nothing on a model it adopted live once that computer restarts", async () => {
    const at = await codexThere();
    const taskId = "t-adopted";
    model([{ text: "Started on it." }, { text: "Still live." }, { text: "On GPT-6 Sol." }]);
    await at.start(taskId);
    await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
    // Only this Mac restarts; meanwhile the newest routing names GPT-6 Sol.
    await at.restartHome();
    await at.inReach(taskId);
    const home = at.home();
    starterLeft(home);
    home.decisions.recordRouting({
      taskId,
      provider: SOL.provider,
      model: SOL.id,
      bucket: "medium",
      rule: "R1",
      served: "medium",
      reasons: ["routed again"],
      facts: { kind: "routing-candidates", candidates: [], accountId: "acct_codex_sol" },
    });
    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Still live.");
    // The live conversation kept its model.
    expect(api.requests.at(-1)?.body.model).toBe(STARTER.id);

    await at.restartComputer();
    await at.inReach(taskId);
    const requests = api.requests.length;
    await home.supervisor.steer.steerCrewmate(taskId, "And the header.", "captain");
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("On GPT-6 Sol.");
    expect(api.requests.slice(requests).map((request) => request.body.model)).toEqual([SOL.id]);
  });

  // INF-5438 round 7 findings 2, 4, 5 and 12: GPT-6 Sol leaves its level
  // while that computer opens the conversation on it, and the starter is put
  // back. The open is refused: no move, routing row or note is written for
  // it, and the next words reach the starter, which a level holds again.
  it("writes nothing for an open refused because its model left the level meanwhile", async () => {
    const at = await codexThere();
    const taskId = "t-refused";
    model([{ text: "Started on it." }, { text: "Back on the starter." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    starterLeft(home);
    const rows = home.decisions.routing({ taskIds: [taskId] }).length;
    const opened: string[] = [];
    const ask = home.devices.ask.bind(home.devices);
    vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
      const [open] = args as [{ spec?: { reattach?: boolean; model?: { id: string } } }];
      const answer = await ask(device, channel, args);
      if (channel === "inf:session:open" && open.spec?.reattach !== true && open.spec?.model) {
        opened.push(open.spec.model.id);
        // The captain puts the starter back while GPT-6 Sol was opening.
        if (open.spec.model.id === SOL.id) {
          const slots = home.slots;
          slots?.setSlotMembership(`${SOL.provider}/${SOL.id}`, "medium", false);
          slots?.setSlotMembership(`${STARTER.provider}/${STARTER.id}`, "medium", true);
        }
      }
      return answer;
    });

    await at.restartComputer();
    await at.inReach(taskId);
    await expect.poll(() => opened).toContain(SOL.id);
    const requests = api.requests.length;
    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Back on the starter.");
    expect(api.requests.slice(requests).map((request) => request.body.model)).toEqual([STARTER.id]);
    // Nothing durable says it moved to GPT-6 Sol.
    expect(rerouted(home, taskId)).toEqual([]);
    expect(home.decisions.routing({ taskIds: [taskId] }).slice(rows)).toEqual([]);
    expect(home.tasks.get(taskId)?.model ?? null).not.toBe(`${SOL.provider}/${SOL.id}`);
  });

  // INF-5438 round 8 findings 1 and 13: the real router routes a resumed
  // task off the starter after both computers restart; while the move to
  // GPT-6 Sol waits to commit, a second order arrives. Neither reaches any
  // model until the move commits, both then reach GPT-6 Sol, bound to the
  // account that serves it, and the move is recorded and said once.
  it("sends no order to a reopened conversation before its move commits", async () => {
    const at = await codexThere();
    const taskId = "t-before-commit";
    model([{ text: "Started on it." }, { text: "On GPT-6 Sol." }, { text: "Header done." }]);
    await at.start(taskId);
    await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
    await at.stopComputer();
    await at.restartHome();
    await at.restartComputer();
    await at.inReach(taskId);
    const home = at.home();
    starterLeft(home);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committing = vi.fn();
    const moves = home.supervisor.moves;
    const route = moves.routeAgainIfLeft.bind(moves);
    vi.spyOn(moves, "routeAgainIfLeft").mockImplementation(async (...asked) => {
      const routed = await route(...asked);
      if (typeof routed !== "object") return routed;
      return {
        ...routed,
        commit: async (opened) => {
          committing();
          await gate;
          return routed.commit(opened);
        },
      };
    });
    const requests = api.requests.length;

    const first = home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => committing.mock.calls.length).toBe(1);
    // Neither waits on the move: each order takes its place behind it.
    const second = home.supervisor.steer.steerCrewmate(taskId, "And the header.", "captain");
    const swept = home.supervisor.watch.sweepTaskLane(taskId, Date.now());
    try {
      await expect
        .poll(() =>
          home.inbox
            .allFor(taskId)
            .some((order) => order.text === "And the header." && order.deliveredAt === null),
        )
        .toBe(true);
      // The conversation opened there, but nothing reached a model yet.
      expect(api.requests.length).toBe(requests);
    } finally {
      release();
    }
    await Promise.all([first, second, swept]);
    await expect.poll(() => said(api.requests.at(-1))).toContain("And the header.");
    const sent = api.requests.slice(requests);
    expect(sent.map((request) => request.body.model)).toEqual(sent.map(() => SOL.id));
    expect(said(sent[0])).toContain("Carry on.");
    expect(at.bound.at(-1)?.accountId).toBe("acct_codex_sol");
    const routed = home.decisions.latestRouting(taskId);
    expect(routed && home.decisions.routingFacts(routed.id)).toMatchObject({
      accountId: "acct_codex_sol",
    });
    expect(rerouted(home, taskId)).toHaveLength(1);
  });

  // INF-5438 round 8 finding 5: a conversation that computer opened and this
  // Mac refused stays refused after this Mac restarts: the next open there
  // asks for a new conversation, never reattaching to the refused one, and
  // the next words reach the model a level holds.
  it("never reattaches to a refused conversation after this Mac restarts", async () => {
    const at = await codexThere();
    const taskId = "t-refused-restart";
    model([{ text: "Started on it." }, { text: "Back on the starter." }]);
    await at.start(taskId);
    const first = at.home();
    await expect.poll(() => first.tasks.get(taskId)?.activity).toBe("idle");
    starterLeft(first);
    const ask = first.devices.ask.bind(first.devices);
    let solOpened = false;
    vi.spyOn(first.devices, "ask").mockImplementation(async (device, channel, args) => {
      const [open] = args as [{ spec?: { reattach?: boolean; model?: { id: string } } }];
      const answer = await ask(device, channel, args);
      // The captain puts the starter back while GPT-6 Sol was opening.
      if (channel === "inf:session:open" && open.spec?.model?.id === SOL.id) {
        first.slots?.setSlotMembership(`${SOL.provider}/${SOL.id}`, "medium", false);
        first.slots?.setSlotMembership(`${STARTER.provider}/${STARTER.id}`, "medium", true);
        solOpened = true;
      }
      return answer;
    });
    // The check of the conversation opened on GPT-6 Sol refuses it: a
    // refusal after that open, not the mark set before it was asked.
    let refusedAfterOpen = 0;
    const refuseOpened = first.supervisor.moves.refuseOpened.bind(first.supervisor.moves);
    vi.spyOn(first.supervisor.moves, "refuseOpened").mockImplementation((task, machine) => {
      if (solOpened) refusedAfterOpen += 1;
      refuseOpened(task, machine);
    });
    await at.restartComputer();
    await at.inReach(taskId);
    await expect.poll(() => refusedAfterOpen).toBeGreaterThan(0);
    expect(first.supervisor.moves.refusedThere(taskId)).toBe(true);

    await at.restartHome();
    await at.inReach(taskId);
    const home = at.home();
    expect(home.supervisor.moves.refusedThere(taskId)).toBe(true);
    const opens: boolean[] = [];
    const again = home.devices.ask.bind(home.devices);
    vi.spyOn(home.devices, "ask").mockImplementation((device, channel, args) => {
      if (channel === "inf:session:open") {
        const [open] = args as [{ spec: { reattach?: boolean } }];
        opens.push(open.spec.reattach === true);
      }
      return again(device, channel, args);
    });
    const requests = api.requests.length;
    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Back on the starter.");
    expect(opens).not.toContain(true);
    expect(api.requests.slice(requests).map((request) => request.body.model)).toEqual([STARTER.id]);
    expect(home.supervisor.moves.refusedThere(taskId)).toBe(false);
  });

  // INF-5438 round 9 findings 1 and 9: this Mac quits while the move to
  // GPT-6 Sol waits to commit, after that computer opened the conversation.
  // The open was marked refused before it was asked, so the next open there
  // never reattaches to it unchecked: it opens anew, is accepted, and only
  // then takes words.
  it("never reattaches to a conversation opened before this Mac quit, until an open there is accepted", async () => {
    const at = await codexThere();
    const taskId = "t-quit-before-accept";
    model([{ text: "Started on it." }, { text: "On GPT-6 Sol." }]);
    await at.start(taskId);
    await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
    await at.stopComputer();
    await at.restartHome();
    await at.restartComputer();
    await at.inReach(taskId);
    const first = at.home();
    starterLeft(first);
    const committing = vi.fn();
    const moves = first.supervisor.moves;
    const route = moves.routeAgainIfLeft.bind(moves);
    // The first move's check never finishes before this Mac quits.
    vi.spyOn(moves, "routeAgainIfLeft").mockImplementation(async (...asked) => {
      const routed = await route(...asked);
      if (typeof routed !== "object") return routed;
      return {
        ...routed,
        commit: async () => {
          committing();
          return new Promise<never>(() => {});
        },
      };
    });
    const requests = api.requests.length;
    void first.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => committing.mock.calls.length).toBe(1);
    expect(first.supervisor.moves.refusedThere(taskId)).toBe(true);

    // Every open the next start of this Mac asks there, from before it listens.
    const opens: boolean[] = [];
    let refusedAtStart: boolean | undefined;
    await at.restartHome(undefined, (next) => {
      refusedAtStart = next.supervisor.moves.refusedThere(taskId);
      const ask = next.devices.ask.bind(next.devices);
      vi.spyOn(next.devices, "ask").mockImplementation((device, channel, args) => {
        if (channel === "inf:session:open") {
          const [open] = args as [{ spec: { reattach?: boolean } }];
          opens.push(open.spec.reattach === true);
        }
        return ask(device, channel, args);
      });
    });
    expect(refusedAtStart).toBe(true);
    await at.inReach(taskId);
    const home = at.home();
    await home.supervisor.watch.sweepTaskLane(taskId, Date.now());
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("On GPT-6 Sol.");
    expect(opens.length).toBeGreaterThan(0);
    expect(opens).not.toContain(true);
    const sent = api.requests.slice(requests);
    expect(sent.map((request) => request.body.model)).toEqual([SOL.id]);
    expect(said(sent[0])).toContain("Carry on.");
    expect(home.supervisor.moves.refusedThere(taskId)).toBe(false);
  });

  // INF-5438 round 9 findings 4, 7 and 9: the move's check cannot read what
  // that computer serves now, because it goes out of reach as it is asked.
  // The conversation takes no words, the order goes back with no attempt
  // spent, and the next pass opens again and delivers it once.
  it("gives an order back unspent when the check of a reopened conversation cannot finish", async () => {
    const at = await codexThere();
    const taskId = "t-unchecked";
    model([{ text: "Started on it." }, { text: "On GPT-6 Sol." }]);
    await at.start(taskId);
    await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
    await at.stopComputer();
    await at.restartHome();
    await at.restartComputer();
    await at.inReach(taskId);
    const home = at.home();
    starterLeft(home);
    let failing = true;
    let unread = 0;
    let armed = false;
    const ask = home.devices.ask.bind(home.devices);
    vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
      // Asked what it serves once the conversation opened, it does not answer.
      if (channel === "inf:sign-ins:list" && armed) {
        armed = false;
        unread += 1;
        throw new DeviceOutOfReachError();
      }
      const answer = await ask(device, channel, args);
      const [open] = args as [{ spec?: { reattach?: boolean; model?: { id: string } } }];
      if (channel === "inf:session:open" && open.spec?.model?.id === SOL.id && failing)
        armed = open.spec.reattach !== true;
      return answer;
    });
    const requests = api.requests.length;
    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => unread).toBeGreaterThanOrEqual(1);
    const order = () => home.inbox.allFor(taskId).find((row) => row.text === "Carry on.");
    await home.supervisor.watch.sweepTaskLane(taskId, Date.now());
    expect(unread).toBeGreaterThanOrEqual(2);
    expect(order()).toMatchObject({ deliveredAt: null, attempts: 0 });
    expect(api.requests.length).toBe(requests);

    failing = false;
    await home.supervisor.watch.sweepTaskLane(taskId, Date.now());
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("On GPT-6 Sol.");
    const sent = api.requests.slice(requests);
    expect(sent.map((request) => request.body.model)).toEqual([SOL.id]);
    expect(said(sent[0])).toContain("Carry on.");
    expect(rerouted(home, taskId)).toHaveLength(1);
  });

  // INF-5438 round 10 finding 3: that computer opens the conversation, but
  // its answer is lost on the way. Nothing was sent: the order goes back
  // with no attempt spent, what it may hold there stays refused, and the
  // next pass opens it, accepted, and delivers the words once.
  it("gives an order back unspent when the answer to its open is lost", async () => {
    const at = await codexThere();
    const taskId = "t-lost-answer";
    model([{ text: "Started on it." }, { text: "On GPT-6 Sol." }]);
    await at.start(taskId);
    await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
    await at.stopComputer();
    await at.restartHome();
    await at.restartComputer();
    await at.inReach(taskId);
    const home = at.home();
    starterLeft(home);
    let losing = true;
    let lost = 0;
    const ask = home.devices.ask.bind(home.devices);
    vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
      const answer = await ask(device, channel, args);
      const [open] = args as [{ spec?: { reattach?: boolean; model?: { id: string } } }];
      if (channel === "inf:session:open" && open.spec?.model?.id === SOL.id && losing) {
        if (open.spec.reattach !== true) {
          lost += 1;
          throw new DeviceOutOfReachError();
        }
      }
      return answer;
    });
    const requests = api.requests.length;
    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => lost).toBeGreaterThanOrEqual(1);
    const order = () => home.inbox.allFor(taskId).find((row) => row.text === "Carry on.");
    await home.supervisor.watch.sweepTaskLane(taskId, Date.now());
    expect(lost).toBeGreaterThanOrEqual(2);
    expect(order()).toMatchObject({ deliveredAt: null, attempts: 0 });
    expect(home.supervisor.moves.refusedThere(taskId)).toBe(true);
    expect(home.supervisor.moves.waitsForModel(taskId)).toBe(false);
    expect(api.requests.length).toBe(requests);

    losing = false;
    await home.supervisor.watch.sweepTaskLane(taskId, Date.now());
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("On GPT-6 Sol.");
    const sent = api.requests.slice(requests);
    expect(sent.map((request) => request.body.model)).toEqual([SOL.id]);
    expect(said(sent[0])).toContain("Carry on.");
    expect(rerouted(home, taskId)).toHaveLength(1);
  });

  // INF-5438 round 10 finding 4: only that computer's typed answer that the
  // open left nothing there passes GPT-6 Sol on its one account over, so the
  // task waits, said once; nothing reached the model.
  it("passes a model over only on that computer's answer that its open left nothing there", async () => {
    const at = await codexThere();
    const taskId = "t-not-opened";
    model([{ text: "Started on it." }]);
    await at.start(taskId);
    await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
    await at.stopComputer();
    await at.restartHome();
    await at.restartComputer();
    await at.inReach(taskId);
    const home = at.home();
    starterLeft(home);
    const notOpened: boolean[] = [];
    const ask = home.devices.ask.bind(home.devices);
    vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
      const [open] = args as [
        { spec?: { reattach?: boolean; notOpened?: boolean; model?: { id: string } } },
      ];
      if (
        channel === "inf:session:open" &&
        open.spec?.model?.id === SOL.id &&
        !open.spec.reattach
      ) {
        notOpened.push(open.spec.notOpened === true);
        // That computer's answer: no sign-in there could open it.
        return { notOpened: "No sign-in here could open GPT-6 Sol." };
      }
      return ask(device, channel, args);
    });
    const requests = api.requests.length;
    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => home.supervisor.moves.waitsForModel(taskId)).toBe(true);
    // It asked for that answer, once, and waits rather than open GPT-6 Sol again.
    expect(notOpened).toEqual([true]);
    expect(api.requests.length).toBe(requests);
    expect(rerouted(home, taskId)).toEqual([]);
  });

  // INF-5438 round 7 findings 8 and 12: a reopen whose open is not accepted
  // keeps orders from the conversation it opened; the next order after it
  // waits for the conversation the next turn opens, and reaches the model once.
  it("sends an order after a reopen that did not open only to the conversation opened next", async () => {
    const at = await world();
    const taskId = "t-after";
    model([{ text: "Started." }, { text: "Carrying on." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    vi.spyOn(home.supervisor, "reopenModel").mockResolvedValueOnce({
      model: { provider: PROVIDER, id: OTHER_MODEL },
      thinking: { level: "low" },
      commit: async () => "again" as const,
      passOver: vi.fn(),
    });
    const letGo = vi.spyOn(home.supervisor, "placedLetGo");
    const requests = api.requests.length;

    await at.restartComputer();
    await expect.poll(() => letGo.mock.calls.length).toBe(1);
    expect(api.requests.length).toBe(requests);
    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Carrying on.");
    expect(
      api.requests.slice(requests).map((request) => said(request).includes("Carry on.")),
    ).toEqual([true]);
    expect(home.inbox.allFor(taskId)).toEqual([]);
  });

  it("opens nothing there and lets the task go when no model can take it", async () => {
    const at = await world();
    const taskId = "t-waiting";
    model([{ text: "Started." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    vi.spyOn(home.supervisor, "reopenModel").mockResolvedValue("wait");
    const letGo = vi.spyOn(home.supervisor, "placedLetGo");
    const requests = api.requests.length;

    await at.restartComputer();
    await expect.poll(() => letGo.mock.calls.length).toBe(1);
    expect(letGo).toHaveBeenCalledWith(taskId);
    expect(api.requests.length).toBe(requests);
  });

  // INF-5438 finding 7: a conversation let go of while its turn is still out
  // there lets that turn end through its own end first, so its words are
  // answered once and none is lost with the session.
  it("lets a task go only once the turn it is in has ended", async () => {
    const at = await world();
    const taskId = "t-cut";
    const answer = gate();
    model([{ held: answer.held, text: "The footer is fixed." }]);
    try {
      await at.start(taskId);
      await expect.poll(() => api.openRequests()).toBe(1);
      const home = at.home();
      const released = vi.spyOn(home.supervisor.sessions, "releaseSession");

      home.supervisor.placedLetGo(taskId);
      expect(released).not.toHaveBeenCalled();
      answer.open();
      await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("The footer is fixed.");
      await expect.poll(() => released.mock.calls.length).toBe(1);
      // The brief its turn served is answered, not left on the lane.
      expect(home.inbox.allFor(taskId)).toEqual([]);
    } finally {
      answer.open();
    }
  });

  // INF-5438 finding 1: a resume asks the computer only to reattach first,
  // and routes only once it answers that no conversation is held there, so
  // nothing new opens on a model that left every level.
  it("routes a resumed task only after its computer answers that it holds no conversation", async () => {
    const at = await world();
    const taskId = "t-resumed";
    model([{ text: "Started on it." }, { text: "On the other model." }]);
    await at.start(taskId);
    await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
    await at.stopComputer();
    await at.restartHome();
    await at.restartComputer();
    await at.inReach(taskId);
    const home = at.home();
    const opens: { reattach: boolean; model?: string }[] = [];
    const ask = home.devices.ask.bind(home.devices);
    vi.spyOn(home.devices, "ask").mockImplementation((device, channel, args) => {
      if (channel === "inf:session:open") {
        const [open] = args as [{ spec: { reattach?: boolean; model?: { id: string } } }];
        opens.push({
          reattach: open.spec.reattach === true,
          ...(open.spec.model ? { model: open.spec.model.id } : {}),
        });
      }
      return ask(device, channel, args);
    });
    const commit = vi.fn(async () => "committed" as const);
    const routed = vi
      .spyOn(home.supervisor.moves, "routeAgainIfLeft")
      .mockImplementation(async () => {
        // Asked only once the computer said it holds nothing to reattach to.
        expect(opens).toEqual([{ reattach: true }]);
        return {
          model: { provider: PROVIDER, id: OTHER_MODEL },
          thinkingLevel: "low",
          providerName: "Stub",
          commit,
          passOver: () => {},
        };
      });

    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("On the other model.");
    expect(routed).toHaveBeenCalledTimes(1);
    // The one conversation opened anew opened on the model routing chose.
    expect(opens).toEqual([{ reattach: true }, { reattach: false, model: OTHER_MODEL }]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(api.requests.at(-1)?.body.model).toBe(OTHER_MODEL);
  });

  it("reattaches a resumed task to the conversation its computer holds, routing nothing", async () => {
    const at = await world();
    const taskId = "t-held";
    model([{ text: "Started on it." }, { text: "Still on the first model." }]);
    await at.start(taskId);
    await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
    // Only this Mac restarts: the computer still holds the idle conversation.
    await at.restartHome();
    await at.inReach(taskId);
    const home = at.home();
    const routed = vi.spyOn(home.supervisor.moves, "routeAgainIfLeft").mockResolvedValue({
      model: { provider: PROVIDER, id: OTHER_MODEL },
      thinkingLevel: "low",
      providerName: "Stub",
      commit: async () => "committed" as const,
      passOver: () => {},
    });

    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Still on the first model.");
    expect(routed).not.toHaveBeenCalled();
    expect(api.requests.at(-1)?.body.model).toBe(MODEL);
  });

  // INF-5438 round 6 finding 6: words sent while a reopen routes wait for
  // that open; one that does not open sends them nowhere, and they reach the
  // model once, in the conversation the next turn opens after the let-go.
  it("holds words sent while a reopen routes, and sends them only once a conversation opens", async () => {
    const at = await world();
    const taskId = "t-unready";
    model([{ text: "Started." }, { text: "Carrying on." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    const routing = gate();
    const asked = vi.spyOn(home.supervisor, "reopenModel").mockImplementation(async () => {
      await routing.held;
      // It opened, but routing changed meanwhile and picks again.
      return {
        model: { provider: PROVIDER, id: OTHER_MODEL },
        thinking: { level: "low" },
        commit: async () => "again" as const,
        passOver: vi.fn(),
      };
    });
    const requests = api.requests.length;
    const atLetGo: number[] = [];
    const letGo = home.supervisor.placedLetGo.bind(home.supervisor);
    vi.spyOn(home.supervisor, "placedLetGo").mockImplementation((id) => {
      atLetGo.push(api.requests.length);
      return letGo(id);
    });
    try {
      await at.restartComputer();
      await expect.poll(() => asked.mock.calls.length).toBe(1);
      await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
      routing.open();
      await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Carrying on.");
      // Nothing reached the model before the conversation that did not open was let go.
      expect(atLetGo[0]).toBe(requests);
      // One request carried the words: the one the new conversation answered.
      expect(
        api.requests.slice(requests).map((request) => said(request).includes("Carry on.")),
      ).toEqual([true]);
      expect(home.inbox.allFor(taskId)).toEqual([]);
    } finally {
      routing.open();
    }
  });

  // INF-5438 round 6 finding 4: the move records the account that computer
  // says it bound, never the one the home guessed.
  it("hands the move what that computer answers it opened on, never the account the home guessed", async () => {
    const at = await world();
    const taskId = "t-bound";
    model([{ text: "Started on it." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    const opened: { model?: unknown; accountId?: unknown }[] = [];
    const ask = home.devices.ask.bind(home.devices);
    vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
      const answer = await ask(device, channel, args);
      if (channel === "inf:session:open") {
        const state = (answer as { state?: { model?: unknown; accountId?: unknown } }).state;
        if (state) opened.push({ model: state.model, accountId: state.accountId });
      }
      return answer;
    });
    const commit = vi.fn(async () => "committed" as const);
    vi.spyOn(home.supervisor, "reopenModel").mockResolvedValue({
      model: { provider: PROVIDER, id: OTHER_MODEL },
      accountId: "a-guess-the-home-made",
      thinking: { level: "low" },
      commit,
      passOver: vi.fn(),
    });

    await at.restartComputer();
    await expect.poll(() => commit.mock.calls.length).toBe(1);
    const there = opened.at(-1);
    expect(there?.accountId).not.toBe("a-guess-the-home-made");
    expect(commit).toHaveBeenCalledWith({
      model: there?.model,
      ...(there?.accountId ? { account: there.accountId } : {}),
    });
  });

  // INF-5438 round 6 finding 5: an older computer reopens a conversation by
  // itself after it removes words from outside, on the model it had; while
  // that model may have left every level, it is asked nothing until it updates.
  it("asks an older computer no cleanup that would reopen a model that may have left every level", async () => {
    const older = CONTRACT_CHANGES.names.filter((name) => name !== "reattach-only-open");
    const at = await world(undefined, { changes: older });
    const taskId = "t-older";
    model([{ text: "Started." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    const record = home.tasks.get(taskId);
    if (!record) throw new Error("no task record");
    const orders: string[] = [];
    const ask = home.devices.ask.bind(home.devices);
    vi.spyOn(home.devices, "ask").mockImplementation((device, channel, args) => {
      orders.push(channel);
      return ask(device, channel, args);
    });
    // Gmail answers read over 30 days ago are due.
    const due = {
      kinds: [
        { label: "Gmail", until: Date.now() - 30 * 86_400_000, note: "[removed after 30 days]" },
      ],
      legacy: [],
    };
    const left = vi.spyOn(home.supervisor.moves, "mayRouteAgain").mockReturnValue(true);
    expect(await home.placed.deleteOutside(record, due)).toEqual({
      computer: expect.any(String),
      until: "update",
    });
    expect(orders).not.toContain("inf:session:delete-outside");
    // Once its model is held again, the order goes as before.
    left.mockReturnValue(false);
    expect(await home.placed.deleteOutside(record, due)).not.toEqual(
      expect.objectContaining({ until: "update" }),
    );
    expect(orders).toContain("inf:session:delete-outside");
  });

  // INF-5438 round 12 finding 3: an older computer may open the conversation
  // again before its cleanup answers: words sent meanwhile wait until it is
  // checked, and an answer lost leaves it refused and this Mac's session let go.
  it("sends no words to a conversation an older computer's cleanup opens before it is checked", async () => {
    const older = CONTRACT_CHANGES.names.filter((name) => name !== "reattach-only-open");
    const at = await world(undefined, { changes: older });
    const taskId = "t-older-cleanup";
    model([{ text: "Started." }, { text: "Carried on." }]);
    await at.start(taskId);
    const home = at.home();
    await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
    const record = home.tasks.get(taskId);
    if (!record) throw new Error("no task record");
    const due = {
      kinds: [
        { label: "Gmail", until: Date.now() - 30 * 86_400_000, note: "[removed after 30 days]" },
      ],
      legacy: [],
    };
    let release: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lose = false;
    const ask = home.devices.ask.bind(home.devices);
    vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
      const answer = await ask(device, channel, args);
      if (channel !== "inf:session:delete-outside") return answer;
      await answered;
      if (lose) throw new Error("The computer went before it answered.");
      return answer;
    });
    const requests = api.requests.length;
    const cleaning = home.placed.deleteOutside(record, due);
    await expect.poll(() => home.placed.refusedHeld(taskId)).toBe(true);
    const steered = home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The cleanup is still outstanding: nothing reached a model.
    expect(api.requests.length).toBe(requests);
    release();
    await cleaning;
    await steered;
    await expect.poll(() => said(api.requests.at(-1))).toContain("Carry on.");
    expect(api.requests.slice(requests).filter((r) => said(r).includes("Carry on."))).toHaveLength(
      1,
    );
    // Checked and accepted, it is refused no more.
    await expect.poll(() => home.placed.refusedHeld(taskId)).toBe(false);

    // An answer lost: what may have opened there stays refused, and this
    // Mac's session is let go, so the next words open a checked conversation.
    lose = true;
    const letGo = vi.spyOn(home.supervisor, "placedLetGo");
    await expect(home.placed.deleteOutside(record, due)).rejects.toThrow("went before");
    expect(home.placed.refusedHeld(taskId)).toBe(true);
    expect(letGo).toHaveBeenCalledWith(taskId);
  });
});
