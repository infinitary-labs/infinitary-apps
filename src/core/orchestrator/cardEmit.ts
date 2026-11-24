import { randomUUID } from "node:crypto";
import { cardAnswerLines } from "@shared/cardAnswerLines";
import { NOTE_DONE_ACTION_ID } from "@shared/cardLeave";
import {
  CARD_REPLY_MAX_CHARS,
  type Card,
  type CardMutation,
  type CardWidth,
  FIRSTMATE_CARD_META,
  MERGE_HELD_MARK,
  mergeEffectOf,
  onStage,
  type PastCard,
  settleEffectOf,
} from "@shared/cards";
import { readyPresentation } from "@shared/changePresentation";
import { mergeActionsOf, withoutHeldMark } from "@shared/mergeHeld";
import { PANEL_READ_NAMES } from "@shared/personal/manifest";
import { isPublishedView } from "@shared/sql";
import { revisedLineWords } from "@shared/threadLines";
import { parseStableCardId, resolveFirstmateCardId } from "../pi/cardTool";
import { decidedCardWidth } from "../pi/cardWidth";
import type { EmittedCardInput } from "../session/tools";
import { TaskService } from "../tasks/taskService";
import { answeredQuestionRefusal } from "./answeredQuestion";
import { FIRSTMATE_CARD_PREFIX } from "./cardIds";
import { revisionLinks } from "./cardNavigation";
import type { CardServiceHost, CardStack } from "./cardStackTypes";
import type { CardThreads } from "./cardThreads";
import { waitingCardWords } from "./idleWakes";
import type { PutOffs } from "./putOffs";
import { emittedSettleFacts } from "./settleCardFacts";

/**
 * A card an agent emits (docs/card-threads.md): the first mate's through its
 * emit_card tool, a crewmate's once its supervisor passed it. One path
 * creates a card or revises its author's own card in place; someone else's
 * card is written through `CardThreads.contribute`, never here.
 */

export { cardEmitter, FIRSTMATE_CARD_PREFIX } from "./cardIds";

/** A decision (a card with actions) shows before a note; the host's own cards sit above both. */
function cardPriority(input: Pick<EmittedCardInput, "actions">): number {
  return input.actions.length > 0 ? 30 : 15;
}

/** A closed card the captain answered with a choice; a record from before `by` was kept counts as theirs. */
function chosenByCaptain(past: PastCard | undefined): past is PastCard {
  return past?.ending.how === "chose" && (past.ending.by ?? "captain") === "captain";
}

/**
 * What the first mate's write on its own card did beyond showing it
 * (docs/card-threads.md, "First mate card threads (phase 2)"): whether it changed the
 * card the captain sees, the thread line it wrote, and the captain message
 * the card still waits on after it. The emit fills it in as it writes.
 */
export type OwnCardWrite = {
  changed?: boolean;
  line?: Pick<CardMutation, "replyId" | "answered" | "alreadyAnswered">;
  stillOpen?: number;
};

/** Who emits a card and what it says of itself beside its declared words. */
type EmitContext = {
  taskId?: string;
  /** The task whose facts a review's card draws: the builder it reviews. */
  factsOf?: string;
  author: "crewmate" | "firstmate";
  meta: string;
  model?: string;
  place?: string;
  mintId: () => string;
  resolveId: (stableId: string) => string;
};

export class CardEmits {
  private cardSeq = 0;

  constructor(
    private readonly host: CardServiceHost,
    private readonly stack: CardStack,
    private readonly threads: CardThreads,
    private readonly putOffs: Pick<PutOffs, "check">,
  ) {}

  /**
   * A card emitted by a crewmate through its emit_card tool (D-9, Q3), once
   * the supervisor's holds, completion actions, lint and CI gate passed it.
   * `place` is where its task runs when that is a computer that runs work.
   */
  emitCrewmateCard(
    taskId: string,
    input: EmittedCardInput,
    meta: string,
    model?: string,
    place?: string,
  ): string {
    // An independent reviewer's decision is its Review finding card
    // (INF-4338's direction D): the app labels it and draws the builder's
    // facts on it, and its choice goes to the builder (`CardActions.act`).
    const review = this.host.tasks.get(taskId);
    const builderId =
      review?.shape?.kind === "review" &&
      review.shape.kind_source === "host:review" &&
      input.actions.length > 0
        ? review.parentId
        : null;
    return this.upsertEmitted(builderId ? { ...input, reviewTaskId: taskId } : input, {
      taskId,
      ...(builderId ? { factsOf: builderId } : {}),
      author: "crewmate",
      meta,
      ...(model ? { model } : {}),
      ...(place ? { place } : {}),
      mintId: () => {
        this.cardSeq += 1;
        return `card-${taskId}-${this.cardSeq}`;
      },
      resolveId: (stableId) => crewmateCardId(taskId, stableId),
    });
  }

