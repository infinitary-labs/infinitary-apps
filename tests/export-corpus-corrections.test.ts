import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FIRSTMATE_CONTRACT_VERSION } from "@core/pi/piResources";
import { CardStore } from "@core/storage/cardStore";
import { openDatabase } from "@core/storage/db";
import { DecisionStore } from "@core/storage/decisionStore";
import { seedTask } from "@core/tasks/seedTask";
import { TaskService } from "@core/tasks/taskService";
import type { HoldOverride, OverridableHold } from "@shared/holds";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../scripts/export-corpus.ts";
import { main as extractDispatchMain } from "../scripts/extract-dispatch-corpus.ts";
import { scratchDir } from "./helpers/scratchDirs";

/**
 * The corrected offline export, proven the way the captain's own evidence
 * would exercise it: a fixture userData built with the app's OWN migrations
 * and stores, session transcripts in the shapes `FirstmateAgent` actually
 * writes today, and the REAL export CLI invoked over them. Every assertion
 * reads the exported files - the corpus a training run would consume - not
 * the exporter's source.
 *
 * What the pre-correction exporter got wrong, and what is pinned here:
 *
 *  - an operational drain wears the same context block as a captain turn,
 *    and was exported as a captain turn with no words;
 *  - a captain turn carrying pending wakes (the wake diet) lost them into
 *    the context blob;
 *  - a card was read through pre-P1 reserved action ids, so a settle button
 *    counted as a steer and a host withdrawal as a captain dismissal;
 *  - a card's shape was exported as gold intent;
 *  - a decision never joined the work it was about;
 *  - backup copies of the sessions directory double-counted every turn;
 *  - tool arguments, assistant text and joined strings were never redacted;
 *  - an unstamped turn had nothing saying which contract it was recorded
 *    under.
 */

/**
 * The captain's real evidence carries this many turns in backup copies of
 * the sessions directory - session files the app had already rolled past.
 * The fixture reproduces the number so the exclusion is measured, not
 * asserted in the abstract.
 */
const BACKUP_TURNS = 678;
const NUMERIC_SECRET = 123456;

