import { ANSWER_DONE_LABEL } from "@shared/cardLeave";
import type { CardNote } from "@shared/cardNotes";
import {
  CARD_REPLY_MAX_CHARS,
  type Card,
  type CardContributor,
  type CardMessage,
  type CardMessageWho,
  type CardMutation,
  type CardObservation,
  type CardThread,
  cardMessageText,
  cardMutationSchema,
  cardTakesReplies,
  onStage,
  takesTaskFacts,
} from "@shared/cards";
import type { CrewResponse } from "@shared/crewResponses";
import { FIRSTMATE_SESSION_ID } from "@shared/observe";
import type { RequiredActionText } from "@shared/requiredActions";
import { cutText } from "@shared/textCut";
import { revisedLineWords } from "@shared/threadLines";
import { decidedCardWidth } from "../pi/cardWidth";
import type { EmittedCardInput } from "../session/tools";
import { TaskService } from "../tasks/taskService";
import { buildEmittedCard, FIRSTMATE_CARD_PREFIX } from "./cardEmit";
import { cardMutationText } from "./cardMutationText";
import { resolveRevisionTargets, revisionLinks } from "./cardNavigation";
import { SIGNED_OFF_ACTION_ID, signOffRefusal } from "./cardSignOff";
import type { CardAuthorRef, CardServiceHost, CardStack } from "./cardStackTypes";
import { waitingCardWords } from "./idleWakes";
import { requiredActionCard, requiredActionProvenance } from "./requiredActionCard";

/**
 * A card's thread and every write on someone else's card
 * (docs/card-threads.md, "Shared cards"): reading a thread, who owes it an
 * answer, a crewmate's line, and a revision or answer from a writer other
 * than the card's author. Every line still goes through the stack's one
 * writer (`CardService.addMessage`), which holds the card for its answer.
 */

/**
 * Who is writing on a card (docs/card-threads.md, "Shared cards"): the
 * first mate, or a crewmate by its task. The host passes the caller it
 * authenticated, never one an agent named.
 */
export type CardCaller = { actor: "firstmate" } | { actor: "crewmate"; taskId: string };

/**
 * What an emit's id names for its caller: no card yet (a new one in the
 * caller's own namespace), one of the caller's own cards, someone else's
 * open card, someone else's closed card, or a card id the record lacks.
 */
type CardTarget =
  | { kind: "new" }
  | { kind: "own"; id: string }
  | { kind: "foreign"; id: string; card: Card }
  | { kind: "closed"; id: string; card: Card }
  | { kind: "unknown"; id: string };

/** A contribution's declared facts beside the card it writes (`major-16.md`). */
export type CardContribution = {
  /** The revision (offer id) the contributor read; a revision needs it. */
  expectedRevision?: string;
  reason?: string;
  operationId?: string;
  /** The captain message this contribution's reply answers. */
  answersMessage?: number;
};

/** A thread line's facts beyond its words (`CardService.addMessage`). */
export type MessageFacts = {
  notes?: CardNote[];
  /** The original captain caption before pasted-file or settings decoration. */
  captainText?: string;
  contributor?: CardContributor;
  answersMessage?: number;
  clarification?: true;
  responseId?: string;
};

/** What a reply alone keeps of its card, as its receipt names it. */
const REPLY_FIELDS_KEPT = ["title", "body", "choices"];

/**
 * Who owes the captain an answer on a card's thread now (docs/card-threads.md
 * "How the first mate learns"): `author` or `firstmate` while the open card's
 * current lifecycle holds for an answer (`CardStore.awaitingAuthor`), `none`
 * on an open card without that hold, `closed` once the card is resolved.
 * Never read from who wrote last: a captain message an earlier lifecycle
 * kept survives the card's resolution and reopening and owes nothing.
 */
export type ThreadOwed = "author" | "firstmate" | "none" | "closed";

/** One card whose thread moved, as the Firstmate's context section reads it. */
export type ThreadActivity = { card: Card; count: number; last: CardMessage; owed: ThreadOwed };

/** A crewmate's line in a card's thread, as the `reply` output carries it. */
type ReplyInput = {
  cardId: string;
  text: string;
  interim?: boolean;
  answersMessage?: number;
  /** The crewmate judged the captain's message says they are done (INF-2845). */
  signsOff?: boolean;
  operationId?: string;
  response?: CrewResponse;
};

export class CardThreads {
  constructor(
    private readonly host: CardServiceHost,
    private readonly stack: CardStack,
  ) {}

  /**
   * A card's thread as it stands (cards-as-threads phase 1), oldest first.
   * Reading one never changes it.
   */
  thread(cardId: string): CardThread {
    const shown = this.stack.shown(cardId);
    const messages = this.host.cardStore.messages(cardId);
    if (!shown?.offerId) return { cardId, messages };
    const offers = this.host.cardStore
      .observations(cardId)
      .filter(
        (o): o is Extract<CardObservation, { kind: "offer" }> =>
          o.kind === "offer" && o.lifecycleId === shown.lifecycleId,
      );
    const shownAt = offers.findIndex((o) => o.offerId === shown.offerId);
    return {
      cardId,
      messages: messages.map((message) => {
        const revision = message.revision;
        if (!revision?.released || revision.lifecycleId !== shown.lifecycleId) return message;
        const sourceAt = offers.findIndex((o) => o.offerId === revision.offerId);
        if (sourceAt < 0 || shownAt < sourceAt) return message;
        const versions = offers.slice(sourceAt, shownAt + 1).map((o) => o.payload);
        return {
          ...message,
          revisionShown: {
            offerId: shown.offerId!,
            targets: resolveRevisionTargets(revision.targets, versions),
          },
        };
      }),
    };
  }

