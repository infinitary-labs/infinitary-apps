/**
 * INF-5608's approved plan, piece 1 (`choice-attachments.md`): the captain
 * asked that "attachments and queued annotations" in a card's field go "along
 * with an action button click", not only as a pure reply. Each case drives a
 * real CrewSupervisor through the crew harness and reads where one press's
 * notes, files and pictures arrive, per kind of button.
 */
import type { CardNote } from "@shared/cardNotes";
import { type Card, choiceCarriedRecordSchema, withAnythingElse } from "@shared/cards";
import { describe, expect, it } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { initAttachmentsDir } from "../attachments";
import { initOverflowDir } from "../overflow";
import { EMIT_CARD_TOOL } from "../pi/cardTool";
import { bindTool } from "../session/tools";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import type { CrewmateSpec } from "./crewSession";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

// The smallest real PNG: one transparent pixel.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HJ3AAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=";

const note: CardNote = {
  start: 0,
  key: "p:0",
  kind: "paragraph",
  excerpt: "Keep the current layout",
  comment: "Use the wider column here",
  line: 1,
};

/** One press's field: the words, a queued note, a pasted file and a picture. */
function fieldValue(words = "Ship it this week") {
  return {
    answers: withAnythingElse([], words),
    notes: [note],
    files: [{ name: "crash.log", text: "panic: the window closed before it drew" }],
    images: [{ mimeType: "image/png", data: PIXEL, name: "screen.png" }],
  };
}

function prepared() {
  initAttachmentsDir(scratchDir("choice-attachments-"));
  initOverflowDir(scratchDir("choice-overflow-"));
}

async function crewmateCard() {
  prepared();
  const crewmate = fakeCrewmate();
  const h = setup(crewmate);
  const { taskId } = await h.supervisor.intake.commission({
    title: "Redesign the settings page",
    intent: intentOf("redesign the settings page"),
  });
  await tick();
  const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
  await emitCard.run({
    title: "Which layout should the settings page use",
    body: "<p>Keep the current layout, or move to two columns.</p>",
    actions: [
      { id: "two", label: "Two columns", default: true },
      { id: "keep", label: "Keep it" },
    ],
  });
  crewmate.emit({ type: "turn_end", taskId });
  crewmate.finishPrompt();
  await tick();
  const card = h.cardStore.listOpen().find((entry) => entry.taskId === taskId) as Card;
  return { ...h, crewmate, taskId, card };
}

/** The turn a crewmate was handed last, whether a steer or a new prompt: its words and pictures. */
function lastHeard(crewmate: ReturnType<typeof fakeCrewmate>) {
  const steered = crewmate.steer.mock.calls.at(-1);
  if (steered) return { text: steered[0], images: steered[1] };
  return { text: crewmate.promptCalls.at(-1) ?? "", images: crewmate.promptImageCalls.at(-1) };
}

/** The `carried` record the captain's last action on a card kept. */
function keptOnAction(h: { cardStore: { observations: (id: string) => unknown[] } }, id: string) {
  const action = (h.cardStore.observations(id) as { kind: string; payload: unknown }[])
    .filter((event) => event.kind === "action")
    .at(-1);
  return choiceCarriedRecordSchema.parse(
    (action?.payload as { carried?: unknown } | undefined)?.carried,
  );
}

