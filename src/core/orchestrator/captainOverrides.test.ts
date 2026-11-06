/**
 * The captain's override as the crew records it (docs/delivery-rigor.md,
 * "The holds"; INF-1216, INF-1582, INF-1966; `CaptainOverrides`): the
 * words the first mate cites for it - their reply or their click on a card
 * of the task, their line in its Crewmate tab, or the override already
 * standing - each refusal when the record holds none, and the refusals of
 * a declaration and a withdrawal that have nothing to record. These cases
 * pin the behaviour no other test reaches. A click on a merge passing its
 * checks stays pinned by the kept merge approval's real-git cases in
 * crewSupervisor.test.ts. Each case drives a public door of the
 * supervisor or its overrides and reads its answer and the record.
 */

import { choiceWords, holdNames, STANDING_WORDS_FROM } from "@shared/holds";
import { CREWMATE_TAB_VIA } from "@shared/provenance";
import { describe, expect, it, vi } from "vitest";
import { fakeCrewmate, intentOf, setup, tick } from "../../../tests/helpers/crewHarness";
import { seedTask } from "../tasks/seedTask";

/** A started task with its crewmate between turns, and a second task beside it. */
async function startedTask() {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate);
  const { taskId } = await h.supervisor.intake.commission({
    title: "Fix the meter",
    intent: intentOf("fix the meter's unit"),
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
  crewmate.finishPrompt();
  await tick();
  seedTask(h.tasks, { id: "other", title: "Read the gauge", status: "completed" });
  return { ...h, crewmate, taskId, key: h.tasks.get(taskId)?.key ?? taskId };
}

/** The first mate's question on a task, with two plain answers. */
function question(h: Awaited<ReturnType<typeof startedTask>>, taskId: string, id: string): string {
  return h.supervisor.cards.addFirstmateCard({
    id,
    taskId,
    title: "Which unit first?",
    body: "<p>Two units to fix.</p>",
    actions: [
      { id: "watts", label: "Watts first", default: true },
      { id: "volts", label: "Volts first" },
    ],
  });
}

describe("the captain's override", () => {
  it("cites the captain's reply or his click on a card of the task, whichever came last", async () => {
    const h = await startedTask();
    const replied = question(h, h.taskId, "fm-replied");
    h.supervisor.replyToCard(replied, "  Do the volts first; skip the review.  ");
    expect(h.supervisor.overrides.citedCaptainWords(h.taskId, ` ${replied} `)).toEqual({
      ok: true,
      words: "Do the volts first; skip the review.",
    });
    const clicked = question(h, h.taskId, "fm-clicked");
    h.supervisor.replyToCard(clicked, "Either is fine.");
    h.supervisor.act(clicked, "volts");
    await tick();
    // His click came after his reply, and a plain answer approves no merge.
    expect(h.supervisor.overrides.citedCaptainWords(h.taskId, clicked)).toEqual({
      ok: true,
      words: choiceWords("Volts first", "Which unit first?"),
    });
  });

  it("refuses words from a card that is unknown, on another task, or holds none of the captain's", async () => {
    const h = await startedTask();
    const elsewhere = question(h, "other", "fm-elsewhere");
    const silent = question(h, h.taskId, "fm-silent");
    expect(h.supervisor.overrides.citedCaptainWords(h.taskId, "fm-nope")).toEqual({
      ok: false,
      text: `Override refused: nothing was recorded. There is no card "fm-nope"; pass from as the id of the card the captain replied under or clicked, ${CREWMATE_TAB_VIA}, or ${STANDING_WORDS_FROM}.`,
    });
    h.supervisor.replyToCard(elsewhere, "Skip the checks.");
    expect(h.supervisor.overrides.citedCaptainWords(h.taskId, elsewhere)).toEqual({
      ok: false,
      text: `Override refused: nothing was recorded. Card "Which unit first?" is not on ${h.key}, so the captain's words there pass nothing on it.`,
    });
    expect(h.supervisor.overrides.citedCaptainWords(h.taskId, silent)).toEqual({
      ok: false,
      text: `Override refused: nothing was recorded. The record holds no words of the captain's on card "Which unit first?": no reply in its thread and no click on its buttons.`,
    });
    expect(() => h.supervisor.overrides.citedCaptainWords("nope", silent)).toThrow(
      'Unknown task "nope".',
    );
  });

  it("cites the captain's newest line in the task's Crewmate tab, and refuses when he typed none", async () => {
    const h = await startedTask();
    expect(h.supervisor.overrides.citedCaptainWords(h.taskId, CREWMATE_TAB_VIA)).toEqual({
      ok: false,
      text: `Override refused: nothing was recorded. The record holds no words the captain typed in ${h.key}'s Crewmate tab.`,
    });
    await h.supervisor.steer.steerFromCrewmateTab(h.taskId, "  merge it without the review ");
    await tick();
    expect(h.supervisor.overrides.citedCaptainWords(h.taskId, CREWMATE_TAB_VIA)).toEqual({
      ok: true,
      words: "merge it without the review",
    });
  });

  it("cites the standing override's words, and refuses when none stands", async () => {
    const h = await startedTask();
    expect(h.supervisor.overrides.citedCaptainWords(h.taskId, STANDING_WORDS_FROM)).toEqual({
      ok: false,
      text: `Override refused: nothing was recorded. No override stands on ${h.key} at this version, so there are no recorded words of the captain's to name more holds with.`,
    });
    expect(
      h.supervisor.overrides.declareOverride(h.taskId, {
        words: "Skip the review on this one.",
        holds: ["waits"],
        until: "task",
      }).ok,
    ).toBe(true);
    expect(h.supervisor.overrides.citedCaptainWords(h.taskId, STANDING_WORDS_FROM)).toEqual({
      ok: true,
      words: "Skip the review on this one.",
    });
  });

  it("refuses a declaration with nothing to pass and a withdrawal with nothing to take back", async () => {
    const h = await startedTask();
    const handle = `${h.key} "Fix the meter"`;
    const declare = (
      input: Parameters<typeof h.supervisor.overrides.declareOverride>[1],
      taskId = h.taskId,
    ) => h.supervisor.overrides.declareOverride(taskId, input);

    expect(declare({ words: "go on", holds: [], until: "task" })).toEqual({
      ok: false,
      text: "Name at least one soft hold the captain's words pass.",
    });
    expect(declare({ words: "go on", holds: ["waits"], until: "version" })).toEqual({
      ok: false,
      text: `${handle} has no version yet, so an override for this version has nothing to cover. Declare until task if their words mean the whole task.`,
    });
    expect(h.supervisor.overrides.withdrawOverride(h.taskId)).toEqual({
      ok: false,
      text: `${handle} has no override to take back.`,
    });
    seedTask(h.tasks, { id: "dropped", title: "Drop the gauge", status: "cancelled" });
    expect(declare({ words: "go on", holds: ["waits"], until: "task" }, "dropped")).toEqual({
      ok: false,
      text: `${h.tasks.get("dropped")?.key || "dropped"} "Drop the gauge" is closed, so no hold is left to pass.`,
    });
    expect(() => declare({ words: "go on", holds: ["waits"], until: "task" }, "nope")).toThrow(
      'Unknown task "nope".',
    );
    expect(() => h.supervisor.overrides.withdrawOverride("nope")).toThrow('Unknown task "nope".');
    // Nothing was recorded on either task.
    expect(h.tasks.get(h.taskId)?.delivery?.override).toBeUndefined();
    expect(h.tasks.get("dropped")?.delivery?.override).toBeUndefined();
  });

  it("takes a standing override back, so the record and the crewmate's lane say it holds again", async () => {
    const h = await startedTask();
    const handle = `${h.key} "Fix the meter"`;
    h.supervisor.overrides.declareOverride(h.taskId, {
      words: "Skip the review on this one.",
      holds: ["waits", "waits"],
      until: "task",
    });
    expect(h.tasks.get(h.taskId)?.delivery?.override).toMatchObject({
      words: "Skip the review on this one.",
      holds: ["waits"],
      until: "task",
    });
    expect(h.supervisor.overrides.withdrawOverride(h.taskId)).toEqual({
      ok: true,
      text: `Took back the captain's override on ${handle}: ${holdNames(["waits"])} hold again.`,
    });
    expect(h.tasks.get(h.taskId)?.delivery?.override).toBeUndefined();
    // The crewmate's lane carries the standing words, then that he took them back.
    const notices = h.inbox
      .allFor(h.taskId)
      .flatMap((row) => (row.facts?.kind === "task-override-changed" ? [row.facts] : []));
    expect(notices).toMatchObject([
      { override: { words: "Skip the review on this one.", holds: ["waits"] } },
      { override: { words: "Skip the review on this one." }, withdrawn: true },
    ]);
    expect(h.supervisor.overrides.withdrawOverride(h.taskId)).toEqual({
      ok: false,
      text: `${handle} has no override to take back.`,
    });
  });
});
