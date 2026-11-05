/**
 * The fixture behind `tests/export-corpus-corrections.test.ts`: a userData
 * built with the app's own migrations and stores, session transcripts in
 * the shapes `FirstmateAgent` writes, and the planted credentials no
 * exported field may carry. It also exports one card turn, or one revised
 * card, through the real CLI for the tests that need a session of their own.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CardStore } from "@core/storage/cardStore";
import { openDatabase } from "@core/storage/db";
import { DecisionStore } from "@core/storage/decisionStore";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import type { Card, CardAction } from "@shared/cards";
import type { HoldOverride, OverridableHold } from "@shared/holds";
import { expect, vi } from "vitest";
import { main } from "../../scripts/export-corpus.ts";
import { seedDelivery } from "./taskDelivery";

/**
 * The captain's real evidence carries this many turns in backup copies of
 * the sessions directory - session files the app had already rolled past.
 * The fixture reproduces the number so the exclusion is measured, not
 * asserted in the abstract.
 */
export const BACKUP_TURNS = 678;
export const NUMERIC_SECRET = 123456;

// Planted credentials. None of these may appear in any exported field; each
// sits in a different shape the old exporter passed through untouched.
export const PLANTED = {
  toolArg: "sk-proj-PLANTEDONE0000000",
  assistant: "ghp_PLANTEDTWO",
  cardTitle: "xai-PLANTEDTHREE",
  taskTitle: "sk-ant-api03-PLANTEDFOUR",
  contextLine: "Bearer PLANTEDFIVE",
  wake: "AKIAPLANTEDSIXAAAAAA",
  header: "Authorization: PLANTEDSEVEN",
  structured: "OPAQUEPLANTEDEIGHT",
  cookie: "OPAQUEPLANTEDCOOKIE",
  session: "OPAQUEPLANTEDSESSION",
  privateKey: "OPAQUEPLANTEDPRIVATE",
  quotedNested: "OPAQUEPLANTEDNESTED",
  quotedAssistantHead: "OPAQUEPLANTEDASSISTANT",
  quotedAssistantTail: "SECRETASSISTANTTAIL",
  quotedJoinedHead: "OPAQUEPLANTEDJOINED",
  quotedJoinedTail: "SECRETJOINEDTAIL",
  prefixedApiKey: "OPAQUEPLANTEDPREFIXEDAPI",
  prefixedSecret: "OPAQUEPLANTEDPREFIXEDSECRET",
  bearerNested: "Bearer abc~PLANTEDBEARERNESTED==",
  bearerJoined: "Authorization: Bearer xyz._+/-~PLANTEDBEARERJOINED==",
  cookieHeaderNested: "Cookie: harmless=1; sessionid=PLANTEDCOOKIENESTED; theme=dark",
  cookieHeaderJoined: "Set-Cookie: a=1; token=PLANTEDCOOKIEJOINED; Path=/",
  credentialsNested: "PLANTEDCREDENTIALSNESTED",
  credentialJoined: "PLANTEDCREDENTIALJOINED",
  oauthNested: "PLANTEDOAUTHNESTED",
  oauthJoined: "PLANTEDOAUTHJOINED",
  shellNested: String.raw`OPENAI_API_KEY=$'PLANTEDSHELLNESTED SECRET' API_KEY=foo\ PLANTEDESCAPEDNESTED`,
  shellJoined: 'API_KEY=$"PLANTEDSHELLJOINED SECRET"',
  lineageTitle: "PLANTEDLINEAGETITLE",
  lineageResult: "PLANTEDLINEAGERESULT",
};

let clock = Date.parse("2026-09-10T09:00:00.000Z");
function nextStamp(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

let entryId = 0;
function entry(body: Record<string, unknown>): string {
  entryId += 1;
  return JSON.stringify({ id: `e${entryId}`, parentId: null, timestamp: nextStamp(), ...body });
}

/** Where the transcript clock and entry ids stand, to restart a later session from. */
export function stamps(): { clock: number; entryId: number } {
  return { clock, entryId };
}

/** Restart the transcript clock and entry ids from a place `stamps` gave. */
export function setStamps(next: { clock: number; entryId: number }): void {
  clock = next.clock;
  entryId = next.entryId;
}

function userEntry(text: string): string {
  return entry({ type: "message", message: { role: "user", content: text, timestamp: clock } });
}

function assistantEntry(
  text: string,
  calls: { id: string; name: string; args: Record<string, unknown> }[] = [],
  stopReason = "toolUse",
): string {
  return entry({
    type: "message",
    message: {
      role: "assistant",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...calls.map((call) => ({
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: call.args,
        })),
      ],
      provider: "xai",
      model: "grok-4.6",
      stopReason,
    },
  });
}

function toolResultEntry(callId: string, text: string): string {
  return entry({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: callId,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: clock,
    },
  });
}

/** The context block `FirstmateAgent.buildContextBlock` writes, verbatim in shape. */
export const CONTEXT = [
  "[fm-op] context (not the user)",
  "repos:",
  `- nimbus-api (repo_id: repo-nimbus) /fleet/nimbus-api [clone, direct-pr, autonomy on]`,
  "crew:",
  `- task t-work active "Ship the nimbus fix" repo nimbus-api`,
  `quota: xai 41% used; ${PLANTED.contextLine}`,
  "self-source: /repo",
].join("\n");
const AMBIGUOUS_CONTEXT = CONTEXT.replace(
  "quota:",
  "durable note: preserve this paragraph\n\n[fm-op] pasted note text\nstill context\nquota:",
);
const POST_SELF_SOURCE_CONTEXT =
  `${CONTEXT}\n` +
  'about: SCR-9 "Review this title\n\n[fm-op] text embedded after self-source" ' +
  "(open) - task_id t-work; the open card points at it";