  /**
   * The open completion card a crewmate's emit would revise in place: the
   * card its declared id names on this task's stack, still carrying a merge.
   * Undefined for a new card, another task's card or one already answered.
   */
  openCompletionCard(taskId: string, declaredId: string | undefined): Card | undefined {
    let stableId: string | undefined;
    try {
      stableId = parseStableCardId(declaredId);
    } catch {
      return undefined;
    }
    if (!stableId) return undefined;
    const card = this.stack.cards.get(crewmateCardId(taskId, stableId));
    if (card?.taskId !== taskId || card.author !== "crewmate") return undefined;
    // A card whose Merge the app holds is still the open merge card (INF-4031).
    return mergeActionsOf(card).length > 0 ? card : undefined;
  }

  /**
   * A card emitted by the Firstmate agent - its only user-facing output
   * channel (report section 4a). Decision answers route back to the agent
   * as [fm-op] messages through `CardActions.act`.
   */
  addFirstmateCard(input: EmittedCardInput, written?: OwnCardWrite): string {
    return this.upsertEmitted(
      input,
      {
        ...(input.taskId ? { taskId: input.taskId } : {}),
        author: "firstmate",
        // The first mate's card is its own (INF-2714): its head names no
        // task. The app's own note about a task heads with that task.
        meta:
          (input.aboutTask && input.taskId
            ? this.host.tasks.get(input.taskId)?.title
            : undefined) ?? FIRSTMATE_CARD_META,
        mintId: () => {
          this.cardSeq += 1;
          return `${FIRSTMATE_CARD_PREFIX}${this.cardSeq}-${randomUUID().slice(0, 6)}`;
        },
        resolveId: resolveFirstmateCardId,
      },
      written,
    );
  }

  /**
   * A host-presented Firstmate note with its completed answer and caller's
   * durable record in the same commit. No model turn or close-out hold.
   * The stack changes only after all writers have committed successfully.
   * `onTop` places it above every card on the stack now, where a note
   * otherwise sorts behind every decision and every older note. The host
   * may also present it as taking no reply, or at the width its body was
   * drawn for (the welcome: its picture is the regular card's width).
   */
  addRecordedFirstmateNote(
    input: Pick<EmittedCardInput, "title" | "body" | "pictures"> & {
      /** What the record keeps as its answer when the body is more than words (the welcome). */
      answer?: string;
    },
    record: (cardId: string) => void,
    presentation: { onTop?: boolean; replies?: false; width?: CardWidth } = {},
  ): string {
    const id = `${FIRSTMATE_CARD_PREFIX}${randomUUID()}`;
    const emitted = buildEmittedCard(
      id,
      {
        title: input.title,
        body: input.body,
        actions: [],
        ...(input.pictures ? { pictures: input.pictures } : {}),
      },
      { author: "firstmate", meta: FIRSTMATE_CARD_META },
      this.host.now(),
    );
    const built = {
      ...emitted,
      ...(presentation.replies === false ? { replies: false as const } : {}),
      ...(presentation.width ? { width: presentation.width } : {}),
    };
    const stamped = this.stack.evidence.stamp(
      presentation.onTop ? { ...built, priority: this.stack.topPriority(built.priority) } : built,
    );
    const card = stamped.card;
    return this.host.tasks.atomic(
      () => {
        this.stack.evidence.write(stamped, { basis: "emitted", source: "host", cause: "emit" });
        this.host.tasks.capture.fileQuestion({
          id: randomUUID().slice(0, 8),
          title: input.title,
          outcome: input.answer ?? input.body,
          cardId: id,
        });
        record(id);
        return id;
      },
      () => {
        this.stack.cards.set(id, card);
        this.stack.placed(card);
        // The note is in the same published ready state, not waiting on the
        // ordinary buffered card broadcast (or any model work).
        this.stack.broadcastSnapshot();
      },
    );
  }

