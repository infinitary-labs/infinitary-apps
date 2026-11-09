/**
 * What the captain already allowed (INF-3170 piece 2, docs/delivery-rigor.md
 * "What the captain already allowed"; the captain's pick on its plan card:
 * a yes carries to "That task, its reviewer, a stronger-model retry and a
 * takeover of its work"). A crewmate marks its yes action with `allows`;
 * the captain's own click on it is kept, quoted on the timeline, served on
 * the task's lane and in every later brief of the work it carries to, and
 * taken back only on the captain's words through the first mate. Each case
 * drives a public door - the crewmate's emit_card, a click, the first
 * mate's take-back - and reads the record and what a crewmate was served.
 */

import {
  ALREADY_ALLOWED_HEADING,
  allowanceRowWords,
  allowanceTakenBackWords,
  alreadyAllowedWords,
} from "@shared/captainAllowances";
import { choiceWords } from "@shared/holds";
import { describe, expect, it, vi } from "vitest";
import {
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { alreadyAllowed } from "../tasks/alreadyAllowed";
import { seedTask } from "../tasks/seedTask";

fakeCrewTimersEachTest();

/** Everything a crewmate was served: its turns' prompts and its mid-turn steers. */
function servedTo(crewmate: FakeCrewmate): string {
  return [
    ...crewmate.promptCalls,
    ...crewmate.steer.mock.calls.map((call) =>
      typeof call[0] === "string" ? call[0] : JSON.stringify(call[0]),
    ),
  ].join("\n");
}

const COVERS = "Signing in with your own GitHub account to run the sign-in check against it";
const TITLE = "Run the sign-in check on your account";

/** A started task whose crewmate asks for consent on a card, with its yes marked. */
async function askedConsent(crewmates: FakeCrewmate[] = []) {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate, { crewmates });
  const { taskId } = await h.supervisor.intake.commission({
    title: "Fix the sign-in check",
    intent: intentOf("fix the sign-in check"),
  });
  await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
  const shown = await h.specs[0]?.onCard?.({
    title: TITLE,
    body: "<p>The check needs your own account; it changes nothing on it.</p>",
    actions: [
      { id: "yes", label: "Use my account", default: true },
      { id: "no", label: "Not now" },
    ],
    allows: { action: "yes", covers: COVERS },
  });
  await endTurn(crewmate, taskId, "The sign-in check waits on your consent.");
  const card = h.supervisor.cards.snapshot().find((entry) => entry.taskId === taskId);
  if (!card) throw new Error(`the consent card did not go up: ${JSON.stringify(shown)}`);
  return { ...h, crewmate, taskId, card, key: h.tasks.get(taskId)?.key ?? taskId };
}

