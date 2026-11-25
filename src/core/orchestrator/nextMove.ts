import { type Card, cardWord } from "@shared/cards";
import { formatDurationShort } from "@shared/quotaSignals";
import { FIRSTMATE_RECIPIENT } from "../storage/inboxStore";
import type { TaskRecord } from "../storage/taskRecords";
import { TaskService } from "../tasks/taskService";
import { keyOrId } from "../tasks/taskWriter";
import { escapeCardText } from "./cardText";
import { HOST_CARD_PRIORITY } from "./hostCards";
import type { IdleLadderHost } from "./idleLadder";
import type { NextMoveBegun } from "./idleWakes";
import { type ClosedParts, lastPartCard, lastPartCardId } from "./lastPartCard";
import { asksAbout, questionsNaming } from "./reviewCard";
import type { TypedWake } from "./wakes";

/**
 * The next-move check (INF-3846 piece 2; docs/report-sort.md, "The
 * next-move check"): the idle ladder's pass widened to the parts of begun
 * work it never read - open work waiting on request, and started work back
 * in the backlog. Each such part is moving, waiting on the captain with a
 * card up or put off until a moment, or stopped by the captain; otherwise
 * nothing will ever move it.
 *
 * A part standing that way, after the ladder's first settle time, gets one
 * typed wake to the first mate per stay in that state. Once the first mate
 * has handled that news and the part still stands, the captain gets one host
 * card about it, which comes down as soon as the part moves. A state answers
 * it - a start, a card, a drop or the captain's stop - never a turn ending.
 * It adds no queue, timer or scheduler: the ladder's pass runs it, the
 * inbox's once-names keep the wake to one, and the card's own raised line
 * keeps the card to one.
 *
 * A part the captain stopped is theirs, so the check asks nothing about it,
 * except once when it is left as its parent's last open part (INF-6663):
 * the host then asks the captain to start it or keep it waiting.
 */

/** The host's card about a part of begun work with no next move. */
export function nextMoveCardId(taskId: string): string {
  return `card-next-move-${taskId}`;
}

export function nextMoveCardTitle(title: string): string {
  return `${title} is standing still`;
}

/** The wake's once-name: one per stay in the standing state. */
export function nextMoveOnce(since: number): string {
  return `next-move:${since}`;
}

type Standing = {
  record: TaskRecord;
  stands: "on-request" | "backlog";
  begun: NextMoveBegun;
  since: number;
};

/**
 * A part the captain stopped, left as the only open part of its parent,
 * since the close of the last other part.
 */
type LastPart = { record: TaskRecord; parent: TaskRecord; since: number; closed: ClosedParts };

/**
 * The captain's put-offs as one pass reads them (`putOffsOnTasks`): the
 * tasks with a put-off of their own, and for each task a close put-off
 * waits for, the tasks waiting and when each put-off was kept.
 */
type PutOffIndex = {
  held: Set<string>;
  awaitedBy: Map<string, { task: string; at: number }[]>;
};

/**
 * What one pass reads once: whether the captain stopped a task, whether a
 * put-off of theirs holds it, and every put-off, read on first need.
 */
type Pass = {
  stopped: Map<string, boolean>;
  putOff: Map<string, boolean>;
  putOffs?: PutOffIndex;
  openCards?: Set<string>;
};

export class NextMove {
  /**
   * `settleMs` is how long a part stands before the first mate hears: the
   * ladder's first rung (`STALL_WAKE_MS`), passed in by the ladder.
   */
  constructor(
    private readonly host: IdleLadderHost,
    private readonly settleMs: number,
  ) {}

  /** One pass over every live part that waits for a start; runs inside the ladder's projection. */
  reconcile(now: number): void {
    const tasks = this.host.tasks;
    const pass: Pass = { stopped: new Map(), putOff: new Map() };
    const standing = new Set<string>();
    const last = new Set<string>();
    const candidates = [
      ...tasks.listOpen().filter((record) => record.startPolicy === "on-request"),
      ...tasks.listActive().filter((record) => record.backlogSince != null),
    ];
    for (const record of candidates) {
      const found = this.standing(record, pass);
      if (found) {
        standing.add(record.id);
        this.act(found, now);
        continue;
      }
      const left = this.lastPart(record, pass);
      if (!left) continue;
      last.add(record.id);
      this.tellLastPart(left, now);
    }
    for (const card of [...this.host.openCards()]) {
      if (!card.taskId) continue;
      const still =
        card.id === nextMoveCardId(card.taskId)
          ? standing
          : card.id === lastPartCardId(card.taskId)
            ? last
            : undefined;
      if (!still || still.has(card.taskId) || this.host.answerOwed(card.id)) continue;
      this.host.withdrawCard(card.id, "moved");
    }
  }