  /**
   * A put-off choice ("Not until…", INF-3846 piece 3) names what an
   * Automation rule can wait for: a task's close by key, kept as the task's
   * id, a time still to come, or an event something connected tells. One it
   * could never see come true is refused with its fix.
   */
  private putOffsChecked(input: EmittedCardInput): EmittedCardInput {
    if (!input.actions.some((action) => action.until)) return input;
    const now = this.host.now();
    const actions = input.actions.map((action) => {
      const until = action.until;
      if (!until) return action;
      if (action.effect)
        throw new Error(
          `Card refused: action "${action.id}" carries both until and an effect. A put-off is an ordinary choice the app keeps; give it no effect. Nothing was shown.`,
        );
      if (until.kind === "date") {
        if (!Number.isFinite(until.at))
          throw new Error(
            `Card refused: action "${action.id}"'s until at is not a time. Give an ISO time with its offset, such as 2026-11-20T09:00:00-08:00. Nothing was shown.`,
          );
        if (until.at <= now)
          throw new Error(
            `Card refused: action "${action.id}"'s until at has already passed. Name a time still to come. Nothing was shown.`,
          );
        return action;
      }
      if (until.kind === "close") {
        const awaited = until.task ? this.host.tasks.resolve(until.task) : undefined;
        if (!awaited)
          throw new Error(
            `Card refused: action "${action.id}"'s until task "${until.task}" names no task. Give the key of the task it waits for. Nothing was shown.`,
          );
        if (TaskService.isClosed(awaited))
          throw new Error(
            `Card refused: ${awaited.key} has already closed, so there is nothing to wait for. Ask the question now, or name another task. Nothing was shown.`,
          );
        return { ...action, until: { kind: "close" as const, task: awaited.id } };
      }
      if (until.kind === "event") {
        try {
          this.putOffs.check(until);
        } catch (error) {
          throw new Error(
            `Card refused: action "${action.id}"'s until event cannot be waited for. ${error instanceof Error ? error.message : String(error)} Nothing was shown.`,
          );
        }
      }
      return action;
    });
    return { ...input, actions };
  }