describe("a yes the captain gave on a crewmate's card", () => {
  it("is kept from the captain's own click, quoted on the timeline and served on the task's lane", async () => {
    const h = await askedConsent();
    // The card says what the yes is kept as before the captain clicks.
    expect(h.card.body).toContain("is kept as your yes to");
    expect(h.card.body).toContain(COVERS);

    h.supervisor.cardActions.act(h.card.id, "yes", "chrome", {
      answers: [
        { name: "anything_else", values: [], changed: true, written: "only for this check" },
      ],
    });
    await tick();
    const words = choiceWords("Use my account", TITLE, "only for this check");
    expect(h.tasks.get(h.taskId)?.delivery?.captainAllowances).toEqual([
      { words, covers: COVERS, card: h.card.id, at: expect.any(Number) },
    ]);
    expect(h.tasks.timeline(h.taskId).map((event) => event.text)).toContain(
      allowanceRowWords({ words, covers: COVERS }),
    );
    // The crewmate's next turn, which the choice starts, reads the whole list.
    const entry = h.tasks.get(h.taskId)?.delivery?.captainAllowances?.[0];
    if (!entry) throw new Error("the yes was not kept");
    await vi.waitFor(() =>
      expect(servedTo(h.crewmate)).toContain(
        alreadyAllowedWords({ allowances: [entry] }, "crewmate"),
      ),
    );
  });

  it("records nothing for the other action, or for a click that is not the captain's", async () => {
    const declined = await askedConsent();
    declined.supervisor.cardActions.act(declined.card.id, "no", "chrome");
    await tick();
    expect(declined.tasks.get(declined.taskId)?.delivery?.captainAllowances).toBeUndefined();

    const scripted = await askedConsent();
    scripted.supervisor.cardActions.act(scripted.card.id, "yes", "frame");
    await tick();
    expect(scripted.tasks.get(scripted.taskId)?.delivery?.captainAllowances).toBeUndefined();
  });

  it("is served in the brief of a stronger-model retry of the work", async () => {
    const retry = fakeCrewmate();
    const h = await askedConsent([retry]);
    h.supervisor.cardActions.act(h.card.id, "yes", "chrome");
    await tick();
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.intake.commission({
      title: "Fix the sign-in check again",
      intent: intentOf("fix the sign-in check"),
      shape: { escalate_from: h.key },
    });
    await vi.waitFor(() => expect(retry.promptCalls.length).toBeGreaterThan(0));
    const original = h.tasks.get(h.taskId);
    if (!original) throw new Error("the original task is gone");
    const [entry] = alreadyAllowed(h.tasks, original).allowances;
    if (!entry) throw new Error("the yes was not kept");
    expect(retry.promptCalls[0]).toContain(
      alreadyAllowedWords(
        {
          allowances: [{ ...entry, from: { key: h.key, title: "Fix the sign-in check" } }],
        },
        "crewmate",
      ),
    );
  });

  it("is taken back only through the first mate, which names its card", async () => {
    const h = await askedConsent();
    h.supervisor.cardActions.act(h.card.id, "yes", "chrome");
    await tick();
    expect(h.supervisor.overrides.withdrawAllowance(h.taskId, "card-unknown")).toMatchObject({
      ok: false,
    });
    expect(h.supervisor.overrides.withdrawAllowance(h.taskId, h.card.id)).toMatchObject({
      ok: true,
    });
    expect(h.tasks.get(h.taskId)?.delivery?.captainAllowances).toBeUndefined();
    const words = choiceWords("Use my account", TITLE);
    await vi.waitFor(() =>
      expect(servedTo(h.crewmate)).toContain(allowanceTakenBackWords({ words, covers: COVERS })),
    );
  });

  it("tells a running retry when the yes it read is taken back on the task it was given on", async () => {
    const retry = fakeCrewmate();
    const h = await askedConsent([retry]);
    h.supervisor.cardActions.act(h.card.id, "yes", "chrome");
    await tick();
    h.crewmate.finishPrompt();
    await tick();
    await h.supervisor.intake.commission({
      title: "Fix the sign-in check again",
      intent: intentOf("fix the sign-in check"),
      shape: { escalate_from: h.key },
    });
    await vi.waitFor(() => expect(retry.promptCalls.length).toBeGreaterThan(0));
    // The first mate names the task the yes was given on, not the retry.
    expect(h.supervisor.overrides.withdrawAllowance(h.taskId, h.card.id)).toMatchObject({
      ok: true,
    });
    const words = choiceWords("Use my account", TITLE);
    await vi.waitFor(() =>
      expect(servedTo(retry)).toContain(allowanceTakenBackWords({ words, covers: COVERS })),
    );
  });

  it("tells a running task that now carries on the work the yes was given on, and nothing for a link with no yes", async () => {
    const carrier = fakeCrewmate();
    const h = await askedConsent([carrier]);
    const { taskId: carrierId } = await h.supervisor.intake.commission({
      title: "Carry the sign-in fix on",
      intent: intentOf("carry the sign-in fix on"),
    });
    await vi.waitFor(() => expect(carrier.promptCalls).toHaveLength(1));
    const quiet = seedTask(h.tasks, {
      id: "quiet",
      title: "Nothing allowed here",
      status: "running",
    });
    h.tasks.graph.link(quiet.id, carrierId, "replaced-by", "firstmate");
    await tick();
    expect(servedTo(carrier)).not.toContain(ALREADY_ALLOWED_HEADING);

    h.supervisor.cardActions.act(h.card.id, "yes", "chrome");
    await tick();
    h.tasks.graph.link(h.taskId, carrierId, "replaced-by", "firstmate");
    const record = h.tasks.get(carrierId);
    if (!record) throw new Error("the carrier is gone");
    const served = alreadyAllowedWords(alreadyAllowed(h.tasks, record), "crewmate");
    expect(served).toContain(`on ${h.key} "Fix the sign-in check", whose work this is`);
    await vi.waitFor(() => expect(servedTo(carrier)).toContain(served));
  });

  it("refuses a mark on an action with an effect, on an action the card lacks, and with nothing it covers", async () => {
    const crewmate = fakeCrewmate();
    const h = setup(crewmate);
    await h.supervisor.intake.commission({
      title: "Fix the sign-in check",
      intent: intentOf("fix the sign-in check"),
    });
    await vi.waitFor(() => expect(crewmate.promptCalls).toHaveLength(1));
    const emit = (allows: { action: string; covers: string }) =>
      h.specs[0]?.onCard?.({
        title: TITLE,
        body: "<p>The check needs your own account.</p>",
        actions: [
          { id: "yes", label: "Use my account", default: true },
          { id: "drop", label: "Drop it", effect: { kind: "settle", mode: "discard" } },
        ],
        allows,
      });
    const refusal = async (allows: { action: string; covers: string }) => {
      try {
        await emit(allows);
        return "shown";
      } catch (caught) {
        return (caught as Error).message;
      }
    };
    expect(await refusal({ action: "drop", covers: COVERS })).toContain("not an ordinary action");
    expect(await refusal({ action: "maybe", covers: COVERS })).toContain("not an ordinary action");
    expect(await refusal({ action: "yes", covers: " " })).toContain("allows needs covers");
  });
});