  /** The part's standing state, or nothing when it moves, the captain holds it or it is not begun. */
  private standing(record: TaskRecord, pass: Pass): Standing | undefined {
    const tasks = this.host.tasks;
    if (record.kind !== "work" || TaskService.isDeliveryChild(record)) return undefined;
    if (this.host.bypassesSupervision(record.id)) return undefined;
    const open = record.status === "open";
    // A gate holds an open part's start: a wait for a time, a quota reset or
    // a computer starts it by itself, and a gate on the captain is theirs.
    if (open && record.gate) return undefined;
    // An uncleared wait holds an open part's start: it moves once that work
    // closes, and a wait that can never clear has its own wake.
    if (open && tasks.graph.waitingOn(record.id).length > 0) return undefined;
    // A parent whose parts do the work is read through its parts. A task that
    // delivers an answer is read itself: the walk ends there, so its parts,
    // ideas for later, are never read in its place.
    if (
      record.shape?.deliverable !== "answer" &&
      tasks.graph.openChildren(record.id).some((child) => !TaskService.isDeliveryChild(child))
    ) {
      return undefined;
    }
    if (this.captainHolds(record, pass)) return undefined;
    if (this.stopped(record, pass)) return undefined;
    const found = open
      ? this.begunOf(record, pass, new Set([record.id]))
      : { begun: { why: "started" as const }, at: record.backlogSince ?? record.createdAt };
    if (!found) return undefined;
    // The stay begins at the newest typed fact that left it standing: its
    // filing, a line that stopped or started it, its move to the backlog,
    // the close of the last work it waited on, the start of the work that
    // made it begun, or the end of another card about it, a first mate
    // question that named it included.
    const since = Math.max(
      record.createdAt,
      tasks.starts.latestStopAt(record.id) ?? 0,
      record.backlogSince ?? 0,
      found.at,
      tasks.graph.latestBlockerClose(record.id) ?? 0,
      tasks.capture.cardResolvedAt(record.id, nextMoveCardId(record.id)) ?? 0,
      ...questionsNaming(record.id, tasks).map((asking) => asking.closedAt ?? 0),
    );
    return { record, stands: open ? "on-request" : "backlog", begun: found.begun, since };
  }

  /**
   * The captain stopped this work, or a parent above it
   * (`TaskStarts.stoppedByCaptain`): each task's own stop is read once a pass.
   */
  private stopped(record: TaskRecord, pass: Pass): boolean {
    const known = pass.stopped.get(record.id);
    if (known !== undefined) return known;
    // A broken chain that loops back reads as not stopped, never forever.
    pass.stopped.set(record.id, false);
    const parent = record.parentId ? this.host.tasks.get(record.parentId) : undefined;
    const stopped =
      this.host.tasks.starts.stoppedByCaptain(record) ||
      (parent !== undefined && this.stopped(parent, pass));
    pass.stopped.set(record.id, stopped);
    return stopped;
  }