  /**
   * Create or revise an agent-emitted card. A still-open card with the same
   * stable id is updated in place (same stack position); otherwise a new
   * card is minted.
   */
  private upsertEmitted(
    raw: EmittedCardInput,
    context: EmitContext,
    written: OwnCardWrite = {},
  ): string {
    // Only the host writes a merge card's held line (INF-4031); an authored body never carries one.
    let input = raw.body.includes(MERGE_HELD_MARK)
      ? { ...raw, body: withoutHeldMark(raw.body) }
      : raw;
    // The two structural checks every emit boundary holds (P1): the host's
    // own effect is no agent's to declare, and a settle effect must know
    // its task or the button can settle nothing. Each lint already refuses
    // both with corrective text; this is the last line behind them.
    const hostEffect = input.actions.find((action) => action.effect?.kind === "host");
    if (hostEffect) {
      throw new Error(
        `Action "${hostEffect.id}" carries a host effect, which only the app's own cards may.`,
      );
    }
    // A kept write is its crewmate's to ask about, on its own task (FI3-1571 piece 4).
    const write = input.actions.find((action) => action.effect?.kind === "request_write");
    if (write && (context.author !== "crewmate" || !context.taskId)) {
      throw new Error(
        `Action "${write.id}" asks to send a crewmate's write, which only that crewmate's card may.`,
      );
    }
    input = this.putOffsChecked(input);
    const settle = input.actions.find((action) => settleEffectOf(action) || mergeEffectOf(action));
    if (settle && !context.taskId) {
      throw new Error(
        `Action "${settle.id}" carries a merge or discard effect, so the card must pass task_id; without it the host cannot tell which task to merge or discard and the button does nothing.`,
      );
    }
    // The click refuses every choice on a closed task's card
    // (`CardActions.act`), so a card with actions on one never goes up.
    const task = context.taskId ? this.host.tasks.get(context.taskId) : undefined;
    if (task && input.actions.length > 0 && TaskService.isClosed(task)) {
      throw new Error(
        `Task ${task.id} is closed, so a choice on a card about it cannot be taken; a card with actions needs an open task.`,
      );
    }
    // A first-mate settle button on a task with a saved story carries that
    // story once it is published (INF-2490, lifting INF-1364): the host binds
    // the card to it (`CrewSupervisor.addFirstmateCard`). Before then the
    // click gate could not pass, so the card is refused before it is written.
    if (
      context.author === "firstmate" &&
      task?.delivery?.presentation &&
      !readyPresentation(task.delivery.presentation) &&
      input.actions.some((action) => {
        const merge = mergeEffectOf(action);
        return merge !== undefined && !merge.review;
      })
    ) {
      throw new Error(
        `Task ${task.id}'s saved change story is not published at its newest revision, so a merge button cannot carry it yet. Steer the crewmate to publish its story, or to emit its own merge card. The card is unchanged.`,
      );
    }
    // A crewmate's review link is the host's own (`emitCrewmateCard`); the
    // first mate's names a review it must check.
    if (input.reviewTaskId && context.author === "firstmate") {
      const review = this.host.tasks.resolve(input.reviewTaskId);
      if (
        !task ||
        review?.shape?.kind !== "review" ||
        review.shape.kind_source !== "host:review" ||
        review.parentId !== task.id
      ) {
        throw new Error(
          "Card refused: review_task_id must name an independent review of task_id. The card is unchanged.",
        );
      }
      input = { ...input, reviewTaskId: review.id };
    }
    // A settle card carries the facts the host holds about its task, and a
    // merge card what the crew filed under its name (`emittedSettleFacts`).
    const taskId = context.factsOf ?? context.taskId;
    if (taskId) {
      input = emittedSettleFacts(input, {
        facts: (part) => this.host.settleFacts(taskId, part),
        othersOpen: () => this.stack.othersOpen(taskId, input.id),
        followups: () => this.host.followupNotice(taskId),
      });
    }
    // An exact card id wins before the author's own prefixing, and a card id
    // the record lacks is an unknown target, never a new card. Someone
    // else's card is written through `contribute`, never here.
    const target = this.threads.targetOf(
      context.author === "firstmate"
        ? { actor: "firstmate" }
        : { actor: "crewmate", taskId: context.taskId ?? "" },
      input.id,
    );
    if (target.kind === "unknown") {
      throw new Error(
        `Card refused: "${target.id}" names no card on the record, so there is nothing to update. Read the card's id again, or give a short id of your own for a new card. Nothing was shown.`,
      );
    }
    if (target.kind === "foreign" || target.kind === "closed") {
      throw new Error(
        `Card refused: card "${target.id}" is someone else's, so this write is a contribution. Read the card, then pass expected_revision with the revision you read to revise it, or give reply alone to write on its thread. Nothing was shown.`,
      );
    }
    let stableId: string | undefined;
    try {
      stableId = parseStableCardId(input.id);
    } catch {
      stableId = undefined;
    }
    const resolved =
      target.kind === "own" ? target.id : stableId ? context.resolveId(stableId) : undefined;
    const existing = resolved ? this.stack.cards.get(resolved) : undefined;
    const owner =
      existing?.taskId ?? (resolved ? this.host.cardStore.get(resolved)?.taskId : undefined);
    if (
      [owner, input.taskId].some((id) => id && this.host.tasks.get(id)?.delivery?.captainAction)
    ) {
      // INF-1137 friction 2: answer on the required-action card without
      // replacing the app's instructions, generation or completion controls.
      const answer = input.reply?.trim();
      if (
        existing &&
        existing.author === "firstmate" &&
        owner &&
        this.host.tasks.get(owner)?.delivery?.captainAction &&
        (!input.taskId || input.taskId === owner) &&
        context.author === "firstmate" &&
        answer
      ) {
        if (answer.length > CARD_REPLY_MAX_CHARS)
          throw new Error(`A reply is at most ${CARD_REPLY_MAX_CHARS} characters.`);
        const named = this.threads.answerFacts(existing, input.answersMessage);
        if ("refusal" in named) throw new Error(`Card refused: ${named.refusal}`);
        const line = this.stack.addMessage(
          existing.id,
          "firstmate",
          answer,
          undefined,
          undefined,
          undefined,
          false,
          named.facts,
        );
        this.noteWrite(written, existing.id, false, this.threads.lineResult(line, named));
        return existing.id;
      }
      throw new Error(
        "This required-action card keeps its app-owned instructions and confirmation. To answer here, emit_card with this same id and reply; the host keeps the body and controls unchanged. Use update_task drop with a reason to cancel, or revise the declaration on its source card.",
      );
    }
    if (!existing && resolved) this.refuseAnsweredRevision(resolved, input);
    this.refuseAnsweredQuestion(resolved, input, context);
    if (existing && resolved) {
      // An update is never the whole answer: while the captain's reply waits
      // on its author, the revision carries the author's short answer too.
      const answer = input.reply?.trim();
      const waiting = this.host.cardStore.awaitingAuthor(resolved);
      if (waiting && !answer) {
        throw new Error(
          `Card refused: the captain's reply under card "${resolved}" waits on your answer, and a revision alone does not give it. Call emit_card again with the same id and the same card plus reply: one to three sentences answering them and saying what you changed on the card and under which heading, with answers_message naming their message when it answers it. The card and its thread are unchanged.`,
        );
      }
      if (answer && answer.length > CARD_REPLY_MAX_CHARS) {
        throw new Error(
          `Card refused: reply is at most ${CARD_REPLY_MAX_CHARS} characters; say it shorter. The card and its thread are unchanged.`,
        );
      }
      // The reply ends the captain's question only when it names it.
      const named = this.threads.answerFacts(existing, answer ? input.answersMessage : undefined);
      if ("refusal" in named) {
        throw new Error(`Card refused: ${named.refusal} The card and its thread are unchanged.`);
      }
      // A crewmate's answer that names no captain message leaves it
      // waiting, and its revision with it, so the card would keep showing
      // the old version after the answer (INF-2884, the captain's "refuse a
      // revision whose answer neither names your message nor is marked as
      // a progress note"). Writing nothing, the half-done state never shows.
      const asked = waiting ? this.host.cardStore.newestCaptainMessage(resolved) : undefined;
      if (
        asked &&
        answer &&
        context.author === "crewmate" &&
        input.interim !== true &&
        named.facts.answersMessage !== asked.id
      ) {
        throw new Error(
          `Card refused: the captain's message ${asked.id} under card "${resolved}" waits on your answer, and this reply does not name it, so the card would keep showing them the version they replied under. Call emit_card again with the same id and the same card plus answers_message ${asked.id} when the reply answers them, or interim true when it is a progress note and you answer later. The card and its thread are unchanged.`,
        );
      }
      const revised = buildEmittedCard(resolved, input, context, existing.createdAt);
      const changed =
        existing.title !== revised.title ||
        existing.body !== revised.body ||
        JSON.stringify(existing.actions) !== JSON.stringify(revised.actions) ||
        JSON.stringify(existing.attachment) !== JSON.stringify(revised.attachment) ||
        JSON.stringify(existing.risk) !== JSON.stringify(revised.risk) ||
        JSON.stringify(existing.requiredActions) !== JSON.stringify(revised.requiredActions) ||
        JSON.stringify(existing.afterMerge) !== JSON.stringify(revised.afterMerge);
      // Every revision made while answering the captain carries its own
      // answer (INF-1623, the captain's "every"): one after the turn's
      // answer would otherwise follow it with no word on what it changed.
      if (changed && !answer && this.stack.stage.of(existing).answering) {
        throw new Error(
          `Card refused: you answered the captain's reply under card "${resolved}" in this turn, and this revision changes the card again without saying how. Call emit_card again with the same id and the same card plus reply: one to three sentences saying what you changed on the card and under which heading. The card and its thread are unchanged.`,
        );
      }
      // A card off the stage stays off it; one on it keeps showing what it
      // showed until its crewmate author's turn ends (the one rule), and so
      // does one still waiting on its author after the captain's reply,
      // whoever its author is. The Firstmate's own revision of any other
      // card on the stage redraws at once. One the captain put aside stays
      // aside while its reply leaves their question waiting (INF-1623).
      const stillAsked =
        waiting &&
        named.facts.answersMessage !== this.host.cardStore.newestCaptainMessage(resolved)?.id;
      const aside = existing.minimized === true && stillAsked;
      const stamped = this.stack.evidence.stamp({
        ...revised,
        ...(aside ? { minimized: true as const } : {}),
        ...(existing.awaiting ? { awaiting: existing.awaiting } : {}),
        ...(existing.sentBackAt !== undefined ? { sentBackAt: existing.sentBackAt } : {}),
      });
      const updated = stamped.card;
      const staged =
        this.stack.stage.of(existing).shown ??
        (onStage(existing) && (context.author === "crewmate" || existing.awaiting !== undefined)
          ? existing
          : undefined);
      this.host.cardStore.transaction(() => {
        // Revise in place keeps the replaced version as the card's history (WI-12).
        this.stack.evidence.write(stamped, {
          revise: true,
          basis: "emitted",
          source: "tool",
          cause: "revise",
          ...(staged ? { shown: staged } : {}),
        });
      });
      if (staged) this.stack.stage.hold(updated, { shown: staged });
      this.stack.cards.set(resolved, updated);
      // A crewmate's revision of a card the captain put aside brings it back
      // when that crewmate's turn ends, never mid-turn (INF-926).
      if (existing.minimized && !aside && context.author === "crewmate")
        this.stack.stage.hold(updated, { aside: true });
      this.stack.placed(updated);
      // The preferred answer to a thread message is a revision of the head
      // (cards-as-threads phase 1): the card re-renders above, and the
      // thread says so in one host line, so a small change is never
      // invisible - the captain's own "it's not clear where the update is".
      if (changed && this.host.cardStore.messages(resolved).length > 0) {
        this.stack.addMessage(
          resolved,
          "host",
          revisedLineWords(updated.title),
          undefined,
          undefined,
          revisionLinks(existing, updated),
        );
      }
      // The answer lands right after the revised line, whether or not the
      // captain's reply still waits (INF-1623): an earlier line that ended
      // the wait never makes the answer vanish.
      let line: OwnCardWrite["line"];
      if (answer && (waiting || this.host.cardStore.messages(resolved).length > 0)) {
        const added = this.stack.addMessage(
          resolved,
          context.author,
          answer,
          undefined,
          undefined,
          undefined,
          context.author === "crewmate" && input.interim === true,
          named.facts,
        );
        line = this.threads.lineResult(added, named);
      }
      this.noteWrite(written, resolved, changed, line);
      this.stack.scheduleBroadcast();
      return resolved;
    }
    // A reply rides a revision of the card the captain wrote under. A new
    // card carrying one would drop it and leave that card waiting on an
    // answer nobody gives (INF-990 friction 4), so it names that card.
    const waiting =
      input.reply?.trim() && context.author === "crewmate" && context.taskId
        ? this.threads.threadsAwaitingAuthor(context.taskId)
        : [];
    if (waiting.length > 0) {
      throw new Error(
        `Card refused: reply answers the captain's reply under ${waitingCardWords(waiting)}, and ${stableId ? `id "${stableId}" names a new card` : "a card without that card's id is a new card"}, so that answer would be lost. Revise that card under its own id with reply, or answer it with reply(card_id, text) and emit this card without reply. Nothing was shown.`,
      );
    }
    const id = resolved && !this.stack.cards.has(resolved) ? resolved : context.mintId();
    const built = buildEmittedCard(id, input, context, this.host.now());
    // A crewmate's new card waits for its close-out, and lands on its
    // task's timeline (P1) when it reaches the stage (`release`). The
    // Firstmate's own cards go up at once - its emits end a short turn -
    // and are recorded by the agent at its emit_card boundary, where it
    // also knows which task a task-less card files.
    const stamped = this.stack.evidence.stamp(
      context.author === "crewmate" ? { ...built, awaiting: "close-out" } : built,
    );
    const card = stamped.card;
    this.host.cardStore.transaction(() => {
      this.stack.evidence.write(stamped, { basis: "emitted", source: "tool", cause: "emit" });
    });
    this.stack.cards.set(id, card);
    this.stack.placed(card);
    this.stack.scheduleBroadcast();
    return id;
  }

