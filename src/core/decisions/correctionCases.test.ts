import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  setup,
} from "../../../tests/helpers/crewHarness";
import { KnowledgeService } from "../knowledge/knowledgeService";
import { ActivityStore } from "../storage/activityStore";
import { DecisionStore } from "../storage/decisionStore";
import { FIRSTMATE_RECIPIENT, INBOX_DEDUPE_WINDOW_MS } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { recentFeed } from "../tasks/taskFeed";
import { CorrectionCases } from "./correctionCases";
import { CORRECTION_CASES, CORRECTION_QUESTIONS, CorrectionConsumer } from "./correctionConsumer";
import { CORRECTION_QUESTION, correctionState } from "./correctionQuestion";
import { CORRECTION_EXCERPT_BYTE_LIMIT, CorrectionSources } from "./correctionSources";

/** Intent: the approved independent offer must save only via the existing
 * direction owner, remain pending on failure, recover by typed identity and
 * preserve source gates. Real card actions/SQLite/knowledge writes exercise
 * those effects; the disposable model receipt does not prove recognition. */
fakeCrewTimersEachTest();
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
async function fixture() {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate);
  const projects = [{ id: "sample-project", name: "Sample project", path: "/projects/sample" }];
  const knowledge = new KnowledgeService({
    projects: { get: (id) => projects.find((p) => p.id === id), list: () => projects },
  });
  const consumer = new CorrectionConsumer({
    inbox: h.inbox,
    ledger: new DecisionStore(h.db),
    now: () => 1_000,
    exists: () => true,
    models: {
      allowsUse: () => true,
      decide: async () => ({
        correction: { value: "review", outcome: "answered", version: CORRECTION_QUESTION.version },
      }),
    },
  });
  cleanup.push(() => {
    consumer.dispose();
    knowledge.close();
  });
  const options = {
    consumer,
    inbox: h.inbox,
    cards: h.cardStore,
    tasks: h.tasks,
    supervisor: h.supervisor,
    now: () => 1_000,
    project: (id: string) => projects.find((p) => p.id === id),
    direction: (id: string) => {
      const read = knowledge.directions.read({ id: id.replace(/^d:/, "") });
      return read.state === "ready" ? read.direction : undefined;
    },
  };
  const cases = new CorrectionCases(options);
  h.supervisor.cards.setDirectionRetention((...args) => cases.retains(...args));
  seedTask(h.tasks, {
    id: "original-work",
    title: "Review the current work",
    status: "running",
    repoId: projects[0]?.id,
  });
  const originalCard = h.supervisor.cards.addFirstmateCard({
    id: "original-approval",
    taskId: "original-work",
    title: "Review the current work",
    body: "<p>The original work has its own choice.</p>",
    actions: [{ id: "approve", label: "Approve", default: true }],
  });
  h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
  const before = h.tasks.get("original-work");
  const text = "For the next 3 reviews, keep the proposed scope unchanged.";
  const state = correctionState(
    { latestReply: text, preceding: [], unavailableContext: false },
    CORRECTION_EXCERPT_BYTE_LIMIT,
  );
  if (!state) throw new Error("The source fixture must fit.");
  consumer.enqueue(
    {
      key: "card:source-input",
      kind: "card",
      cardId: originalCard,
      taskId: "original-work",
      at: 1_000,
    },
    state,
  );
  await consumer.drain();
  const inputId = h.inbox.allFor(CORRECTION_CASES)[0]?.id;
  if (inputId === undefined) throw new Error("The fixture has no flagged case.");
  await cases.handle({ op: "offer", inputId, projectId: projects[0]?.id, text });
  h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
  const offer = consumer.input(inputId)?.offer;
  if (!offer) throw new Error("The fixture has no proposed offer.");
  return {
    ...h,
    crewmate,
    cases,
    options,
    consumer,
    knowledge,
    projects,
    text,
    inputId,
    offer,
    originalCard,
    before,
  };
}