describe("a card button carries what waits in the card's field", () => {
  it("brings a crewmate's choice message its words, note, file and picture in one steer", async () => {
    const h = await crewmateCard();
    const prompts = h.crewmate.promptCalls.length;
    h.supervisor.cardActions.act(h.card.id, "two", "chrome", fieldValue());
    await tick();
    expect(h.crewmate.steer.mock.calls.length + h.crewmate.promptCalls.length - prompts).toBe(1);
    const { text, images } = lastHeard(h.crewmate);
    expect(text).toContain('chose "Two columns"');
    expect(text).toContain("Ship it this week");
    expect(text).toContain("Use the wider column here");
    expect(text).toContain("panic: the window closed before it drew");
    expect(text).toContain("[attached: 1 picture: screen.png]");
    expect(images).toEqual([expect.objectContaining({ mimeType: "image/png", data: PIXEL })]);
    // The record keeps the note, the file's words and its own copy of the picture.
    const kept = keptOnAction(h, h.card.id);
    expect(kept.notes).toEqual([note]);
    expect(kept.files).toContain("panic: the window closed before it drew");
    expect(kept.pictures).toHaveLength(1);
  });

  it("brings a first mate card's choice turn the same, its picture by reference on the row", () => {
    prepared();
    const h = setup(fakeCrewmate());
    const id = h.supervisor.cards.addFirstmateCard({
      id: "fm-layout",
      title: "Pick the settings layout",
      body: "<p>Keep the current layout, or move to two columns.</p>",
      actions: [
        { id: "two", label: "Two columns", default: true },
        { id: "keep", label: "Keep it" },
      ],
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    const before = h.ops.length;
    h.supervisor.cardActions.act(id, "two", "chrome", fieldValue());
    const told = h.ops.slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("Two columns");
    expect(told[0]).toContain("Use the wider column here");
    expect(told[0]).toContain("panic: the window closed before it drew");
    expect(told[0]).toContain("[attached: 1 picture: screen.png]");
    expect(told[0]).not.toContain("The app already carried out this choice");
  });

  it("tells the first mate once when the app carries the choice out itself", () => {
    prepared();
    const h = setup(fakeCrewmate());
    const id = h.supervisor.cards.addFirstmateCard({
      id: "fm-settings",
      title: "Open Settings to sign in again",
      body: "<p>Your sign-in ended.</p>",
      actions: [
        {
          id: "open",
          label: "Open Settings",
          default: true,
          effect: { kind: "open", target: "settings" },
        },
        { id: "later", label: "Later" },
      ],
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    const before = h.ops.length;
    const result = h.supervisor.cardActions.act(
      id,
      "open",
      "chrome",
      fieldValue("Use the work account"),
    );
    expect(result.effect).toMatchObject({ kind: "open", target: "settings" });
    const told = h.ops.slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("The app already carried out this choice");
    expect(told[0]).toContain("Use the wider column here");
    expect(told[0]).toContain("[attached: 1 picture: screen.png]");
  });

  it("keeps what went with an answer's closing choice for the first mate's notice and the builder", async () => {
    prepared();
    const crewmate = fakeCrewmate();
    const builder = fakeCrewmate();
    const h = setup(crewmate, {
      crewmates: [builder],
      classifier: {
        classify: async (input) =>
          input.title.startsWith("Plan")
            ? ({ kind: "research", source: "classifier:test", version: "kc1" } as const)
            : ({ kind: "implement", source: "classifier:test", version: "kc1" } as const),
      },
    });
    const { taskId } = await h.supervisor.intake.commission({
      title: "Plan the settings page redesign",
      intent: {
        ...intentOf("plan how the settings page should look"),
        constraints: [{ kind: "read-only" }],
      },
    });
    await tick();
    const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
    await emitCard.run({
      title: "Two columns for the settings page",
      body: "<p>Keep the current layout, or move to two columns.</p>",
      actions: [
        { id: "build", label: "Approve and build", default: true },
        { id: "defer", label: "Save and defer" },
      ],
    });
    h.specs.at(-1)?.onReport?.("The plan is on its card.");
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const card = h.cardStore.listOpen().find((entry) => entry.taskId === taskId) as Card;
    h.supervisor.cardActions.act(card.id, "build", "chrome", fieldValue());
    await tick();
    expect(h.tasks.get(taskId)?.status).toBe("done");
    // The first mate's closing notice, as its lane serves it.
    const notice =
      h.inbox
        .allFor(FIRSTMATE_RECIPIENT)
        .filter((row) => (row.facts as { kind?: string } | undefined)?.kind === "answer-closed")
        .map((row) => renderWake(row))
        .at(-1) ?? "";
    expect(notice).toContain("Use the wider column here");
    expect(notice).toContain("panic: the window closed before it drew");
    expect(notice).toContain("[attached: 1 picture: screen.png]");
    // The builder's brief reads the notes after the answers, and carries the picture.
    await h.supervisor.intake.commission({
      title: "Build the two-column settings page",
      intent: intentOf("build it"),
      shape: { basis: h.tasks.get(taskId)?.key ?? taskId },
    });
    await tick();
    // Its picture is read back from disk, real I/O the fake clock does not wait on.
    for (let i = 0; i < 50 && builder.promptCalls.length === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await tick();
    }
    const brief = builder.promptCalls[0] ?? "";
    expect(brief).toContain("What the captain sent with that choice:");
    expect(brief.indexOf("Use the wider column here")).toBeGreaterThan(
      brief.indexOf("Ship it this week"),
    );
    expect(brief).toContain("panic: the window closed before it drew");
    expect(builder.promptImageCalls[0]).toEqual([expect.objectContaining({ data: PIXEL })]);
  });

  it("sends a note's Got it with the field as the reply under the note", async () => {
    prepared();
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    const { taskId } = await h.supervisor.intake.commission({
      title: "Redesign the settings page",
      intent: intentOf("redesign the settings page"),
    });
    await tick();
    const emitCard = bindTool(EMIT_CARD_TOOL, h.specs.at(-1) as CrewmateSpec);
    await emitCard.run({
      title: "The settings page now uses two columns",
      body: "<p>Keep the current layout was replaced by two columns.</p>",
    });
    crewmate.emit({ type: "turn_end", taskId });
    crewmate.finishPrompt();
    await tick();
    const card = h.cardStore.listOpen().find((entry) => entry.taskId === taskId) as Card;
    h.supervisor.pressNote(card.id, undefined, fieldValue("Looks right"));
    await tick();
    const thread = h.supervisor.cards.thread(card.id).messages;
    expect(thread.at(-1)).toMatchObject({ who: "captain", notes: [note] });
    expect(thread.at(-1)?.text).toContain("Looks right");
    expect(thread.at(-1)?.text).toContain("[attached 1 picture: screen.png]");
    const heard = lastHeard(crewmate);
    expect(heard.text).toContain("Looks right");
    expect(heard.text).toContain("panic: the window closed before it drew");
    expect(heard.text).toContain("Use the wider column here");
    expect(heard.images).toEqual([expect.objectContaining({ data: PIXEL })]);
  });
});
