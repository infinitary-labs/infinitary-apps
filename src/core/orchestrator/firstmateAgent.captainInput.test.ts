import { describe, expect, it } from "vitest";
import { drained, fakeClockEachTest, setup, tick } from "../../../tests/helpers/firstmateHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { prepareComposerTurn } from "../composerTurn";
import { initOverflowDir } from "../overflow";

/**
 * Intent: the approved correction detector may use only new captain-written
 * input, not attached files or a replay of accepted work. These disposable
 * submissions use the real composer producer, agent and SQLite ask owner.
 * Classification quality and provider access are not simulated here.
 */
fakeClockEachTest();

describe("original composer input", () => {
  it("keeps the caption before file decoration while delivering the attachment to its author", async () => {
    const h = setup();
    initOverflowDir(scratchDir("composer-caption-overflow-"));
    const caption = "For the next four reviews here, show the wording before keeping it.";
    const attached = "An attached example is not a captain instruction.";
    const turn = prepareComposerTurn({
      text: caption,
      files: [{ name: "example.txt", text: attached }],
    });
    await h.agent.converse(turn);
    await drained(h.session, 1);
    const id = h.tasks.capture.latestAskId();
    expect(id).toBeDefined();
    expect(h.tasks.capture.captainAskText(id ?? "")).toBe(caption);
    expect(h.tasks.capture.getAsk(id ?? "")?.text).toBe(turn.text);
    expect(h.session.prompts.join("\n")).toContain(attached);
  });

  it("records a file-only submission as known empty text, not an inferred caption", async () => {
    const h = setup();
    initOverflowDir(scratchDir("composer-file-only-"));
    await h.agent.converse(
      prepareComposerTurn({
        files: [{ name: "example.txt", text: "Attached reference material." }],
      }),
    );
    await drained(h.session, 1);
    const id = h.tasks.capture.latestAskId();
    expect(id).toBeDefined();
    expect(h.tasks.capture.captainAskText(id ?? "")).toBe("");
  });

  it("does not admit a retry as a second new correction", async () => {
    const h = setup();
    const turn = prepareComposerTurn("Keep verification summaries brief for later work here.");
    await h.agent.converse(turn);
    await drained(h.session, 1);
    const original = h.tasks.capture.latestAskId();
    expect(h.tasks.capture.captainAskText(original ?? "")).toBe(turn.captainText);
    h.supervisor.hostOps.runHostOp({ kind: "host", op: "retry-firstmate" });
    await tick();
    const retry = h.tasks.capture.latestAskId();
    expect(retry).toBeDefined();
    expect(retry).toBe(original);
    expect(h.tasks.capture.captainAskText(retry ?? "")).toBe(turn.captainText);
    expect(h.tasks.capture.getAsk(retry ?? "")?.text).toBe(turn.text);
  });
});
