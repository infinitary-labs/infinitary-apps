import { type Card, RISK_DIMENSIONS } from "@shared/cards";
import { changePresentationSchema } from "@shared/changePresentation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CardStore } from "../storage/cardStore";
import { openInMemoryDatabase } from "../storage/db";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { cardMutationText } from "./cardMutationText";
import { CardService } from "./cardService";
import { requiredActionCard } from "./requiredActionCard";

/**
 * Shared cards (INF-2214's approved second piece, carried out by INF-2225;
 * docs/card-threads.md "Shared cards", docs/required-actions.md "Correcting
 * the words"). The captain approved that any crewmate or first mate may
 * write on a card without a per-card grant, recorded as itself, while the
 * card keeps its author, task, lifecycle and answerer; that a final answer
 * names the captain message it ends; and that a receipt says only what the
 * host saved. The required action is DOP-217's: its words named a remover
 * the captain could not find on the PC.
 */

const REMOVER = "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd";

function setup() {
  const db = openInMemoryDatabase();
  const now = () => 1_000;
  const tasks = new TaskService({ db, strict: true, now });
  const cardStore = new CardStore(db);
  const pushes: Card[][] = [];
  const cards = new CardService({
    now,
    tasks,
    cardStore,
    syncCaptainGate: () => {},
    closeAnsweredTask: () => false,
    settleFacts: () => undefined,
    followupNotice: () => undefined,
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
    broadcastCards: (shown) => pushes.push(shown),
  });
  seedTask(tasks, { id: "t1", title: "Retire the shell PC job host", status: "idle" });
  seedTask(tasks, { id: "t2", title: "Find the remover", status: "idle" });
  return {
    db,
    tasks,
    cardStore,
    cards,
    pushes,
  };
}

const t2 = { actor: "crewmate", taskId: "t2" } as const;
const firstmate = { actor: "firstmate" } as const;

/** A crewmate note on t1, on the captain's stage. */
function noteOnT1(cards: CardService): string {
  const id = cards.emitCrewmateCard(
    "t1",
    {
      title: "Run the job host remover",
      body: "<p>Run the remover on the shell PC.</p>",
      actions: [],
    },
    "m",
  );
  cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
  return id;
}

/** The DOP-217 required action, filed from a completed source task and shown. */
function requiredAction(f: ReturnType<typeof setup>) {
  seedTask(f.tasks, { id: "dop208", title: "Retire the job host", status: "completed" });
  f.tasks.delivery.declareRequiredActions(
    "dop208",
    {
      cardId: "card-dop208-1",
      offerId: "offer-1",
      actions: [
        {
          id: "remove-job-host",
          target: "the shell PC",
          title: "Remove the job host from the shell PC",
          consequence: "Until then the old job host keeps taking fleet checks on that PC.",
          instructions: ["Run C:\\FleetCheck\\remove-job-host.cmd as an administrator."],
          criterion: "The PC no longer lists the job host service.",
          prerequisites: [],
          completion: { kind: "manual", label: "I removed it" },
        },
      ],
    },
    true,
  );
  const row = f.tasks.listOpen().find((task) => task.delivery?.captainAction);
  if (!row) throw new Error("no required action");
  const action = f.tasks.delivery.presentCaptainAction(row.id);
  if (!action) throw new Error("not presented");
  f.cards.put(requiredActionCard(row.id, action, 1_000, { filedFrom: () => "DOP-208" }));
  return { taskId: row.id, cardId: action.cardId };
}

