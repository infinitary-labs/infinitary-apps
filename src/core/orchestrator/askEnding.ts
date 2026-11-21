import { type Card, mergeEffectOf } from "@shared/cards";
import type { AskRecord } from "../storage/askStore";
import type { TaskCoverageFields } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { actionTookEffect, noticeAskId } from "./answerDelivery";
import { answerTaskChoice } from "./answerTaskResponse";
import { hasMergeLine } from "./settleWords";

/**
 * How a captain's message ends (INF-1610 piece 2, docs/task-capture.md "How
 * a message ends"): on a card the captain accepts as its answer. A message
 * may run any number of tasks and cards first; the ones along the way stay
 * as they are. This module reads typed state only - the saved message, the
 * task graph, the cards and the captain's own response - and never the
 * words of a card or a message.
 *
 * A message that joined an earlier one's open work (`continues`) ends with
 * it: the earliest is the root, and the root with every message that joined
 * it is one chain, with one ending.
 */

/** What the app reads from the stack. */
export type AskEndingHost = {
  tasks: TaskService;
  /** The cards on the stack now. */
  openCards: () => Iterable<Card>;
  /** A card's row, open or resolved. */
  storedCard: (id: string) => Card | undefined;
  /** When the captain was last offered the card as it stands. */
  shownAt: (card: Card) => number;
  /**
   * A task's cards the captain saw, with when they last saw each, passing
   * over every lifecycle its own author withdrew (`CardStore.seenCards`).
   */
  seenCards: (taskId: string) => readonly { cardId: string; at: number }[];
  /**
   * Whether a response request still waits for its answer: `pending` while
   * open, `unread` once answered with the answer not yet served to the first
   * mate (`InboxStore.requestOpen`). Absent, none waits.
   */
  requestOpen?: (requestId: string) => "pending" | "unread" | undefined;
};

/** A root message with every message that joined its work. */
export type AskChain = {
  root: AskRecord;
  members: AskRecord[];
  ids: string[];
  /** When the newest message of the chain was sent. */
  newestAt: number;
  work: TaskCoverageFields[];
  /** The tasks of `work` the first mate's own tools attached the chain's messages to. */
  acted: ReadonlySet<string>;
  /** When a merge linked each task of `work` it filed or started (`askCoverage`'s `joined`). */
  joined?: ReadonlyMap<string, number>;
  /**
   * The tasks of `work` the chain's messages are only tied to: a question
   * the first mate asked there, or a change it refused (`askCoverage`'s `tied`).
   */
  tied?: ReadonlySet<string>;
  /** The response requests the first mate asked for the chain's messages, by task. */
  requests?: readonly { taskId: string; requestId: string }[];
};

/**
 * Where a chain stands. `answered` and `unanswered` are saved endings;
 * `accepted` is an answer the captain accepted with nothing more running,
 * which becomes `answered` once the first mate has nothing left to do for
 * it; `working` has work still running; `waiting` has an answering card up
 * for the captain; `missing` has neither.
 */
export type AskState =
  | { kind: "answered"; cardId: string | null }
  | { kind: "unanswered" }
  | { kind: "accepted"; cardId: string | null }
  | { kind: "working" }
  | { kind: "waiting"; cardId: string }
  | { kind: "missing" };

/**
 * Where a close of a task's work puts its outcome: on the card that answers
 * its message (`revise`, `open` when it is still up), as the app's one
 * closing note marked as the answer (`note`), nowhere because other work of
 * the message runs on or took it over (`quiet`), or - for work no message
 * of the captain's covers - by today's rule for work the fleet started.
 */
export type ClosingPlace =
  | { kind: "revise"; card: Card; open: boolean }
  | { kind: "note" }
  | { kind: "quiet" }
  | { kind: "unasked"; card?: Card };

/**
 * A card shaped as the outcome of work: its author's answering mark, a
 * merge card's merge, or the app's merge line on the story note of
 * work that merges on its own. All typed; never the card's words.
 */