  private noteWrite(
    written: OwnCardWrite,
    cardId: string,
    changed: boolean,
    line: OwnCardWrite["line"],
  ): void {
    written.changed = changed;
    if (line) written.line = line;
    const open = this.host.cardStore.awaitingAuthor(cardId)
      ? this.host.cardStore.newestCaptainMessage(cardId)?.id
      : undefined;
    if (open !== undefined) written.stillOpen = open;
  }

  /**
   * The id the host's own offer card for the first mate's `app_change` goes
   * up under (`HandoverOffer`, firstmateTools' handover). The offer's id
   * while its card is up, or never answered, so asking again revises it.
   * Once the captain answered that card with a choice, the next ask is a
   * new question: it goes up under the next id in the series, so adding a
   * second computer is never refused as the first one's answered card.
   */
  offerCardId(stableId: string): string {
    let id = stableId;
    let next = 2;
    while (chosenByCaptain(this.host.cardStore.past(resolveFirstmateCardId(id)))) {
      id = `${stableId}-${next}`;
      next += 1;
    }
    return id;
  }

  /**
   * INF-6250 finding 2: a validation question whose click came too late is
   * left as a note while its crewmate asks again, and the app tells that
   * crewmate to revise the same card. The captain closing that note is not
   * their read of a finished answer, so the renewed question may come back
   * under its id. It is that note while the newest request bound to the card
   * expired with no answer (`TaskDeliveries.expireValidationDecision`).
   */
  private renewingValidationQuestion(past: PastCard): boolean {
    if (!past.taskId) return false;
    const permissions = this.host.tasks.get(past.taskId)?.delivery?.liveValidation?.permissions;
    const newest = permissions?.findLast((item) => item.decision?.card === past.id);
    return newest?.state === "expired" && newest.answer === undefined;
  }