  /**
   * Whether the Firstmate is the one that answers a card's thread: its own
   * card, a card the host named it the answerer of (the stuck alert,
   * `Card.answeredBy`), or a note a task closed done kept, whose crewmate
   * is gone.
   */
  firstmateAnswers(card: Card): boolean {
    if (card.author === "firstmate" || card.answeredBy === "firstmate") return true;
    if (card.author !== "crewmate" || !card.taskId) return false;
    const task = this.host.tasks.get(card.taskId);
    return task !== undefined && TaskService.isClosed(task);
  }

  /**
   * Capture the Firstmate's closing words as its line in the thread of a
   * card it answers (phase 2). The line names no captain message, so it
   * leaves the question waiting: a handoff stays open, and the Firstmate
   * answers with an emit_card reply that names the message. No-op without
   * a current answer hold - a named reply may have answered it, or the old
   * lifecycle may have closed - or when the Firstmate already wrote its
   * own line since the captain's. Returns whether the line was written.
   */
  recordFirstmateThreadAnswer(cardId: string, text: string): boolean {
    const card = this.stack.cards.get(cardId);
    if (!card || !this.firstmateAnswers(card)) return false;
    if (!this.host.cardStore.awaitingAuthor(cardId)) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const asked = this.host.cardStore.newestCaptainMessage(cardId)?.id ?? 0;
    const wrote = this.host.cardStore
      .messages(cardId)
      .some((line) => line.id > asked && line.who === "firstmate" && !line.contributor);
    if (wrote) return false;
    this.stack.addMessage(cardId, "firstmate", trimmed);
    return true;
  }

  /**
   * Open cards on this session that have a thread, for Observe. The
   * Firstmate session lists firstmate-authored cards; a crewmate session
   * lists that task's cards. Empty threads stay off the pane.
   */
  observeThreads(
    sessionId: string,
  ): Array<{ cardId: string; title: string; messages: CardMessage[] }> {
    const cards =
      sessionId === FIRSTMATE_SESSION_ID
        ? this.stack.snapshot().filter((card) => card.author === "firstmate")
        : this.stack.snapshot().filter((card) => card.taskId === sessionId);
    return cards
      .map((card) => ({
        cardId: card.id,
        title: card.title,
        messages: this.host.cardStore.messages(card.id),
      }))
      .filter((thread) => thread.messages.length > 0);
  }

  /**
   * A crewmate's line in a card's thread (the `reply` output, contract
   * v4.1): prose only, and never a second card. On its own card it writes
   * as the author; on anyone else's card - another task's, the first
   * mate's, a required action - it writes with its name on the line
   * (`replyAs`, docs/card-threads.md "Shared cards"). Either way it ends a
   * captain question only by naming it. Refusals are tool text and write
   * nothing.
   */
  replyFromCrewmate(taskId: string, input: ReplyInput): string {
    const id = input.cardId.trim();
    if (!id) return "reply needs card_id: the id of the card whose thread you write in.";
    const card = this.stack.cards.get(id) ?? this.host.cardStore.get(id);
    if (!card) {
      return `Unknown card "${id}". Read the card's id again; a reply names a card on the record.`;
    }
    const caller: CardCaller = { actor: "crewmate", taskId };
    const signsOff = input.signsOff === true;
    if (signsOff) {
      const refusal = signOffRefusal({
        taskId,
        card: this.stack.cards.get(id),
        record: this.host.tasks.get(taskId),
        answersMessage: input.answersMessage,
        interim: input.interim === true,
        waitingOn: this.host.cardStore.awaitingAuthor(id)
          ? this.host.cardStore.newestCaptainMessage(id)?.id
          : undefined,
      });
      if (refusal) return `Nothing was written: ${refusal}`;
    }
    const own =
      this.stack.cards.has(id) && answersFor(card, caller, (other) => this.firstmateAnswers(other));
    const mutation = this.replyAs(caller, input);
    if (!own || mutation.effect !== "reply-only" || mutation.alreadyAnswered || mutation.repeated) {
      return cardMutationText(mutation);
    }
    const question = this.host.cardStore.awaitingAuthor(id)
      ? this.host.cardStore.newestCaptainMessage(id)
      : undefined;
    if (input.interim === true && question) {
      return `Posted in the thread on "${card.title}" (${id}); the captain's message ${question.id} still waits for your answer when the work is done, in a line naming it in answers_message.`;
    }
    const replied = `Replied in the thread on "${card.title}" (${id}).`;
    if (signsOff && mutation.answered === input.answersMessage) {
      const closed = this.signOff(id);
      const signed = `${replied} It answers the captain's message ${mutation.answered} and signs the answer off: the card left the stack as read`;
      return closed
        ? `${signed} and your task closes as answered, so nothing more is owed. End your turn.`
        : `${signed}, but your task stays open; report when your work is done.`;
    }
    const answered =
      mutation.answered !== undefined
        ? ` It answers the captain's message ${mutation.answered}.`
        : question
          ? ` The captain's message ${question.id} still waits: a line answers it only by naming it in answers_message.`
          : "";
    // An answer under another card leaves the captain's reply waiting
    // (INF-990 friction 4): the receipt names the card that still waits.
    const still = this.threadsAwaitingAuthor(taskId).filter((other) => other.id !== id);
    return still.length > 0
      ? `${replied}${answered} ${stillWaitingWords(still)}`
      : `${replied}${answered}`;
  }