const WHITESPACE_CONTEXT = CONTEXT.replace("repos:", "repos:  ");
export const WHITESPACE_WAKE = "[fm-op] padded wake  ";

/** The host's operational wake (`CrewSupervisor`, `[fm-op] ...`). */
export const FAILED_WAKE =
  `[fm-op] crewmate 1's turn on task t-work "Ship the nimbus fix" failed: provider timeout.` +
  " The crewmate is still steerable; you can retry, steer, or interrupt it.";
export const GATE_WAKE =
  `[fm-op] queued task t-plan "Plan the rollout" waits on t-work, which was dropped,` +
  " so its wait can never end.";
export const QUOTED_USER_MARKER_WAKE = "[fm-op] report:\n\n[user]\nquoted transcript text";

function mainSessionJsonl(): string {
  return `${[
    JSON.stringify({ type: "session", version: 3, id: "sess-main", timestamp: nextStamp() }),
    // The contract this history was actually recorded under.
    entry({
      type: "custom",
      customType: "fm-contract",
      data: { version: "1.1", prompt_sha: "sha-old" },
    }),
    entry({ type: "model_change", provider: "xai", modelId: "grok-4.6" }),

    // 1 - a plain captain turn.
    userEntry(`${CONTEXT}\n\n[user]\nGet the nimbus fix shipped.`),
    assistantEntry("", [
      {
        id: "c1",
        name: "spawn_crewmate",
        args: {
          title: "Ship the nimbus fix",
          goal: "Ship it.",
          user_words: "Get the nimbus fix shipped.",
          repo_id: "repo-nimbus",
          // A credential nested two levels down inside a tool argument.
          constraints: {
            env: {
              OPENAI_API_KEY: PLANTED.toolArg,
              access_token: PLANTED.structured,
              credentials: PLANTED.credentialsNested,
              oauth: PLANTED.oauthNested,
              password: NUMERIC_SECRET,
            },
            headers: [
              PLANTED.header,
              { transport: PLANTED.bearerNested, raw: PLANTED.cookieHeaderNested },
            ],
            sample: `{"api.key":"${PLANTED.quotedNested}"}`,
            joined: `OPENAI_API_KEY=${PLANTED.prefixedApiKey}`,
            shell: PLANTED.shellNested,
          },
        },
      },
    ]),
    toolResultEntry("c1", "Commissioned crewmate 1 on task t-work."),
    assistantEntry("ok", [], "stop"),

    // 2 - an OPERATIONAL drain: the same context block, an [fm-op] wake,
    // and no captain words at all.
    userEntry(`${CONTEXT}\n\n${FAILED_WAKE}`),
    assistantEntry("", [
      { id: "c2", name: "steer_crewmate", args: { task_id: "t-work", text: "retry the build" } },
    ]),
    assistantEntry(
      `retried using ${PLANTED.assistant}; ` +
        `password="${PLANTED.quotedAssistantHead}\\" ${PLANTED.quotedAssistantTail}"; ` +
        `client_secret=${PLANTED.prefixedSecret}`,
      [],
      "stop",
    ),

    userEntry(`${CONTEXT}\n\n${QUOTED_USER_MARKER_WAKE}`),
    assistantEntry("recorded", [], "stop"),

    // 3 - a MIXED turn: the captain spoke and the turn carried a pending wake.
    userEntry(`${CONTEXT}\n\n${GATE_WAKE}\n\n[user]\nWhat is going on with the rollout?`),
    assistantEntry("", [{ id: "c3", name: "emote", args: { emote: "ponder" } }]),
    toolResultEntry("c3", "Emote requested: ponder"),
    assistantEntry("", [{ id: "c4", name: "tasks", args: { status: "open" } }]),
    toolResultEntry("c4", "1 open task."),
    assistantEntry("said so", [], "stop"),

    // 4 - the decision card, in the shape emit_card takes today: no kind,
    // actions carrying effects.
    userEntry(`${CONTEXT}\n\n[user]\nIs it ready?`),
    assistantEntry("", [
      {
        id: "c5",
        name: "emit_card",
        args: {
          task_id: "t-work",
          title: `Merge the nimbus PR? ${PLANTED.cardTitle}`,
          body: "<p>CI is green on the head commit.</p>",
          actions: [
            {
              id: "merge-pr",
              label: "Merge it",
              default: true,
              effect: { kind: "settle", mode: "merge" },
            },
            {
              id: "drop-it",
              label: "Discard the work",
              danger: true,
              effect: { kind: "settle", mode: "discard", confirm: true },
            },
          ],
        },
      },
    ]),
    toolResultEntry("c5", "Card shown: Merge the nimbus PR? (card-t-work-1)"),
    assistantEntry("asked", [], "stop"),

    // 5 - a note card the emitter later withdrew: a card-shape turn.
    userEntry(`${CONTEXT}\n\n[user]\nAnything else?`),
    assistantEntry("", [
      {
        id: "c6",
        name: "emit_card",
        args: { task_id: "t-work", title: "Nothing outstanding", body: "<p>All quiet.</p>" },
      },
    ]),
    toolResultEntry("c6", "Card shown: Nothing outstanding (card-t-work-2)"),
    assistantEntry("noted", [], "stop"),

    userEntry(`${CONTEXT}\n\n[user]\nAnalyze this:\n\n[fm-op] sample log from the captain.`),
    assistantEntry("read", [], "stop"),

    userEntry(`${AMBIGUOUS_CONTEXT}\n\n[user]\nWhat did the note say?`),
    assistantEntry("read", [], "stop"),

    userEntry(`${POST_SELF_SOURCE_CONTEXT}\n\n[user]\nWhat title is open?`),
    assistantEntry("read", [], "stop"),

    userEntry(`${WHITESPACE_CONTEXT}\n\n${WHITESPACE_WAKE}\n\n[user]\n  pasted sample  `),
    assistantEntry("read", [], "stop"),

    // A reviewed builder and its review task (delivery rigor phase 3): one
    // steer to each, so both join and carry the review facts.
    userEntry(`${CONTEXT}\n\n[user]\nWhere does the meter review stand?`),
    assistantEntry("", [
      { id: "c7", name: "steer_crewmate", args: { task_id: "t-build", text: "hold" } },
      { id: "c8", name: "steer_crewmate", args: { task_id: "t-review", text: "wait" } },
    ]),
    toolResultEntry("c7", "Steered task t-build."),
    toolResultEntry("c8", "Steered task t-review."),
    assistantEntry("both steered", [], "stop"),
  ].join("\n")}\n`;
}

/** An unstamped session: history from before the contract stamp existed. */
function unstampedSessionJsonl(): string {
  return `${[
    JSON.stringify({ type: "session", version: 3, id: "sess-old", timestamp: nextStamp() }),
    userEntry(`${CONTEXT}\n\n[user]\nOld question.`),
    assistantEntry("answered", [], "stop"),
  ].join("\n")}\n`;
}

/**
 * One rolled session and the backup copy of it that is still on disk: the
 * same session id, the same entry ids, fewer entries because the copy was
 * taken before the session grew. Returns [full, backup].
 */
function bulkSessionPair(): [string, string] {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "sess-bulk",
    timestamp: nextStamp(),
  });
  const lines: string[] = [];
  const turns: number[] = [];
  for (let i = 0; i < BACKUP_TURNS + 22; i += 1) {
    turns.push(lines.length);
    lines.push(userEntry(`${CONTEXT}\n\n[user]\nturn ${i}`));
    lines.push(assistantEntry("ok", [], "stop"));
  }
  const cut = turns[BACKUP_TURNS] ?? lines.length;
  return [`${[header, ...lines].join("\n")}\n`, `${[header, ...lines.slice(0, cut)].join("\n")}\n`];
}

/** A session forked from the main one: it carries the parent's entries verbatim. */
function forkedSessionJsonl(parentPath: string, parent: string): string {
  const copied = parent
    .split("\n")
    .filter((line) => line.trim() && !line.includes('"type":"session"'))
    .slice(0, 6);
  return `${[
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-fork",
      timestamp: nextStamp(),
      parentSession: parentPath,
    }),
    ...copied,
    userEntry(`${CONTEXT}\n\n[user]\nCarry on from the fork.`),
    assistantEntry("ok", [], "stop"),
  ].join("\n")}\n`;
}

/** A plain reply action, the default one. */
const reply = (id: string, label: string): CardAction => ({ id, label, default: true });

/** A default action that opens a place in the app. */
const open = (id: string, label: string, target: "settings" | "subscriptions"): CardAction => ({
  id,
  label,
  default: true,
  effect: { kind: "open", target },
});

/** A default action that merges the work. */
const merge = (id: string, label: string): CardAction => ({
  id,
  label,
  default: true,
  effect: { kind: "settle", mode: "merge" },
});

/**
 * One card the fixture stores and resolves, with the timeline events the
 * host records about it. A card on a task records its resolution on that
 * task; a card with none is filed as a decision of its own and closed.
 */
type FixtureCard = {
  id: string;
  taskId?: string;
  author: "firstmate" | "crewmate";
  priority?: number;
  title: string;
  body: string;
  actions: CardAction[];
  createdAt: number;
  /** Stored as the decision kind cards carried before P1 dropped it. */
  storedAsDecision?: true;
  /** The `card_raised` event; its title is the card's unless named. */
  raised?: { kind: "decision" | "note"; title?: string };
  /** The version the card was revised to before the captain chose. */
  revised?: { body: string; actions: CardAction[] };
  /** The captain's duplicate label. */
  duplicateOf?: { cardId: string; note: string; at: number };
  /** What the card row stores as chosen. */
  chosen: string;
  /** The `card_resolved` event on its task; its title and action are the card's unless named. */
  resolved?: { title?: string; action?: string; actor: "captain" | "firstmate" };
  /** A taskless card's decision, and how it closed. */
  decision?: { id: string; close: Parameters<TaskService["close"]>[1] };
  /** Times written after the fact: the revision's window and the resolution's moment. */
  later?: { revisions: { createdAt: number; replacedAt: number }; resolvedAt: number };
};

function seedCard(
  db: ReturnType<typeof openDatabase>,
  cards: CardStore,
  tasks: TaskService,
  card: FixtureCard,
): void {
  const stored: Card = {
    id: card.id,
    ...(card.taskId ? { taskId: card.taskId } : {}),
    author: card.author,
    priority: card.priority ?? 2,
    title: card.title,
    meta: "",
    body: card.body,
    actions: card.actions,
    status: "ready",
    createdAt: card.createdAt,
  };
  cards.upsert(stored);
  if (card.storedAsDecision) {
    db.prepare("UPDATE cards SET kind = 'decision' WHERE id = ?").run(card.id);
  }
  if (card.raised && card.taskId) {
    tasks.recordCardRaised(card.taskId, {
      cardId: card.id,
      kind: card.raised.kind,
      title: card.raised.title ?? card.title,
    });
  }
  const decision = card.decision
    ? tasks.fileDecision({
        id: card.decision.id,
        title: card.title,
        cardId: card.id,
        actor: "firstmate",
      })
    : null;
  if (card.revised) cards.revise({ ...stored, ...card.revised });
  if (card.duplicateOf) {
    cards.flagDuplicate({
      cardId: card.id,
      duplicateOf: card.duplicateOf.cardId,
      note: card.duplicateOf.note,
      at: card.duplicateOf.at,
    });
  }
  cards.resolve(card.id, card.chosen);
  if (card.resolved && card.taskId) {
    tasks.recordCardResolved(card.taskId, {
      cardId: card.id,
      title: card.resolved.title ?? card.title,
      action: card.resolved.action ?? card.chosen,
      actor: card.resolved.actor,
    });
  }
  if (decision && card.decision) tasks.close(decision.id, card.decision.close);
  if (card.later) {
    db.prepare("UPDATE card_revisions SET created_at = ?, replaced_at = ? WHERE card_id = ?").run(
      card.later.revisions.createdAt,
      card.later.revisions.replacedAt,
      card.id,
    );
    db.prepare("UPDATE cards SET resolved_at = ? WHERE id = ?").run(card.later.resolvedAt, card.id);
  }
}

/** The cards the export reads, in the order the host stored them. */
const CARDS: FixtureCard[] = [
  // The decision card, exactly as the host stores one today: one shape, the
  // actions carrying the effects, attached to the work it is about. The
  // captain clicked the merge button: the host settles, nobody steers.
  {
    id: "card-t-work-1",
    taskId: "t-work",
    author: "firstmate",
    priority: 3,
    title: `Merge the nimbus PR? ${PLANTED.cardTitle}`,
    body: "<p>CI is green on the head commit.</p>",
    actions: [
      merge("merge-pr", "Merge it"),
      {
        id: "drop-it",
        label: "Discard the work",
        danger: true,
        effect: { kind: "settle", mode: "discard", confirm: true },
      },
    ],
    createdAt: 20,
    raised: { kind: "decision", title: "Merge the nimbus PR?" },
    chosen: "merge-pr",
    resolved: { title: "Merge the nimbus PR?", actor: "captain" },
  },
  // A note the EMITTER withdrew: not a captain dismissal.
  {
    id: "card-t-work-2",
    taskId: "t-work",
    author: "firstmate",
    title: "Nothing outstanding",
    body: "<p>All quiet.</p>",
    actions: [],
    createdAt: 21,
    raised: { kind: "note" },
    chosen: "no longer relevant",
    resolved: { action: "closed", actor: "firstmate" },
  },
  {
    id: "card-t-work-3",
    taskId: "t-work",
    author: "firstmate",
    title: "Current free-form action",
    body: "<p>Choose.</p>",
    actions: [reply("open-settings", "Send this guidance")],
    createdAt: 22,
    chosen: "open-settings",
    resolved: { actor: "captain" },
  },
  {
    id: "card-t-work-4",
    taskId: "t-work",
    author: "firstmate",
    title: "Historical reserved action",
    body: "<p>Choose.</p>",
    actions: [reply("open-settings", "Open settings")],
    createdAt: 23,
    storedAsDecision: true,
    chosen: "open-settings",
    resolved: { actor: "captain" },
  },
  {
    id: "card-t-work-5",
    taskId: "t-work",
    author: "firstmate",
    title: "Repeated note",
    body: "<p>This repeats an earlier card.</p>",
    actions: [],
    createdAt: 24,
    duplicateOf: { cardId: "card-t-work-2", note: "same information", at: 25 },
    chosen: "duplicate",
    resolved: { action: "closed", actor: "captain" },
  },
  {
    id: "card-t-work-6",
    taskId: "t-work",
    author: "crewmate",
    title: "Crewmate free-form action",
    body: "<p>Choose.</p>",
    actions: [reply("use-postgres", "Use Postgres")],
    createdAt: 26,
    chosen: "use-postgres",
    resolved: { actor: "captain" },
  },
  {
    id: "card-t-work-close",
    taskId: "t-work",
    author: "firstmate",
    title: "Current close action",
    body: "<p>Open settings.</p>",
    actions: [open("close", "Open settings", "settings")],
    createdAt: 27,
    chosen: "close",
    resolved: { actor: "captain" },
  },
  {
    id: "card-t-work-close-dismissed",
    taskId: "t-work",
    author: "firstmate",
    title: "Dismissed close action",
    body: "<p>Open settings.</p>",
    actions: [open("close", "Open settings", "settings")],
    createdAt: 28,
    chosen: "close",
    resolved: { action: "dismissed", actor: "captain" },
  },
  {
    id: "card-t-work-dismissed-action",
    taskId: "t-work",
    author: "firstmate",
    title: "Declared dismissed action",
    body: "<p>Open subscriptions.</p>",
    actions: [open("dismissed", "Open subscriptions", "subscriptions")],
    createdAt: 29,
    chosen: "dismissed",
    resolved: { actor: "captain" },
  },
  {
    id: "card-t-work-dismissed-chrome",
    taskId: "t-work",
    author: "firstmate",
    title: "Chrome-dismissed declared action",
    body: "<p>Open subscriptions.</p>",
    actions: [open("dismissed", "Open subscriptions", "subscriptions")],
    createdAt: 30,
    chosen: "close",
    resolved: { action: "dismissed", actor: "captain" },
  },
  {
    id: "card-t-work-landed-action",
    taskId: "t-work",
    author: "firstmate",
    title: "Current landed action",
    body: "<p>Land this work.</p>",
    actions: [merge("landed", "Land")],
    createdAt: 29,
    chosen: "landed",
    resolved: { actor: "captain" },
  },
  {
    id: "card-t-work-closed-action",
    taskId: "t-work",
    author: "crewmate",
    title: "Current closed action",
    body: "<p>Send guidance.</p>",
    actions: [reply("closed", "Send guidance")],
    createdAt: 30,
    chosen: "closed",
    resolved: { actor: "captain" },
  },
  {
    id: "card-t-work-bare-landed",
    taskId: "t-work",
    author: "firstmate",
    title: "Bare landed withdrawal",
    body: "<p>Withdrawn.</p>",
    actions: [],
    createdAt: 31,
    chosen: "landed",
    resolved: { actor: "captain" },
  },
  {
    id: "card-t-work-legacy-keep",
    taskId: "t-work",
    author: "crewmate",
    title: "Historical keep control",
    body: "<p>Old decision.</p>",
    actions: [reply("keep", "Keep")],
    createdAt: 31,
    storedAsDecision: true,
    chosen: "keep",
    resolved: { actor: "captain" },
  },
  {
    id: "card-fm-close-acted",
    author: "firstmate",
    title: "Taskless close action",
    body: "<p>Open settings.</p>",
    actions: [open("close", "Open settings", "settings")],
    createdAt: 32,
    chosen: "close",
    decision: {
      id: "decision-close-acted",
      close: {
        status: "done",
        reason: "answered",
        actor: "captain",
        text: 'chose "Open settings"',
      },
    },
  },
  {
    id: "card-fm-close-dismissed",
    author: "firstmate",
    title: "Taskless dismissed close",
    body: "<p>Open settings.</p>",
    actions: [open("close", "Open settings", "settings")],
    createdAt: 33,
    chosen: "close",
    decision: {
      id: "decision-close-dismissed",
      close: {
        status: "dropped",
        reason: "cancelled",
        actor: "captain",
        text: "dismissed without a choice",
      },
    },
  },
  {
    id: "card-fm-withdrawn-acted",
    author: "firstmate",
    title: "Declared withdrawn action",
    body: "<p>Open settings.</p>",
    actions: [open("withdrawn", "Open settings", "settings")],
    createdAt: 34,
    chosen: "withdrawn",
    decision: {
      id: "decision-withdrawn-acted",
      close: {
        status: "done",
        reason: "answered",
        actor: "captain",
        text: 'chose "Open settings"',
      },
    },
  },
  {
    id: "card-fm-withdrawn-retired",
    author: "firstmate",
    title: "Retired withdrawn action",
    body: "<p>Open settings.</p>",
    actions: [open("withdrawn", "Open settings", "settings")],
    createdAt: 35,
    chosen: "withdrawn",
    decision: {
      id: "decision-withdrawn-retired",
      close: {
        status: "dropped",
        reason: "superseded",
        actor: "firstmate",
        text: "withdrawn as obsolete",
      },
    },
  },
  {
    id: "card-fm-closed-acted",
    author: "firstmate",
    title: "Declared closed action",
    body: "<p>Open subscriptions.</p>",
    actions: [open("closed", "Open subscriptions", "subscriptions")],
    createdAt: 36,
    chosen: "closed",
    decision: {
      id: "decision-closed-acted",
      close: {
        status: "dropped",
        reason: "superseded",
        actor: "captain",
        text: 'chose "Open subscriptions"',
      },
    },
  },
  {
    id: "card-fm-closed-retired",
    author: "firstmate",
    title: "Retired closed action",
    body: "<p>Open subscriptions.</p>",
    actions: [open("closed", "Open subscriptions", "subscriptions")],
    createdAt: 37,
    chosen: "closed",
    decision: {
      id: "decision-closed-retired",
      close: {
        status: "dropped",
        reason: "superseded",
        actor: "firstmate",
        text: "withdrawn as obsolete",
      },
    },
  },
  {
    id: "card-fm-withdrawn",
    author: "firstmate",
    title: "Withdrawn proposal",
    body: "<p>Obsolete.</p>",
    actions: [reply("proceed", "Proceed")],
    createdAt: 34,
    chosen: "proceed",
    decision: {
      id: "decision-withdrawn",
      close: {
        status: "dropped",
        reason: "superseded",
        actor: "firstmate",
        text: "withdrawn as obsolete",
      },
    },
  },
  {
    id: "card-t-work-title",
    taskId: "t-work",
    author: "crewmate",
    title: "Title-only historical result",
    body: "<p>Choose.</p>",
    actions: [reply("accept", "Accept")],
    createdAt: 35,
    raised: { kind: "decision" },
    chosen: "accept",
    resolved: { actor: "captain" },
  },
  {
    id: "card-t-work-credential-title",
    taskId: "t-work",
    author: "firstmate",
    title: `Credential API_KEY=${PLANTED.lineageTitle}`,
    body: "<p>Original credential-bearing evidence.</p>",
    actions: [reply("review-credential", "Review")],
    createdAt: 38,
    raised: { kind: "decision" },
    revised: {
      body: "<p>Revised credential-bearing evidence.</p>",
      actions: [merge("merge-credential", "Merge")],
    },
    chosen: "merge-credential",
    resolved: { actor: "captain" },
    later: { revisions: { createdAt: 38, replacedAt: 40 }, resolvedAt: 50 },
  },
  {
    id: "card-fm-result-credential",
    taskId: "t-work",
    author: "firstmate",
    title: "Credential result card",
    body: "<p>Result carried a credential.</p>",
    actions: [open("open-result", "Open settings", "settings")],
    createdAt: 39,
    raised: { kind: "decision" },
    chosen: "open-result",
    resolved: { actor: "captain" },
  },
];

/** The fixture userData, written into `dir`. */
export function buildFixture(dir: string): void {
  const db = openDatabase(dir);
  db.prepare(
    "INSERT INTO repos (id, path, name, setup_kind, origin, delivery, autonomy, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("repo-nimbus", "/fleet/nimbus-api", "nimbus-api", "clone", null, "direct-pr", 1, 1);

  const tasks = new TaskService({ db, strict: true });
  seedTask(tasks, {
    id: "t-work",
    // A credential in a joined string: the title rides every evidence line
    // the exporter composes about this task.
    title:
      `Ship the nimbus fix ${PLANTED.taskTitle} ` +
      `cookie=${PLANTED.cookie} session: ${PLANTED.session} private_key=${PLANTED.privateKey} ` +
      `private.key="${PLANTED.quotedJoinedHead}\\" ${PLANTED.quotedJoinedTail}" ` +
      `${PLANTED.bearerJoined}\n${PLANTED.cookieHeaderJoined}\n` +
      `credential=${PLANTED.credentialJoined}\noauth=${PLANTED.oauthJoined}\n${PLANTED.shellJoined}`,
    prompt: "brief",
    repoId: "repo-nimbus",
    repoDir: "/fleet/nimbus-api",
    worktreeDir: "/worktrees/t-work",
    branch: "fm/t-work",
    sessionFile: null,
    accountId: null,
    status: "running",
    createdAt: 10,
  });

  // A reviewed builder with its review's verdict on record, and the review
  // task that read it (delivery rigor phase 3).
  seedTask(tasks, {
    id: "t-build",
    title: "Ship the meter fix",
    prompt: "brief",
    repoId: "repo-nimbus",
    repoDir: "/fleet/nimbus-api",
    worktreeDir: "/worktrees/t-build",
    branch: "fm/t-build",
    sessionFile: null,
    accountId: null,
    status: "idle",
    createdAt: 11,
    difficulty: "high",
    shape: { kind: "fix", kind_source: "classifier:test", rigor: "reviewed" },
  });
  // The facts the host records on a builder: the PR it opened, the CI
  // rounds it spent, and the verdict its reviewer returned - the last as a
  // `review` timeline event, which is what the phase-4 numbers count.
  seedDelivery(tasks, "t-build", { mode: "direct-pr", prNumber: 7, ciRounds: 2 });
  seedDelivery(
    tasks,
    "t-build",
    {
      reviewVerdict: "findings",
      reviewRisk: "medium",
      reviewRounds: 1,
    },
    {
      kind: "review",
      text: "review findings at abc1234, risk medium - findings round 1",
      data: { reviewTaskId: "t-review" },
    },
  );
  // The captain's words passed two soft holds, he took them back, then his
  // words passed one: the rows `update_task override` writes (INF-484 move
  // 8 counts them per hold kind; the take-back is not an override).
  const override = (holds: OverridableHold[], at: number): HoldOverride => ({
    words: "Ship it as it is.",
    holds,
    until: "task",
    at,
  });
  seedDelivery(
    tasks,
    "t-build",
    { override: override(["checks", "waits"], 20) },
    {
      kind: "note",
      actor: "firstmate",
      feed: true,
      text: "Your words pass the repairs.",
      data: { news: true },
    },
  );
  seedDelivery(
    tasks,
    "t-build",
    { override: undefined },
    {
      kind: "note",
      actor: "firstmate",
      feed: true,
      text: "You took back your words.",
      data: { news: true, overrideWithdrawn: override(["checks", "waits"], 20) },
    },
  );
  seedDelivery(
    tasks,
    "t-build",
    { override: override(["checks"], 30) },
    {
      kind: "note",
      actor: "firstmate",
      feed: true,
      text: "Your words pass the repairs.",
      data: { news: true },
    },
  );
  seedTask(tasks, {
    id: "t-review",
    title: "Review: Ship the meter fix",
    prompt: "brief",
    repoId: "repo-nimbus",
    repoDir: "/fleet/nimbus-api",
    worktreeDir: "/worktrees/t-review",
    branch: "fm/t-review",
    sessionFile: null,
    accountId: null,
    status: "idle",
    createdAt: 12,
    difficulty: "high",
    parentId: "t-build",
    shape: { kind: "review", kind_source: "host:review" },
  });
  // The reviewer's own report is what the findings are counted from.
  tasks.recordReport("t-review", {
    text: [
      "verdict: findings",
      "F1 error src/meter.ts:20 the window is never bounded - auto-fix",
      "F2 warning src/meter.ts:44 this changes what the captain sees - ask-user",
      "risk: medium one finding needs the captain",
    ].join("\n"),
  });

  const cards = new CardStore(db);
  for (const card of CARDS) seedCard(db, cards, tasks, card);

  const supervision = new DecisionStore(db);
  const preCreationOutcome = supervision.recordSort({
    taskId: "t-work",
    wake: `crewmate reported: build green, key ${PLANTED.wake}`,
    verdict: "captain",
    summary: "Merge needs a call.",
    cardId: "card-t-work-1",
    model: "ollama/gemma4:12b",
    promptSha: "prompt-a",
    toolsSha: "tools-a",
    steered: false,
    wakeKind: "task_report",
  });
  supervision.recordSort({
    taskId: "t-work",
    wake: "crewmate reported: all quiet",
    verdict: "captain",
    summary: "Nothing to decide.",
    cardId: "card-t-work-2",
    model: "ollama/gemma4:12b",
    promptSha: "prompt-a",
    toolsSha: "tools-a",
    wakeKind: "task_report",
  });
  db.prepare("UPDATE decisions SET at = ? WHERE id = ?").run(19, preCreationOutcome);

  cards.upsert({
    id: "card-t-work-supervision-revised",
    taskId: "t-work",
    author: "firstmate",
    priority: 3,
    title: "Original escalation",
    meta: "",
    body: "<p>Original evidence.</p>",
    actions: [],
    status: "ready",
    createdAt: 40,
  });
  tasks.recordCardRaised("t-work", {
    cardId: "card-t-work-supervision-revised",
    kind: "decision",
    title: "Original escalation",
  });
  const revisedOutcome = supervision.recordSort({
    taskId: "t-work",
    wake: "crewmate reported: choose the response",
    verdict: "captain",
    summary: "The original evidence needs a choice.",
    cardId: "card-t-work-supervision-revised",
    model: "ollama/gemma4:12b",
    promptSha: "prompt-a",
    toolsSha: "tools-a",
    wakeKind: "task_report",
  });
  cards.revise({
    id: "card-t-work-supervision-revised",
    taskId: "t-work",
    author: "firstmate",
    priority: 3,
    title: "Revised escalation",
    meta: "",
    body: "<p>Revised evidence.</p>",
    actions: [
      {
        id: "merge-revised",
        label: "Merge revised work",
        default: true,
        effect: { kind: "settle", mode: "merge" },
      },
    ],
    status: "ready",
    createdAt: 40,
  });
  cards.resolve("card-t-work-supervision-revised", "merge-revised");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-supervision-revised",
    title: "Revised escalation",
    action: "merge-revised",
    actor: "captain",
  });
  db.prepare("UPDATE card_revisions SET created_at = 40, replaced_at = 60 WHERE card_id = ?").run(
    "card-t-work-supervision-revised",
  );
  db.prepare("UPDATE cards SET resolved_at = 70 WHERE id = ?").run(
    "card-t-work-supervision-revised",
  );
  db.prepare("UPDATE decisions SET at = 50 WHERE id = ?").run(revisedOutcome);

  cards.upsert({
    id: "card-t-work-supervision-open",
    taskId: "t-work",
    author: "firstmate",
    priority: 3,
    title: "Open escalation",
    meta: "",
    body: "<p>Still waiting.</p>",
    actions: [{ id: "answer", label: "Answer", default: true }],
    status: "ready",
    createdAt: 80,
  });
  const openOutcome = supervision.recordSort({
    taskId: "t-work",
    wake: "crewmate reported: waiting for the captain",
    verdict: "captain",
    summary: "This choice remains open.",
    cardId: "card-t-work-supervision-open",
    model: "ollama/gemma4:12b",
    promptSha: "prompt-a",
    toolsSha: "tools-a",
    wakeKind: "task_report",
  });
  db.prepare("UPDATE decisions SET at = 90 WHERE id = ?").run(openOutcome);

  const sessionsDir = join(dir, "firstmate", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const mainPath = join(sessionsDir, "2026-09-10T09-00-00-000Z_sess-main.jsonl");
  const mainRaw = mainSessionJsonl();
  writeFileSync(mainPath, mainRaw);
  writeFileSync(
    join(sessionsDir, "2026-09-02T08-00-00-000Z_sess-old.jsonl"),
    unstampedSessionJsonl(),
  );
  const [bulk, bulkBackup] = bulkSessionPair();
  writeFileSync(join(sessionsDir, "2026-09-05T08-00-00-000Z_sess-bulk.jsonl"), bulk);
  writeFileSync(join(sessionsDir, "sessions-backup-2026-09-06_sess-bulk.jsonl"), bulkBackup);
  writeFileSync(
    join(sessionsDir, "2026-09-11T10-00-00-000Z_sess-fork.jsonl"),
    forkedSessionJsonl(mainPath, mainRaw),
  );
  db.close();
}