  /**
   * A decision asking a question the captain already answered on another
   * closed card (INF-6523 part 4, `answeredQuestionRefusal`): read on the
   * emitting task's cards and, for a reviewer, on every review of the same
   * builder, since each round's Review finding card asks about one work.
   * `asks_again` names the earlier card the author re-asks on purpose.
   */
  private refuseAnsweredQuestion(
    resolved: string | undefined,
    input: EmittedCardInput,
    context: EmitContext,
  ): void {
    if (input.actions.length === 0 || !context.taskId) return;
    const scope = new Set([context.taskId]);
    const builder = context.factsOf ?? (input.reviewTaskId ? context.taskId : undefined);
    if (builder) {
      scope.add(builder);
      for (const child of this.host.tasks.graph.children(builder))
        if (child.shape?.kind === "review") scope.add(child.id);
    }
    const skip = new Set([resolved, input.asksAgain?.card].filter((id) => id !== undefined));
    const store = this.host.cardStore;
    const earlier = () =>
      [...scope].flatMap((id) =>
        store.closedByCaptain(id).flatMap((card) => store.past(card.id) ?? []),
      );
    const refusal = answeredQuestionRefusal(input.body, earlier, skip);
    if (refusal) throw new Error(refusal);
  }

  /**
   * A card the captain answered with a choice stays answered (INF-1389
   * friction 1): an emit under its id is refused while the choice has not
   * reached its author, the refusal carrying the choice, since that
   * revision was written without it. Once the author has heard it, a
   * revision with actions would ask the same question again, so a new
   * question is a new card; one without actions only tells the captain
   * something and shows as a note. A note the captain closed stays closed
   * (INF-2718, from INF-2662's answer raised again after the captain's
   * close): no emit under its id shows it again. A decision closed without
   * a choice, or a card its author or the host closed, can come back.
   */
  private refuseAnsweredRevision(id: string, input: EmittedCardInput): void {
    const past = this.host.cardStore.past(id);
    // The captain's read of a note is its Got it or Done (INF-2794), kept as
    // that button's choice; a record from before it kept the corner's close.
    const read =
      past?.ending.how === "dismissed" ||
      (past?.ending.how === "chose" && past.ending.actionId === NOTE_DONE_ACTION_ID);
    if (read && past.actions.length === 0 && (past.ending.by ?? "captain") === "captain") {
      if (this.renewingValidationQuestion(past)) return;
      throw new Error(
        `Card refused: the captain closed your note "${id}" ("${past.title}"), so it stays closed and nothing was shown. Their close is their read of it, and a closed note is never raised again. When nothing is left, report finished. Only something new that they must see goes on a new card, with an id and title of its own.`,
      );
    }
    if (!chosenByCaptain(past)) return;
    const stored = this.host.cardStore.get(id);
    const choice = `"${past.ending.label ?? past.ending.actionId ?? "an action"}"`;
    if (stored && this.host.choiceUnheard?.(stored)) {
      const answers = past.answers.length
        ? ` Their answers to the card's questions:\n${cardAnswerLines(past.answers).join("\n")}`
        : "";
      throw new Error(
        `Card refused: the captain already answered card "${id}" ("${past.title}") by choosing ${choice}, and that answer has not reached you yet, so this revision was written without it.${answers} Act on that answer; it also reaches you as its own message. The card stays closed.`,
      );
    }
    if (input.actions.length > 0) {
      throw new Error(
        `Card refused: the captain already answered card "${id}" ("${past.title}") by choosing ${choice}, so a card with actions under its id would ask them that question again. Ask a new question on a new card, without this id and under a title of its own; a revision without actions, which only tells them something, shows as a note. The card stays closed.`,
      );
    }
  }
}