export function answersByShape(card: Card): boolean {
  return (
    card.answering === true ||
    card.actions.some((action) => mergeEffectOf(action)) ||
    hasMergeLine(card.body)
  );
}

/** The ending over a card stack: its open cards, its rows and when each was offered. */
export function askEndingOf(
  tasks: TaskService,
  cards: {
    values(): Iterable<Card>;
    stored(id: string): Card | undefined;
    shownAt(card: Card): number;
    seenCards(taskId: string): readonly { cardId: string; at: number }[];
  },
  requestOpen?: (requestId: string) => "pending" | "unread" | undefined,
): AskEnding {
  return new AskEnding({
    tasks,
    openCards: () => cards.values(),
    storedCard: (id) => cards.stored(id),
    shownAt: (card) => cards.shownAt(card),
    seenCards: (taskId) => cards.seenCards(taskId),
    ...(requestOpen ? { requestOpen } : {}),
  });
}

export class AskEnding {
  constructor(private readonly host: AskEndingHost) {}

  /** A message's chain: its root, and every message that joined the root's work. */
  chain(askId: string): AskChain | undefined {
    const ask = this.host.tasks.capture.getAsk(askId);
    if (!ask) return undefined;
    const root = ask.continues ? (this.host.tasks.capture.getAsk(ask.continues) ?? ask) : ask;
    return this.withCoverage(root, this.host.tasks.capture.askMembers(root.id));
  }

  private withCoverage(root: AskRecord, members: AskRecord[]): AskChain {
    const ids = members.map((member) => member.id);
    const { work, acted, joined, tied, requests } = this.host.tasks.capture.askCoverage(ids);
    return {
      root,
      members,
      ids,
      newestAt: Math.max(...members.map((member) => member.at)),
      work,
      acted,
      joined,
      tied,
      requests,
    };
  }

  /**
   * The chains that have not ended, oldest first: one per root. `running`
   * also reads the messages whose reply is still running.
   */
  openChains(running = false): AskChain[] {
    return this.host.tasks.readProjection(() =>
      this.host.tasks.capture
        .openAskChains(running)
        .map(({ root, members }) => this.withCoverage(root, members)),
    );
  }

  /**
   * Why the first mate may not name a message on an action from a step
   * that did not read it, or undefined when it may (INF-2664): any open
   * message a finished reply has read, a notice-up one included. Typed
   * facts only - which message the work serves is the first mate's to say.
   */
  nameRefusal(askId: string): string | undefined {
    const ask = this.host.tasks.capture.getAsk(askId);
    if (!ask) return "ask_id must name an open message (open_asks id), or be empty.";
    if (ask.turnState === "open") {
      return "ask_id must name a message a step has read; this one waits for its own step.";
    }
    const chain = this.chain(askId);
    const ended =
      !ask.followed ||
      !chain ||
      chain.members.some((member) => member.answeredAt !== null) ||
      (chain.members.some((member) => member.delivery === "unresolved") &&
        !chain.members.some((member) => member.noticeCardId && this.noticeUp(member.id)));
    return ended
      ? "ask_id names a message that has ended: it was answered, or its notice was closed. Leave ask_id empty for this work."
      : undefined;
  }

  /** Whether a message's notice is on the stack now. */
  private noticeUp(askId: string): boolean {
    return this.noticesUp().some((notice) => notice.askId === askId);
  }

  /** When the captain was last offered a card as it stands. */
  offeredAt(card: Card): number {
    return this.host.shownAt(card);
  }

  /** The notices up now, by message, with when each was offered. */
  noticesUp(): { askId: string; shownAt: number }[] {
    const notices: { askId: string; shownAt: number }[] = [];
    for (const card of this.host.openCards()) {
      const askId = noticeAskId(card.id);
      if (askId) notices.push({ askId, shownAt: this.host.shownAt(card) });
    }
    return notices;
  }