  /**
   * The captain's line under an answer said they are done, and the crewmate
   * that answered it marked it so (INF-2845, direction A): the card resolves
   * through the one resolution path as read, the message it answers takes
   * it as its answer, and the task closes as answered - the same ending as
   * Done on a saved answer. The past card names its crewmate, never a click
   * of the captain's. Returns whether the task closed.
   */
  private signOff(id: string): boolean {
    const card = this.stack.cards.get(id);
    if (!card) return false;
    return this.stack.resolve(
      { ...card, actions: [{ id: SIGNED_OFF_ACTION_ID, label: ANSWER_DONE_LABEL }] },
      SIGNED_OFF_ACTION_ID,
      SIGNED_OFF_ACTION_ID,
      undefined,
      "crewmate",
      undefined,
      () => this.host.captainResponded?.(card, "signed-off"),
    );
  }

  /** Whether a captain reply on this open card still waits for its answer. */
  answerOwed(cardId: string): boolean {
    return this.stack.cards.has(cardId) && this.host.cardStore.awaitingAuthor(cardId);
  }

  /**
   * Whether any of a task's open cards currently waits on an author answer.
   * The sort and idle ladder share this persisted lifecycle-aware witness;
   * retained thread history alone does not mean the author owes an answer.
   */
  threadAwaitingAuthor(taskId: string): boolean {
    return this.threadsAwaitingAuthor(taskId).length > 0;
  }