/**
 * Uniform chrome for agent-emitted cards (crewmate and firstmate alike). A
 * card carries exactly the actions its author declared (cards/tasks/agents
 * P0, WI-1): the host prepends, appends, and arranges nothing - an agent
 * that wants "ask me tomorrow" declares that as an ordinary action.
 */
export function buildEmittedCard(
  id: string,
  input: EmittedCardInput,
  context: {
    taskId?: string;
    author: "crewmate" | "firstmate";
    meta: string;
    model?: string;
    place?: string;
  },
  createdAt: number,
): Card {
  // The emitter's own default is the primary button (WI-10) - never an
  // accident of which option it listed last.
  // The footer reads the same on every card (design skill ResponseCard):
  // the other choices, then the default last. Notes with no declared
  // actions have no footer; close lives in the card chrome.
  const rank = (action: EmittedCardInput["actions"][number]) => (action.default ? 1 : 0);
  const declared: Card["actions"] = [...input.actions]
    .sort((a, b) => rank(a) - rank(b))
    .map((action) => {
      // A destructive choice reads as one: declared danger, or a discard
      // (which is always destructive). Danger outranks the default's primary.
      const danger = action.danger === true || settleEffectOf(action) !== undefined;
      return {
        id: action.id,
        label: action.label,
        variant: danger
          ? ("danger" as const)
          : action.default
            ? ("primary" as const)
            : ("secondary" as const),
        ...(action.default ? { default: true } : {}),
        ...(action.effect ? { effect: action.effect } : {}),
        ...(danger ? { danger: true } : {}),
        ...(action.declines ? { declines: true as const } : {}),
        ...(action.care ? { care: action.care } : {}),
        ...(action.until ? { until: action.until } : {}),
      };
    });
  const width = decidedCardWidth(input);
  return {
    id,
    ...(context.taskId ? { taskId: context.taskId } : {}),
    author: context.author,
    ...(input.reviewTaskId ? { reviewTaskId: input.reviewTaskId } : {}),
    priority: cardPriority(input),
    title: input.title,
    meta: context.meta,
    ...(context.model ? { model: context.model } : {}),
    ...(context.place ? { place: context.place } : {}),
    body: input.body,
    actions: declared,
    status: "ready",
    createdAt,
    ...(input.pictures?.length ? { pictures: input.pictures } : {}),
    // A revision's list replaces the card's: one without files takes them away.
    ...(input.files?.length ? { files: input.files } : {}),
    // Facts first, then the author's hint, which only widens (the
    // captain's Q5 A); decided again on every revision, since a revised
    // body can hold a different table or picture.
    ...(width ? { width } : {}),
    // The host resolved it from the author's label (docs/task-browser.md,
    // "From a card"); a revision without one takes it away.
    ...(input.attachment ? { attachment: input.attachment } : {}),
    // A crewmate's card alone carries live reads (docs/ui-plugins.md "A
    // card's reads"), held to this home's own lists whichever computer's
    // tool checked them; a revision without them takes them away.
    ...(context.author === "crewmate" ? liveReadsOf(input) : {}),
    // The host keeps the author's declaration alone
    // (docs/card-authoring.md "The risk chart"); a revision replaces it.
    ...(input.risk ? { risk: input.risk } : {}),
    ...(input.requiredActions !== undefined ? { requiredActions: input.requiredActions } : {}),
    ...(input.afterMerge?.length ? { afterMerge: input.afterMerge } : {}),
    ...(input.asking ? { asking: true as const } : {}),
    ...(input.designOnly ? { designOnly: true as const } : {}),
    ...(input.continues ? { continues: true as const } : {}),
    ...(input.answering ? { answering: true as const } : {}),
    ...(input.holdsPlace ? { holdsPlace: true as const } : {}),
  };
}

/**
 * A crewmate card's id on its task. Idempotent, like resolveFirstmateCardId:
 * emit_card hands the model back the resolved id, so a crewmate revising its
 * own card resends that id. Prefixing it again would mint a duplicate instead.
 * A report naming its card reads the id the same way (`ReportIntake`).
 */
export function crewmateCardId(taskId: string, stableId: string): string {
  return stableId.startsWith(`card-${taskId}-`) ? stableId : `card-${taskId}-${stableId}`;
}

/**
 * A crewmate card's declared reads and views as this home keeps them: the
 * reads a custom panel may name and the views this version publishes. A
 * computer that runs work checked them with its own lists, which a newer
 * build may have widened; a name this home does not have is left out.
 */
function liveReadsOf(input: Pick<EmittedCardInput, "reads" | "sql">): Pick<Card, "reads" | "sql"> {
  const reads = (input.reads ?? []).filter((read) =>
    (PANEL_READ_NAMES as readonly string[]).includes(read),
  );
  const sql = (input.sql ?? []).filter(isPublishedView);
  return { ...(reads.length ? { reads } : {}), ...(sql.length ? { sql } : {}) };
}