/** One exported dispatch record, as the tests read it. */
export type DispatchRow = {
  kind: string;
  kind_basis: string;
  kind_unknown: boolean;
  framing_ambiguity: string | null;
  framed_text: string | null;
  ambiguous_wakes: string[];
  model: string | null;
  context: string | null;
  ops: string[];
  user: string | null;
  observed_class: string;
  contract: { version: string; prompt_sha: string } | null;
  outcome: {
    tasks: {
      task_id: string;
      via: string;
      found: boolean;
      rigor?: string;
      review_of?: string | null;
      review_verdict?: string | null;
      review_risk?: string | null;
    }[];
    cards: {
      card_id: string | null;
      found?: boolean;
      joined_via?: string;
      task_id?: string | null;
      task_via?: string | null;
      author?: string | null;
      title?: string;
      body?: string;
      revisions?: number;
      actions?: Array<{ id?: string; effect?: { kind?: string; mode?: string } }>;
      actions_version?: string;
      chosen_action?: string | null;
      chosen_effect?: { kind?: string; mode?: string; target?: string } | null;
      effect_source?: string | null;
      captain_contact?: string;
      resolution?: string;
      resolved_by?: string | null;
    }[];
  };
  label: {
    gold_class: string | null;
    unknown: boolean;
    basis: string;
    confidence: string;
    evidence: string[];
  };
};