  /** The chains whose work includes a task, newest first. */
  chainsOf(taskId: string): AskChain[] {
    const roots = new Set<string>();
    const chains: AskChain[] = [];
    for (const ask of this.host.tasks.capture.asksAbove(taskId)) {
      const chain = this.chain(ask.id);
      if (!chain || roots.has(chain.root.id)) continue;
      roots.add(chain.root.id);
      chains.push(chain);
    }
    return chains;
  }

  /**
   * The task a card is about: the one it names, else the record filed for
   * it. The first mate's own answer to a crewmate's report names no task
   * (INF-2714), so its answer record leads to the reporting task it saved
   * as its origin.
   */
  private cardTask(card: Card): string | undefined {
    if (card.taskId) return card.taskId;
    const capture = this.host.tasks.capture;
    const filed = capture.taskForCard(card.id);
    return (filed?.kind === "question" ? capture.reportOrigin(filed.id) : undefined) ?? filed?.id;
  }

  /** The cards the first mate showed for the chain's messages, by its own facts. */
  private shownFor(chain: AskChain): Set<string> {
    return new Set(
      chain.members.flatMap((member) =>
        member.deliveryFacts.entries.flatMap((entry) =>
          entry.outcome === "action" && entry.kind === "card" && entry.ref ? [entry.ref] : [],
        ),
      ),
    );
  }

  /**
   * Whether a card can answer the chain: shaped as an answer and about its
   * work, or one the first mate showed for its messages.
   */
  candidate(chain: AskChain, card: Card): boolean {
    return this.about(chain, card) && (this.shownFor(chain).has(card.id) || answersByShape(card));
  }

  /** Whether a card is about the chain: shown for its messages, or a card of its work. */
  private about(chain: AskChain, card: Card): boolean {
    if (this.shownFor(chain).has(card.id)) return true;
    const taskId = this.cardTask(card);
    return taskId !== undefined && chain.work.some((task) => task.id === taskId);
  }

  /** The newest card up that answers the chain and was shown since its newest message. */
  waitingCard(chain: AskChain): Card | undefined {
    let newest: Card | undefined;
    for (const card of this.host.openCards()) {
      if (!this.candidate(chain, card) || this.host.shownAt(card) < chain.newestAt) continue;
      if (!newest || this.host.shownAt(card) > this.host.shownAt(newest)) newest = card;
    }
    return newest;
  }

  /**
   * An answer the captain saw (INF-2845, direction A): the newest answering
   * crewmate card of the chain's work they saw since its newest message,
   * never a merge offer and never one its own author withdrew. Once the
   * chain's work has ended it is the answer: the crewmate is not asked
   * again, the first mate is not asked, and no closing note goes up.
   */
  seenAnswer(chain: AskChain): Card | undefined {
    let newest: { card: Card; at: number } | undefined;
    for (const task of chain.work) {
      for (const seen of this.host.seenCards(task.id)) {
        if (seen.at < chain.newestAt || (newest && newest.at >= seen.at)) continue;
        const card = this.host.storedCard(seen.cardId);
        if (card?.author !== "crewmate" || card.answering !== true) continue;
        if (card.actions.some((action) => mergeEffectOf(action) !== undefined)) continue;
        newest = { card, at: seen.at };
      }
    }
    return newest?.card;
  }

  /**
   * The captain's accepted answer, when they accepted it since the newest
   * message. Work their choice started keeps the message working until it
   * ends; then the accepted card still answers it, revised with the outcome.
   */
  private acceptance(chain: AskChain): string | undefined {
    const { root } = chain;
    if (!root.answerCardId || root.acceptedAt === null) return undefined;
    return root.acceptedAt < chain.newestAt ? undefined : root.answerCardId;
  }