describe("independent correction offers", () => {
  it("keeps only its own task pending until an exact saved readback, and recovers once", async () => {
    const h = await fixture();
    const own = h.tasks.capture.openCardTaskFor(h.offer.cardId);
    expect(own).toBeDefined();
    expect(h.tasks.get("original-work")?.gate).toEqual(h.before?.gate);
    const sourceActions = h.cardStore.get(h.originalCard)?.actions;
    h.supervisor.cardActions.act(h.offer.cardId, h.offer.keepActionId, "chrome");
    expect(h.supervisor.cards.has(h.offer.cardId)).toBe(false);
    expect(h.tasks.capture.openCardTaskFor(h.offer.cardId)?.id).toBe(own?.id);
    expect(h.tasks.get("original-work")?.gate).toEqual(h.before?.gate);
    expect(h.cardStore.get(h.originalCard)?.actions).toEqual(sourceActions);
    const selected = () =>
      h.inbox
        .allFor(FIRSTMATE_RECIPIENT)
        .filter((row) => row.facts?.kind === "correction-review" && row.facts.selected === true);
    expect(selected()).toHaveLength(1);
    expect(selected()[0]?.facts).toMatchObject({ inputId: h.inputId });
    new CorrectionCases(h.options).sweep();
    expect(selected()).toHaveLength(1);
    expect(await h.cases.handle({ op: "recover", inputId: h.inputId })).toMatchObject({
      status: "not-kept",
    });
    expect(h.cardStore.messages(h.originalCard)).toEqual([]);
    h.knowledge.directions.change({
      op: "add",
      id: h.offer.directionId,
      text: h.offer.text,
      scope: h.offer.projectId,
      reason: "The captain chose the exact project offer.",
    });
    // A quit after storage but before the success callback uses the same typed case.
    const recovered = new CorrectionCases(h.options);
    expect(await recovered.handle({ op: "recover", inputId: h.inputId })).toMatchObject({
      status: "kept",
    });
    expect(h.tasks.capture.openCardTaskFor(h.offer.cardId)).toBeUndefined();
    const receipt = h.cardStore.messages(h.originalCard);
    expect(receipt).toHaveLength(1);
    expect(receipt[0]?.text).toContain(h.offer.text);
    await recovered.handle({ op: "recover", inputId: h.inputId });
    expect(h.cardStore.messages(h.originalCard)).toEqual(receipt);
    const saved = h.knowledge.directions.read({ id: h.offer.directionId.replace(/^d:/, "") });
    expect(saved.state === "ready" && saved.direction).toMatchObject({
      text: h.text,
      scope: h.offer.projectId,
      revision: 1,
    });
  });

  it("declines without writing a direction or changing the source gate", async () => {
    const h = await fixture();
    h.supervisor.cardActions.act(h.offer.cardId, h.offer.declineActionId, "chrome");
    expect(h.consumer.input(h.inputId)).toBeUndefined();
    expect(
      h.knowledge.directions.read({ id: h.offer.directionId.replace(/^d:/, "") }),
    ).toMatchObject({ state: "missing" });
    expect(h.tasks.get("original-work")?.gate).toEqual(h.before?.gate);
  });

  it("honors an explicit written keep through the existing writer without a second choice", async () => {
    const h = await fixture();
    h.supervisor.cardActions.replyToCard(
      h.offer.cardId,
      "Keep that exact wording for this project.",
    );
    const written = h.cardStore
      .observations(h.offer.cardId)
      .findLast((row) => h.cardStore.captainInput(row.id) !== undefined);
    if (!written) throw new Error("The actual written request was not captured.");
    expect(
      await h.cases.handle({ op: "recover", inputId: h.inputId, explicitSourceId: written.id }),
    ).toMatchObject({ status: "not-kept" });
    h.knowledge.directions.change({
      op: "add",
      id: h.offer.directionId,
      scope: h.offer.projectId,
      text: h.offer.text,
      reason: "The captain explicitly asked to keep the offered instruction.",
    });
    h.cases.saved(h.offer.directionId);
    expect(h.tasks.capture.openCardTaskFor(h.offer.cardId)).toBeUndefined();
    expect(h.supervisor.cards.has(h.offer.cardId)).toBe(false);
    expect(h.cardStore.messages(h.originalCard)).toHaveLength(1);
  });

  it("does not carry an earlier written keep onto newly proposed wording", async () => {
    const h = await fixture();
    h.supervisor.cardActions.replyToCard(h.offer.cardId, "Keep this exact project instruction.");
    const observed = h.cardStore
      .observations(h.offer.cardId)
      .findLast((entry) => h.cardStore.captainInput(entry.id) !== undefined);
    if (!observed) throw new Error("The actual written request was not recorded.");
    await h.cases.handle({ op: "recover", inputId: h.inputId, explicitSourceId: observed.id });
    await expect(h.cases.handle({ op: "ignore", inputId: h.inputId })).rejects.toThrow(
      "pending saving",
    );
    const messageId = h.supervisor.cards.thread(h.offer.cardId).messages.at(-1)?.id;
    await h.cases.handle({
      op: "offer",
      inputId: h.inputId,
      projectId: h.offer.projectId,
      text: "Ask before changing scope in every review.",
      reply: "This different wording needs its own choice.",
      answersMessage: messageId,
    });
    expect(h.consumer.input(h.inputId)?.explicitSourceId).toBeUndefined();
    expect(h.consumer.input(h.inputId)?.choiceOfferId).toBeUndefined();
    expect(await h.cases.handle({ op: "recover", inputId: h.inputId })).toMatchObject({
      status: "choice-pending",
    });
    expect(h.cardStore.messages(h.originalCard)).toEqual([]);
  });

  it("answers a wording reply on the same offer and retains the replacement revision", async () => {
    const h = await fixture();
    const existing = h.knowledge.directions.change({
      op: "add",
      scope: h.offer.projectId,
      text: "Review the original scope.",
      reason: "An existing project instruction.",
    });
    await h.cases.handle({
      op: "offer",
      inputId: h.inputId,
      projectId: h.offer.projectId,
      directionId: existing.direction.id,
      expectedRevision: existing.direction.revision,
      text: h.text,
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    const revised =
      "For the next 3 reviews, keep the proposed scope unchanged; ask before adding scope.";
    h.supervisor.cardActions.replyToCard(h.offer.cardId, `Use this wording instead: ${revised}`);
    const messageId = h.supervisor.cards.thread(h.offer.cardId).messages.at(-1)?.id;
    if (messageId === undefined) throw new Error("The actual wording reply is missing.");
    await h.cases.handle({
      op: "offer",
      inputId: h.inputId,
      projectId: h.offer.projectId,
      text: revised,
      reply: "I changed the proposed wording.",
      answersMessage: messageId,
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    const offer = h.consumer.input(h.inputId)?.offer;
    expect(offer).toMatchObject({
      cardId: h.offer.cardId,
      directionId: existing.direction.id,
      expectedRevision: existing.direction.revision,
      text: revised,
    });
    h.supervisor.cardActions.act(h.offer.cardId, h.offer.keepActionId, "chrome");
    const saved = h.knowledge.directions.change({
      op: "revise",
      id: existing.direction.id,
      expectedRevision: existing.direction.revision,
      text: revised,
      reason: "The captain kept the revised wording.",
    });
    h.cases.saved(existing.direction.id);
    expect(h.consumer.input(h.inputId)?.offer?.savedRevision).toBe(saved.direction.revision);
    expect(h.cardStore.messages(h.originalCard).at(-1)?.text).toContain(revised);
  });

  it("never confirms a newer revision against an older replacement choice", async () => {
    const h = await fixture();
    const original = h.knowledge.directions.change({
      op: "add",
      text: "Review the original scope.",
      scope: h.offer.projectId,
      reason: "An existing project instruction.",
    });
    await h.cases.handle({
      op: "offer",
      inputId: h.inputId,
      projectId: h.offer.projectId,
      directionId: original.direction.id,
      expectedRevision: original.direction.revision,
      text: h.text,
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    const offer = h.consumer.input(h.inputId)?.offer;
    if (!offer) throw new Error("The replacement proposal was not recorded.");
    h.supervisor.cardActions.act(offer.cardId, offer.keepActionId, "chrome");
    h.knowledge.directions.change({
      op: "revise",
      id: original.direction.id,
      expectedRevision: original.direction.revision,
      text: "A separately chosen newer instruction.",
      reason: "Another explicit change.",
    });
    expect(await h.cases.handle({ op: "recover", inputId: h.inputId })).toMatchObject({
      status: "not-kept",
    });
    expect(h.tasks.capture.openCardTaskFor(offer.cardId)).toBeDefined();
    expect(() =>
      h.knowledge.directions.change({
        op: "revise",
        id: original.direction.id,
        expectedRevision: original.direction.revision,
        text: h.text,
        reason: "Retry the old choice.",
      }),
    ).toThrow();
    expect(h.cardStore.messages(h.originalCard)).toEqual([]);
  });

  it("queues saved wording once only for declared active workers in that project", async () => {
    const h = await fixture();
    const project = h.repos.ensurePersonal(h.paths.fleetDir);
    h.projects.push({ id: project.id, name: project.name, path: h.paths.fleetDir });
    const worker = await h.supervisor.intake.commission({
      title: "An active review",
      intent: intentOf("Review the current project scope."),
      repoId: project.id,
    });
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1));
    await h.cases.handle({ op: "offer", inputId: h.inputId, projectId: project.id, text: h.text });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    const offer = h.consumer.input(h.inputId)?.offer;
    if (!offer) throw new Error("The live worker's project offer was not recorded.");
    seedTask(h.tasks, {
      id: "other-project-work",
      title: "Review another project",
      status: "running",
      repoId: "another-project",
    });
    seedTask(h.tasks, {
      id: "unstarted-project-work",
      title: "An unstarted review",
      status: "queued",
      startPolicy: "on-request",
      repoId: offer.projectId,
    });
    h.supervisor.cardActions.act(offer.cardId, offer.keepActionId, "chrome");
    const saved = h.knowledge.directions.change({
      op: "add",
      id: offer.directionId,
      scope: offer.projectId,
      text: offer.text,
      reason: "The captain kept the displayed project instruction.",
    });
    h.cases.saved(offer.directionId);
    expect(
      await h.cases.handle({
        op: "guide",
        inputId: h.inputId,
        affectedTaskIds: [
          worker.taskId,
          worker.taskId,
          "other-project-work",
          "unstarted-project-work",
        ],
      }),
    ).toEqual({ status: "complete", told: [worker.taskId] });
    await vi.waitFor(() => expect(h.crewmate.steers).toHaveLength(1));
    expect(h.crewmate.steers[0]?.text).toContain(h.text);
    expect(
      h.inbox.woken(
        worker.taskId,
        `kept-direction:${offer.directionId}:${saved.direction.revision}`,
      ),
    ).toBe(true);
    expect(h.inbox.allFor("other-project-work")).toEqual([]);
    expect(h.inbox.allFor("unstarted-project-work")).toEqual([]);
    expect(
      await h.cases.handle({ op: "guide", inputId: h.inputId, affectedTaskIds: [worker.taskId] }),
    ).toMatchObject({ status: "handled" });
    expect(h.crewmate.steers).toHaveLength(1);
  });

  it("requires an affected-work declaration and refuses stale saved wording", async () => {
    const h = await fixture();
    h.supervisor.cardActions.act(h.offer.cardId, h.offer.keepActionId, "chrome");
    const saved = h.knowledge.directions.change({
      op: "add",
      id: h.offer.directionId,
      scope: h.offer.projectId,
      text: h.offer.text,
      reason: "The captain kept this exact wording.",
    });
    h.cases.saved(h.offer.directionId);
    await expect(h.cases.handle({ op: "guide", inputId: h.inputId })).rejects.toThrow(
      "Declare affected",
    );
    h.knowledge.directions.change({
      op: "revise",
      id: h.offer.directionId,
      expectedRevision: saved.direction.revision,
      text: "A separately approved instruction.",
      reason: "The captain changed this instruction.",
    });
    await expect(
      h.cases.handle({ op: "guide", inputId: h.inputId, affectedTaskIds: ["original-work"] }),
    ).rejects.toThrow("changed after saving");
    expect(
      h.inbox.allFor("original-work").filter((row) => row.facts?.kind === "kept-project-direction"),
    ).toEqual([]);
    expect(h.consumer.input(h.inputId)).toBeDefined();
    expect(await h.cases.handle({ op: "ignore", inputId: h.inputId })).toEqual({
      status: "ignored",
    });
    expect(h.consumer.input(h.inputId)).toBeUndefined();
  });

  it("withdraws an unchosen offer when its target project is removed, without changing the original work", async () => {
    const h = await fixture();
    h.projects.splice(0);
    h.cases.sweep();
    expect(h.supervisor.cards.has(h.offer.cardId)).toBe(false);
    expect(h.consumer.input(h.inputId)).toBeUndefined();
    expect(h.tasks.capture.openCardTaskFor(h.offer.cardId)).toBeUndefined();
    expect(h.tasks.get("original-work")).toMatchObject({
      status: h.before?.status,
      gate: h.before?.gate,
    });
    expect(h.cardStore.messages(h.originalCard)).toEqual([]);
  });

  it("does not claim saving after the target project disappears", async () => {
    const h = await fixture();
    h.supervisor.cardActions.act(h.offer.cardId, h.offer.keepActionId, "chrome");
    h.projects.splice(0);
    expect(await h.cases.handle({ op: "recover", inputId: h.inputId })).toMatchObject({
      status: "not-kept",
    });
    expect(h.tasks.capture.openCardTaskFor(h.offer.cardId)).toBeDefined();
    expect(h.cardStore.messages(h.originalCard)).toEqual([]);
  });
  it("asks once more after a turn ends without the save, then lets the first mate say why", async () => {
    // Intent: review findings - a failed save after Keep was never asked about
    // again, and then a retry on a clock had no end; the captain is told why.
    const h = await fixture();
    h.supervisor.cardActions.act(h.offer.cardId, h.offer.keepActionId, "chrome");
    const selected = () =>
      h.inbox
        .allFor(FIRSTMATE_RECIPIENT)
        .filter((row) => row.facts?.kind === "correction-review" && row.facts.selected === true);
    const first = selected();
    expect(first).toHaveLength(1);
    expect(first[0]?.facts).not.toHaveProperty("retry");
    h.cases.sweep();
    expect(selected()).toEqual(first);
    // The first mate's turn handled the ask, and its save did not land.
    h.inbox.ack(first.map((row) => row.id));
    h.cases.sweep();
    h.cases.sweep();
    const retry = selected();
    expect(retry).toHaveLength(1);
    expect(retry[0]?.facts).toMatchObject({ inputId: h.inputId, selected: true, retry: true });
    // Its turn ended without the save too: the app asks no more, however long it waits.
    h.inbox.ack(retry.map((row) => row.id));
    vi.setSystemTime(Date.now() + INBOX_DEDUPE_WINDOW_MS + 1);
    h.cases.sweep();
    expect(selected()).toEqual([]);
    expect(h.tasks.capture.openCardTaskFor(h.offer.cardId)).toBeDefined();
    await expect(h.cases.handle({ op: "ignore", inputId: h.inputId })).rejects.toThrow(
      "pending saving",
    );
    const why = "I could not save this instruction: the project's directions were unavailable.";
    const operation = h.tasks.capture.openCardTaskFor(h.offer.cardId);
    expect(await h.cases.handle({ op: "ignore", inputId: h.inputId, reply: why })).toEqual({
      status: "ignored",
    });
    // The captain's Keep took the offer card off the stack, so they read the
    // reason on the card they replied on, which is still shown, and in the feed.
    expect(h.supervisor.cards.has(h.offer.cardId)).toBe(false);
    expect(h.supervisor.cards.has(h.originalCard)).toBe(true);
    expect(h.cardStore.messages(h.originalCard).at(-1)?.text).toBe(why);
    expect(
      recentFeed(h.tasks, new ActivityStore(h.db), 200).filter(
        (line) => line.taskKey === operation?.key,
      ),
    ).toEqual([expect.objectContaining({ text: why })]);
    expect(h.consumer.input(h.inputId)).toBeUndefined();
    expect(h.tasks.capture.openCardTaskFor(h.offer.cardId)).toBeUndefined();
  });

  it("does not ask again when a different revision landed after the Keep", async () => {
    // Intent: review finding - only a save that has not landed is asked about
    // again; another wording needs the first mate's new offer instead.
    const h = await fixture();
    h.supervisor.cardActions.act(h.offer.cardId, h.offer.keepActionId, "chrome");
    const selected = () =>
      h.inbox
        .allFor(FIRSTMATE_RECIPIENT)
        .filter((row) => row.facts?.kind === "correction-review" && row.facts.selected === true);
    h.inbox.ack(selected().map((row) => row.id));
    h.knowledge.directions.change({
      op: "add",
      id: h.offer.directionId,
      scope: h.offer.projectId,
      text: "A different instruction someone saved meanwhile.",
      reason: "Another explicit change.",
    });
    h.cases.sweep();
    expect(selected()).toEqual([]);
  });

  it("ends the case when Keep is chosen on wording no offer recorded", async () => {
    // Intent: review finding - a Keep on a card the first mate revised outside
    // the offer was retained with nothing queued, pending forever.
    const h = await fixture();
    const shown = h.supervisor.cards.shown(h.offer.cardId);
    if (!shown) throw new Error("The offer is not shown.");
    h.supervisor.cards.addFirstmateCard({
      id: h.offer.cardId,
      title: shown.title,
      body: "<p>Keep a reworded instruction that no offer recorded?</p>",
      actions: shown.actions,
    });
    h.supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    expect(h.supervisor.cards.shown(h.offer.cardId)?.offerId).not.toBe(
      h.consumer.input(h.inputId)?.offer?.cardOfferId,
    );
    h.supervisor.cardActions.act(h.offer.cardId, h.offer.keepActionId, "chrome");
    expect(h.consumer.input(h.inputId)).toBeUndefined();
    expect(h.tasks.capture.openCardTaskFor(h.offer.cardId)).toBeUndefined();
    expect(
      h.inbox.allFor(FIRSTMATE_RECIPIENT).filter((row) => row.facts?.kind === "correction-review"),
    ).toEqual([]);
    expect(h.tasks.get("original-work")?.gate).toEqual(h.before?.gate);
  });

  it("does not check a reply on the open offer's own card as a new correction", async () => {
    // Intent: review finding - wording replies on the offer card were sent to
    // a paid reply check and could open a second offer for the same instruction.
    const h = await fixture();
    const enqueue = vi.fn();
    const sources = new CorrectionSources({
      cards: h.cardStore,
      consumer: { enqueue },
      allowed: () => true,
      offerCard: (id) => h.cases.offering(id),
      task: (id) => h.tasks.get(id),
      project: () => undefined,
    });
    const stop = h.cardStore.onCaptainInteraction((id) => {
      const input = h.cardStore.captainInput(id);
      if (input) sources.card(input);
    });
    cleanup.push(stop);
    h.supervisor.cardActions.replyToCard(
      h.offer.cardId,
      "Use this wording instead: ask before adding scope in every review.",
    );
    expect(enqueue).not.toHaveBeenCalled();
    h.supervisor.cardActions.replyToCard(
      h.originalCard,
      "From now on, ask before changing the plan.",
    );
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("purges every pending check, case and ask with the captain's words", async () => {
    // Intent: review finding - the Settings purge left reply-check cases,
    // keyed by their source rather than a task, holding the captain's words.
    const h = await fixture();
    h.supervisor.cardActions.replyToCard(h.offer.cardId, "Keep it, but for this project only.");
    h.supervisor.cardActions.act(h.offer.cardId, h.offer.keepActionId, "chrome");
    expect(h.cardStore.observations(h.offer.cardId)).not.toEqual([]);
    const state = correctionState(
      { latestReply: "Always ask first.", preceding: [], unavailableContext: false },
      CORRECTION_EXCERPT_BYTE_LIMIT,
    );
    if (!state) throw new Error("The second source must fit.");
    h.consumer.enqueue(
      { key: "card:second-input", kind: "card", cardId: h.originalCard, at: 1_000 },
      state,
    );
    h.cases.purge();
    expect(h.inbox.allFor(CORRECTION_QUESTIONS)).toEqual([]);
    expect(h.inbox.allFor(CORRECTION_CASES)).toEqual([]);
    expect(
      h.inbox.allFor(FIRSTMATE_RECIPIENT).filter((row) => row.facts?.kind === "correction-review"),
    ).toEqual([]);
    expect(h.cardStore.observations(h.offer.cardId)).toEqual([]);
    h.cases.sweep();
    await h.consumer.drain();
    expect(h.inbox.allFor(CORRECTION_CASES)).toEqual([]);
  });
});