// Planted credentials. None of these may appear in any exported field; each
// sits in a different shape the old exporter passed through untouched.
const PLANTED = {
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
const CONTEXT = [
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
const WHITESPACE_WAKE = "[fm-op] padded wake  ";

/** The host's operational wake (`CrewSupervisor`, `[fm-op] ...`). */
const FAILED_WAKE =
  `[fm-op] crewmate 1's turn on task t-work "Ship the nimbus fix" failed: provider timeout.` +
  " The crewmate is still steerable; you can retry, steer, or interrupt it.";
const GATE_WAKE =
  `[fm-op] queued task t-plan "Plan the rollout" waits on t-work, which was dropped,` +
  " so its wait can never end.";
const QUOTED_USER_MARKER_WAKE = "[fm-op] report:\n\n[user]\nquoted transcript text";

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

function buildFixture(dir: string): void {
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
  tasks.recordDelivery("t-build", { mode: "direct-pr", prNumber: 7, ciRounds: 2 });
  tasks.recordDelivery(
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
  tasks.recordDelivery(
    "t-build",
    { override: override(["repairs", "rounds"], 20) },
    {
      kind: "note",
      actor: "firstmate",
      feed: true,
      text: "Your words pass the repairs.",
      data: { news: true },
    },
  );
  tasks.recordDelivery(
    "t-build",
    { override: undefined },
    {
      kind: "note",
      actor: "firstmate",
      feed: true,
      text: "You took back your words.",
      data: { news: true, overrideWithdrawn: override(["repairs", "rounds"], 20) },
    },
  );
  tasks.recordDelivery(
    "t-build",
    { override: override(["repairs"], 30) },
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
  // The decision card, exactly as the host stores one today: one shape, the
  // actions carrying the effects, attached to the work it is about.
  cards.upsert({
    id: "card-t-work-1",
    taskId: "t-work",
    author: "firstmate",
    priority: 3,
    title: `Merge the nimbus PR? ${PLANTED.cardTitle}`,
    meta: "",
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
    status: "ready",
    createdAt: 20,
  });
  tasks.recordCardRaised("t-work", {
    cardId: "card-t-work-1",
    kind: "decision",
    title: "Merge the nimbus PR?",
  });
  // The captain clicked the merge button: the host settles, nobody steers.
  cards.resolve("card-t-work-1", "merge-pr");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-1",
    title: "Merge the nimbus PR?",
    action: "merge-pr",
    actor: "captain",
  });

  // A note the EMITTER withdrew: not a captain dismissal.
  cards.upsert({
    id: "card-t-work-2",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Nothing outstanding",
    meta: "",
    body: "<p>All quiet.</p>",
    actions: [],
    status: "ready",
    createdAt: 21,
  });
  tasks.recordCardRaised("t-work", {
    cardId: "card-t-work-2",
    kind: "note",
    title: "Nothing outstanding",
  });
  cards.resolve("card-t-work-2", "no longer relevant");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-2",
    title: "Nothing outstanding",
    action: "closed",
    actor: "firstmate",
  });

  cards.upsert({
    id: "card-t-work-3",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Current free-form action",
    meta: "",
    body: "<p>Choose.</p>",
    actions: [{ id: "open-settings", label: "Send this guidance", default: true }],
    status: "ready",
    createdAt: 22,
  });
  cards.resolve("card-t-work-3", "open-settings");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-3",
    title: "Current free-form action",
    action: "open-settings",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-4",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Historical reserved action",
    meta: "",
    body: "<p>Choose.</p>",
    actions: [{ id: "open-settings", label: "Open settings", default: true }],
    status: "ready",
    createdAt: 23,
  });
  db.prepare("UPDATE cards SET kind = 'decision' WHERE id = 'card-t-work-4'").run();
  cards.resolve("card-t-work-4", "open-settings");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-4",
    title: "Historical reserved action",
    action: "open-settings",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-5",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Repeated note",
    meta: "",
    body: "<p>This repeats an earlier card.</p>",
    actions: [],
    status: "ready",
    createdAt: 24,
  });
  cards.flagDuplicate({
    cardId: "card-t-work-5",
    duplicateOf: "card-t-work-2",
    note: "same information",
    at: 25,
  });
  cards.resolve("card-t-work-5", "duplicate");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-5",
    title: "Repeated note",
    action: "closed",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-6",
    taskId: "t-work",
    author: "crewmate",
    priority: 2,
    title: "Crewmate free-form action",
    meta: "",
    body: "<p>Choose.</p>",
    actions: [{ id: "use-postgres", label: "Use Postgres", default: true }],
    status: "ready",
    createdAt: 26,
  });
  cards.resolve("card-t-work-6", "use-postgres");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-6",
    title: "Crewmate free-form action",
    action: "use-postgres",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-close",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Current close action",
    meta: "",
    body: "<p>Open settings.</p>",
    actions: [
      {
        id: "close",
        label: "Open settings",
        default: true,
        effect: { kind: "open", target: "settings" },
      },
    ],
    status: "ready",
    createdAt: 27,
  });
  cards.resolve("card-t-work-close", "close");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-close",
    title: "Current close action",
    action: "close",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-close-dismissed",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Dismissed close action",
    meta: "",
    body: "<p>Open settings.</p>",
    actions: [
      {
        id: "close",
        label: "Open settings",
        default: true,
        effect: { kind: "open", target: "settings" },
      },
    ],
    status: "ready",
    createdAt: 28,
  });
  cards.resolve("card-t-work-close-dismissed", "close");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-close-dismissed",
    title: "Dismissed close action",
    action: "dismissed",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-dismissed-action",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Declared dismissed action",
    meta: "",
    body: "<p>Open subscriptions.</p>",
    actions: [
      {
        id: "dismissed",
        label: "Open subscriptions",
        default: true,
        effect: { kind: "open", target: "subscriptions" },
      },
    ],
    status: "ready",
    createdAt: 29,
  });
  cards.resolve("card-t-work-dismissed-action", "dismissed");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-dismissed-action",
    title: "Declared dismissed action",
    action: "dismissed",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-dismissed-chrome",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Chrome-dismissed declared action",
    meta: "",
    body: "<p>Open subscriptions.</p>",
    actions: [
      {
        id: "dismissed",
        label: "Open subscriptions",
        default: true,
        effect: { kind: "open", target: "subscriptions" },
      },
    ],
    status: "ready",
    createdAt: 30,
  });
  cards.resolve("card-t-work-dismissed-chrome", "close");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-dismissed-chrome",
    title: "Chrome-dismissed declared action",
    action: "dismissed",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-landed-action",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Current landed action",
    meta: "",
    body: "<p>Land this work.</p>",
    actions: [
      {
        id: "landed",
        label: "Land",
        default: true,
        effect: { kind: "settle", mode: "merge" },
      },
    ],
    status: "ready",
    createdAt: 29,
  });
  cards.resolve("card-t-work-landed-action", "landed");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-landed-action",
    title: "Current landed action",
    action: "landed",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-closed-action",
    taskId: "t-work",
    author: "crewmate",
    priority: 2,
    title: "Current closed action",
    meta: "",
    body: "<p>Send guidance.</p>",
    actions: [{ id: "closed", label: "Send guidance", default: true }],
    status: "ready",
    createdAt: 30,
  });
  cards.resolve("card-t-work-closed-action", "closed");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-closed-action",
    title: "Current closed action",
    action: "closed",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-bare-landed",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Bare landed withdrawal",
    meta: "",
    body: "<p>Withdrawn.</p>",
    actions: [],
    status: "ready",
    createdAt: 31,
  });
  cards.resolve("card-t-work-bare-landed", "landed");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-bare-landed",
    title: "Bare landed withdrawal",
    action: "landed",
    actor: "captain",
  });

  cards.upsert({
    id: "card-t-work-legacy-keep",
    taskId: "t-work",
    author: "crewmate",
    priority: 2,
    title: "Historical keep control",
    meta: "",
    body: "<p>Old decision.</p>",
    actions: [{ id: "keep", label: "Keep", default: true }],
    status: "ready",
    createdAt: 31,
  });
  db.prepare("UPDATE cards SET kind = 'decision' WHERE id = 'card-t-work-legacy-keep'").run();
  cards.resolve("card-t-work-legacy-keep", "keep");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-legacy-keep",
    title: "Historical keep control",
    action: "keep",
    actor: "captain",
  });

  cards.upsert({
    id: "card-fm-close-acted",
    author: "firstmate",
    priority: 2,
    title: "Taskless close action",
    meta: "",
    body: "<p>Open settings.</p>",
    actions: [
      {
        id: "close",
        label: "Open settings",
        default: true,
        effect: { kind: "open", target: "settings" },
      },
    ],
    status: "ready",
    createdAt: 32,
  });
  const actedCloseDecision = tasks.fileDecision({
    id: "decision-close-acted",
    title: "Taskless close action",
    cardId: "card-fm-close-acted",
    actor: "firstmate",
  });
  cards.resolve("card-fm-close-acted", "close");
  tasks.close(actedCloseDecision.id, {
    status: "done",
    reason: "answered",
    actor: "captain",
    text: 'chose "Open settings"',
  });

  cards.upsert({
    id: "card-fm-close-dismissed",
    author: "firstmate",
    priority: 2,
    title: "Taskless dismissed close",
    meta: "",
    body: "<p>Open settings.</p>",
    actions: [
      {
        id: "close",
        label: "Open settings",
        default: true,
        effect: { kind: "open", target: "settings" },
      },
    ],
    status: "ready",
    createdAt: 33,
  });
  const dismissedCloseDecision = tasks.fileDecision({
    id: "decision-close-dismissed",
    title: "Taskless dismissed close",
    cardId: "card-fm-close-dismissed",
    actor: "firstmate",
  });
  cards.resolve("card-fm-close-dismissed", "close");
  tasks.close(dismissedCloseDecision.id, {
    status: "dropped",
    reason: "cancelled",
    actor: "captain",
    text: "dismissed without a choice",
  });

  cards.upsert({
    id: "card-fm-withdrawn-acted",
    author: "firstmate",
    priority: 2,
    title: "Declared withdrawn action",
    meta: "",
    body: "<p>Open settings.</p>",
    actions: [
      {
        id: "withdrawn",
        label: "Open settings",
        default: true,
        effect: { kind: "open", target: "settings" },
      },
    ],
    status: "ready",
    createdAt: 34,
  });
  const actedWithdrawnDecision = tasks.fileDecision({
    id: "decision-withdrawn-acted",
    title: "Declared withdrawn action",
    cardId: "card-fm-withdrawn-acted",
    actor: "firstmate",
  });
  cards.resolve("card-fm-withdrawn-acted", "withdrawn");
  tasks.close(actedWithdrawnDecision.id, {
    status: "done",
    reason: "answered",
    actor: "captain",
    text: 'chose "Open settings"',
  });

  cards.upsert({
    id: "card-fm-withdrawn-retired",
    author: "firstmate",
    priority: 2,
    title: "Retired withdrawn action",
    meta: "",
    body: "<p>Open settings.</p>",
    actions: [
      {
        id: "withdrawn",
        label: "Open settings",
        default: true,
        effect: { kind: "open", target: "settings" },
      },
    ],
    status: "ready",
    createdAt: 35,
  });
  const retiredWithdrawnDecision = tasks.fileDecision({
    id: "decision-withdrawn-retired",
    title: "Retired withdrawn action",
    cardId: "card-fm-withdrawn-retired",
    actor: "firstmate",
  });
  cards.resolve("card-fm-withdrawn-retired", "withdrawn");
  tasks.close(retiredWithdrawnDecision.id, {
    status: "dropped",
    reason: "superseded",
    actor: "firstmate",
    text: "withdrawn as obsolete",
  });

  cards.upsert({
    id: "card-fm-closed-acted",
    author: "firstmate",
    priority: 2,
    title: "Declared closed action",
    meta: "",
    body: "<p>Open subscriptions.</p>",
    actions: [
      {
        id: "closed",
        label: "Open subscriptions",
        default: true,
        effect: { kind: "open", target: "subscriptions" },
      },
    ],
    status: "ready",
    createdAt: 36,
  });
  const actedClosedDecision = tasks.fileDecision({
    id: "decision-closed-acted",
    title: "Declared closed action",
    cardId: "card-fm-closed-acted",
    actor: "firstmate",
  });
  cards.resolve("card-fm-closed-acted", "closed");
  tasks.close(actedClosedDecision.id, {
    status: "dropped",
    reason: "superseded",
    actor: "captain",
    text: 'chose "Open subscriptions"',
  });

  cards.upsert({
    id: "card-fm-closed-retired",
    author: "firstmate",
    priority: 2,
    title: "Retired closed action",
    meta: "",
    body: "<p>Open subscriptions.</p>",
    actions: [
      {
        id: "closed",
        label: "Open subscriptions",
        default: true,
        effect: { kind: "open", target: "subscriptions" },
      },
    ],
    status: "ready",
    createdAt: 37,
  });
  const retiredClosedDecision = tasks.fileDecision({
    id: "decision-closed-retired",
    title: "Retired closed action",
    cardId: "card-fm-closed-retired",
    actor: "firstmate",
  });
  cards.resolve("card-fm-closed-retired", "closed");
  tasks.close(retiredClosedDecision.id, {
    status: "dropped",
    reason: "superseded",
    actor: "firstmate",
    text: "withdrawn as obsolete",
  });

  cards.upsert({
    id: "card-fm-withdrawn",
    author: "firstmate",
    priority: 2,
    title: "Withdrawn proposal",
    meta: "",
    body: "<p>Obsolete.</p>",
    actions: [{ id: "proceed", label: "Proceed", default: true }],
    status: "ready",
    createdAt: 34,
  });
  const withdrawnDecision = tasks.fileDecision({
    id: "decision-withdrawn",
    title: "Withdrawn proposal",
    cardId: "card-fm-withdrawn",
    actor: "firstmate",
  });
  cards.resolve("card-fm-withdrawn", "proceed");
  tasks.close(withdrawnDecision.id, {
    status: "dropped",
    reason: "superseded",
    actor: "firstmate",
    text: "withdrawn as obsolete",
  });

  cards.upsert({
    id: "card-t-work-title",
    taskId: "t-work",
    author: "crewmate",
    priority: 2,
    title: "Title-only historical result",
    meta: "",
    body: "<p>Choose.</p>",
    actions: [{ id: "accept", label: "Accept", default: true }],
    status: "ready",
    createdAt: 35,
  });
  tasks.recordCardRaised("t-work", {
    cardId: "card-t-work-title",
    kind: "decision",
    title: "Title-only historical result",
  });
  cards.resolve("card-t-work-title", "accept");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-title",
    title: "Title-only historical result",
    action: "accept",
    actor: "captain",
  });

  const credentialTitle = `Credential API_KEY=${PLANTED.lineageTitle}`;
  cards.upsert({
    id: "card-t-work-credential-title",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: credentialTitle,
    meta: "",
    body: "<p>Original credential-bearing evidence.</p>",
    actions: [{ id: "review-credential", label: "Review", default: true }],
    status: "ready",
    createdAt: 38,
  });
  tasks.recordCardRaised("t-work", {
    cardId: "card-t-work-credential-title",
    kind: "decision",
    title: credentialTitle,
  });
  cards.revise({
    id: "card-t-work-credential-title",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: credentialTitle,
    meta: "",
    body: "<p>Revised credential-bearing evidence.</p>",
    actions: [
      {
        id: "merge-credential",
        label: "Merge",
        default: true,
        effect: { kind: "settle", mode: "merge" },
      },
    ],
    status: "ready",
    createdAt: 38,
  });
  cards.resolve("card-t-work-credential-title", "merge-credential");
  tasks.recordCardResolved("t-work", {
    cardId: "card-t-work-credential-title",
    title: credentialTitle,
    action: "merge-credential",
    actor: "captain",
  });
  db.prepare("UPDATE card_revisions SET created_at = 38, replaced_at = 40 WHERE card_id = ?").run(
    "card-t-work-credential-title",
  );
  db.prepare("UPDATE cards SET resolved_at = 50 WHERE id = ?").run("card-t-work-credential-title");

  cards.upsert({
    id: "card-fm-result-credential",
    taskId: "t-work",
    author: "firstmate",
    priority: 2,
    title: "Credential result card",
    meta: "",
    body: "<p>Result carried a credential.</p>",
    actions: [
      {
        id: "open-result",
        label: "Open settings",
        default: true,
        effect: { kind: "open", target: "settings" },
      },
    ],
    status: "ready",
    createdAt: 39,
  });
  tasks.recordCardRaised("t-work", {
    cardId: "card-fm-result-credential",
    kind: "decision",
    title: "Credential result card",
  });
  cards.resolve("card-fm-result-credential", "open-result");
  tasks.recordCardResolved("t-work", {
    cardId: "card-fm-result-credential",
    title: "Credential result card",
    action: "open-result",
    actor: "captain",
  });

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