  /**
   * A part the captain stopped (INF-6663) whose every other part closed
   * after that stop: the stop no longer holds back just this part but the
   * whole parent, which nothing else reads. A parent the captain stopped,
   * or one that delivers an answer, whose parts are ideas for later, is not
   * read; a part held at a gate or by an uncleared wait has another owner
   * of its start; and a part the captain holds by a card or a put-off is
   * already theirs. A stop recorded after the last close was
   * made with the parent already waiting, so it says nothing new.
   */
  private lastPart(record: TaskRecord, pass: Pass): LastPart | undefined {
    const tasks = this.host.tasks;
    if (record.kind !== "work" || !record.parentId || TaskService.isDeliveryChild(record)) {
      return undefined;
    }
    if (this.host.bypassesSupervision(record.id)) return undefined;
    const parent = tasks.get(record.parentId);
    if (!parent || TaskService.isClosed(parent) || parent.shape?.deliverable === "answer") {
      return undefined;
    }
    if (!this.stopped(record, pass) || this.stopped(parent, pass)) return undefined;
    const open = record.status === "open";
    if (open && (record.gate || tasks.graph.waitingOn(record.id).length > 0)) return undefined;
    const others = tasks.graph
      .children(parent.id)
      .filter(
        (part) =>
          part.id !== record.id && part.kind === "work" && !TaskService.isDeliveryChild(part),
      );
    if (others.length === 0 || others.some((part) => !TaskService.isClosed(part))) {
      return undefined;
    }
    const since = Math.max(...others.map((part) => part.closedAt ?? 0));
    if (since <= (tasks.starts.latestStopAt(record.id) ?? 0)) return undefined;
    if (this.captainHolds(record, pass)) return undefined;
    const dropped = others.filter((part) => part.status === "dropped").length;
    return { record, parent, since, closed: { done: others.length - dropped, dropped } };
  }

  /**
   * Why an open part counts as begun work, and since when: at each level
   * from it up through its live parents, a parent or another part under it
   * started building, or started work waits on that level, through a blocks
   * link or a put-off until it closes - directly, or through open work that
   * is begun itself. Work the captain stopped is no reason, and a task that
   * delivers an answer is not building work and ends the walk, so ideas
   * filed for later stay exempt. The part and its parents are already known
   * not stopped and cached for the pass, so a part beside them costs one
   * stop read a pass, and a done part, which no stop can hold, is read as
   * one earliest start.
   */
  private begunOf(
    record: TaskRecord,
    pass: Pass,
    seen: Set<string>,
  ): { begun: NextMoveBegun; at: number } | undefined {
    const tasks = this.host.tasks;
    const waited = (node: TaskRecord): { begun: NextMoveBegun; at: number } | undefined => {
      // A blocks link from this level, or a put-off of the captain's until
      // it closes, which begins its wait only when it was kept.
      const waiters = [
        ...tasks.graph.liveWaiters(node.id).map((waiter) => ({ waiter, kept: 0 })),
        ...this.putOffWaiters(node.id, pass),
      ];
      for (const { waiter, kept } of waiters) {
        if (seen.has(waiter.id)) continue;
        seen.add(waiter.id);
        if (this.stopped(waiter, pass)) continue;
        const begun: NextMoveBegun = {
          why: "waited-on",
          task: named(waiter),
          ...(node.id === record.id ? {} : { via: named(node) }),
        };
        if (waiter.status === "active" && startedBuilding(waiter)) {
          return { begun, at: Math.max(waiter.startedAt ?? 0, kept) };
        }
        if (waiter.status === "open") {
          const inner = this.begunOf(waiter, pass, seen);
          if (inner) return { begun, at: Math.max(inner.at, kept) };
        }
      }
      return undefined;
    };
    const own = waited(record);
    if (own) return own;
    let node = record;
    for (const parent of tasks.graph.ancestors(record.id)) {
      // Work filed under a task that delivers an answer is an idea for later,
      // whatever started above that task: the walk ends there, as at a
      // closed parent.
      if (TaskService.isClosed(parent) || parent.shape?.deliverable === "answer") break;
      const live = tasks.graph
        .openChildren(parent.id)
        .filter(
          (part) => part.id !== node.id && startedBuilding(part) && !this.stopped(part, pass),
        );
      const starts = [
        ...(startedBuilding(parent) ? [parent.startedAt ?? 0] : []),
        ...live.map((part) => part.startedAt ?? 0),
        ...[tasks.graph.earliestDonePartStart(parent.id)].filter(
          (at): at is number => at !== undefined,
        ),
      ];
      if (starts.length > 0)
        return { begun: { why: "part", task: named(parent) }, at: Math.min(...starts) };
      const above = waited(parent);
      if (above) return above;
      node = parent;
    }
    return undefined;
  }

