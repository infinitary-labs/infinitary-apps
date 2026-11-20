import { describe, expect, it, vi } from "vitest";
import {
  api,
  gate,
  model,
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