type DispatchRow = {
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

// Every case runs the real exporter over a freshly built fixture, and the
// card cases run it again over a second one - honest work that outgrows the
// 5s default on a loaded machine (they timed out at load average 40+), so
// the suite states its own budget.
describe("corpus export - the R1 corrections", { timeout: 30_000 }, () => {
  let dir: string;
  let out: string;
  let dispatch: DispatchRow[];
  let raw: { dispatch: string; supervision: string; manifest: string };
  let manifest: {
    dispatch: {
      records: number;
      by_class: Record<string, number>;
      by_contract_version: Record<string, number>;
      unknown_intent: number;
      excluded: { backup_copies: string[]; backup_records: number; copied_entries: number };
    };
    rigor: {
      dispatches: number;
      by_rigor: Record<string, number>;
      reviews: number;
      by_verdict: Record<string, number>;
      by_risk: Record<string, number>;
      reviewed_changes: number;
      cap_hits: number;
      overrides_by_hold: Record<string, number>;
      metrics: Record<string, number | null>;
    };
    exporter_contract_version: string;
  };

  let template: string;
  let fixtureClock: number;
  let fixtureEntryId: number;

  beforeAll(() => {
    entryId = 0;
    clock = Date.parse("2026-09-10T09:00:00.000Z");
    template = scratchDir("infinitary-r1-template-");
    dir = template;
    buildFixture(dir);
    fixtureClock = clock;
    fixtureEntryId = entryId;
    out = join(dir, "corpus");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      // The real CLI, over the fixture userData.
      expect(main(["--out", out, "--user-data", dir], { isPackaged: false })).toBe(0);
    } finally {
      stderr.mockRestore();
    }
    raw = {
      dispatch: readFileSync(join(out, "dispatch.jsonl"), "utf8"),
      supervision: readFileSync(join(out, "supervision.jsonl"), "utf8"),
      manifest: readFileSync(join(out, "manifest.json"), "utf8"),
    };
  });

  afterAll(() => rmSync(template, { recursive: true, force: true }));

  beforeEach(() => {
    // Export the full immutable corpus once. Each mutation still runs the real
    // CLI against its own filesystem/database, never a shared writable input.
    dir = scratchDir("infinitary-r1-");
    cpSync(template, dir, { recursive: true });
    // Fork headers contain an absolute parent path. Rebase that link too, so
    // a mutation of the copied parent cannot reach the shared template.
    const forkPath = join(dir, "firstmate", "sessions", "2026-09-11T10-00-00-000Z_sess-fork.jsonl");
    const [header, ...entries] = readFileSync(forkPath, "utf8").split("\n");
    const fork = JSON.parse(header ?? "") as { parentSession: string };
    fork.parentSession = join(dir, relative(template, fork.parentSession));
    writeFileSync(forkPath, [JSON.stringify(fork), ...entries].join("\n"));
    out = join(dir, "corpus");
    clock = fixtureClock;
    entryId = fixtureEntryId;
    dispatch = raw.dispatch
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as DispatchRow);
    manifest = JSON.parse(raw.manifest);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const turnSaying = (needle: string): DispatchRow => {
    const row = dispatch.find((record) => record.user?.includes(needle));
    if (!row) throw new Error(`no turn saying ${needle}`);
    return row;
  };

  const exportCardCase = (
    user: string,
    cardId: string,
    title: string,
    args: Record<string, unknown>,
    includeResultId = true,
    resultText?: string,
  ): DispatchRow => {
    const session = `${[
      JSON.stringify({ type: "session", version: 3, id: `case-${cardId}`, timestamp: nextStamp() }),
      userEntry(`${CONTEXT}\n\n[user]\n${user}`),
      assistantEntry("", [{ id: `call-${cardId}`, name: "emit_card", args }]),
      toolResultEntry(
        `call-${cardId}`,
        resultText ??
          (includeResultId ? `Card shown: ${title} (${cardId})` : `Card shown: ${title}`),
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
  };

  const exportRevisionCase = (): { early: DispatchRow; current: DispatchRow } => {
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
  };

  it("keeps an operational drain operational, and preserves the wake it carried", () => {
    const ops = dispatch.filter((record) => record.kind === "op");
    expect(ops).toHaveLength(2);
    const drain = ops.find((record) => record.ops.includes(FAILED_WAKE));
    expect(drain).toBeDefined();
    // The wake is carried verbatim, not folded into the context blob.
    expect(drain?.ops).toEqual([FAILED_WAKE]);
    expect(drain?.user).toBeNull();
    expect(drain?.context).toContain("[fm-op] context (not the user)");
    expect(drain?.context).not.toContain("failed: provider timeout");
    expect(drain?.observed_class).toBe("steer");
    // No captain turn may claim the drain's words.
    expect(dispatch.some((record) => record.kind === "user" && record.user === "")).toBe(false);
  });

  it("does not invent captain input from a user marker quoted by a wake", () => {
    const row = dispatch.find((record) => record.ops.includes(QUOTED_USER_MARKER_WAKE));
    expect(row).toBeDefined();
    expect(row?.kind).toBe("op");
    expect(row?.user).toBeNull();
    expect(row?.ops).toEqual([QUOTED_USER_MARKER_WAKE]);
    expect(row?.kind_unknown).toBe(true);
    expect(row?.kind_basis).toBe("ambiguous-framing");
    expect(row?.framing_ambiguity).toBe("user-boundary");
    expect(row?.label).toMatchObject({ gold_class: null, unknown: true });
    expect(row?.framed_text).toBe(
      `${CONTEXT.replace(PLANTED.contextLine, "Bearer [redacted]")}\n\n${QUOTED_USER_MARKER_WAKE}`,
    );
  });

  it("reads a captain turn that carried pending wakes as mixed, keeping both halves", () => {
    const mixed = turnSaying("What is going on with the rollout?");
    expect(mixed.kind).toBe("mixed");
    expect(mixed.ops).toEqual([GATE_WAKE]);
    expect(mixed.user).toBe("What is going on with the rollout?");
    expect(mixed.context).toContain("repos:");
    // `emote` is auxiliary: it neither carries a class nor makes the turn
    // unclassifiable, so reading alone still reads as the answer it was.
    expect(mixed.observed_class).toBe("answer");
  });

  it("preserves an fm-op paragraph inside the captain's words", () => {
    const row = turnSaying("Analyze this:");
    expect(row.kind).toBe("user");
    expect(row.ops).toEqual([]);
    expect(row.user).toBe("Analyze this:\n\n[fm-op] sample log from the captain.");
    expect(row.kind_unknown).toBe(false);
  });

  it("keeps an ambiguous fm-op paragraph inside context", () => {
    const row = turnSaying("What did the note say?");
    expect(row.kind).toBe("user");
    expect(row.ops).toEqual([]);
    expect(row.context).toContain("[fm-op] pasted note text\nstill context");
    expect(row.ambiguous_wakes).toEqual([
      expect.stringContaining("[fm-op] pasted note text\nstill context"),
    ]);
    expect(row.kind_basis).toBe("ambiguous-context");
    expect(row.kind_unknown).toBe(true);
  });

  it("keeps post-self-source title text in ambiguous context", () => {
    const row = turnSaying("What title is open?");
    expect(row.kind).toBe("user");
    expect(row.ops).toEqual([]);
    expect(row.context).toContain('[fm-op] text embedded after self-source"');
    expect(row.ambiguous_wakes).toEqual([
      expect.stringContaining('[fm-op] text embedded after self-source"'),
    ]);
    expect(row.kind_basis).toBe("ambiguous-context");
    expect(row.kind_unknown).toBe(true);
  });

  it("preserves captain whitespace after the user boundary", () => {
    const row = dispatch.find((record) => record.user === "  pasted sample  ");
    expect(row).toBeDefined();
    expect(row?.kind).toBe("mixed");
    expect(row?.context).toContain("repos:  \n");
    expect(row?.ops).toEqual([WHITESPACE_WAKE]);
    expect(row?.user).toBe("  pasted sample  ");
  });

  it("joins the current decision to the work it is about, through the record's own timeline", () => {
    const asked = turnSaying("Is it ready?");
    const [card] = asked.outcome.cards;
    expect(card).toMatchObject({
      card_id: "card-t-work-1",
      task_id: "t-work",
      task_via: "task-event",
      resolution: "acted",
      resolved_by: "captain",
    });
    // The work rides the record too, not just the card id.
    expect(asked.outcome.tasks.map((task) => task.task_id)).toContain("t-work");
    expect(asked.outcome.tasks.every((task) => task.found)).toBe(true);
    // A row dispatched before delivery rigor existed (no shape, or a shape
    // with no rigor) exports as the quick work it was, never as unknown
    // (delivery rigor phase 2).
    const work = asked.outcome.tasks.find((task) => task.task_id === "t-work");
    expect(work?.rigor).toBe("quick");
    // ...and carries no review facts, because none were ever recorded on
    // it: null, never a guessed verdict (delivery rigor phase 3).
    expect(work).toMatchObject({ review_of: null, review_verdict: null, review_risk: null });
  });

  it("carries the review facts on a reviewed builder and the builder on its review task (phase 3)", () => {
    const asked = turnSaying("Where does the meter review stand?");
    const builder = asked.outcome.tasks.find((task) => task.task_id === "t-build");
    const review = asked.outcome.tasks.find((task) => task.task_id === "t-review");
    expect(builder).toMatchObject({
      found: true,
      rigor: "reviewed",
      review_of: null,
      review_verdict: "findings",
      review_risk: "medium",
    });
    expect(review).toMatchObject({
      found: true,
      rigor: "quick",
      review_of: "t-build",
      review_verdict: null,
      review_risk: null,
    });
  });

  it("resolves credential-bearing card lineage before redacting the finished record", () => {
    const credentialTitle = `Credential API_KEY=${PLANTED.lineageTitle}`;
    const args = {
      task_id: "t-work",
      title: credentialTitle,
      body: "<p>Revised credential-bearing evidence.</p>",
      actions: [
        {
          id: "merge-credential",
          label: "Merge",
          default: true,
          effect: { kind: "settle", mode: "merge" },
        },
      ],
    };
    const byId = exportCardCase(
      "Show the credential-title card by id.",
      "card-t-work-credential-title",
      credentialTitle,
      args,
    );
    expect(byId.outcome.cards[0]).toMatchObject({
      card_id: "card-t-work-credential-title",
      found: true,
      joined_via: "tool-result-id",
      task_id: "t-work",
      revisions: 1,
      actions: [{ id: "merge-credential", effect: { kind: "settle", mode: "merge" } }],
      resolution: "acted",
      captain_contact: "settle",
    });

    const byTitle = exportCardCase(
      "Show the credential-title card without an id.",
      "card-t-work-credential-title",
      credentialTitle,
      args,
      false,
    );
    expect(byTitle.outcome.cards[0]).toMatchObject({
      card_id: "card-t-work-credential-title",
      found: true,
      joined_via: "title",
      task_id: "t-work",
      revisions: 1,
      resolution: "acted",
    });

    const resultCredential = exportCardCase(
      "Recover the id after a credential-bearing result.",
      "card-fm-result-credential",
      "Credential result card",
      {
        task_id: "t-work",
        title: "Credential result card",
        body: "<p>Result carried a credential.</p>",
        actions: [
          {
            id: "open-result",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
      true,
      `Card shown: Authorization: Bearer ${PLANTED.lineageResult} (card-fm-result-credential)`,
    );
    expect(resultCredential.outcome.cards[0]).toMatchObject({
      card_id: "card-fm-result-credential",
      found: true,
      joined_via: "tool-result-id",
      task_id: "t-work",
      actions: [{ id: "open-result", effect: { kind: "open", target: "settings" } }],
      resolution: "acted",
      captain_contact: "open",
    });

    for (const cardId of ["card-t-work-credential-title", "card-fm-result-credential"]) {
      const exported = readFileSync(join(dir, `corpus-${cardId}`, "dispatch.jsonl"), "utf8");
      expect(exported).not.toContain(PLANTED.lineageTitle);
      expect(exported).not.toContain(PLANTED.lineageResult);
      expect(exported).toContain("[redacted");
    }
  });

  it("reads a settle effect as a settle, never as a steer", () => {
    const [card] = turnSaying("Is it ready?").outcome.cards;
    expect(card?.chosen_action).toBe("merge-pr");
    expect(card?.chosen_effect).toMatchObject({ kind: "settle", mode: "merge" });
    expect(card?.captain_contact).toBe("settle");
    expect(raw.dispatch).not.toContain('"captain_contact":"steer"');
    // The supervision half reads the same card the same way.
    const escalations = raw.supervision
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { card: { captain_contact?: string } | null });
    expect(escalations[0]?.card?.captain_contact).toBe("settle");
  });

  it("separates the escalation shape from the resolution-time action shape", () => {
    const records = raw.supervision
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            card: {
              card_id: string;
              title?: string;
              body?: string;
              decision?: boolean;
              actions?: Array<{ id?: string }>;
              description_version?: {
                requested_at: number;
                selected_at: number | null;
                basis: string;
                fallback: string | null;
              };
              resolution_actions?: Array<{
                id?: string;
                effect?: { kind?: string; mode?: string };
              }>;
              resolution_version?: {
                requested_at: number | null;
                selected_at: number | null;
                basis: string;
              };
              chosen_effect?: { kind?: string; mode?: string } | null;
              captain_contact?: string;
              resolution?: string;
            } | null;
            label: {
              confidence: string;
              unknown: boolean;
              basis: string;
              evidence: string[];
            };
          },
      );
    const byCard = new Map(records.map((record) => [record.card?.card_id, record]));

    const revised = byCard.get("card-t-work-supervision-revised");
    expect(revised?.card).toMatchObject({
      title: "Original escalation",
      body: "<p>Original evidence.</p>",
      decision: false,
      actions: [],
      description_version: {
        requested_at: 50,
        selected_at: 50,
        basis: "revision",
        fallback: null,
      },
      resolution_actions: [{ id: "merge-revised", effect: { kind: "settle", mode: "merge" } }],
      resolution_version: { requested_at: 70, selected_at: 70, basis: "current" },
      chosen_effect: { kind: "settle", mode: "merge" },
      resolution: "acted",
    });
    expect(revised?.label).toMatchObject({
      confidence: "corroborated",
      unknown: false,
      basis: "card-resolution",
    });
    expect(revised?.label.evidence).toEqual([
      expect.stringContaining("showed a note; its resolution-time decision was answered"),
    ]);

    expect(byCard.get("card-t-work-1")?.card?.description_version).toEqual({
      requested_at: 19,
      selected_at: 20,
      basis: "current",
      fallback: "creation",
    });

    const open = byCard.get("card-t-work-supervision-open");
    expect(open?.card).toMatchObject({
      title: "Open escalation",
      actions: [{ id: "answer" }],
      resolution: "open",
      resolution_version: { requested_at: null, selected_at: null, basis: "open" },
      chosen_effect: null,
      captain_contact: "none",
    });
    expect(open?.card?.resolution_actions).toBeUndefined();
  });

  it("never reads an emitter's withdrawal as the captain's dismissal", () => {
    const [card] = turnSaying("Anything else?").outcome.cards;
    expect(card).toMatchObject({ resolution: "retired", resolved_by: "firstmate" });
    const escalations = raw.supervision
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { label: { confidence: string } });
    // A withdrawn card contradicts nothing: nobody ever answered it.
    expect(escalations[1]?.label.confidence).toBe("observed");
  });

  it("reads current colliding action ids only by their declared effect", () => {
    const row = exportCardCase(
      "Use the current action.",
      "card-t-work-3",
      "Current free-form action",
      {
        task_id: "t-work",
        title: "Current free-form action",
        body: "<p>Choose.</p>",
        actions: [{ id: "open-settings", label: "Send this guidance", default: true }],
      },
    );
    const [card] = row.outcome.cards;
    expect(card).toMatchObject({
      chosen_action: "open-settings",
      chosen_effect: null,
      effect_source: null,
      author: "firstmate",
      captain_contact: "none",
    });

    const crewRow = exportCardCase(
      "Use the crewmate action.",
      "card-t-work-6",
      "Crewmate free-form action",
      {
        task_id: "t-work",
        title: "Crewmate free-form action",
        body: "<p>Choose.</p>",
        actions: [{ id: "use-postgres", label: "Use Postgres", default: true }],
      },
    );
    expect(crewRow.outcome.cards[0]).toMatchObject({
      chosen_action: "use-postgres",
      chosen_effect: null,
      effect_source: null,
      author: "crewmate",
      captain_contact: "steer",
    });
  });

  it("uses the card version each emit turn actually showed", () => {
    const { early, current } = exportRevisionCase();
    expect(early.outcome.cards[0]).toMatchObject({
      card_id: "card-t-work-revised",
      joined_via: "title",
      actions_version: "revision",
      body: "<p>Original choice.</p>",
      actions: [{ id: "choose-a" }],
      resolution: "retired",
      captain_contact: "withdrawn",
    });
    expect(current.outcome.cards[0]).toMatchObject({
      joined_via: "tool-result-id",
      actions_version: "current",
      body: "<p>Current choice.</p>",
      actions: [{ id: "merge-current", effect: { kind: "settle", mode: "merge" } }],
      resolution: "acted",
      chosen_effect: { kind: "settle", mode: "merge" },
      captain_contact: "settle",
    });
  });

  it("lets a current declared close action outrank the chrome dismissal id", () => {
    const row = exportCardCase(
      "Use the declared close action.",
      "card-t-work-close",
      "Current close action",
      {
        task_id: "t-work",
        title: "Current close action",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "close",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(row.outcome.cards[0]).toMatchObject({
      chosen_action: "close",
      resolution: "acted",
      chosen_effect: { kind: "open", target: "settings" },
      captain_contact: "open",
    });
  });

  it("distinguishes a declared close action from chrome dismissal", () => {
    const dismissed = exportCardCase(
      "Dismiss the close-action card.",
      "card-t-work-close-dismissed",
      "Dismissed close action",
      {
        task_id: "t-work",
        title: "Dismissed close action",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "close",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(dismissed.outcome.cards[0]).toMatchObject({
      chosen_action: "close",
      resolution: "dismissed",
      chosen_effect: null,
      captain_contact: "dismissed",
    });
    expect(dismissed.label.confidence).toBe("contradicted");

    const acted = exportCardCase(
      "Use the taskless close action.",
      "card-fm-close-acted",
      "Taskless close action",
      {
        standalone: true,
        title: "Taskless close action",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "close",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(acted.outcome.cards[0]).toMatchObject({
      chosen_action: "close",
      resolution: "acted",
      resolved_by: "captain",
      chosen_effect: { kind: "open", target: "settings" },
      captain_contact: "open",
    });

    const tasklessDismissed = exportCardCase(
      "Dismiss the taskless close action.",
      "card-fm-close-dismissed",
      "Taskless dismissed close",
      {
        standalone: true,
        title: "Taskless dismissed close",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "close",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(tasklessDismissed.outcome.cards[0]).toMatchObject({
      chosen_action: "close",
      resolution: "dismissed",
      resolved_by: "captain",
      chosen_effect: null,
      captain_contact: "dismissed",
    });
  });

  it("lets current declared sentinel ids outrank their host meanings", () => {
    const dismissedAction = exportCardCase(
      "Use the declared dismissed action.",
      "card-t-work-dismissed-action",
      "Declared dismissed action",
      {
        task_id: "t-work",
        title: "Declared dismissed action",
        body: "<p>Open subscriptions.</p>",
        actions: [
          {
            id: "dismissed",
            label: "Open subscriptions",
            default: true,
            effect: { kind: "open", target: "subscriptions" },
          },
        ],
      },
    );
    expect(dismissedAction.outcome.cards[0]).toMatchObject({
      chosen_action: "dismissed",
      resolution: "acted",
      chosen_effect: { kind: "open", target: "subscriptions" },
      captain_contact: "open",
    });

    const chromeDismissed = exportCardCase(
      "Dismiss the declared dismissed action.",
      "card-t-work-dismissed-chrome",
      "Chrome-dismissed declared action",
      {
        task_id: "t-work",
        title: "Chrome-dismissed declared action",
        body: "<p>Open subscriptions.</p>",
        actions: [
          {
            id: "dismissed",
            label: "Open subscriptions",
            default: true,
            effect: { kind: "open", target: "subscriptions" },
          },
        ],
      },
    );
    expect(chromeDismissed.outcome.cards[0]).toMatchObject({
      chosen_action: "close",
      resolution: "dismissed",
      chosen_effect: null,
      captain_contact: "dismissed",
    });

    const withdrawnAction = exportCardCase(
      "Use the declared withdrawn action.",
      "card-fm-withdrawn-acted",
      "Declared withdrawn action",
      {
        standalone: true,
        title: "Declared withdrawn action",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "withdrawn",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(withdrawnAction.outcome.cards[0]).toMatchObject({
      chosen_action: "withdrawn",
      resolution: "acted",
      chosen_effect: { kind: "open", target: "settings" },
      captain_contact: "open",
    });

    const retiredWithdrawn = exportCardCase(
      "Withdraw the declared withdrawn action.",
      "card-fm-withdrawn-retired",
      "Retired withdrawn action",
      {
        standalone: true,
        title: "Retired withdrawn action",
        body: "<p>Open settings.</p>",
        actions: [
          {
            id: "withdrawn",
            label: "Open settings",
            default: true,
            effect: { kind: "open", target: "settings" },
          },
        ],
      },
    );
    expect(retiredWithdrawn.outcome.cards[0]).toMatchObject({
      chosen_action: "withdrawn",
      resolution: "retired",
      chosen_effect: null,
      captain_contact: "withdrawn",
    });

    const closedAction = exportCardCase(
      "Use the taskless declared closed action.",
      "card-fm-closed-acted",
      "Declared closed action",
      {
        standalone: true,
        title: "Declared closed action",
        body: "<p>Open subscriptions.</p>",
        actions: [
          {
            id: "closed",
            label: "Open subscriptions",
            default: true,
            effect: { kind: "open", target: "subscriptions" },
          },
        ],
      },
    );
    expect(closedAction.outcome.cards[0]).toMatchObject({
      chosen_action: "closed",
      resolution: "acted",
      resolved_by: "captain",
      chosen_effect: { kind: "open", target: "subscriptions" },
      captain_contact: "open",
    });

    const retiredClosed = exportCardCase(
      "Withdraw the taskless declared closed action.",
      "card-fm-closed-retired",
      "Retired closed action",
      {
        standalone: true,
        title: "Retired closed action",
        body: "<p>Open subscriptions.</p>",
        actions: [
          {
            id: "closed",
            label: "Open subscriptions",
            default: true,
            effect: { kind: "open", target: "subscriptions" },
          },
        ],
      },
    );
    expect(retiredClosed.outcome.cards[0]).toMatchObject({
      chosen_action: "closed",
      resolution: "retired",
      resolved_by: "firstmate",
      chosen_effect: null,
      captain_contact: "withdrawn",
    });
  });

  it("lets current declared actions outrank withdrawal-shaped ids", () => {
    const landed = exportCardCase(
      "Use the declared landed action.",
      "card-t-work-landed-action",
      "Current landed action",
      {
        task_id: "t-work",
        title: "Current landed action",
        body: "<p>Land this work.</p>",
        actions: [
          {
            id: "landed",
            label: "Land",
            default: true,
            effect: { kind: "settle", mode: "merge" },
          },
        ],
      },
    );
    expect(landed.outcome.cards[0]).toMatchObject({
      chosen_action: "landed",
      resolution: "acted",
      chosen_effect: { kind: "settle", mode: "merge" },
      captain_contact: "settle",
    });

    const closed = exportCardCase(
      "Use the declared closed action.",
      "card-t-work-closed-action",
      "Current closed action",
      {
        task_id: "t-work",
        title: "Current closed action",
        body: "<p>Send guidance.</p>",
        actions: [{ id: "closed", label: "Send guidance", default: true }],
      },
    );
    expect(closed.outcome.cards[0]).toMatchObject({
      chosen_action: "closed",
      resolution: "acted",
      chosen_effect: null,
      author: "crewmate",
      captain_contact: "steer",
    });

    const bare = exportCardCase(
      "Show the bare landed withdrawal.",
      "card-t-work-bare-landed",
      "Bare landed withdrawal",
      {
        task_id: "t-work",
        title: "Bare landed withdrawal",
        body: "<p>Withdrawn.</p>",
      },
    );
    expect(bare.outcome.cards[0]).toMatchObject({
      chosen_action: "landed",
      resolution: "retired",
      chosen_effect: null,
      captain_contact: "withdrawn",
    });
  });

  it("reads a legacy keep action as a close control, never a steer", () => {
    const row = exportCardCase(
      "Read the historical close control.",
      "card-t-work-legacy-keep",
      "Historical keep control",
      {
        kind: "decision",
        task_id: "t-work",
        title: "Historical keep control",
        body: "<p>Old decision.</p>",
        actions: [{ id: "keep", label: "Keep", default: true }],
      },
    );
    expect(row.outcome.cards[0]).toMatchObject({
      chosen_action: "keep",
      resolution: "dismissed",
      chosen_effect: null,
      captain_contact: "dismissed",
    });
  });

  it("preserves legacy interpretation only for source-proven historical cards", () => {
    const row = exportCardCase(
      "Read the historical action.",
      "card-t-work-4",
      "Historical reserved action",
      {
        kind: "decision",
        task_id: "t-work",
        title: "Historical reserved action",
        body: "<p>Choose.</p>",
        actions: [{ id: "open-settings", label: "Open settings", default: true }],
      },
    );
    const [card] = row.outcome.cards;
    expect(card).toMatchObject({
      chosen_action: "open-settings",
      chosen_effect: { kind: "open", target: "settings" },
      effect_source: "legacy-id",
      captain_contact: "open",
    });
  });

  it("keeps a captain-confirmed duplicate closure as a withdrawal", () => {
    const row = exportCardCase("Show the repeated note.", "card-t-work-5", "Repeated note", {
      task_id: "t-work",
      title: "Repeated note",
      body: "<p>This repeats an earlier card.</p>",
    });
    const [card] = row.outcome.cards;
    expect(card).toMatchObject({
      chosen_action: "duplicate",
      resolution: "retired",
      resolved_by: "captain",
      captain_contact: "withdrawn",
    });
  });

  it("uses a taskless card's linked decision actor", () => {
    const row = exportCardCase(
      "Show the withdrawn proposal.",
      "card-fm-withdrawn",
      "Withdrawn proposal",
      {
        standalone: true,
        title: "Withdrawn proposal",
        body: "<p>Obsolete.</p>",
        actions: [{ id: "proceed", label: "Proceed", default: true }],
      },
    );
    expect(row.outcome.cards[0]).toMatchObject({
      chosen_action: "proceed",
      resolution: "retired",
      resolved_by: "firstmate",
      captain_contact: "withdrawn",
    });
  });

  it("reports title provenance independently from task-event provenance", () => {
    const row = exportCardCase(
      "Show the title-only result.",
      "card-t-work-title",
      "Title-only historical result",
      {
        task_id: "t-work",
        title: "Title-only historical result",
        body: "<p>Choose.</p>",
        actions: [{ id: "accept", label: "Accept", default: true }],
      },
      false,
    );
    expect(row.outcome.cards[0]).toMatchObject({
      card_id: "card-t-work-title",
      joined_via: "title",
      task_id: "t-work",
      task_via: "task-event",
    });
  });

  it("keeps a card-shape class explicitly weak, with no gold intent", () => {
    const asked = turnSaying("Is it ready?");
    expect(asked.observed_class).toBe("ask");
    expect(asked.label).toMatchObject({ gold_class: null, unknown: true, basis: "card-shape" });
    expect(asked.label.evidence.join(" ")).toContain("no gold intent");
    // A turn that exercised a move keeps its (still weak) gold class.
    const spawn = turnSaying("Get the nimbus fix shipped.");
    expect(spawn.label).toMatchObject({ gold_class: "spawn", unknown: false, basis: "tool" });
    expect(manifest.dispatch.unknown_intent).toBeGreaterThan(0);
  });

  it(`excludes the backup copies of the sessions directory - exactly ${BACKUP_TURNS} turns`, () => {
    // What a run that read every file on disk would have counted.
    const onDisk = dispatch.length + manifest.dispatch.excluded.backup_records;
    expect(manifest.dispatch.excluded.backup_records).toBe(BACKUP_TURNS);
    expect(onDisk - dispatch.length).toBe(BACKUP_TURNS);
    expect(manifest.dispatch.excluded.backup_copies).toHaveLength(1);
    expect(manifest.dispatch.excluded.backup_copies[0]).toContain("sessions-backup");
    // And no turn is in the corpus twice.
    const ids = dispatch.map((record) => `${record.kind}:${record.user}:${record.ops.join()}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reads a forked session's copied history once, as history", () => {
    expect(manifest.dispatch.excluded.copied_entries).toBeGreaterThan(0);
    expect(dispatch.filter((row) => row.user === "Get the nimbus fix shipped.")).toHaveLength(1);
    const fork = turnSaying("Carry on from the fork.");
    expect(fork.contract).toEqual({ version: "1.1", prompt_sha: "sha-old" });
    expect(fork.model).toBe("xai/grok-4.6");
  });

  it("keeps every input at the contract version it was recorded under", () => {
    const stamped = turnSaying("Is it ready?");
    expect(stamped.contract).toEqual({ version: "1.1", prompt_sha: "sha-old" });
    const unstamped = turnSaying("Old question.");
    expect(unstamped.contract).toBeNull();
    // The version this checkout serves is reported once, as the exporter's
    // own, and is never stamped onto a historical turn.
    expect(manifest.exporter_contract_version).toBe(FIRSTMATE_CONTRACT_VERSION);
    expect(manifest.dispatch.by_contract_version.unstamped).toBeGreaterThan(0);
    expect(manifest.dispatch.by_contract_version["1.1"]).toBeGreaterThan(0);
    expect(manifest.dispatch.by_contract_version[FIRSTMATE_CONTRACT_VERSION]).toBeUndefined();
    expect(raw.dispatch).not.toContain(`"version":"${FIRSTMATE_CONTRACT_VERSION}"`);
  });

  it("rolls up how carefully the fleet shipped, scored by the one home (phase 4)", () => {
    const rigor = manifest.rigor;
    // One shaped row SHIPPED work here, and it shipped reviewed. The review
    // task is shaped too and is deliberately not in the mix: it read that
    // change rather than shipping one, so counting it would count the
    // reading as a shipment.
    expect(rigor.by_rigor).toEqual({ reviewed: 1 });
    expect(rigor.dispatches).toBe(1);
    // One verdict, on one change, with the risk it stated.
    expect(rigor.reviews).toBe(1);
    expect(rigor.by_verdict).toEqual({ findings: 1 });
    expect(rigor.by_risk).toEqual({ medium: 1 });
    expect(rigor.reviewed_changes).toBe(1);
    expect(rigor.cap_hits).toBe(0);
    // Each override the captain's words declared, per hold kind it passed:
    // two declared, one taken back between them (INF-484 move 8).
    expect(rigor.overrides_by_hold).toEqual({ repairs: 2, rounds: 1 });
    // The numbers are the metric module's, not a second implementation: the
    // findings are counted off the reviewer's own report, and the CI rounds
    // are charged to the one direct-pr change that opened a pull request.
    expect(rigor.metrics).toMatchObject({
      rigor_share_reviewed: 1,
      rigor_share_quick: 0,
      review_rounds_per_change: 1,
      review_verdict_share_findings: 1,
      review_verdict_share_pass: 0,
      findings_auto_fix_per_change: 1,
      findings_ask_user_per_change: 1,
      findings_ask_user_rate: 0.5,
      ci_rounds_per_change: 2,
      rigor_cap_hits: 0,
      hold_overrides: 2,
    });
    // No completion card settled anything here, so the evidence question
    // has nothing to answer - never a zero share.
    expect(rigor.metrics.evidence_headings_share).toBeNull();
  });

  it("redacts database joins in the standalone dispatch export", () => {
    const standalone = join(dir, "dispatch-standalone.jsonl");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(extractDispatchMain(["--out", standalone, "--user-data", dir])).toBe(0);
    } finally {
      stderr.mockRestore();
    }
    const text = readFileSync(standalone, "utf8");
    expect(text).not.toContain("PLANTEDFOUR");
    expect(text).not.toContain(PLANTED.structured);
    expect(text).not.toContain(PLANTED.cookie);
    expect(text).not.toContain(PLANTED.session);
    expect(text).not.toContain(PLANTED.privateKey);
    expect(text).toContain("[redacted");
  });

  it("lets no planted credential survive in any exported field", () => {
    for (const [where, secret] of Object.entries(PLANTED)) {
      const marker = secret.replace(
        /^(sk-proj-|ghp_|xai-|sk-ant-api03-|Bearer |AKIA|Authorization: )/,
        "",
      );
      for (const [file, text] of Object.entries(raw)) {
        expect(`${where} in ${file}: ${text.includes(marker) ? "LEAKED" : "clean"}`).toBe(
          `${where} in ${file}: clean`,
        );
      }
    }
    for (const text of Object.values(raw)) {
      expect(text).not.toContain("PLANTEDBEARERNESTED");
      expect(text).not.toContain("PLANTEDBEARERJOINED");
      expect(text).not.toContain("PLANTEDCOOKIENESTED");
      expect(text).not.toContain("PLANTEDCOOKIEJOINED");
      expect(text).not.toContain("PLANTEDCREDENTIALSNESTED");
      expect(text).not.toContain("PLANTEDCREDENTIALJOINED");
      expect(text).not.toContain("PLANTEDOAUTHNESTED");
      expect(text).not.toContain("PLANTEDOAUTHJOINED");
      expect(text).not.toContain("PLANTEDSHELLNESTED");
      expect(text).not.toContain("PLANTEDESCAPEDNESTED");
      expect(text).not.toContain("PLANTEDSHELLJOINED");
    }
    // The redaction happened, rather than the fields being dropped.
    expect(raw.dispatch).not.toContain(`"password":${NUMERIC_SECRET}`);
    expect(raw.dispatch).toContain('"password":"[redacted credential]"');
    expect(raw.dispatch).toContain("[redacted");
    expect(raw.supervision).toContain("[redacted");
  });
});