  /**
   * The chain's own work: the tasks the first mate's tools acted on for
   * it, and those filed, started or joined by a merge after it (a part, a
   * handover, a choice on its card that started work, an existing task a
   * merge set to start for the rest). A task the message only pointed at
   * (its card or panel), which nobody acted on since, is not its work.
   */
  ownWork(chain: AskChain): TaskCoverageFields[] {
    return chain.work.filter(
      (task) =>
        !chain.tied?.has(task.id) &&
        (chain.acted.has(task.id) ||
          Math.max(task.createdAt, task.startedAt ?? 0, chain.joined?.get(task.id) ?? 0) >
            chain.root.at),
    );
  }

  /**
   * The tasks the chain waits on: its own work still running, each open task
   * a request asked for its messages still owes an answer, and each task
   * whose answer is still unread on the first mate's lane, closed or not. A
   * pending request whose task closed, or that its sender cancelled, waits
   * no longer: the message never waits longer than its task, and an unread
   * answer only until its wake is read.
   */
  private waitsOn(chain: AskChain): Set<string> {
    const open = new Set(
      this.ownWork(chain)
        .filter((task) => !TaskService.isClosed(task))
        .map((task) => task.id),
    );
    const requestOpen = this.host.requestOpen;
    if (!requestOpen) return open;
    for (const { taskId, requestId } of chain.requests ?? []) {
      if (open.has(taskId)) continue;
      const task = chain.work.find((entry) => entry.id === taskId);
      const waits = task ? requestOpen(requestId) : undefined;
      if (waits === "unread" || (waits === "pending" && task && !TaskService.isClosed(task)))
        open.add(taskId);
    }
    return open;
  }

  /**
   * The chain's work as its readers list it: its own work, and each task it
   * is only tied to that it still waits on for an answer.
   */
  listedWork(chain: AskChain): TaskCoverageFields[] {
    const own = new Set(this.ownWork(chain).map((task) => task.id));
    const waits = this.waitsOn(chain);
    return chain.work.filter((task) => own.has(task.id) || waits.has(task.id));
  }

  /** Whether the chain's own work runs on: the message still waits for its outcome. */
  private live(chain: AskChain): boolean {
    return this.waitsOn(chain).size > 0;
  }

  /** Whether the chain waits on a task other than this one. */
  private waitsOnOther(chain: AskChain, taskId: string): boolean {
    return [...this.waitsOn(chain)].some((id) => id !== taskId);
  }

  state(chain: AskChain): AskState {
    const { root } = chain;
    if (root.answeredAt !== null) return { kind: "answered", cardId: root.answerCardId };
    if (root.delivery === "unresolved") return { kind: "unanswered" };
    const live = this.live(chain);
    const accepted = this.acceptance(chain);
    if (accepted && !live) return { kind: "accepted", cardId: accepted };
    if (live) return { kind: "working" };
    const waiting = this.waitingCard(chain);
    if (waiting) return { kind: "waiting", cardId: waiting.id };
    const seen = this.seenAnswer(chain);
    if (seen) return { kind: "accepted", cardId: seen.id };
    const entries = chain.members.flatMap((member) => member.deliveryFacts.entries);
    // The first mate's answer in a card's thread: its closing words under the
    // card the message replied under, or its line alone on someone else's card.
    const reply = entries.findLast(
      (entry) => entry.outcome === "action" && entry.kind === "reply" && entry.ref,
    );
    if (reply?.ref) return { kind: "accepted", cardId: reply.ref };
    // A reaction answers a message that asks nothing; the first mate judged that.
    const reacted = actionTookEffect(
      entries.filter(
        (entry) =>
          entry.outcome === "refused" || (entry.outcome === "action" && entry.kind === "reaction"),
      ),
    );
    if (reacted) return { kind: "accepted", cardId: null };
    return { kind: "missing" };
  }

