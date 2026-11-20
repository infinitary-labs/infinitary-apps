import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import type { InboxRow } from "../storage/inboxStore";
import { TaskEventStore } from "../storage/taskEventStore";
import { renderWake } from "./wakes";

/**
 * Intent: the approved detector includes genuine captain text from either
 * author route. Drive the real Crewmate-tab producer, keeping its original
 * input before delivery normalization, while its existing delivery continues.
 * The disposable crewmate receives ordinary guidance; it does not classify it.
 */
fakeCrewTimersEachTest();

describe("captain input from the Crewmate tab", () => {
  it("retains original input on the accepted row before the author receives its existing guidance", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Review the proposed scope",
      intent: intentOf("Review the proposed scope"),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    const accepted: InboxRow[] = [];
    h.inbox.onEnqueue((row) => {
      if (row.recipient !== taskId || row.facts?.kind !== "crewmate-tab-line") return;
      expect(crewmate.steer).not.toHaveBeenCalled();
      accepted.push(row);
    });
    const original = "  For the next 3 reviews, keep the proposed scope unchanged.\n";
    expect(await h.supervisor.steer.steerFromCrewmateTab(taskId, original)).toEqual({ ok: true });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.facts).toEqual({
      kind: "crewmate-tab-line",
      words: original.trim(),
      captainText: original,
    });
    expect(crewmate.steer).toHaveBeenCalledWith(
      renderWake({ facts: { kind: "crewmate-tab-line", words: original.trim() } }),
      undefined,
      expect.stringMatching(/^rows:\d+:/),
    );
    const event = h.tasks.timeline(taskId).findLast((row) => row.kind === "steered");
    expect(event).toBeDefined();
    if (!event) throw new Error("The accepted steer has no task event.");
    const source = new TaskEventStore(h.db);
    expect(source.captainText(taskId, event.id)).toBe(original);
    expect(source.get(event.id)).not.toHaveProperty("captainText");
    expect(source.get(event.id)?.data).not.toHaveProperty("captainText");
    // The permanent source belongs to the task record, not a live delivery row.
    h.inbox.ack(accepted.map((row) => row.id));
    expect(source.captainText(taskId, event.id)).toBe(original);
    expect(source.captainText("another-task", event.id)).toBeUndefined();
    await h.supervisor.sessions.interruptCrewmate(taskId, "cancel");
    await tick();
  });

  it("records no input when the Crewmate tab refuses the send", async () => {
    const h = setup(fakeCrewmate());
    const accepted = vi.fn();
    h.inbox.onEnqueue(accepted);
    expect(
      await h.supervisor.steer.steerFromCrewmateTab("missing-task", "A correction"),
    ).toMatchObject({
      ok: false,
    });
    expect(await h.supervisor.steer.steerFromCrewmateTab("missing-task", "   ")).toMatchObject({
      ok: false,
    });
    expect(accepted).not.toHaveBeenCalled();
  });
});
