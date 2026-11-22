import { type Card, cardWord } from "@shared/cards";
import { reportSummary } from "@shared/feed";
import { crewProblem, typedFailureOf } from "@shared/plainProblem";
import { formatDurationShort } from "@shared/quotaSignals";
import { withoutDigest, workWaitSchema } from "@shared/recovery";
import type { TaskRecord } from "../storage/taskRecords";
import type { TaskService } from "../tasks/taskService";
import { escapeCardText } from "./cardText";
import { stallCardId, stallCardTitle } from "./idleStallCardNames";
import type { IdleRule } from "./reportSort";
import type { TypedWake } from "./wakes";

/**
 * The idle ladder's host card for a task it could not move (rung 3); the
 * ladder (`idleLadder.ts`) decides when it goes up and takes it down.
 */

const HOST_CARD_PRIORITY = 40;

/** What the card needs of the ladder's host. */
export type StallCardHost = {
  tasks: TaskService;
  recordSort(
    taskId: string,
    title: string,
    wake: string | TypedWake,
    verdict: "routine" | "captain",
    reason: string,
    rule: IdleRule,
    effect: () => void,
  ): void;
  raiseCard(card: Card): void;
};

/**
 * Rung 3 of the idle ladder (the captain's Q3, a decision of 2026-09-26
 * that revises the card rule): the Firstmate let two wakes about a stuck
 * crewmate go, so the work cannot move without the captain, and the host
 * raises its own card - the app's attention, like the sign-in card. Like
 * every card with actions it places the captain gate on its task, so it
 * holds the turn while it is up and nothing repeats; it leaves on a
 * choice (Back to backlog parks the task, INF-3143), when the task moves -
 * unless a reply under it still waits on the first mate, which answers it
 * (INF-1670) - when it goes back to the backlog, or when the task closes.
 * The minus only minimizes the alert and keeps its card and gate pending.
 */
export function raiseStallCard(
  host: StallCardHost,
  record: TaskRecord,
  nudged: boolean,
  now: number,
): void {
  const observed = host.tasks
    .timeline(record.id)
    .filter((event) => event.kind === "report")
    .at(-1);
  const typedWait = workWaitSchema.safeParse(observed?.data?.workWait);
  const id = stallCardId(record.id);
  host.tasks.turns.recordRecovery(record.id, {
    rung: 3,
    count: record.recoveryCount ?? 0,
    at: now,
  });
  const stuckFor = formatDurationShort(now - (record.idleSince ?? now));
  const last = host.tasks
    .timeline(record.id)
    .filter((event) => event.kind === "report" || event.kind === "failed")
    .at(-1);
  const lastLine = !last
    ? "<p>It has not reported anything yet.</p>"
    : last.kind === "report"
      ? `<p>What it last said: ${escapeCardText(reportSummary(last.text) || last.text)}</p>`
      : `<p>Its last try ended in a problem: ${escapeCardText(crewProblem(typeof last.data?.error === "string" ? last.data.error : last.text, typedFailureOf(last.data)))}.</p>`;
  const told = nudged
    ? "It was nudged once, and your first mate was told twice, and nothing has moved since."
    : "Your first mate was told twice, and nothing has moved since.";
  // A wait its crewmate declared with no card up is a question nobody put
  // to him (INF-11): the card names it in the crewmate's words.
  const wait = record.delivery?.captainWait;
  const opening = wait
    ? `<p>It waits on you to ${escapeCardText(wait.reason)}, and no card has asked you. ${told}</p>`
    : `<p>It stopped with nothing running and no question for you. ${told}</p>`;
  // The same typed wait it stopped on (F1 of INF-1554, "Keep the card for
  // you after the last wake"): what it still waits on, and the recovery
  // attempts the first mate recorded since, never an older verdict.
  const attempts = observed
    ? host.tasks
        .timeline(record.id)
        .filter((event) => event.data?.ledger === "verdict" && event.at >= observed.at)
    : [];
  const latest = attempts.at(-1);
  const recovery = typedWait.success
    ? `<p>It is still waiting: ${escapeCardText(withoutDigest(typedWait.data.observation))}</p><p>${
        latest
          ? `Your first mate recorded ${attempts.length === 1 ? "one attempt" : `${attempts.length} attempts`} to get around it since then; the latest: ${escapeCardText(latest.text)}`
          : "Your first mate has recorded no attempt to get around it."
      }</p>`
    : "";
  const nudges = "Nudge tells it to finish or say what is in its way.";
  const card: Card = {
    id,
    taskId: record.id,
    author: "host",
    priority: HOST_CARD_PRIORITY,
    title: stallCardTitle(record.title, stuckFor),
    // The head leads with the task's key from `taskId`, as on every card
    // about a task (INF-358), and the title names the task: nothing is
    // left for the meta words to add, so the key reads once (INF-418).
    meta: "",
    body: [
      opening,
      recovery,
      lastLine,
      `<p>${nudges} Back to backlog parks it with its work kept until you start it, and your first mate hears once if news reaches it. Discard ends it and throws its work away. For anything else, reply here.</p>`,
    ].join(""),
    // The captain's choice on INF-1670: a reply here goes to the first
    // mate, which can always answer, and nuanced operations ride it.
    answeredBy: "firstmate",
    actions: [
      {
        id: "nudge",
        label: "Nudge",
        variant: "primary",
        default: true,
        effect: { kind: "host", op: "continue-task", arg: record.id },
      },
      {
        // INF-3143's direction A: a blocker nothing will change soon parks
        // where its wait shows, its work kept, instead of a Nudge starting
        // the cycle again. It took Keep waiting's place (the captain's
        // pick: a card holds three buttons).
        id: "backlog",
        label: "Back to backlog",
        variant: "secondary",
        effect: { kind: "host", op: "backlog-task", arg: record.id },
      },
      {
        id: "discard",
        label: "Discard",
        variant: "danger",
        danger: true,
        effect: { kind: "settle", mode: "discard" },
      },
    ],
    status: "ready",
    createdAt: now,
  };
  // In place of any further wake: the ledger row carries what went up,
  // and the Firstmate's context shows the card and the task's stall line.
  host.recordSort(
    record.id,
    record.title,
    `host card ${id}: "${card.title}"`,
    "captain",
    "two wakes about this idle crewmate went ignored; the host raised its own card.",
    "idle-card",
    () => {
      host.raiseCard(card);
      host.tasks.capture.recordCardRaised(record.id, {
        cardId: id,
        kind: cardWord(card),
        title: card.title,
        actor: "host",
      });
    },
  );
}
