import { describe, expect, it, vi } from "vitest";
import {
  api,
  gate,
  MODEL,
  model,
  OTHER_MODEL,
  PROVIDER,
  placedWorldHooks,
  type Step,
  said,
  world,
} from "../../../tests/helpers/placedWorld";
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
    const commit = vi.fn(() => true);
    const asked = vi.spyOn(home.supervisor, "reopenModel").mockResolvedValue({
      model: { provider: PROVIDER, id: OTHER_MODEL },
      thinking: { level: "off" },
      commit,
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
    const commit = vi.fn(() => true);
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
      commit: () => true,
    });

    await home.supervisor.steer.steerCrewmate(taskId, "Carry on.", "captain");
    await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Still on the first model.");
    expect(routed).not.toHaveBeenCalled();
    expect(api.requests.at(-1)?.body.model).toBe(MODEL);
  });
});