/**
 * One emit_card turn in a session of its own, exported through the real
 * CLI over the fixture copy in `dir`: the record of the captain's words.
 */
export function exportCardCaseIn(
  dir: string,
  user: string,
  cardId: string,
  title: string,
  args: Record<string, unknown>,
  includeResultId = true,
  resultText?: string,
): DispatchRow {
  const session = `${[
    JSON.stringify({ type: "session", version: 3, id: `case-${cardId}`, timestamp: nextStamp() }),
    userEntry(`${CONTEXT}\n\n[user]\n${user}`),
    assistantEntry("", [{ id: `call-${cardId}`, name: "emit_card", args }]),
    toolResultEntry(
      `call-${cardId}`,
      resultText ?? (includeResultId ? `Card shown: ${title} (${cardId})` : `Card shown: ${title}`),
    ),
    assistantEntry("asked", [], "stop"),
  ].join("\n")}\n`;
  writeFileSync(join(dir, "firstmate", "sessions", `case-${cardId}.jsonl`), session);
  const caseOut = join(dir, `corpus-${cardId}`);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(
      main(
        [
          "--out",
          caseOut,
          "--user-data",
          dir,
          "--session-file",
          join(dir, "firstmate", "sessions", `case-${cardId}.jsonl`),
        ],
        { isPackaged: false },
      ),
    ).toBe(0);
  } finally {
    stderr.mockRestore();
  }
  const rows = readFileSync(join(caseOut, "dispatch.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as DispatchRow);
  const row = rows.find((record) => record.user === user);
  if (!row) throw new Error(`no exported case turn saying ${user}`);
  return row;
}

/**
 * A card revised between two turns, exported through the real CLI over the
 * fixture copy in `dir`: the record of the turn that showed each version.
 */
export function exportRevisionCaseIn(dir: string): { early: DispatchRow; current: DispatchRow } {
  const cardId = "card-t-work-revised";
  const earlyArgs = {
    task_id: "t-work",
    title: "Original revision title",
    body: "<p>Original choice.</p>",
    actions: [{ id: "choose-a", label: "Choose A", default: true }],
  };
  const currentArgs = {
    task_id: "t-work",
    title: "Current revision title",
    body: "<p>Current choice.</p>",
    actions: [
      {
        id: "merge-current",
        label: "Merge",
        default: true,
        effect: { kind: "settle" as const, mode: "merge" as const },
      },
    ],
  };
  const earlyUser = userEntry(`${CONTEXT}\n\n[user]\nShow the original revision.`);
  const earlyAt = clock;
  const earlyAssistant = assistantEntry("", [
    { id: "revision-a", name: "emit_card", args: earlyArgs },
  ]);
  const earlyResult = toolResultEntry("revision-a", "Card shown: Original revision title");
  const earlyObservedAt = clock;
  const earlyClose = assistantEntry("asked", [], "stop");
  const currentUser = userEntry(`${CONTEXT}\n\n[user]\nShow the current revision.`);
  const currentTurnAt = clock;
  const currentAssistant = assistantEntry("", [
    { id: "revision-b", name: "emit_card", args: currentArgs },
  ]);
  const currentResult = toolResultEntry(
    "revision-b",
    `Card shown: Current revision title (${cardId})`,
  );
  const replacedAt = clock;
  const currentClose = assistantEntry("asked", [], "stop");
  const session = `${[
    JSON.stringify({ type: "session", version: 3, id: "case-revisions", timestamp: nextStamp() }),
    earlyUser,
    earlyAssistant,
    earlyResult,
    earlyClose,
    currentUser,
    currentAssistant,
    currentResult,
    currentClose,
  ].join("\n")}\n`;

  const db = openDatabase(dir);
  const store = new CardStore(db);
  store.upsert({
    id: cardId,
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: currentArgs.title,
    meta: "",
    body: currentArgs.body,
    actions: currentArgs.actions,
    status: "ready",
    createdAt: earlyAt,
  });
  db.prepare(
    `INSERT INTO card_revisions
       (card_id, revision, kind, title, body, actions_json, created_at, replaced_at, replaced_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cardId,
    1,
    "card",
    earlyArgs.title,
    earlyArgs.body,
    JSON.stringify(earlyArgs.actions),
    earlyAt,
    replacedAt,
    cardId,
  );
  store.upsert({
    id: "card-t-work-future-same-title",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: earlyArgs.title,
    meta: "",
    body: "<p>Future unrelated card.</p>",
    actions: [{ id: "future", label: "Future", default: true }],
    status: "ready",
    createdAt: earlyObservedAt + 60_000,
  });
  store.resolve(cardId, "merge-current");
  db.close();

  writeFileSync(join(dir, "firstmate", "sessions", "case-revisions.jsonl"), session);
  const caseOut = join(dir, "corpus-revisions");
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    expect(
      main(
        [
          "--out",
          caseOut,
          "--user-data",
          dir,
          "--session-file",
          join(dir, "firstmate", "sessions", "case-revisions.jsonl"),
        ],
        { isPackaged: false },
      ),
    ).toBe(0);
  } finally {
    stderr.mockRestore();
  }
  const rows = readFileSync(join(caseOut, "dispatch.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as DispatchRow);
  const early = rows.find((row) => row.user === "Show the original revision.");
  const current = rows.find((row) => row.user === "Show the current revision.");
  if (!early || !current) throw new Error("missing revised card turns");
  expect(earlyAt).toBeLessThan(earlyObservedAt);
  expect(earlyObservedAt).toBeLessThan(currentTurnAt);
  expect(currentTurnAt).toBeLessThan(replacedAt);
  return { early, current };
}