  /**
   * The captain holds it: a card about it asks them something (its
   * reviewer's question card included, INF-5004), a first mate's
   * question names it, they put off a card of it or of a parent above it,
   * or their hands hold its browser.
   */
  private captainHolds(record: TaskRecord, pass: Pass): boolean {
    if (this.putOff(record, pass)) return true;
    if (this.namedByQuestion(record, pass)) return true;
    const own = new Set([nextMoveCardId(record.id), lastPartCardId(record.id)]);
    let anyCard = false;
    for (const card of this.host.openCards()) {
      if (!asksAbout(card, record.id, this.host.tasks) || own.has(card.id)) continue;
      anyCard = true;
      if (cardWord(card) === "decision") return true;
    }
    if (this.host.answerNoteForTask?.(record.id) !== undefined) return true;
    if (record.delivery?.captainWait && anyCard) return true;
    return this.host.browserWithCaptain?.(record.id) === true;
  }

  /**
   * A first mate's decision that belongs to no task names this work in
   * `related` (INF-4165 finding 3): its record, open while its card is up,
   * links to the work, and that card asks the captain the work's question
   * for it, so the work is held as a card of its own would hold it.
   */
  private namedByQuestion(record: TaskRecord, pass: Pass): boolean {
    return questionsNaming(record.id, this.host.tasks).some(
      (asking) =>
        asking.status === "open" &&
        asking.gate?.kind === "captain" &&
        asking.gate.ref !== undefined &&
        this.openCardIds(pass).has(asking.gate.ref),
    );
  }

  private openCardIds(pass: Pass): Set<string> {
    if (!pass.openCards)
      pass.openCards = new Set([...this.host.openCards()].map((card) => card.id));
    return pass.openCards;
  }

  /**
   * The captain put off a card of this work, or of a parent above it, with a
   * Not until choice (INF-3846 piece 3, docs/card-authoring.md "Not until"):
   * the host raises the same card again at its moment, so nothing here asks
   * about the work before then. Each task is read once a pass.
   */
  private putOff(record: TaskRecord, pass: Pass): boolean {
    const known = pass.putOff.get(record.id);
    if (known !== undefined) return known;
    // A broken chain that loops back reads as not put off, never forever.
    pass.putOff.set(record.id, false);
    const parent = record.parentId ? this.host.tasks.get(record.parentId) : undefined;
    const held =
      this.putOffIndex(pass).held.has(record.id) ||
      (parent !== undefined && this.putOff(parent, pass));
    pass.putOff.set(record.id, held);
    return held;
  }

  private putOffWaiters(taskId: string, pass: Pass): { waiter: TaskRecord; kept: number }[] {
    return (this.putOffIndex(pass).awaitedBy.get(taskId) ?? []).flatMap(({ task, at }) => {
      const waiter = this.host.tasks.get(task);
      return waiter && !TaskService.isClosed(waiter) ? [{ waiter, kept: at }] : [];
    });
  }

  private putOffIndex(pass: Pass): PutOffIndex {
    if (pass.putOffs) return pass.putOffs;
    const index: PutOffIndex = { held: new Set(), awaitedBy: new Map() };
    for (const putOff of this.host.putOffsOnTasks?.() ?? []) {
      index.held.add(putOff.task);
      if (putOff.until.kind !== "close") continue;
      const awaited = this.host.tasks.resolve(putOff.until.task);
      if (!awaited) continue;
      const waiting = index.awaitedBy.get(awaited.id) ?? [];
      waiting.push({ task: putOff.task, at: putOff.at });
      index.awaitedBy.set(awaited.id, waiting);
    }
    pass.putOffs = index;
    return index;
  }

  /** The wake once the part has settled, then the card once that news was handled. */
  private act(found: Standing, now: number): void {
    const { record, since } = found;
    const inbox = this.host.inbox;
    if (now - since < this.settleMs) return;
    if (inbox.holdsUnhandled(FIRSTMATE_RECIPIENT, record.id)) return;
    const once = nextMoveOnce(since);
    if (!inbox.woken(record.id, once)) {
      const wake: TypedWake = {
        facts: {
          kind: "next-move",
          task: { id: record.id, title: record.title },
          key: keyOrId(record),
          stands: found.stands,
          begun: found.begun,
          standingMs: now - since,
        },
        once,
      };
      this.host.recordSort(
        record.id,
        record.title,
        wake,
        "captain",
        "a part of begun work waits for a start nobody gave, with no card up and no stop from the captain; told the first mate once.",
        "next-move-wake",
        () => this.host.notifyOp(wake, "agent", record.id),
      );
      return;
    }
    const id = nextMoveCardId(record.id);
    const raised = this.host.tasks.capture.cardRaisedAt(record.id, id);
    if (raised !== undefined && raised >= since) return;
    this.raiseCard(found, now);
  }

