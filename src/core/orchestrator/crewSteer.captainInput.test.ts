import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { type CardNote, MARKED_PICTURES_LINE } from "@shared/cardNotes";
import type { TurnImage } from "@shared/cards";
import type { InboxRow } from "../storage/inboxStore";
import { TaskEventStore } from "../storage/taskEventStore";
import { renderWake, replyWordsSpan } from "./wakes";

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

  /**
   * Intent: the accepted Point at plan - with no card beside a running page, notes on it leave
   * from the crewmate's message box, with the pictures their marks are drawn on.
   */
  it("carries notes on the task's running page with their marked picture, with or without words", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Build the sign-up page",
      intent: intentOf("Build the sign-up page"),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    const note: CardNote = {
      start: 0,
      key: "page",
      kind: "page",
      excerpt: "Sign up",
      comment: "This should say what happens next",
      line: 1,
      place: { width: 1280, height: 800, box: { x: 40, y: 132, width: 47, height: 18 } },
      page: {
        url: "http://localhost:5173/sign-up",
        title: "Sign up",
        under: { role: "text", name: "Name" },
      },
    };
    // The one-pixel PNG a marked picture stands in as: the host reads its bytes, never its drawing.
    const picture: TurnImage = {
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      name: "marked-1.png",
    };
    const pointed =
      '- page "Sign up" (http://localhost:5173/sign-up), mark 1, box 40,132 47×18 in the 1280×800 picture, on text "Name": This should say what happens next';

    // Notes alone are a line: the box needs no words beside them.
    expect(
      await h.supervisor.steer.steerFromCrewmateTab(taskId, "", {
        notes: [note],
        images: [picture],
      }),
    ).toEqual({ ok: true });
    const bare = { kind: "crewmate-tab-line", words: "", notes: [note] } as const;
    const alone = renderWake({ facts: bare });
    const said = replyWordsSpan({ facts: bare });
    expect(said && alone.slice(said.from, said.to).split("\n")).toEqual([
      "Pointed at:",
      pointed,
      MARKED_PICTURES_LINE,
    ]);
    expect(said?.to).toBe(alone.length);
    expect(crewmate.steer).toHaveBeenLastCalledWith(
      alone,
      [expect.objectContaining({ mimeType: "image/png", data: picture.data })],
      expect.stringMatching(/^rows:\d+:/),
    );

    await h.supervisor.steer.steerFromCrewmateTab(taskId, " Fix the label too ", { notes: [note] });
    const facts = { kind: "crewmate-tab-line", words: "Fix the label too", notes: [note] } as const;
    const worded = renderWake({ facts });
    expect(crewmate.steer).toHaveBeenLastCalledWith(
      worded,
      undefined,
      expect.stringMatching(/^rows:\d+:/),
    );
    // What the record shows as the captain's line is the words and the notes, never the lead.
    const span = replyWordsSpan({ facts });
    expect(span && worded.slice(span.from, span.to).split("\n")).toEqual([
      "Fix the label too",
      "Pointed at:",
      pointed,
      MARKED_PICTURES_LINE,
    ]);
    await h.supervisor.sessions.interruptCrewmate(taskId, "cancel");
    await tick();
  });
});