describe("shared cards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("revises another task's card as its true writer, keeping its author, task, lifecycle and answerer", () => {
    const f = setup();
    const id = noteOnT1(f.cards);
    const before = f.cards.get(id) as Card;
    const read = f.cards.cardRead(id);
    expect(read).toMatchObject({ id, author: "crewmate", open: true, revision: before.offerId });

    const result = f.cards.contribute(
      t2,
      { id, title: "Run the job host remover", body: `<p>Run ${REMOVER}.</p>`, actions: [] },
      { expectedRevision: read?.revision, reason: "The remover's path was missing" },
    );
    const key = f.tasks.get("t2")?.key;
    expect(result).toMatchObject({
      effect: "revised",
      cardId: id,
      contributor: { actor: "crewmate", taskId: "t2", label: `the crewmate on ${key}` },
      unchanged: ["author", "task", "lifecycle", "answerer"],
      display: "held",
    });
    const after = f.cards.get(id) as Card;
    expect(after).toMatchObject({
      author: "crewmate",
      taskId: "t1",
      lifecycleId: before.lifecycleId,
      body: `<p>Run ${REMOVER}.</p>`,
    });
    expect(after.offerId).not.toBe(before.offerId);
    expect(f.cards.thread(id).messages).toMatchObject([
      { who: "host", text: "revised: Run the job host remover", contributor: { taskId: "t2" } },
    ]);
    // The receipt says what was saved and when the captain sees it.
    expect(cardMutationText(result)).toContain(
      `Revised card "Run the job host remover" (${id}) as the crewmate on ${key}.`,
    );
    expect(cardMutationText(result)).toContain(
      "The captain sees the new version when your turn ends.",
    );

    // The stage keeps the version the captain had until the writer's own
    // turn ends; the card's author closing out does not release it.
    expect(f.cards.shown(id)?.body).toBe(before.body);
    f.cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(f.cards.shown(id)?.body).toBe(before.body);
    f.cards.closeOut({ kind: "crewmate", taskId: "t2" }, "idle");
    expect(f.cards.shown(id)?.body).toBe(after.body);
  });

  it("refuses a stale revision with the current one, and writes nothing", () => {
    const f = setup();
    const id = noteOnT1(f.cards);
    const read = f.cards.cardRead(id);
    f.cards.contribute(
      firstmate,
      { id, title: "Run the remover", body: "<p>First fix.</p>", actions: [] },
      { expectedRevision: read?.revision },
    );
    const current = f.cards.get(id) as Card;
    const lines = f.cards.thread(id).messages.length;

    const stale = f.cards.contribute(
      t2,
      { id, title: "Run the remover", body: "<p>Second fix.</p>", actions: [] },
      { expectedRevision: read?.revision },
    );
    expect(stale).toMatchObject({ effect: "refused", revision: current.offerId });
    expect(cardMutationText(stale)).toMatch(/^Nothing changed on card .*Its current revision is /);
    expect(f.cards.get(id)).toEqual(current);
    expect(f.cards.thread(id).messages).toHaveLength(lines);
  });

  it("returns the first result again for the same operation identity, writing once", () => {
    const f = setup();
    const id = noteOnT1(f.cards);
    const read = f.cards.cardRead(id);
    const write = () =>
      f.cards.contribute(
        t2,
        { id, title: "Run the remover", body: `<p>Run ${REMOVER}.</p>`, actions: [] },
        { expectedRevision: read?.revision, operationId: "op-remover-path" },
      );
    const first = write();
    const revised = f.cards.get(id) as Card;
    const again = write();
    expect(again).toEqual({ ...first, repeated: true });
    expect(cardMutationText(again)).toMatch(/^This operation identity already ran/);
    expect(f.cards.get(id)).toEqual(revised);
    expect(f.cards.thread(id).messages).toHaveLength(1);
    // The identity belongs to the card it wrote on.
    const other = noteOnT1(f.cards);
    expect(
      f.cards.replyAs(t2, { cardId: other, text: "Same here.", operationId: "op-remover-path" }),
    ).toMatchObject({ effect: "refused" });
  });

  it("ends only the captain message a line names, and a queued answerer then hears that answer", () => {
    const f = setup();
    const id = noteOnT1(f.cards);
    const asked = f.cards.addMessage(id, "captain", "Where is the remover?");
    const card = f.cards.get(id) as Card;
    expect(card.awaiting).toBe("answer");
    expect(f.cards.cardRead(id)?.waitingOn).toEqual({
      messageId: asked.id,
      text: "Where is the remover?",
    });

    // A comment from someone else ends nothing.
    const comment = f.cards.replyAs(t2, { cardId: id, text: "Looking into it." });
    expect(comment).toMatchObject({ effect: "reply-only" });
    expect(comment.answered).toBeUndefined();
    expect(f.cards.get(id)?.awaiting).toBe("answer");

    // A message id that is no captain message on this card is refused.
    expect(
      f.cards.replyAs(t2, { cardId: id, text: "It is here.", answersMessage: comment.replyId }),
    ).toMatchObject({ effect: "refused" });

    const answer = f.cards.replyAs(t2, {
      cardId: id,
      text: `It is at ${REMOVER}.`,
      answersMessage: asked.id,
    });
    expect(answer).toMatchObject({ effect: "reply-only", answered: asked.id });
    expect(cardMutationText(answer)).toContain(
      `it answers the captain's message ${asked.id} and ends that question`,
    );
    expect(f.cards.get(id)?.awaiting).not.toBe("answer");
    expect(f.cards.answeredByContributor(id, asked.id)?.text).toBe(`It is at ${REMOVER}.`);

    // The card's own crewmate, queued behind that answer, hears it: its
    // line is a comment, and the question is not answered twice.
    const late = f.cards.replyAs(
      { actor: "crewmate", taskId: "t1" },
      { cardId: id, text: "The remover is on the share." },
    );
    expect(late).toMatchObject({
      effect: "reply-only",
      alreadyAnswered: { messageId: asked.id, text: `It is at ${REMOVER}.` },
    });
    expect(late.answered).toBeUndefined();
    const lines = f.cards.thread(id).messages;
    expect(lines.filter((line) => line.answersMessage === asked.id)).toHaveLength(1);
  });

  it("leaves the question open after its author's handoff line, and ends it with the line that names it", () => {
    // The captain's choice on handoff-ends-question: "Only a line that says
    // it answers it; a handoff stays open".
    const f = setup();
    const id = noteOnT1(f.cards);
    const asked = f.cards.addMessage(id, "captain", "Where is the remover?");
    expect(
      f.cards.replyFromCrewmate("t1", { cardId: id, text: "I asked the shell PC task to look." }),
    ).toContain(`The captain's message ${asked.id} still waits`);
    expect(f.cards.get(id)?.awaiting).toBe("answer");
    // A revision whose reply names nothing is refused (INF-2884), and one
    // marked a progress note leaves it open too.
    const title = (f.cards.get(id) as Card).title;
    const body = "<p>Looking for the remover.</p>";
    const revision = { id, title, body, actions: [], reply: "Updated it." };
    expect(() => f.cards.emitCrewmateCard("t1", revision, "m")).toThrow(
      `answers_message ${asked.id}`,
    );
    f.cards.emitCrewmateCard("t1", { ...revision, interim: true }, "m");
    expect(f.cards.get(id)?.awaiting).toBe("answer");

    expect(
      f.cards.replyFromCrewmate("t1", {
        cardId: id,
        text: `It is at ${REMOVER}.`,
        answersMessage: asked.id,
      }),
    ).toContain(`It answers the captain's message ${asked.id}.`);
    expect(f.cards.get(id)?.awaiting).toBe("close-out");
    const answers = f.cards.thread(id).messages.filter((line) => line.answersMessage === asked.id);
    expect(answers.map((line) => line.text)).toEqual([`It is at ${REMOVER}.`]);
  });

  it("ends the author's own turn holds while another writer's revision waits, and that writer's turn end releases the card", () => {
    // INF-2555: the author's close-out skipped a card another writer had
    // revised, so its answer stayed held and its next revision was refused.
    const f = setup();
    const id = noteOnT1(f.cards);
    const before = f.cards.get(id) as Card;
    f.cards.contribute(
      t2,
      { id, title: before.title, body: `<p>Run ${REMOVER}.</p>`, actions: [] },
      { expectedRevision: before.offerId, reason: "The remover's path was missing" },
    );
    const asked = f.cards.addMessage(id, "captain", "Which PC is it on?");
    const t1 = { actor: "crewmate", taskId: "t1" } as const;
    expect(
      f.cards.replyAs(t1, { cardId: id, text: "The shell PC.", answersMessage: asked.id }),
    ).toMatchObject({ answered: asked.id });
    expect(f.cards.get(id)?.awaiting).toBe("close-out");

    // The author's turn ends: the card still waits for the other writer,
    // and the author's next turn revises without being refused.
    f.cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(f.cards.get(id)?.awaiting).toBe("close-out");
    const body = `<p>Run ${REMOVER} as an administrator.</p>`;
    expect(() =>
      f.cards.emitCrewmateCard("t1", { id, title: before.title, body, actions: [] }, "m"),
    ).not.toThrow();
    f.cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(f.cards.get(id)?.awaiting).toBe("close-out");

    // The other writer's turn ends: the card comes back with its newest words.
    f.cards.closeOut({ kind: "crewmate", taskId: "t2" }, "idle");
    expect(f.cards.get(id)?.awaiting).toBeUndefined();
    expect(f.cards.shown(id)?.body).toBe(body);
  });

  it("brings back another writer's named answer when that writer's turn ends", () => {
    // INF-2555: a named answer from someone other than the card's author
    // waited for the author's next turn end, which may never come.
    const f = setup();
    const id = noteOnT1(f.cards);
    const asked = f.cards.addMessage(id, "captain", "Where is the remover?");
    f.cards.replyAs(t2, { cardId: id, text: `It is at ${REMOVER}.`, answersMessage: asked.id });
    expect(f.cards.get(id)?.awaiting).toBe("close-out");
    f.cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(f.cards.get(id)?.awaiting).toBe("close-out");
    f.cards.closeOut({ kind: "crewmate", taskId: "t2" }, "idle");
    expect(f.cards.get(id)?.awaiting).toBeUndefined();
  });

  it("leaves the author's turn end alone when another writer's revision is not held", () => {
    // INF-2555: the first mate's revision of an idle card shows at once, so
    // nothing waits for its turn end and the author's answer comes back
    // when the author's turn ends.
    const f = setup();
    const id = noteOnT1(f.cards);
    const before = f.cards.get(id) as Card;
    const result = f.cards.contribute(
      firstmate,
      { id, title: before.title, body: `<p>Run ${REMOVER}.</p>`, actions: [] },
      { expectedRevision: before.offerId, reason: "The remover's path was missing" },
    );
    expect(result).toMatchObject({ effect: "revised", display: "available" });
    const asked = f.cards.addMessage(id, "captain", "Which PC is it on?");
    f.cards.replyAs(
      { actor: "crewmate", taskId: "t1" },
      { cardId: id, text: "The shell PC.", answersMessage: asked.id },
    );
    expect(f.cards.get(id)?.awaiting).toBe("close-out");
    f.cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
    expect(f.cards.get(id)?.awaiting).toBeUndefined();
  });

  it.each([
    [
      "its author withdraws it",
      (f: ReturnType<typeof setup>, id: string) => {
        f.cards.close(id, { kind: "crewmate", taskId: "t1" });
      },
    ],
    [
      "the app takes it down",
      (f: ReturnType<typeof setup>, id: string) => {
        f.cards.takeDown(id, "retired");
      },
    ],
  ])(
    "forgets another writer once %s, so the card returning under its id comes up with its author's turn end",
    (_how, leave) => {
      // INF-2555: the other writer's record outlived the card, so the author's
      // every close-out then skipped a card returning under the same id.
      const f = setup();
      const id = noteOnT1(f.cards);
      const before = f.cards.get(id) as Card;
      f.cards.contribute(
        t2,
        { id, title: before.title, body: `<p>Run ${REMOVER}.</p>`, actions: [] },
        { expectedRevision: before.offerId, reason: "The remover's path was missing" },
      );
      leave(f, id);
      // The other writer's turn ends while the card is off the stack.
      f.cards.closeOut({ kind: "crewmate", taskId: "t2" }, "idle");

      const body = `<p>Run ${REMOVER} as an administrator.</p>`;
      f.cards.emitCrewmateCard("t1", { id, title: before.title, body, actions: [] }, "m");
      expect(f.cards.get(id)?.lifecycleId).not.toBe(before.lifecycleId);
      f.cards.closeOut({ kind: "crewmate", taskId: "t1" }, "idle");
      expect(f.cards.get(id)?.awaiting).toBeUndefined();
      expect(f.cards.shown(id)?.body).toBe(body);
    },
  );

  it("keeps a closed card's words and choices, and takes only a dated clarification", () => {
    const f = setup();
    const id = noteOnT1(f.cards);
    const read = f.cards.cardRead(id);
    // INF-2794: the captain's Got it closes the note.
    f.cards.pressNote(f.cards.get(id) as Card);
    const closed = f.cardStore.get(id) as Card;

    const revision = f.cards.contribute(
      t2,
      { id, title: "Run the remover", body: "<p>Rewritten.</p>", actions: [] },
      { expectedRevision: read?.revision },
    );
    expect(revision).toMatchObject({ effect: "refused" });
    expect(revision.refusal).toContain("the card is closed");
    expect(
      f.cards.replyAs(t2, { cardId: id, text: "It ended no question.", answersMessage: 1 }),
    ).toMatchObject({ effect: "refused" });

    vi.setSystemTime(new Date("2026-11-03T17:05:00Z"));
    const clarification = f.cards.replyAs(t2, {
      cardId: id,
      text: `For the record: the remover is ${REMOVER}.`,
    });
    expect(clarification).toMatchObject({ effect: "reply-only", clarification: true });
    expect(f.cards.get(id)).toBeUndefined();
    expect(f.cardStore.get(id)).toMatchObject({ title: closed.title, body: closed.body });
    expect(f.cards.thread(id).messages.at(-1)).toMatchObject({
      text: `For the record: the remover is ${REMOVER}.`,
      clarification: true,
      at: Date.parse("2026-11-03T17:05:00Z"),
      contributor: { taskId: "t2" },
    });
  });

  it("refuses an unknown id, the app's own card, a required action's words and a choice that carries an effect", () => {
    const f = setup();
    expect(
      f.cards.contribute(
        t2,
        { id: "card-t1-404", title: "x", body: "<p>x</p>", actions: [] },
        { expectedRevision: "r" },
      ),
    ).toMatchObject({ effect: "refused", refusal: "that id names no card on the record." });

    const { cardId } = requiredAction(f);
    const shown = f.cards.get(cardId) as Card;
    const words = f.cards.contribute(
      t2,
      { id: cardId, title: shown.title, body: "<p>Other words.</p>", actions: [] },
      { expectedRevision: shown.offerId },
    );
    expect(words.refusal).toContain("revise_required_action");
    expect(f.cards.get(cardId)).toEqual(shown);

    const id = noteOnT1(f.cards);
    const read = f.cards.cardRead(id);
    const settle = f.cards.contribute(
      t2,
      {
        id,
        title: "Merge it",
        body: "<p>Merge.</p>",
        actions: [
          {
            id: "merge",
            label: "Merge",
            default: true,
            effect: { kind: "merge", after: "close" },
          },
        ],
      },
      { expectedRevision: read?.revision },
    );
    expect(settle).toMatchObject({ effect: "refused" });
    expect(settle.refusal).toContain("carries an effect");
    expect(f.cards.get(id)?.actions).toEqual([]);

    f.cards.addFirstmateQuietCard("<p>Your first mate has not answered for ten minutes.</p>");
    const quiet = f.cards.get("card-fm-quiet") as Card;
    const app = f.cards.contribute(
      t2,
      { id: quiet.id, title: quiet.title, body: "<p>It is answering now.</p>", actions: [] },
      { expectedRevision: f.cards.cardRead(quiet.id)?.revision },
    );
    expect(app).toMatchObject({ effect: "refused" });
    expect(app.refusal).toContain("the app wrote this card");
    expect(f.cards.get(quiet.id)).toEqual(quiet);
  });

  // The task's acceptance: a saved change story's words are its own crewmate's.
  it("refuses another writer's words on a card whose task's saved change story owns them", () => {
    const f = setup();
    const head = "5f0c6e2a9b7d4c1e8f3a6b9d2c5e8f1a4b7c0d3e";
    const risk = Object.fromEntries(
      RISK_DIMENSIONS.map((dimension) => [dimension, { level: "low", why: "One script path" }]),
    );
    f.tasks.delivery.updateChangePresentation("t1", () => ({
      revisions: [
        changePresentationSchema.parse({
          version: 2,
          taskId: "t1",
          revision: 1,
          destination: { kind: "branch", origin: "git@git.example.com:fleet/checks.git" },
          title: "fix(fleet): retire the shell PC job host",
          base: head,
          head,
          why: ["The old job host still takes fleet checks on the shell PC."],
          whatChanged: ["The fleet check setup ships a remover for the job host."],
          before: ["The job host had no remover."],
          after: ["The remover takes the job host off the shell PC."],
          views: [],
          noPicture: "This adds a setup script, not a screen.",
          checked: [{ check: "Ran the remover", result: "The service list no longer has it." }],
          verification: ["Ran the remover on a scratch PC."],
          risk,
          requiredActions: [],
          unfinished: [],
          projectText: "",
          assets: [],
          pictures: [],
        }),
      ],
      receipts: [],
    }));
    const id = noteOnT1(f.cards);
    const before = f.cards.get(id) as Card;

    const result = f.cards.contribute(
      t2,
      { id, title: before.title, body: `<p>Run ${REMOVER}.</p>`, actions: [] },
      { expectedRevision: f.cards.cardRead(id)?.revision },
    );
    expect(result).toMatchObject({ effect: "refused", cardId: id });
    expect(result.refusal).toContain("saved change story");
    expect(f.cards.get(id)).toEqual(before);
    expect(f.cards.thread(id).messages).toEqual([]);
  });

  it("corrects the DOP-217 remover path on its required action, keeping the filing and moving the generation", () => {
    const f = setup();
    const { taskId, cardId } = requiredAction(f);
    f.cards.addMessage(cardId, "captain", "Where is the remover? I cannot find it on the PC.");
    const read = f.cards.cardRead(cardId);
    expect(read?.requiredAction).toMatchObject({ generation: 1, state: "ready" });
    const filing = f.tasks.get(taskId)?.delivery?.captainAction;

    const correct = (generation: number, operationId: string, instructions: string[]) =>
      f.cards.reviseRequiredAction(t2, {
        action: cardId,
        source: "dop208",
        actionId: "remove-job-host",
        expectedGeneration: generation,
        patch: { instructions },
        reason: "The remover lives under FleetCheckSetup, not FleetCheck",
        operationId,
        sameAction: true,
      });
    const fixed = [`Run ${REMOVER} as an administrator.`];
    const result = correct(1, "op-1", fixed);
    expect(result).toMatchObject({ effect: "revised", generation: 2 });
    expect(result.unchanged).toEqual(
      expect.arrayContaining(["target", "filing", "completion", "state", "title", "criterion"]),
    );

    const action = f.tasks.get(taskId)?.delivery?.captainAction;
    expect(action).toMatchObject({ generation: 2, state: "ready", presentedGeneration: 2 });
    expect(action?.requirements[0]).toMatchObject({
      source: filing?.requirements[0]?.source,
      offer: filing?.requirements[0]?.offer,
      action: { ...filing?.requirements[0]?.action, instructions: fixed },
      corrections: [
        {
          operationId: "op-1",
          actor: "crewmate",
          taskId: "t2",
          generation: 2,
          previous: { instructions: filing?.requirements[0]?.action.instructions },
        },
      ],
    });
    // The card shows the new words at once, under the same id, with no second card.
    const card = f.cards.get(cardId) as Card;
    expect(card.body).toContain("FleetCheckSetup");
    expect(f.cards.snapshot().filter((entry) => entry.taskId === taskId)).toHaveLength(1);
    expect(
      f.cards.thread(cardId).messages.map((line) => [line.who, line.contributor?.taskId]),
    ).toEqual([
      ["captain", undefined],
      ["host", "t2"],
    ]);
    // The captain's question still waits for its named answer.
    expect(f.cards.get(cardId)?.awaiting).toBe("answer");

    // The confirmation offered at generation 1 no longer completes it.
    expect(f.tasks.delivery.completeCaptainAction(taskId, 1, "confirmed")).toBe(false);

    // A stale read, the same words again, and the same operation again.
    expect(correct(1, "op-2", ["Something else."])).toMatchObject({
      effect: "refused",
      generation: 2,
    });
    expect(correct(2, "op-3", fixed)).toMatchObject({ effect: "unchanged", generation: 2 });
    expect(correct(1, "op-1", fixed)).toMatchObject({
      effect: "revised",
      generation: 2,
      repeated: true,
    });
    expect(f.tasks.get(taskId)?.delivery?.captainAction?.generation).toBe(2);
  });
});