  /**
   * The captain acknowledged a card: a choice, an ordinary note read, or
   * explicit Done on a marked saved answer. It is the
   * answer for each open chain it is about, when it was shown since the
   * chain's newest message and no reply of theirs waits under it: their
   * choice on a decision about its work that is not still asking (or an
   * explicitly answering terminal answer-task choice), or acknowledgement
   * of a note shaped as its answer. Aside and saved-answer reads never call
   * this acknowledgement path. A decision put aside answers nothing.
   * A chain whose reply is still running counts too: a quick choice lands
   * before the turn that showed the card ends. `signed-off` is the captain's
   * line under the card that its crewmate marked as saying they are done
   * (INF-2845, `CardThreads.signOff`): it answers each chain the card is
   * about, as a choice does.
   */
  captainResponded(card: Card, response: "choice" | "close" | "signed-off", action?: string): void {
    if (card.awaiting === "answer") return;
    if (response === "close" && card.actions.length > 0) return;
    const terminalAnswer =
      response === "choice" &&
      card.answering === true &&
      answerTaskChoice(card, card.taskId ? this.host.tasks.get(card.taskId) : undefined, action);
    if (response === "choice" && (card.continues || (card.asking && !terminalAnswer))) return;
    for (const chain of this.openChains(true)) {
      // A choice on a decision about its work answers it; an acknowledged
      // note answers it only when shaped as its answer, not a note along the way.
      // A line its crewmate signed off (INF-2845) answers it like a choice.
      const answers = response === "close" ? this.candidate(chain, card) : this.about(chain, card);
      if (!answers || this.host.shownAt(card) < chain.newestAt) continue;
      this.host.tasks.capture.acceptAnswer(chain.ids, card.id);
    }
  }

  /**
   * The crewmate step: a crewmate reports its task finished. When that task
   * is the last running work of a followed message with no answer accepted
   * or up, the crewmate is asked once for the card that answers it; the
   * returned chain is the one it is asked about.
   */
  crewmateStep(taskId: string): AskChain | undefined {
    for (const chain of this.chainsOf(taskId)) {
      const { root } = chain;
      if (!root.followed || root.answeredAt !== null || root.delivery === "unresolved") continue;
      if (root.crewmateAskedAt !== null) continue;
      if (this.waitsOnOther(chain, taskId) || this.acceptance(chain) || this.waitingCard(chain))
        continue;
      if (this.seenAnswer(chain)) continue;
      this.host.tasks.capture.markCrewmateAsked(root.id);
      return chain;
    }
    return undefined;
  }

  /**
   * Where a closed task's outcome goes (the at-most-one rule). The newest
   * message covering the task decides: its answer, recorded or accepted,
   * is revised; other running work of it means quiet; an answering card up
   * is revised; otherwise the app's one closing note answers it.
   */
  closingPlace(taskId: string): ClosingPlace {
    // A message only tied to the task decides only when no message has it as work.
    const chains = this.chainsOf(taskId);
    const chain = chains.find((entry) => !entry.tied?.has(taskId)) ?? chains[0];
    const own = [...this.host.openCards()].find(
      (card) => this.cardTask(card) === taskId && answersByShape(card),
    );
    if (!chain) return { kind: "unasked", ...(own ? { card: own } : {}) };
    const { root } = chain;
    const answer =
      root.answeredAt !== null ? (root.answerCardId ?? undefined) : this.acceptance(chain);
    if (answer) {
      const open = [...this.host.openCards()].find((card) => card.id === answer);
      const card = open ?? this.host.storedCard(answer);
      return card ? { kind: "revise", card, open: open !== undefined } : { kind: "quiet" };
    }
    if (root.answeredAt !== null || root.delivery === "unresolved") return { kind: "quiet" };
    if (this.waitsOnOther(chain, taskId)) return { kind: "quiet" };
    // An answering card up is revised; so is the task's own, shown before a
    // later message about it, which the revision shows again as the answer.
    const waiting = this.waitingCard(chain) ?? own;
    if (waiting) return { kind: "revise", card: waiting, open: true };
    // An answer the captain saw already answers it: nothing comes back.
    if (this.seenAnswer(chain)) return { kind: "quiet" };
    return { kind: "note" };
  }
}