  /**
   * The task's open cards whose current lifecycle waits on an author answer,
   * oldest first: what a reminder names, so its author answers the card the
   * captain wrote under rather than another of its cards (INF-990 friction 4).
   */
  threadsAwaitingAuthor(taskId: string): { id: string; title: string }[] {
    // A reply the first mate answers on the host's behalf (the stuck alert)
    // is never a thread the task's crewmate owes (INF-1670).
    return [...this.stack.cards.values()]
      .filter(
        (card) =>
          card.taskId === taskId &&
          card.answeredBy !== "firstmate" &&
          this.host.cardStore.awaitingAuthor(card.id),
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((card) => ({ id: card.id, title: card.title }));
  }

  /**
   * What a task's crew line says about its threads (`thread:`): how many
   * messages sit on its open cards and who wrote the newest, so the
   * Firstmate reads the state of a conversation it was never woken for.
   */
  threadFact(taskId: string): string | undefined {
    return this.threadFacts([taskId]).get(taskId);
  }

  /** One current roster read: visit the open stack once and fetch only its requested thread metadata. */
  threadFacts(taskIds: readonly string[]): Map<string, string> {
    if (taskIds.length === 0) return new Map();
    const wanted = new Set(taskIds);
    const cards = [...this.stack.cards.values()].filter(
      (card) => card.taskId && wanted.has(card.taskId),
    );
    const stats = this.host.cardStore.threadStats(cards.map((card) => card.id));
    const threads = new Map<string, { count: number; last: Pick<CardMessage, "who" | "at"> }>();
    for (const card of cards) {
      const stat = stats.get(card.id);
      if (!stat || !card.taskId) continue;
      const thread = threads.get(card.taskId);
      if (!thread) threads.set(card.taskId, { count: stat.count, last: stat });
      else {
        thread.count += stat.count;
        if (stat.at >= thread.last.at) thread.last = stat;
      }
    }
    return new Map(
      [...threads].map(([taskId, { count, last }]) => [
        taskId,
        `thread: ${count} message${count === 1 ? "" : "s"}, last from ${last.who}`,
      ]),
    );
  }

  /**
   * Every card whose thread has moved since `since`, newest first, with its
   * message count, newest message and who owes an answer now: what the
   * Firstmate's context-block section is rendered from (phase 1, captain's
   * C9 A). A card whose row is gone is skipped rather than named as an id
   * nobody can look up.
   */
  threadActivitySince(since: number, limit = 8): ThreadActivity[] {
    return this.host.cardStore.threadSummaries(since, limit).flatMap((summary) => {
      const open = this.stack.cards.get(summary.cardId);
      const card = open ?? this.host.cardStore.get(summary.cardId);
      if (!card) return [];
      return [{ card, count: summary.count, last: summary.last, owed: this.threadOwed(open) }];
    });
  }

  /** Who owes an answer on a card now: `closed` once it is off the stack. */
  owed(cardId: string): ThreadOwed {
    return this.threadOwed(this.stack.cards.get(cardId));
  }

  /** The current lifecycle's answer hold, the witness the sort and idle ladder read (`ThreadOwed`). */
  private threadOwed(open: Card | undefined): ThreadOwed {
    if (!open) return "closed";
    if (!this.host.cardStore.awaitingAuthor(open.id)) return "none";
    return this.firstmateAnswers(open) ? "firstmate" : "author";
  }

  /**
   * What an emit's id names for its caller (docs/card-threads.md, "Shared
   * cards"): an exact existing card id wins before the caller's own
   * prefixing, so a full id another agent read reaches that card; a card id
   * the record lacks, outside the caller's own namespace, is an unknown
   * target and never a new card.
   */
  targetOf(caller: CardCaller, rawId: string | undefined): CardTarget {
    const id = rawId?.trim() ?? "";
    if (!id) return { kind: "new" };
    const card = this.stack.cards.get(id) ?? this.host.cardStore.get(id);
    if (card) {
      if (ownedBy(card, caller)) return { kind: "own", id };
      return this.stack.cards.has(id)
        ? { kind: "foreign", id, card }
        : { kind: "closed", id, card };
    }
    const own =
      caller.actor === "firstmate"
        ? id.startsWith(FIRSTMATE_CARD_PREFIX)
        : id.startsWith(`card-${caller.taskId}-`);
    return id.startsWith("card-") && !own ? { kind: "unknown", id } : { kind: "new" };
  }

  /**
   * The line someone other than the card's answerer wrote that answered
   * this captain message, if one did: a queued answerer hears it instead of
   * answering the same question again (docs/card-threads.md, "Shared cards").
   */
  answeredByContributor(cardId: string, messageId: number): CardMessage | undefined {
    const line = this.host.cardStore.answerTo(cardId, messageId);
    return line?.contributor ? line : undefined;
  }

  /** The host's words for a writer, the same on every view and receipt. */
  contributorOf(caller: CardCaller): CardContributor {
    if (caller.actor === "firstmate") return { actor: "firstmate", label: "your first mate" };
    const key = this.host.tasks.get(caller.taskId)?.key || caller.taskId;
    return { actor: "crewmate", taskId: caller.taskId, label: `the crewmate on ${key}` };
  }

  /**
   * One card's current facts for a writer about to edit or answer it
   * (read-before-edit): its revision and lifecycle, the captain question it
   * waits on, its choices, words and thread with message ids, and for a
   * required action its generation and filings. Undefined for no card.
   */
  cardRead(id: string): CardRead | undefined {
    const card = this.stack.cards.get(id) ?? this.host.cardStore.get(id);
    if (!card) return undefined;
    const open = this.stack.cards.has(id);
    const task = card.taskId ? this.host.tasks.get(card.taskId) : undefined;
    const captainAction = task?.delivery?.captainAction;
    const question =
      open && this.host.cardStore.awaitingAuthor(id)
        ? this.host.cardStore.newestCaptainMessage(id)
        : undefined;
    return {
      id: card.id,
      title: card.title,
      author: card.author,
      ...(task ? { task: task.key || task.id } : {}),
      open,
      ...(card.lifecycleId ? { lifecycle: card.lifecycleId } : {}),
      ...(card.offerId ? { revision: card.offerId } : {}),
      ...(question
        ? { waitingOn: { messageId: question.id, text: cardMessageText(question) } }
        : {}),
      choices: card.actions.map((action) => ({
        id: action.id,
        label: action.label,
        ...(action.effect ? { effect: action.effect.kind } : {}),
      })),
      body: card.body,
      thread: this.host.cardStore.messages(id).map((message) => ({
        id: message.id,
        who: message.who,
        at: message.at,
        text: cardMessageText(message),
        ...(message.contributor ? { by: message.contributor.label } : {}),
        ...(message.answersMessage !== undefined ? { answers: message.answersMessage } : {}),
        ...(message.clarification ? { clarification: true } : {}),
      })),
      ...(captainAction && captainAction.cardId === id
        ? {
            requiredAction: {
              task: task?.key || card.taskId,
              generation: captainAction.generation,
              state: captainAction.state,
              requirements: captainAction.requirements.map((entry) => ({
                source: this.host.tasks.get(entry.source)?.key || entry.source,
                action: entry.action.id,
                title: entry.action.title,
                consequence: entry.action.consequence,
                instructions: entry.action.instructions,
                criterion: entry.action.criterion,
                corrections: (entry.corrections ?? []).map((correction) => ({
                  by: correction.label,
                  at: correction.at,
                  reason: correction.reason,
                  generation: correction.generation,
                })),
              })),
            },
          }
        : {}),
    };
  }

  /**
   * Revise or answer someone else's card (docs/card-threads.md, "Shared
   * cards"). Any first mate or crewmate may, with no grant: the card keeps
   * its author, task, lifecycle, source offer and answerer, the write
   * records who really made it, and nothing transfers responsibility,
   * attaches the card to the writer's task, approves, completes or settles.
   * A revision names the revision it read; a stale one, a closed card, a
   * card the host owns or a choice that carries an effect is refused with
   * nothing written. Without a revision named, it is a reply alone.
   */
  contribute(caller: CardCaller, raw: EmittedCardInput, facts: CardContribution): CardMutation {
    const contributor = this.contributorOf(caller);
    const target = this.targetOf(caller, raw.id);
    if (target.kind !== "foreign" && target.kind !== "closed") {
      return {
        effect: "refused",
        cardId: raw.id?.trim() ?? "",
        contributor,
        display: "available",
        refusal:
          target.kind === "unknown"
            ? "that id names no card on the record."
            : "that id names no card of someone else's; write your own card under your own id.",
      };
    }
    const repeated = this.repeatedContribution(facts.operationId, target.id, contributor);
    if (repeated) return repeated;
    const card = target.card;
    if (facts.expectedRevision === undefined) {
      const text = raw.reply?.trim();
      if (!text) {
        return this.refusedOn(
          card,
          contributor,
          "a revision of someone else's card names expected_revision, the revision you read; a reply alone carries reply. Read the card first.",
        );
      }
      return this.replyAs(caller, {
        cardId: card.id,
        text,
        ...(facts.answersMessage !== undefined ? { answersMessage: facts.answersMessage } : {}),
        ...(facts.operationId ? { operationId: facts.operationId } : {}),
      });
    }
    const refusal = this.contributionRefusal(card, target.kind === "closed", raw, facts);
    if (refusal) return this.refusedOn(card, contributor, refusal);
    const answer = raw.reply?.trim();
    if (answer && answer.length > CARD_REPLY_MAX_CHARS) {
      return this.refusedOn(
        card,
        contributor,
        `reply is at most ${CARD_REPLY_MAX_CHARS} characters; say it shorter.`,
      );
    }
    const answerFacts = answer ? this.answerFacts(card, facts.answersMessage) : undefined;
    if (answerFacts && "refusal" in answerFacts) {
      return this.refusedOn(card, contributor, answerFacts.refusal);
    }
    const answerer = answersFor(card, caller, (other) => this.firstmateAnswers(other));
    const author = card.author === "crewmate" ? "crewmate" : "firstmate";
    const declared = buildEmittedCard(
      card.id,
      { ...raw, taskId: card.taskId },
      {
        author,
        meta: card.meta,
        ...(card.taskId ? { taskId: card.taskId } : {}),
        ...(card.model ? { model: card.model } : {}),
        ...(card.place ? { place: card.place } : {}),
      },
      card.createdAt,
    );
    const { pictures: _pictures, width: _width, ...kept } = card;
    const revised: Card = {
      ...kept,
      title: declared.title,
      body: declared.body,
      actions: declared.actions,
      priority: declared.priority,
      ...(declared.pictures ? { pictures: declared.pictures } : {}),
      ...(declared.width ? { width: declared.width } : {}),
    };
    const changed =
      card.title !== revised.title ||
      card.body !== revised.body ||
      JSON.stringify(card.actions) !== JSON.stringify(revised.actions) ||
      JSON.stringify(card.pictures) !== JSON.stringify(revised.pictures);
    if (!changed && !answer) {
      return { ...this.mutationBase(card, contributor), effect: "unchanged" };
    }
    if (!changed && answer) {
      return this.replyAs(caller, {
        cardId: card.id,
        text: answer,
        ...(facts.answersMessage !== undefined ? { answersMessage: facts.answersMessage } : {}),
        ...(facts.operationId ? { operationId: facts.operationId } : {}),
      });
    }
    const stamped = this.stack.evidence.stamp(revised);
    const updated = stamped.card;
    // The stage keeps what it showed until the writer's own turn ends: a
    // crewmate's always, the first mate's while the card waits on its
    // author. A card not yet on the stage takes the write with it.
    const staged =
      this.stack.stage.of(card).shown ??
      (onStage(card) && (caller.actor === "crewmate" || card.awaiting !== undefined)
        ? card
        : undefined);
    let replyLine: CardMessage | undefined;
    const mutation = this.host.cardStore.transaction((): CardMutation => {
      this.stack.evidence.write(stamped, {
        revise: true,
        basis: "emitted",
        source: "tool",
        cause: "revise",
        ...(staged ? { shown: staged } : {}),
      });
      this.stack.cards.set(card.id, updated);
      this.stack.addMessage(
        card.id,
        "host",
        revisedLineWords(updated.title),
        undefined,
        undefined,
        revisionLinks(card, updated),
        false,
        { contributor },
      );
      if (answer && answerFacts) {
        replyLine = this.stack.addMessage(
          card.id,
          caller.actor,
          answer,
          undefined,
          undefined,
          undefined,
          false,
          { ...answerFacts.facts, ...(answerer ? {} : { contributor }) },
        );
      }
      const result: CardMutation = {
        ...this.mutationBase(updated, contributor),
        effect: "revised",
        unchanged: ["author", "task", "lifecycle", "answerer"],
        display: staged ? "held" : "available",
        ...(replyLine ? this.lineResult(replyLine, answerFacts) : {}),
      };
      this.recordContribution(facts, card.id, caller, result);
      return result;
    });
    if (staged) this.stack.stage.hold(updated, { shown: staged, writer: authorKey(caller) });
    this.stack.placed(updated);
    this.stack.scheduleBroadcast();
    return mutation;
  }

  /**
   * A line in a card's thread from any first mate or crewmate (the `reply`
   * output; docs/card-threads.md, "Shared cards"). Anyone but the card's
   * own answerer has its line carry who wrote it. Any line ends a captain
   * question only when it names that message and it is the one the card
   * waits on. A line naming a question already answered is kept as a
   * comment. A closed card takes a dated clarification that reopens
   * nothing. A response it carries is saved with it, once.
   */
  replyAs(caller: CardCaller, input: ReplyInput): CardMutation {
    const contributor = this.contributorOf(caller);
    const id = input.cardId.trim();
    const refuse = (refusal: string, card?: Card): CardMutation =>
      card
        ? this.refusedOn(card, contributor, refusal)
        : { effect: "refused", cardId: id, contributor, display: "available", refusal };
    if (!id) return refuse("reply needs card_id.");
    const card = this.stack.cards.get(id) ?? this.host.cardStore.get(id);
    if (!card) return refuse("that id names no card on the record.");
    const repeated = this.repeatedContribution(input.operationId, id, contributor);
    if (repeated) return repeated;
    const open = this.stack.cards.has(id);
    if (open && !cardTakesReplies(card)) {
      return refuse(
        card.replies === false ? "this card takes no reply." : "this card has no thread.",
        card,
      );
    }
    const text = input.text.trim();
    if (!text) return refuse("a reply needs some words.", card);
    if (text.length > CARD_REPLY_MAX_CHARS) {
      return refuse(
        `a reply is at most ${CARD_REPLY_MAX_CHARS} characters; say it shorter, or revise the card.`,
        card,
      );
    }
    if (input.response && caller.actor !== "crewmate") {
      return refuse("only a crewmate's line carries a response.", card);
    }
    // The card's own answerer writes as before; anyone else's line says who.
    const answerer = answersFor(card, caller, (other) => this.firstmateAnswers(other));
    const designated = open && answerer;
    const facts: MessageFacts = answerer ? {} : { contributor };
    if (!open) facts.clarification = true;
    if (!open && input.answersMessage !== undefined) {
      return refuse(
        "the card is closed, so a line on it answers no question; drop answers_message to add a dated clarification.",
        card,
      );
    }
    let answer = open ? this.answerFacts(card, input.answersMessage) : undefined;
    if (answer && "refusal" in answer) return refuse(answer.refusal, card);
    // A queued answerer whose question someone else already answered hears
    // that answer instead of answering again: its line is a comment.
    if (designated && input.answersMessage === undefined && card.awaiting !== "answer") {
      const newest = this.host.cardStore.newestCaptainMessage(id);
      const done = newest ? this.host.cardStore.answerTo(id, newest.id) : undefined;
      if (done?.contributor) answer = { facts: {}, already: done };
    }
    Object.assign(facts, answer?.facts ?? {});
    if (input.response && caller.actor === "crewmate") {
      if (!this.host.checkCardResponse || !this.host.submitCardResponse) {
        return refuse("this home cannot save a response with a card line.", card);
      }
      try {
        this.host.checkCardResponse(caller.taskId, input.response, {
          id,
          ...(card.lifecycleId ? { lifecycleId: card.lifecycleId } : {}),
          ...(facts.answersMessage !== undefined ? { messageId: facts.answersMessage } : {}),
        });
      } catch (caught) {
        return refuse(caught instanceof Error ? caught.message : String(caught), card);
      }
      facts.responseId = input.response.responseId;
    }
    // An interim line keeps the captain's reply waiting only from the card's
    // own answerer while one waits; anyone else's is a comment.
    const interim = designated && input.interim === true && card.awaiting === "answer";
    const response = input.response;
    return this.host.cardStore.transaction((): CardMutation => {
      const line = this.stack.addMessage(
        id,
        caller.actor,
        text,
        undefined,
        undefined,
        undefined,
        interim,
        facts,
      );
      if (response && caller.actor === "crewmate") {
        this.host.submitCardResponse?.(caller.taskId, response, text, {
          cardId: id,
          messageId: line.id,
        });
      }
      const result: CardMutation = {
        ...this.mutationBase(this.stack.cards.get(id) ?? card, contributor),
        effect: "reply-only",
        unchanged: REPLY_FIELDS_KEPT,
        display: "available",
        ...this.lineResult(line, answer),
      };
      this.recordContribution(input, id, caller, result);
      return result;
    });
  }

  /**
   * Correct a required action's words on its card (docs/required-actions.md,
   * "Correcting the words"): `TaskService.delivery.reviseRequiredAction` writes the
   * correction, and a card on the stack shows the new words and generation
   * at once with a thread line naming who corrected it. Every refusal
   * writes nothing.
   */
  reviseRequiredAction(
    caller: CardCaller,
    input: {
      action: string;
      source: string;
      actionId: string;
      expectedGeneration: number;
      patch: RequiredActionText;
      reason: string;
      operationId: string;
      sameAction: boolean;
    },
  ): CardMutation {
    const contributor = this.contributorOf(caller);
    const ref = input.action.trim();
    const rowId = ref.startsWith("card-fm-required-action-")
      ? ref.slice("card-fm-required-action-".length)
      : ref;
    const row = this.host.tasks.resolve(rowId);
    const cardId = row?.delivery?.captainAction?.cardId ?? ref;
    const shown = this.stack.cards.get(cardId);
    let updated: Card | undefined;
    const result = this.host.tasks.atomic(
      () => {
        const revision = this.host.tasks.delivery.reviseRequiredAction(ref, {
          source: input.source,
          actionId: input.actionId,
          expectedGeneration: input.expectedGeneration,
          patch: input.patch,
          reason: input.reason,
          operationId: input.operationId,
          sameAction: input.sameAction,
          by: {
            actor: contributor.actor,
            ...(contributor.taskId ? { taskId: contributor.taskId } : {}),
            label: contributor.label,
          },
          presented: shown !== undefined,
        });
        if (revision.effect !== "revised" || !shown || !row) return revision;
        const action = this.host.tasks.get(row.id)?.delivery?.captainAction;
        if (!action) return revision;
        const next = requiredActionCard(
          row.id,
          action,
          shown.createdAt,
          requiredActionProvenance(this.host.tasks),
        );
        const stamped = this.stack.evidence.stamp({
          ...shown,
          title: next.title,
          body: next.body,
          actions: next.actions,
          width: decidedCardWidth({ body: next.body }),
        });
        const card = stamped.card;
        this.stack.evidence.write(stamped, {
          revise: true,
          basis: "put",
          source: "host",
          cause: "revise",
        });
        this.stack.cards.set(card.id, card);
        this.stack.addMessage(
          card.id,
          "host",
          revisedLineWords(card.title),
          undefined,
          undefined,
          revisionLinks(shown, card),
          false,
          { contributor },
        );
        updated = card;
        return revision;
      },
      () => {
        if (updated) {
          this.stack.placed(updated);
          this.stack.scheduleBroadcast();
        }
      },
    );
    const card = updated ?? shown ?? this.host.cardStore.get(cardId);
    const base: Omit<CardMutation, "effect"> = card
      ? this.mutationBase(card, contributor)
      : { cardId, contributor, display: "available" };
    const generation = "generation" in result ? result.generation : undefined;
    switch (result.effect) {
      case "refused":
        return {
          ...base,
          effect: "refused",
          refusal: result.refusal,
          ...(generation !== undefined ? { generation } : {}),
        };
      case "unchanged":
        return { ...base, effect: "unchanged", generation: result.generation };
      case "repeated":
      case "revised": {
        // A repeated operation answers the revision it made the first time,
        // read back from the correction that operation saved.
        const changed =
          result.effect === "revised"
            ? result.changed
            : result.correction
              ? Object.keys(result.correction.previous)
              : undefined;
        return {
          ...base,
          effect: "revised",
          generation:
            result.effect === "repeated"
              ? (result.correction?.generation ?? result.generation)
              : result.generation,
          ...(result.effect === "repeated" ? { repeated: true } : {}),
          unchanged: [
            "target",
            "filing",
            "prerequisites",
            "completion",
            "state",
            "thread",
            ...(changed
              ? (["title", "consequence", "instructions", "criterion"] as const).filter(
                  (field) => !changed.includes(field),
                )
              : []),
          ],
        };
      }
    }
  }

  /**
   * Which captain message a line answers, read from the record: the one it
   * names, checked to be a captain message on this card; a line naming none
   * answers none. A named message someone already answered makes the line
   * a comment.
   */
  answerFacts(
    card: Card,
    named: number | undefined,
  ): { facts: MessageFacts; already?: CardMessage } | { refusal: string } {
    if (named === undefined) return { facts: {} };
    const message = this.host.cardStore.messageById(named);
    if (!message || message.cardId !== card.id || message.who !== "captain") {
      return {
        refusal: `message ${named} is not a captain message on this card; read the card and name the captain message you answer.`,
      };
    }
    const already = this.host.cardStore.answerTo(card.id, named);
    if (already) return { facts: {}, already };
    return { facts: { answersMessage: named } };
  }

  /**
   * Why someone else's open card cannot take this revision, or undefined
   * when it can (docs/card-threads.md, "Shared cards"): a closed card keeps
   * its offered words and choices; the app's own cards, a required action's
   * words and a saved change story have their own owners; a choice that
   * carries an effect is validated only on its own task's path; and the
   * facts that belong to the card's own task and author stay theirs.
   */
  private contributionRefusal(
    card: Card,
    closed: boolean,
    raw: EmittedCardInput,
    facts: CardContribution,
  ): string | undefined {
    if (closed) {
      return "the card is closed, so its offered words, choices and decision history stay as they were. Add a dated clarification with reply alone.";
    }
    const task = card.taskId ? this.host.tasks.get(card.taskId) : undefined;
    if (task?.delivery?.captainAction?.cardId === card.id) {
      return "a required action's words change only through revise_required_action, which keeps its filing and moves its generation; its thread takes a reply.";
    }
    if (card.author !== "crewmate" && card.author !== "firstmate") {
      return "the app wrote this card, so its words and controls are not prose anyone revises; its thread takes a reply when it has one.";
    }
    if (facts.expectedRevision !== card.offerId) {
      return `you read revision ${facts.expectedRevision}, and the card has changed since. Read it again, then revise the version it shows now.`;
    }
    if (raw.taskId && raw.taskId !== card.taskId) {
      return "a contribution keeps the card on its own task; drop task_id.";
    }
    const effect = [...card.actions, ...raw.actions].find((action) => action.effect);
    if (effect || takesTaskFacts(card)) {
      return `choice "${effect?.id ?? "merge"}" carries an effect the app checks against this card's own task, checks and version, so only its author's own path changes it. Write on its thread with reply instead.`;
    }
    if (task?.delivery?.presentation && card.author === "crewmate") {
      return "this task's saved change story owns its completion words, bound to its checked version; its own crewmate revises the story. Write on its thread with reply instead.";
    }
    const owned = [
      raw.requiredActions !== undefined && "required_actions",
      raw.riskDeclaration && "risk",
      raw.presentationRevision !== undefined && "presentation",
      raw.sinceSeen !== undefined && "since_seen",
      raw.reviewTaskId && "review_task_id",
      raw.validationDecision && "validation_request",
      raw.allows && "allows",
      (raw.browserButton !== undefined || raw.browserPage !== undefined || raw.browserHandoff) &&
        "browser controls",
    ].filter(Boolean);
    if (owned.length > 0) {
      return `${owned.join(", ")} belong to the card's own task and author; leave them out of a contribution.`;
    }
    return undefined;
  }

  /** What a refusal or a result names of the card as it stands. */
  private mutationBase(card: Card, contributor: CardContributor): Omit<CardMutation, "effect"> {
    return {
      cardId: card.id,
      title: card.title,
      ...(card.lifecycleId ? { lifecycleId: card.lifecycleId } : {}),
      ...(card.offerId ? { revision: card.offerId } : {}),
      contributor,
      display: "available",
    };
  }

  private refusedOn(card: Card, contributor: CardContributor, refusal: string): CardMutation {
    return { ...this.mutationBase(card, contributor), effect: "refused", refusal };
  }

  /** The same operation identity answers its earlier result, on its own card only. */
  private repeatedContribution(
    operationId: string | undefined,
    cardId: string,
    contributor: CardContributor,
  ): CardMutation | undefined {
    if (!operationId) return undefined;
    const prior = this.host.cardStore.contribution(operationId);
    if (!prior) return undefined;
    if (prior.cardId !== cardId) {
      return {
        effect: "refused",
        cardId,
        contributor,
        display: "available",
        refusal: `operation ${operationId} already wrote on card ${prior.cardId}; give this write its own operation identity.`,
      };
    }
    const parsed = cardMutationSchema.safeParse(prior.result);
    return parsed.success ? { ...parsed.data, repeated: true } : undefined;
  }

  private recordContribution(
    facts: { operationId?: string; reason?: string },
    cardId: string,
    caller: CardCaller,
    result: CardMutation,
  ): void {
    if (!facts.operationId) return;
    this.host.cardStore.recordContribution({
      operationId: facts.operationId,
      cardId,
      actor: caller.actor,
      ...(caller.actor === "crewmate" ? { taskId: caller.taskId } : {}),
      ...(facts.reason?.trim() ? { reason: cutText(facts.reason.trim(), 500) } : {}),
      at: this.host.now(),
      result,
    });
  }

  /** The thread facts a write's result names. */
  lineResult(
    line: CardMessage,
    answer: { facts: MessageFacts; already?: CardMessage } | { refusal: string } | undefined,
  ): Partial<CardMutation> {
    const already = answer && "already" in answer ? answer.already : undefined;
    return {
      replyId: line.id,
      ...(line.answersMessage !== undefined && !already ? { answered: line.answersMessage } : {}),
      ...(line.clarification ? { clarification: true as const } : {}),
      ...(already
        ? {
            alreadyAnswered: {
              messageId: already.answersMessage ?? 0,
              by:
                already.contributor?.label ??
                (already.who === "firstmate" ? "your first mate" : "the card's author"),
              text: cutText(already.text.replace(/\s+/g, " "), 160),
            },
          }
        : {}),
    };
  }
}

/** What a receipt adds when another card's thread still waits on its author. */
function stillWaitingWords(cards: readonly { id: string; title: string }[]): string {
  return `The captain's reply under ${waitingCardWords(cards)} still waits on your answer: answer it there with reply, or in that card's emit_card revision, naming their message in answers_message.`;
}

/** Whether a card is the caller's own: the first mate's, or its crewmate's on its task. */
function ownedBy(card: Card, caller: CardCaller): boolean {
  return caller.actor === "firstmate"
    ? card.author === "firstmate"
    : card.author === "crewmate" && card.taskId === caller.taskId;
}

/** Whether the caller is the one the card's thread routes the captain's replies to. */
function answersFor(
  card: Card,
  caller: CardCaller,
  firstmateAnswers: (card: Card) => boolean,
): boolean {
  // A crewmate answers every card on its own task, as it always has
  // (INF-1273: a first mate card its task's crewmate is asked to answer).
  return caller.actor === "firstmate" ? firstmateAnswers(card) : card.taskId === caller.taskId;
}

/** A writer's key in a card's `StageHold`, matched by `CardService.closeOut`. */
export function authorKey(author: CardCaller | CardAuthorRef | CardContributor): string {
  const kind = "actor" in author ? author.actor : author.kind;
  return kind === "firstmate" ? "firstmate" : `crewmate:${(author as { taskId: string }).taskId}`;
}

/**
 * One card as a writer reads it before editing or answering
 * (`CardService.cardRead`): JSON for the `tasks` read's card field.
 */
export type CardRead = {
  id: string;
  title: string;
  author: Card["author"];
  task?: string;
  open: boolean;
  lifecycle?: string;
  revision?: string;
  waitingOn?: { messageId: number; text: string };
  choices: { id: string; label: string; effect?: string }[];
  body: string;
  thread: {
    id: number;
    who: CardMessageWho;
    at: number;
    text: string;
    by?: string;
    answers?: number;
    clarification?: boolean;
  }[];
  requiredAction?: {
    task?: string;
    generation: number;
    state: string;
    requirements: {
      source: string;
      action: string;
      title: string;
      consequence: string;
      instructions: string[];
      criterion: string;
      corrections: { by: string; at: number; reason: string; generation: number }[];
    }[];
  };
};