  /**
   * The card once the last close has settled, so a first mate that starts
   * the part on that news is not raced; once for that close, so Keep it
   * waiting keeps it down until another part closes after a new one opens.
   */
  private tellLastPart(found: LastPart, now: number): void {
    const { record, parent, since, closed } = found;
    if (now - since < this.settleMs) return;
    const id = lastPartCardId(record.id);
    const raised = this.host.tasks.capture.cardRaisedAt(record.id, id);
    if (raised !== undefined && raised >= since) return;
    const card = lastPartCard(record, parent, closed, now);
    this.host.recordSort(
      record.id,
      record.title,
      // i18n-exempt: the decision ledger's record of what went up, read by no person
      `host card ${id}: "${card.title}"`,
      "captain",
      // i18n-exempt: the decision ledger's reason, read by no person
      "every other part of its parent closed after the captain stopped this one; the host asked the captain once.",
      "last-part-card",
      () => {
        this.host.raiseCard(card);
        this.host.tasks.capture.recordCardRaised(record.id, {
          cardId: id,
          kind: cardWord(card),
          title: card.title,
          actor: "host",
        });
      },
    );
  }

  private raiseCard(found: Standing, now: number): void {
    const { record } = found;
    const id = nextMoveCardId(record.id);
    const begun =
      found.begun.why === "started"
        ? "It started earlier, so its work is begun."
        : found.begun.why === "part"
          ? `It is a part of ${escapeCardText(found.begun.task.title)}, where work has started.`
          : found.begun.via
            ? `Started work waits on ${escapeCardText(found.begun.via.title)}, which it is a part of: ${escapeCardText(found.begun.task.title)}.`
            : `Started work waits on it: ${escapeCardText(found.begun.task.title)}.`;
    const stands =
      found.stands === "backlog"
        ? `It went back to the backlog ${formatDurationShort(now - found.since)} ago, and nothing will start it again.`
        : `It has waited ${formatDurationShort(now - found.since)} for a start nobody has given, and nothing will start it.`;
    const card: Card = {
      id,
      taskId: record.id,
      author: "host",
      priority: HOST_CARD_PRIORITY,
      title: nextMoveCardTitle(record.title),
      meta: "",
      body: [
        `<p>${begun} ${stands}</p>`,
        "<p>Your first mate was told and left it as it is.</p>",
        "<p>Start it starts it now. Leave it keeps it waiting, and this card comes back only if something about it changes and it stands still again. For anything else, such as dropping it, reply here.</p>",
      ].join(""),
      // A reply goes to the first mate, which can always answer (INF-1670).
      answeredBy: "firstmate",
      actions: [
        {
          id: "start",
          label: "Start it",
          variant: "primary",
          default: true,
          effect: { kind: "host", op: "start-task", arg: record.id },
        },
        { id: "leave", label: "Leave it", variant: "secondary" },
      ],
      status: "ready",
      createdAt: now,
    };
    this.host.recordSort(
      record.id,
      record.title,
      `host card ${id}: "${card.title}"`,
      "captain",
      "a part of begun work still waits for a start after the first mate's turn; the host raised its own card.",
      "next-move-card",
      () => {
        this.host.raiseCard(card);
        this.host.tasks.capture.recordCardRaised(record.id, {
          cardId: id,
          kind: cardWord(card),
          title: card.title,
          actor: "host",
        });
      },
    );
  }
}

/** Work that started building: a started part that delivers no answer and is no delivery step. */
export function startedBuilding(record: TaskRecord): boolean {
  return (
    record.kind === "work" &&
    record.startedAt != null &&
    record.status !== "dropped" &&
    record.shape?.deliverable !== "answer" &&
    !TaskService.isDeliveryChild(record)
  );
}

function named(record: TaskRecord): { id: string; key: string; title: string } {
  return { id: record.id, key: keyOrId(record), title: record.title };
}