describe("the work a yes carries to", () => {
  it("reaches a takeover and a stronger-model retry through earlier tasks, never a follow-up a merge filed", () => {
    const h = setup(fakeCrewmate());
    const given = seedTask(h.tasks, {
      id: "given",
      title: "Fix the sign-in check",
      status: "running",
    });
    h.tasks.delivery.recordAllowance(given.id, {
      words: "Use my account",
      covers: COVERS,
      card: "card-1",
      at: 1,
    });
    const takeover = seedTask(h.tasks, {
      id: "takeover",
      title: "Carry the fix on",
      status: "running",
    });
    h.tasks.graph.link(given.id, takeover.id, "replaced-by", "firstmate");
    // The task the yes was given on closes; its yes stays for the work that carries it on.
    h.tasks.close(given.id, { status: "dropped", reason: "cancelled", actor: "firstmate" });
    const retry = seedTask(h.tasks, {
      id: "retry",
      title: "Retry the carried fix",
      status: "queued",
      shape: { kind: "fix", escalate_from: takeover.key },
    });
    const followUp = seedTask(h.tasks, {
      id: "follow-up",
      title: "Tidy the sign-in copy",
      status: "queued",
    });
    h.tasks.graph.link(followUp.id, given.id, "discovered-from", "crewmate");

    const carried = (id: string) => {
      const record = h.tasks.get(id);
      if (!record) throw new Error(`no task ${id}`);
      return alreadyAllowed(h.tasks, record).allowances.map((entry) => ({
        covers: entry.covers,
        from: entry.from?.key,
      }));
    };
    expect(carried(given.id)).toEqual([{ covers: COVERS, from: undefined }]);
    expect(carried(takeover.id)).toEqual([{ covers: COVERS, from: given.key }]);
    expect(carried(retry.id)).toEqual([{ covers: COVERS, from: given.key }]);
    expect(carried(followUp.id)).toEqual([]);
  });

  it("reaches a Take over filing that continues the task's branch, linked only related and blocks (the captain's \"Count branch takeovers\")", () => {
    const h = setup(fakeCrewmate());
    const given = seedTask(h.tasks, {
      id: "given",
      title: "Fix the sign-in check",
      status: "running",
    });
    h.tasks.delivery.recordAllowance(given.id, {
      words: "Use my account",
      covers: COVERS,
      card: "card-1",
      at: 1,
    });
    const takeOver = seedTask(h.tasks, {
      id: "take-over",
      title: "Take over: my branch",
      status: "queued",
      shape: { kind: "fix", branch_from: given.key },
    });
    h.tasks.graph.link(takeOver.id, given.id, "related", "firstmate");
    h.tasks.graph.link(given.id, takeOver.id, "blocks", "firstmate");
    const record = h.tasks.get(takeOver.id);
    if (!record) throw new Error("no take-over task");
    expect(
      alreadyAllowed(h.tasks, record).allowances.map((entry) => ({
        covers: entry.covers,
        from: entry.from?.key,
      })),
    ).toEqual([{ covers: COVERS, from: given.key }]);
  });
});
