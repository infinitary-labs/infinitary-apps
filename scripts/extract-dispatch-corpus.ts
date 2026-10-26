/**
 * C5 - the dispatch extractor (PoC-2 capture; design record
 * `fm3000-poc1-finetune-pivot-board-s1/report.md` §A.1.3).
 *
 * Reconstructs the Firstmate's own six-way classify-first orchestrator turns
 * - the G3 (dispatch class) / G4 (restraint) / G5 (output contract) dataset -
 * from the session JSONL the app already writes, joined to the `tasks`,
 * `repos` and `cards` tables. PoC-1 had to hand-build a 40-record synthetic
 * dispatch corpus; the captain's ordinary usage produces this one for free.
 * A session served by either seat is read through the one Firstmate session
 * reader (`src/core/storage/sessionReader.ts`), which hands a
 * Claude-served session over in the Pi dialect, so everything below reads
 * Pi entries.
 *
 * Offline dev tool: no schema change, no product surface, no telemetry, and
 * nothing leaves the box. Reads are strictly read-only.
 *
 * Run it (Node 24 strips the types):
 *   pnpm extract:dispatch --out corpus.jsonl
 *   pnpm extract:dispatch --user-data /path/to/exported/userData --out corpus.jsonl
 *
 * The live transcripts and firstmate.db live on whichever machine the captain
 * dogfoods on, so every input is a parameter with a sensible default: point
 * `--user-data` at an exported copy and the same run works anywhere.
 */

import { decode } from "@toon-format/toon";
import Database from "better-sqlite3";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { settingFrom } from "../src/shared/envSettings.ts";
import { redactDeep } from "../src/core/observe/redact.ts";
import {
  sessionFilesIn,
  readSession,
} from "../src/core/storage/sessionReader.ts";
import { migrateLegacyActions } from "../src/shared/cards.ts";
import {
  RELEASE_USER_DATA_FOLDER,
  userDataFoldersNewestFirst,
} from "../src/shared/userDataFolders.ts";
import { parseServedInput } from "../src/shared/servedFrame.ts";
import { savedShapeReader } from "../src/core/storage/taskReferenceFields.ts";
import { overrideHoldsFrom, type ReviewEvent, reviewEventFrom } from "./interaction-metrics.ts";

// --------------------------------------------------------------------------
// The contract this extractor reads (src/core/pi/piResources.ts,
// FIRSTMATE_PROMPT_CORE "EVERY TURN, classify first"). A tool decides the
// class it belongs to; query and bookkeeping tools decide nothing.
// --------------------------------------------------------------------------

export type DispatchClass =
  | "answer"
  | "ask"
  | "steer"
  | "spawn"
  | "settle"
  | "operate"
  | "none"
  | "other";

/** Precedence when a turn composes several classes (PoC-1 `inferClass` order).
 * Class 4 is "spawn or plan" since task-system P2: create_task records the
 * same new work spawn_crewmate would start, so it sorts with spawn; the
 * graph edits (update_task, link_tasks) are fleet management, operate. */
const SPAWN_TOOLS = ["spawn_crewmate", "create_task"];
const SETTLE_TOOLS = ["settle_task"];
const STEER_TOOLS = ["steer_crewmate", "interrupt_crewmate"];
const OPERATE_TOOLS = [
  // The action catalog's one change: project setup, settings and removal,
  // theme and panels. The repo tools below are what it replaced; a session
  // recorded before the catalog still names them, so they stay operate.
  "app_change",
  "setup_repo",
  "configure_repo",
  "unregister_repo",
  "schedule_prompt",
  "cancel_schedule",
  "remember",
  "forget",
  "recall_decision",
  "locate_project",
  "update_task",
  "link_tasks",
  // The captain's own surfaces (talk-to-personalize Step 1, contract v2.8):
  // the personalization case of the operate move, and a panel someone else
  // made, which the host then asks the captain about on its own card.
  "personalize",
  "install_plugin",
  // Durable labels the captain asked for, kept like a note: a missed
  // escalation, a card that repeats another, and a fact for the knowledge.
  "flag_missed_escalation",
  "flag_duplicate",
  "record_knowledge",
];
/** Reading: it serves a class, it is never one. A turn that only read has
 * still answered the user out of what it read. `app_state` looks at the
 * action catalog and `knowledge` at what the crew learned; neither changes
 * anything. `integrations` lists what the captain connected and
 * `use_integration` reads through one: a change there waits for the
 * captain's click on a card the host raises, not on the first mate's move
 * (docs/integrations.md). */
const READ_TOOLS = [
  "crew_status",
  "supervision_log",
  "check_pr_ci",
  "tasks",
  "app_state",
  "knowledge",
  "integrations",
  "use_integration",
];
/** Card hygiene: neutral inside any turn, and self-management on its own. */
const BOOKKEEPING_TOOLS = ["close_card"];
/**
 * Auxiliary: the character side channel. `emote` paints a reaction and
 * changes no card, task or consult state (src/core/pi/emoteTool.ts), so it
 * neither carries a class nor makes the turn that used it unclassifiable -
 * it drops out before the class is read, exactly like whitespace.
 */
const AUXILIARY_TOOLS = ["emote"];
const CARD_TOOL = "emit_card";

/**
 * A turn with no class-bearing tool: reading alone is an answer, withdrawing
 * a card alone is an operate, and anything unrecognised stays `other` rather
 * than being forced into a class it did not exercise.
 */
function fallbackClass(names: string[]): DispatchClass {
  const deciding = names.filter((name) => !AUXILIARY_TOOLS.includes(name));
  if (deciding.length === 0) return "none";
  if (!deciding.every((n) => READ_TOOLS.includes(n) || BOOKKEEPING_TOOLS.includes(n)))
    return "other";
  return deciding.some((n) => READ_TOOLS.includes(n)) ? "answer" : "operate";
}

// --------------------------------------------------------------------------
// Pi session JSONL (node_modules/@earendil-works/pi-coding-agent, SessionEntry
// + @earendil-works/pi-ai Message). Observe's parser drops tool arguments and
// truncates results, which is exactly what a dispatch record needs, so this
// reads the raw entries itself and reuses only Observe's redaction.
// --------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

export type ToolCallRecord = {
  name: string;
  args: JsonRecord;
  /** The tool's own reply, matched by toolCallId. */
  result?: { text: string; isError: boolean; at: number | null };
};

export type DispatchTurn = {
  id: string;
  session_id: string | null;
  session_file: string;
  turn_index: number;
  at: number;
  /**
   * What the host actually put in front of the model this turn:
   *
   * - `user`  the captain's words, under the injected context block;
   * - `op`    an operational drain - the context block followed by one or
   *           more `[fm-op]` wakes and no captain words at all;
   * - `mixed` a captain turn that carried pending operational wakes with it
   *           (the wake diet, WI-13: they ride before the `[user]` line).
   *
   * An op drain is NOT a captain turn: it wears the same context block, and
   * reading that header as "the captain spoke" was how operational turns
   * used to leave this corpus labelled `user` with empty words.
   */
  kind: "user" | "op" | "mixed";
  kind_basis: "structural-frame" | "host-framing" | "ambiguous-context" | "ambiguous-framing";
  kind_unknown: boolean;
  framing_ambiguity: "user-boundary" | null;
  framed_text: string | null;
  ambiguous_wakes: string[];
  model: string | null;
  /**
   * The contract revision and served-prompt sha the session recorded before
   * this turn (contract v1.1 provenance, the rolling session's `fm-contract`
   * custom entry). Null for a turn older than the stamp: contract v1.
   * `instructions_sha` is the sha of the captain-owned instructions served
   * beside the prompt (docs/sequences.md), absent on a session older than
   * them - the trainable prompt's sha never covers user text.
   */
  contract: { version: string; prompt_sha: string; instructions_sha?: string } | null;
  context: string | null;
  fleet: FleetSnapshot | null;
  user: string | null;
  /**
   * Every unambiguous `[fm-op]` observation, in order and verbatim -
   * the wakes the model actually read. They used to be swallowed into the
   * context blob (or dropped with it), which is the evidence a dispatch
   * record exists to preserve.
   */
  ops: string[];
  /** The same observations as one block, for readers that want the payload. */
  op: string | null;
  assistant: string;
  names: string[];
  calls: ToolCallRecord[];
  /**
   * The word each emitted card carried: its recorded `kind` argument on a
   * session old enough to have declared one, else the shape its own actions
   * give it (one card shape since P1). A shape is not an intent - see
   * `label.basis`.
   */
  cardKinds: string[];
  cardTitles: string[];
  /** G5: the turn closed with some assistant text (brief close; empty is not a close). */
  doneClose: boolean;
  turnFailed: boolean;
  error: string | null;
};

export type FleetSnapshot = {
  repos: {
    id: string;
    name: string;
    path: string;
    setupKind: string;
    delivery: string;
    autonomy: boolean;
  }[];
  crew: { taskId: string; status: string; title: string; repoName: string; gate?: string }[];
  quotaLine: string | null;
  selfSource: string | null;
};

const USER_MARKER = "\n[user]\n";
const FM_OP_MARKER = "[fm-op]";
const OP_SEGMENT_MARKER = "\n\n[fm-op]";
/** The rolling session's contract stamp (src/core/pi/session.ts). */
const FIRSTMATE_CONTRACT_ENTRY = "fm-contract";
const CONTEXT_HEADER = "[fm-op] context";

/**
 * One session's Pi-dialect text (a Pi file as written, or a Claude-served
 * session as the one reader hands it over) → the Firstmate turns it
 * contains. A turn opens on a user message (the captain's `context +
 * [user]` prompt, or an `[fm-op]` wake) and absorbs every assistant and
 * toolResult message until the next.
 */
export function extractTurnsFromJsonl(
  raw: string,
  sessionFile: string,
  options: { seenEntryIds?: Set<string> } = {},
): DispatchTurn[] {
  const turns: DispatchTurn[] = [];
  const seen = options.seenEntryIds;
  let sessionId: string | null = null;
  let model: string | null = null;
  let contract: DispatchTurn["contract"] = null;
  let current: DispatchTurn | undefined;
  const pendingCalls = new Map<string, ToolCallRecord>();

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: JsonRecord;
    try {
      entry = JSON.parse(trimmed) as JsonRecord;
    } catch {
      // A trailing partial write, exactly as Observe tolerates it.
      continue;
    }
    const entryId = typeof entry.id === "string" ? entry.id : "";
    const duplicate = !!(seen && entryId && type_isEntry(entry) && seen.has(entryId));
    if (seen && entryId && type_isEntry(entry) && !duplicate) seen.add(entryId);
    const type = typeof entry.type === "string" ? entry.type : "";
    if (type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      continue;
    }
    if (type === "custom") {
      const data = entry.data as JsonRecord | undefined;
      if (
        entry.customType === FIRSTMATE_CONTRACT_ENTRY &&
        typeof data?.version === "string" &&
        typeof data.prompt_sha === "string"
      ) {
        contract = {
          version: data.version,
          prompt_sha: data.prompt_sha,
          ...(typeof data.instructions_sha === "string"
            ? { instructions_sha: data.instructions_sha }
            : {}),
        };
      }
      continue;
    }
    if (type === "model_change") {
      model = modelLabel(entry.provider, entry.modelId) ?? model;
      if (current && !current.model) current.model = model;
      continue;
    }
    if (duplicate) continue;
    if (type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const msg = message as JsonRecord;
    const role = typeof msg.role === "string" ? msg.role : "";
    const observedAt = timestampOf(entry) ?? timestampOf(msg);
    const at = observedAt ?? 0;

    if (role === "user") {
      current = openTurn({
        sessionId,
        sessionFile,
        index: turns.length,
        at,
        model,
        contract,
        text: textFromContent(msg.content),
      });
      turns.push(current);
      pendingCalls.clear();
      continue;
    }
    if (!current) continue;

    if (role === "assistant") {
      const label = modelLabel(msg.provider, msg.model);
      if (label) {
        model = label;
        current.model = label;
      }
      const text = textFromContent(msg.content).trim();
      if (text) current.assistant = current.assistant ? `${current.assistant}\n${text}` : text;
      for (const call of toolCallsFromContent(msg.content)) {
        const record: ToolCallRecord = { name: call.name, args: call.args };
        current.names.push(call.name);
        current.calls.push(record);
        if (call.id) pendingCalls.set(call.id, record);
        if (call.name === CARD_TOOL) {
          current.cardKinds.push(stringArg(call.args, "kind") ?? cardWordOf(call.args));
          current.cardTitles.push(stringArg(call.args, "title") ?? "");
        }
      }
      if (msg.stopReason === "error") {
        current.turnFailed = true;
        current.error = typeof msg.errorMessage === "string" ? msg.errorMessage : "error";
      }
      continue;
    }
    if (role === "toolResult") {
      const callId = typeof msg.toolCallId === "string" ? msg.toolCallId : "";
      const record = pendingCalls.get(callId);
      const result = {
        text: textFromContent(msg.content),
        isError: Boolean(msg.isError),
        at: observedAt ?? null,
      };
      if (record) record.result = result;
      continue;
    }
  }

  for (const turn of turns) {
    // G5: the turn closed with some assistant text. The close used to
    // mandate the exact token `done`; it now asks for one short sentence
    // the captain reads beside their message. Empty output is still not a
    // close (that was the 21-minute silence loop).
    const lastLine = turn.assistant.trim().split(/\n/).pop() ?? "";
    turn.doneClose = lastLine.trim().length > 0;
  }
  return turns;
}

/** Entry types that carry a tree id worth de-duplicating across files. */
function type_isEntry(entry: JsonRecord): boolean {
  return typeof entry.type === "string" && entry.type !== "session";
}

/**
 * The host's three turn shapes, told apart by what the text actually
 * contains rather than by its first line (`FirstmateAgent.converse` and
 * `drainInbox`):
 *
 *   captain     <context>\n\n[user]\n<words>
 *   mixed       <context>\n\n<[fm-op] wake>...\n\n[user]\n<words>
 *   operational <context>\n\n<[fm-op] wake>...            (no [user] line)
 *
 * The context block opens with `[fm-op] context (not the user)`, so the
 * header alone says nothing about who spoke - only the `[user]` line does.
 *
 * A turn served since R2 is framed (`src/shared/servedFrame.ts`): every
 * segment opens with U+2063 `FIRSTMATE_OP: v1 <kind> [<origin>]: `, so its shape is
 * read structurally (`kind_basis: "structural-frame"`) and none of the
 * delimiter heuristics below apply to it.
 */
export function parseTurnText(raw: string): {
  kind: "user" | "op" | "mixed";
  kind_basis: "structural-frame" | "host-framing" | "ambiguous-context" | "ambiguous-framing";
  kind_unknown: boolean;
  framing_ambiguity: "user-boundary" | null;
  framed_text: string | null;
  ambiguous_wakes: string[];
  context: string | null;
  ops: string[];
  user: string | null;
} {
  const framed = parseServedInput(raw);
  if (framed) {
    const bodies = (kind: string) =>
      framed.filter((segment) => segment.kind === kind).map((segment) => segment.body);
    const contexts = bodies("context");
    const ops = bodies("wake");
    const words = bodies("user").map((body) =>
      body.startsWith("[user]\n") ? body.slice("[user]\n".length) : body,
    );
    const user = words.length > 0 ? words.join("\n\n") : null;
    return {
      kind: user === null ? "op" : ops.length > 0 ? "mixed" : "user",
      kind_basis: "structural-frame",
      kind_unknown: false,
      framing_ambiguity: null,
      framed_text: null,
      ambiguous_wakes: [],
      context: contexts.length > 0 ? contexts.join("\n\n") : null,
      ops,
      user,
    };
  }
  const text = raw;
  if (!text.startsWith(CONTEXT_HEADER)) {
    const operational = text.startsWith(FM_OP_MARKER);
    return {
      kind: operational ? "op" : "user",
      kind_basis: "host-framing",
      kind_unknown: false,
      framing_ambiguity: null,
      framed_text: null,
      ambiguous_wakes: [],
      context: null,
      ops: operational ? [text] : [],
      user: operational ? null : text,
    };
  }

  const userCandidates = markerOffsets(text, USER_MARKER);
  const framedUserCandidates = userCandidates.filter((at) => at > 0 && text[at - 1] === "\n");
  const candidateAt = framedUserCandidates.length === 1 ? framedUserCandidates[0] : undefined;
  const candidatePrefix = candidateAt === undefined ? text : text.slice(0, candidateAt - 1);
  const candidateSegments = splitOpSegments(candidatePrefix).filter((segment) => segment.length > 0);
  const openWakePayload =
    candidateSegments.length > 1 && candidateSegments.at(-1)?.trimEnd().endsWith(":");
  const userBoundaryAmbiguous =
    userCandidates.length > 0 &&
    (framedUserCandidates.length !== 1 ||
      framedUserCandidates.length !== userCandidates.length ||
      openWakePayload);
  const userAt = userBoundaryAmbiguous ? -1 : (candidateAt ?? -1);
  const prefix = userAt >= 0 ? candidatePrefix : text;
  const user = userAt >= 0 ? text.slice(userAt + USER_MARKER.length) : null;
  const segments = splitOpSegments(prefix).filter((segment) => segment.length > 0);
  let context: string | null = null;
  let ops: string[] = [];
  let ambiguousWakes: string[] = [];
  if (segments[0]?.startsWith(CONTEXT_HEADER)) {
    let contextEnd = -1;
    let hasPostSelfSourceContext = false;
    for (let index = 0; index < segments.length; index += 1) {
      const lines = segments[index]?.split("\n") ?? [];
      const selfSourceAt = lines.findIndex((line) => line.startsWith("self-source:"));
      if (selfSourceAt >= 0) {
        contextEnd = index;
        hasPostSelfSourceContext = lines.slice(selfSourceAt + 1).some((line) => line.length > 0);
      }
    }
    if (contextEnd < 0 || hasPostSelfSourceContext) contextEnd = segments.length - 1;
    context = segments.slice(0, contextEnd + 1).join("\n\n");
    ambiguousWakes = segments.slice(1, contextEnd + 1);
    ops = segments.slice(contextEnd + 1);
  } else {
    ops = segments;
  }

  const kind = user === null ? "op" : ops.length > 0 ? "mixed" : "user";
  const kindUnknown = userBoundaryAmbiguous || ambiguousWakes.length > 0;
  return {
    kind,
    kind_basis: userBoundaryAmbiguous
      ? "ambiguous-framing"
      : ambiguousWakes.length > 0
        ? "ambiguous-context"
        : "host-framing",
    kind_unknown: kindUnknown,
    framing_ambiguity: userBoundaryAmbiguous ? "user-boundary" : null,
    framed_text: userBoundaryAmbiguous ? text : null,
    ambiguous_wakes: ambiguousWakes,
    context,
    ops,
    user,
  };
}

function markerOffsets(text: string, marker: string): number[] {
  const offsets: number[] = [];
  let at = text.indexOf(marker);
  while (at >= 0) {
    offsets.push(at);
    at = text.indexOf(marker, at + marker.length);
  }
  return offsets;
}

function splitOpSegments(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let at = text.indexOf(OP_SEGMENT_MARKER, 1);
  while (at >= 0) {
    segments.push(text.slice(start, at));
    start = at + 2;
    at = text.indexOf(OP_SEGMENT_MARKER, start + 1);
  }
  segments.push(text.slice(start));
  return segments;
}

function openTurn(input: {
  sessionId: string | null;
  sessionFile: string;
  index: number;
  at: number;
  model: string | null;
  contract: DispatchTurn["contract"];
  text: string;
}): DispatchTurn {
  const parsed = parseTurnText(input.text);
  const context = parsed.context;
  return {
    id: `${basename(input.sessionFile).replace(/\.jsonl$/, "")}#${input.index}`,
    session_id: input.sessionId,
    session_file: input.sessionFile,
    turn_index: input.index,
    at: input.at,
    kind: parsed.kind,
    kind_basis: parsed.kind_basis,
    kind_unknown: parsed.kind_unknown,
    framing_ambiguity: parsed.framing_ambiguity,
    framed_text: parsed.framed_text,
    ambiguous_wakes: parsed.ambiguous_wakes,
    model: input.model,
    contract: input.contract,
    context,
    fleet: context ? parseContextBlock(context) : null,
    user: parsed.user,
    ops: parsed.ops,
    op: parsed.ops.length > 0 ? parsed.ops.join("\n\n") : null,
    assistant: "",
    names: [],
    calls: [],
    cardKinds: [],
    cardTitles: [],
    doneClose: false,
    turnFailed: false,
    error: null,
  };
}

/**
 * The `[fm-op] context` block back into structure, mirroring the lines
 * `FirstmateAgent.buildContextBlock` writes. Anything it cannot parse stays
 * absent rather than being guessed at - the raw block rides the record too.
 */
export function parseContextBlock(block: string): FleetSnapshot {
  const snapshot: FleetSnapshot = { repos: [], crew: [], quotaLine: null, selfSource: null };
  const toon = parseToonContext(block);
  if (toon) {
    snapshot.repos = toon.repos
      .filter((repo) => typeof repo.autonomy === "boolean")
      .map((repo) => ({
        id: String(repo.repo_id ?? ""),
        name: String(repo.name ?? ""),
        path: String(repo.path ?? ""),
        setupKind: String(repo.setup ?? ""),
        delivery: String(repo.delivery ?? ""),
        autonomy: repo.autonomy as boolean,
      }));
    snapshot.crew = toon.crew.map((entry) => ({
      taskId: String(entry.task_id ?? ""),
      status: String(entry.status ?? ""),
      title: String(entry.title ?? ""),
      repoName: String(entry.repo ?? ""),
      ...(typeof entry.gate === "string" ? { gate: entry.gate } : {}),
    }));
    snapshot.quotaLine = typeof toon.quota === "string" ? toon.quota : null;
    snapshot.selfSource = typeof toon.self_source === "string" ? toon.self_source : null;
    return snapshot;
  }
  let section: "repos" | "crew" | "" = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("repos:")) {
      section = "repos";
      continue;
    }
    if (line.startsWith("crew:")) {
      section = "crew";
      continue;
    }
    if (line.startsWith("quota: ")) {
      snapshot.quotaLine = line.slice("quota: ".length).trim();
      section = "";
      continue;
    }
    if (line.startsWith("self-source: ")) {
      snapshot.selfSource = line.slice("self-source: ".length).trim();
      section = "";
      continue;
    }
    if (!line.startsWith("- ")) {
      if (line.endsWith(":")) section = "";
      continue;
    }
    if (section === "repos") {
      const match = line.match(
        /^- (.+?) \(repo_id: (.+?)\) (.+?) \[(.+?), (.+?), autonomy (on|off)\]$/,
      );
      if (match) {
        snapshot.repos.push({
          name: match[1] ?? "",
          id: match[2] ?? "",
          path: match[3] ?? "",
          setupKind: match[4] ?? "",
          delivery: match[5] ?? "",
          autonomy: match[6] === "on",
        });
      }
      continue;
    }
    if (section === "crew") {
      const match = line.match(/^- task (\S+) (\S+) "(.*)" repo (.+?)(?: \((.+)\))?$/);
      if (match) {
        snapshot.crew.push({
          taskId: match[1] ?? "",
          status: match[2] ?? "",
          title: match[3] ?? "",
          repoName: match[4] ?? "",
          ...(match[5] ? { gate: match[5] } : {}),
        });
      }
    }
  }
  return snapshot;
}

function parseToonContext(block: string): {
  repos: Record<string, unknown>[];
  crew: Record<string, unknown>[];
  quota?: unknown;
  self_source?: unknown;
} | null {
  const firstBreak = block.indexOf("\n");
  if (firstBreak < 0) return null;
  try {
    const value = decode(block.slice(firstBreak + 1));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (!Array.isArray(record.repos) || !Array.isArray(record.crew)) return null;
    if (
      !record.repos.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) ||
      !record.crew.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    ) {
      return null;
    }
    return record as {
      repos: Record<string, unknown>[];
      crew: Record<string, unknown>[];
      quota?: unknown;
      self_source?: unknown;
    };
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Classification
// --------------------------------------------------------------------------

/**
 * PoC-1 parity (`run_gates.test.ts` `inferClass`): the class a turn's tool
 * NAMES alone imply. `emit_card` is deliberately ambiguous here because a
 * card can be either an answer or a question; `classifyTurn` resolves it.
 */
export function inferClassFromNames(names: string[]): DispatchClass | "answer-or-ask" {
  if (names.some((n) => SPAWN_TOOLS.includes(n))) return "spawn";
  if (names.some((n) => SETTLE_TOOLS.includes(n))) return "settle";
  if (names.some((n) => STEER_TOOLS.includes(n))) return "steer";
  if (names.some((n) => OPERATE_TOOLS.includes(n))) return "operate";
  if (names.includes(CARD_TOOL)) return "answer-or-ask";
  return fallbackClass(names);
}

/**
 * Every class a turn actually exercised. The contract allows a turn to
 * compose ("only when the user asked for more than one thing"), so the
 * record carries the set and a primary rather than collapsing to one.
 */
export function classifyTurn(
  names: string[],
  cardKinds: string[],
): {
  primary: DispatchClass;
  classes: DispatchClass[];
  /**
   * What the primary class rests on. `tool` is the turn's own exercised
   * move; `card-shape` is only the shape of a card it emitted, which says
   * how the card reads, not what the Firstmate set out to do; `fallback`
   * is the read-only/bookkeeping reading of a turn with no move at all.
   */
  basis: "tool" | "card-shape" | "fallback";
} {
  const classes: DispatchClass[] = [];
  if (names.some((n) => SPAWN_TOOLS.includes(n))) classes.push("spawn");
  if (names.some((n) => SETTLE_TOOLS.includes(n))) classes.push("settle");
  if (names.some((n) => STEER_TOOLS.includes(n))) classes.push("steer");
  if (names.some((n) => OPERATE_TOOLS.includes(n))) classes.push("operate");
  const fromTools = classes.length;
  if (cardKinds.includes("decision")) classes.push("ask");
  // `live-prototype` is retired, but a recorded session still names it and a
  // corpus row is only as classifiable as the history it was taken from.
  if (cardKinds.some((kind) => kind === "note" || kind === "live-prototype")) classes.push("answer");
  if (classes.length === 0) {
    const fallback = fallbackClass(names);
    return { primary: fallback, classes: [fallback], basis: "fallback" };
  }
  return {
    primary: classes[0] as DispatchClass,
    classes,
    basis: fromTools > 0 ? "tool" : "card-shape",
  };
}

// --------------------------------------------------------------------------
// The joins: tasks, repos, cards
// --------------------------------------------------------------------------

export type TaskJoin = {
  task_id: string;
  via: string;
  found: boolean;
  title?: string;
  status?: string;
  kind?: string;
  repo_id?: string | null;
  repo_name?: string | null;
  delivery?: string | null;
  autonomy?: boolean | null;
  created_at?: number;
  /**
   * The routing shape and its outcome (intelligence-bucket routing S2).
   * `shape` is what the host took the work to BE - the kind a classifier
   * established, the basis it verified, the captain's premium ask or model
   * override - and `rule` the row of the policy table that read it
   * (`src/shared/routingPolicy.ts`). `tier` is the slot asked for. Together
   * they are the label this corpus lacked: the input beside the decision.
   * Null on rows routed before the shape existed.
   */
  shape?: JsonRecord | null;
  tier?: string | null;
  /**
   * The delivery rigor the host stamped on the shape (delivery rigor phase
   * 2). A row without one - dispatched before the tier existed - is `quick`:
   * nothing derived a rigor and the crewmate was told no procedure, so that
   * is what it shipped at, never an unknown.
   */
  rigor?: string;
  /**
   * What the task DELIVERS (crew-posture rationalization Task B): `answer`
   * for work that finds something out and lands one card, `change` for work
   * that ships one. A row shaped before the axis existed reads `change`,
   * which is what it shipped - never an unknown.
   */
  deliverable?: string;
  rule?: string | null;
  /**
   * The tier the ladder actually served (S5). Equal to `tier` when the slot
   * the policy asked for could serve, weaker when it fell back, and null on
   * a row routed before the column - never assumed equal.
   */
  served?: string | null;
  /**
   * The review facts (delivery rigor phase 3). `review_of` is the builder a
   * review task reads, off its shape; `review_verdict` and `review_risk`
   * are the latest verdict recorded on a BUILDER's delivery facts. Null
   * where the record carries none - a pre-phase-2 database has no review
   * anywhere and exports every one of them null.
   */
  review_of?: string | null;
  review_verdict?: string | null;
  review_risk?: string | null;
};

export type CardJoin = {
  card_id: string | null;
  kind: string;
  title: string;
  found: boolean;
  /** How the card row was reached: the id the tool returned, the task
   * timeline's own `card_raised` row, or - last and weakest - its title. */
  joined_via?: "tool-result-id" | "task-event" | "title";
  /** The work the card is about: the timeline says so, or the card row's own
   * column, or the decision record the host filed for a task-less card. */
  task_id?: string | null;
  task_via?: "task-event" | "cards.task_id" | "decision-record" | null;
  /** The persisted body and declared actions from the version that was shown. */
  body?: string;
  actions?: JsonRecord[];
  author?: string | null;
  status?: string;
  created_at?: number;
  resolved_at?: number | null;
  chosen_action?: string | null;
  /**
   * What the chosen action DECLARED (P1's one semantics). Read off the
   * card's own actions, never guessed from the id - a settle is a host
   * teardown, an open is a shell navigation, and only an action with no
   * effect on a crewmate's card ever reached the crewmate as a steer.
   */
  chosen_effect?: JsonRecord | null;
  /** `declared` when the row carried the effect; `legacy-id` when it was
   * derived from a pre-P1 reserved id, which is recorded, never rewritten. */
  effect_source?: "declared" | "legacy-id" | null;
  /** What the captain's click actually did, from the effect above. */
  captain_contact?: "steer" | "settle" | "open" | "dismissed" | "withdrawn" | "none";
  /** Who resolved it, from the timeline's actor-labelled `card_resolved`. */
  resolved_by?: string | null;
  /** How many superseded versions the card lineage kept (WI-12). */
  revisions?: number;
  /** Which persisted version supplied this turn's title/body/actions. */
  actions_version?: "current" | "revision" | "unknown";
  /**
   * open    still on the stack
   * acted   the captain chose one of the card's own declared actions
   * dismissed the captain dismissed it without choosing
   * retired the host or the emitter withdrew it - not a captain answer at all
   * unknown no persisted version covers the emit turn
   */
  resolution?: "open" | "acted" | "dismissed" | "retired" | "unknown";
  /** The captain-confirmed duplicate label (WI-14), when stamped. */
  duplicate_of?: string | null;
  duplicate_note?: string | null;
  duplicate_at?: number | null;
};

export type DispatchRecord = DispatchTurn & {
  inferred: DispatchClass | "answer-or-ask";
  observed_class: DispatchClass;
  classes: DispatchClass[];
  restraint: {
    tool_calls: number;
    spawns: number;
    steers: number;
    cards: number;
    decision_cards: number;
    note_cards: number;
  };
  outcome: { tasks: TaskJoin[]; cards: CardJoin[] };
  label: {
    /**
     * The class the Firstmate actually took. Weak by construction, and
     * NULL when nothing but a card's shape was available to read it from.
     */
    gold_class: DispatchClass | null;
    weak: true;
    /** Explicit: no gold intent could be established for this turn. */
    unknown: boolean;
    /** What `observed_class` rests on (see `classifyTurn`). */
    basis: "tool" | "card-shape" | "fallback";
    confidence: "corroborated" | "observed" | "contradicted";
    evidence: string[];
  };
};

type TaskRow = {
  /** Null means never dispatched; absent only in databases predating that fact. */
  started_at?: number | null;
  id: string;
  title: string;
  status: string;
  kind: string;
  repo_id: string | null;
  /** The parent edge - on a `review` shape, the builder it reads (the one stored join). */
  parent_id: string | null;
  created_at: number;
  closed_at: number | null;
  closed_reason: string | null;
  /** The computed tier (S2); a judged class on rows older than the shape. */
  difficulty: string | null;
  /** The `WorkShape` JSON the host routed from (S2), null before it existed. */
  shape_json: string | null;
  /** The delivery facts JSON (task-system P0), where the review verdict lives. */
  delivery_json: string | null;
  /** The last report the row recorded - a reviewer's verdict text, on a review task. */
  outcome: string | null;
};
type RepoRow = { id: string; name: string; delivery: string; autonomy: number };
type CardRow = {
  id: string;
  /** The task the card is about, when the emitter attached one (P1). */
  task_id: string | null;
  /** The stored column: "card" since cards/tasks/agents P1, an older row's word before it. */
  kind: string;
  /** The card's declared actions, verbatim: a decision is a card with at least one. */
  actions_json: string;
  author: string | null;
  title: string;
  body: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
  chosen_action: string | null;
  /** The captain's confirmed duplicate label (WI-14); null on unflagged or older rows. */
  duplicate_of: string | null;
  duplicate_note: string | null;
  duplicate_at: number | null;
};

export type CardRevisionRow = {
  card_id: string;
  revision: number;
  kind: string;
  title: string;
  body: string;
  actions_json: string;
  created_at: number;
  replaced_at: number;
  replaced_by: string;
};

export type CardVersion = {
  kind: string;
  title: string;
  body: string;
  actions_json: string;
  basis: "current" | "revision";
};

export type CardVersionSource = Pick<CardRow, "kind" | "title" | "body" | "actions_json">;

/** One actor-labelled row of a task's own timeline (`task_events`). */
export type CardEvent = { taskId: string; actor: string; at: number; action?: string };

export type FleetTables = {
  tasks: Map<string, TaskRow>;
  repos: Map<string, RepoRow>;
  cards: Map<string, CardRow>;
  cardsByTitle: Map<string, CardRow[]>;
  /** card id -> the task whose timeline recorded the card being raised. */
  cardRaised: Map<string, CardEvent>;
  /** card id -> the actor-labelled resolution the timeline recorded. */
  cardResolved: Map<string, CardEvent>;
  /** card id -> the decision record the host filed for a task-less card. */
  decisionByCard: Map<string, TaskRow>;
  /** card id -> superseded versions, oldest first. */
  cardRevisions: Map<string, CardRevisionRow[]>;
  /**
   * task id -> what its newest routing decision recorded: the policy rule
   * that chose the tier (S2) and the tier the ladder actually served (S5).
   * Either may be null on a database older than the column that carries it.
   */
  routing: Map<string, { rule: string | null; served: string | null }>;
  /**
   * Every `review` timeline event, oldest first (delivery rigor phase 2):
   * one verdict a reviewer returned, on the BUILDER's own timeline. Empty
   * on a database older than the reviewed tier.
   */
  reviewEvents: ReviewEvent[];
  /**
   * task id -> how many times a `cap_reset` reopened its rounds (phase 3).
   * A cap that is still standing lives on the delivery facts instead; the
   * two together are the holds the change earned.
   */
  capResets: Map<string, number>;
  /**
   * task id -> each override the captain's words declared on it, as the
   * soft holds it named (INF-484 move 8; `overrideHoldsFrom`). Empty on a
   * database older than the override.
   */
  overrides: Map<string, string[][]>;
};

export const EMPTY_TABLES: FleetTables = {
  tasks: new Map(),
  repos: new Map(),
  cards: new Map(),
  cardsByTitle: new Map(),
  cardRaised: new Map(),
  cardResolved: new Map(),
  decisionByCard: new Map(),
  cardRevisions: new Map(),
  routing: new Map(),
  reviewEvents: [],
  capResets: new Map(),
  overrides: new Map(),
};

/** Read-only snapshot of the three tables the dispatch dataset joins to. */
export function readFleetTables(dbPath: string): FleetTables {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // Tables and views: since migration 50 `routing_decisions` is a view
    // over the one decision ledger, with the same rows.
    const tables = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
          .all() as { name: string }[]
      ).map((row) => row.name),
    );
    const tasks = new Map<string, TaskRow>();
    if (tables.has("tasks")) {
      const taskColumns = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name),
      );
      const startedAt = taskColumns.has("started_at") ? "started_at, " : "";
      const closedAt = taskColumns.has("closed_at") ? "closed_at" : "NULL AS closed_at";
      const closedReason = taskColumns.has("closed_reason")
        ? "closed_reason"
        : "NULL AS closed_reason";
      const difficulty = taskColumns.has("difficulty") ? "difficulty" : "NULL AS difficulty";
      const shape = taskColumns.has("shape_json") ? "shape_json" : "NULL AS shape_json";
      const delivery = taskColumns.has("delivery_json")
        ? "delivery_json"
        : "NULL AS delivery_json";
      const outcome = taskColumns.has("outcome") ? "outcome" : "NULL AS outcome";
      const parent = taskColumns.has("parent_id") ? "parent_id" : "NULL AS parent_id";
      // A task's shape as the app reads it, its references in it.
      const shapeOf = savedShapeReader(db);
      for (const row of db
        .prepare(
          `SELECT id, title, status, kind, repo_id, ${parent}, created_at, ${startedAt}${closedAt}, ${closedReason}, ${difficulty}, ${shape}, ${delivery}, ${outcome} FROM tasks`,
        )
        .all() as TaskRow[]) {
        tasks.set(row.id, { ...row, shape_json: shapeOf(row.id, row.shape_json) });
      }
    }
    // The rule that chose each task's tier and the tier actually served,
    // newest decision per task. Each column arrived with its own step (S2,
    // S5), so a database routed before one simply has none of it - never a
    // guessed rule and never a served tier assumed equal to the asked one.
    const routing = new Map<string, { rule: string | null; served: string | null }>();
    if (tables.has("routing_decisions")) {
      const columns = new Set(
        (db.prepare("PRAGMA table_info(routing_decisions)").all() as { name: string }[]).map(
          (column) => column.name,
        ),
      );
      const rule = columns.has("rule") ? "rule" : "NULL AS rule";
      const served = columns.has("served") ? "served" : "NULL AS served";
      for (const row of db
        .prepare(`SELECT task_id, ${rule}, ${served} FROM routing_decisions ORDER BY at, id`)
        .all() as { task_id: string; rule: string | null; served: string | null }[]) {
        routing.set(row.task_id, { rule: row.rule, served: row.served });
      }
    }
    const repos = new Map<string, RepoRow>();
    if (tables.has("repos")) {
      for (const row of db
        .prepare("SELECT id, name, delivery, autonomy FROM repos")
        .all() as RepoRow[]) {
        repos.set(row.id, row);
      }
    }
    const cards = new Map<string, CardRow>();
    const cardsByTitle = new Map<string, CardRow[]>();
    if (tables.has("cards")) {
      // A database older than migration 25 has no duplicate label: null.
      const columns = new Set(
        (db.prepare("PRAGMA table_info(cards)").all() as { name: string }[]).map((c) => c.name),
      );
      const labelled = columns.has("duplicate_of")
        ? "duplicate_of, duplicate_note, duplicate_at"
        : "NULL AS duplicate_of, NULL AS duplicate_note, NULL AS duplicate_at";
      const author = columns.has("author") ? "author" : "NULL AS author";
      for (const row of db
        .prepare(
          `SELECT id, task_id, kind, actions_json, ${author}, title, body, status, created_at, resolved_at, chosen_action, ${labelled} FROM cards`,
        )
        .all() as CardRow[]) {
        cards.set(row.id, row);
        const bucket = cardsByTitle.get(row.title) ?? [];
        bucket.push(row);
        cardsByTitle.set(row.title, bucket);
      }
    }
    // Lineage, from the record's own actor-labelled timeline (task-system
    // P2/P3). A card's task is recorded when it is raised and again when it
    // is resolved; reading those beats matching on a title.
    const cardRaised = new Map<string, CardEvent>();
    const cardResolved = new Map<string, CardEvent>();
    if (tables.has("task_events")) {
      for (const row of db
        .prepare(
          `SELECT task_id, at, actor, kind, data_json, ref FROM task_events
             WHERE kind IN ('card_raised', 'card_resolved') AND ref IS NOT NULL
             ORDER BY at, id`,
        )
        .all() as {
        task_id: string;
        at: number;
        actor: string;
        kind: string;
        data_json: string | null;
        ref: string;
      }[]) {
        const event: CardEvent = { taskId: row.task_id, actor: row.actor, at: row.at };
        if (row.kind === "card_raised") cardRaised.set(row.ref, event);
        else cardResolved.set(row.ref, { ...event, ...actionOf(row.data_json) });
      }
    }
    const cardRevisions = new Map<string, CardRevisionRow[]>();
    if (tables.has("card_revisions")) {
      for (const row of db
        .prepare(
          `SELECT card_id, revision, kind, title, body, actions_json,
                  created_at, replaced_at, replaced_by
           FROM card_revisions ORDER BY card_id, revision`,
        )
        .all() as CardRevisionRow[]) {
        const revisions = cardRevisions.get(row.card_id) ?? [];
        revisions.push(row);
        cardRevisions.set(row.card_id, revisions);
        const card = cards.get(row.card_id);
        if (card) {
          const titleRows = cardsByTitle.get(row.title) ?? [];
          if (!titleRows.some((candidate) => candidate.id === card.id)) titleRows.push(card);
          cardsByTitle.set(row.title, titleRows);
        }
      }
    }
    // A Firstmate decision card with no task of its own still has a record:
    // the host files a `decision` row gated on the card id (task-system P1).
    const decisionByCard = new Map<string, TaskRow>();
    if (tables.has("tasks")) {
      const taskColumns = new Set(
        (db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name),
      );
      if (taskColumns.has("gate_ref")) {
        for (const row of db
          .prepare("SELECT id, gate_ref FROM tasks WHERE kind = 'decision' AND gate_ref IS NOT NULL")
          .all() as { id: string; gate_ref: string }[]) {
          const record = tasks.get(row.id);
          if (record) decisionByCard.set(row.gate_ref, record);
        }
      }
      for (const [cardId, raised] of cardRaised) {
        const record = tasks.get(raised.taskId);
        if (record?.kind === "decision") decisionByCard.set(cardId, record);
      }
      if (tables.has("task_events")) {
        const closeEvent = db.prepare(
          `SELECT actor, at FROM task_events
           WHERE task_id = ? AND at = ?
           ORDER BY id DESC LIMIT 1`,
        );
        for (const [cardId, record] of decisionByCard) {
          if (cardResolved.has(cardId) || record.closed_at === null) continue;
          const event = closeEvent.get(record.id, record.closed_at) as
            | { actor: string; at: number }
            | undefined;
          if (event) {
            const card = cards.get(cardId);
            const chosen = card?.chosen_action;
            const version =
              card?.resolved_at == null
                ? null
                : cardVersionAt(card, cardRevisions.get(cardId) ?? [], card.resolved_at);
            const captainDeclaredChoice = Boolean(
              event.actor === "captain" &&
                version?.kind === "card" &&
                chosen &&
                declaredActionsOf(version.actions_json).some((entry) => entry.id === chosen),
            );
            const action =
              record.closed_reason === "cancelled"
                ? "dismissed"
                : record.closed_reason === "superseded"
                  ? captainDeclaredChoice
                    ? (chosen ?? undefined)
                    : "withdrawn"
                  : record.closed_reason === "answered"
                    ? (chosen ?? undefined)
                    : undefined;
            cardResolved.set(cardId, {
              taskId: record.id,
              actor: event.actor,
              at: event.at,
              ...(action ? { action } : {}),
            });
          }
        }
      }
    }
    // The rigor record (delivery rigor phase 4): the verdicts reviewers
    // returned, and the caps a steer reopened. Both live in `task_events`,
    // and a database older than the tiers simply has neither.
    const reviewEvents: ReviewEvent[] = [];
    const capResets = new Map<string, number>();
    // The captain's overrides (INF-484 move 8): a `note` row whose delivery
    // patch carries the typed override.
    const overrides = new Map<string, string[][]>();
    if (tables.has("task_events")) {
      for (const row of db
        .prepare(
          `SELECT task_id, at, kind, data_json FROM task_events
             WHERE kind IN ('review', 'cap_reset')
                OR (kind = 'note' AND data_json LIKE '%"override":%')
             ORDER BY at, id`,
        )
        .all() as { task_id: string; at: number; kind: string; data_json: string | null }[]) {
        if (row.kind === "note") {
          const holds = overrideHoldsFrom(row.data_json);
          if (holds) overrides.set(row.task_id, [...(overrides.get(row.task_id) ?? []), holds]);
          continue;
        }
        if (row.kind === "cap_reset") {
          capResets.set(row.task_id, (capResets.get(row.task_id) ?? 0) + 1);
          continue;
        }
        reviewEvents.push(reviewEventFrom(row.task_id, row.at, row.data_json));
      }
    }
    return {
      tasks,
      repos,
      cards,
      cardsByTitle,
      cardRaised,
      cardResolved,
      decisionByCard,
      cardRevisions,
      routing,
      reviewEvents,
      capResets,
      overrides,
    };
  } finally {
    db.close();
  }
}

/** The action a `card_resolved` event recorded, when it carried one. */
export function actionOf(dataJson: string | null): { action?: string } {
  if (!dataJson) return {};
  try {
    const parsed = JSON.parse(dataJson) as JsonRecord;
    return typeof parsed.action === "string" ? { action: parsed.action } : {};
  } catch {
    return {};
  }
}

/**
 * A settings value as a string. `SettingsStore.set` stores every value
 * JSON-encoded, so the app writes a path as `"/path"`; a raw string (an
 * older hand-written row) still reads as itself.
 */
export function settingString(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" && parsed ? parsed : null;
  } catch {
    return value || null;
  }
}

/** The rolling Firstmate session file the app last wrote, when recorded. */
export function readFirstmateSessionFile(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'firstmate-session-file'")
      .get() as { value: string } | undefined;
    return settingString(row?.value);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * `Commissioned crewmate 1 on task ab12.` / `Queued task ab12; …` /
 * `Planned FI3-310 "<title>" (task_id ab12) - starts on request.` → `ab12`.
 * The id a planned task's result names wins over the words of its title.
 */
export function taskIdFromSpawnResult(text: string): string | null {
  const match = text.match(/\(task_id ([A-Za-z0-9_-]+)\)/) ?? text.match(/\btask ([A-Za-z0-9_-]+)/);
  return match?.[1] ?? null;
}

/** `Card shown: <title> (<card id>)` → the card id the store assigned. */
export function cardIdFromEmitResult(text: string): string | null {
  const match = text.match(/^Card shown: .*\(([^()]+)\)\s*$/);
  return match?.[1] ?? null;
}

function joinTask(taskId: string, via: string, tables: FleetTables): TaskJoin {
  const task = tables.tasks.get(taskId);
  if (!task) return { task_id: taskId, via, found: false };
  const repo = task.repo_id ? tables.repos.get(task.repo_id) : undefined;
  return {
    task_id: taskId,
    via,
    found: true,
    title: task.title,
    status: task.status,
    kind: task.kind,
    repo_id: task.repo_id,
    repo_name: repo?.name ?? null,
    delivery: repo?.delivery ?? null,
    autonomy: repo ? repo.autonomy === 1 : null,
    shape: parseShape(task.shape_json),
    tier: task.difficulty,
    rigor: rigorOf(parseShape(task.shape_json)),
    deliverable: deliverableOf(parseShape(task.shape_json)),
    rule: tables.routing.get(taskId)?.rule ?? null,
    served: tables.routing.get(taskId)?.served ?? null,
    ...reviewOf(task, parseShape(task.shape_json)),
  };
}

/** The deliverable a shape carries; a shape from before the axis is a change. */
function deliverableOf(shape: JsonRecord | null): string {
  const deliverable = shape?.deliverable;
  return deliverable === "answer" ? "answer" : "change";
}

/** The rigor a shape carries; a shape from before it, or no shape, is quick. */
function rigorOf(shape: JsonRecord | null): string {
  const rigor = shape?.rigor;
  return typeof rigor === "string" && rigor ? rigor : "quick";
}

/**
 * The review facts (phase 3): the builder a review task reads - its PARENT,
 * the one stored join since the `review_of` fold (captain-approved
 * 2026-09-19) - and the verdict and risk recorded on a builder's delivery
 * facts. Null wherever the record carries none - never a guessed verdict.
 */
function reviewOf(
  task: TaskRow,
  shape: JsonRecord | null,
): { review_of: string | null; review_verdict: string | null; review_risk: string | null } {
  const of = shape?.kind === "review" ? task.parent_id : null;
  const delivery = parseShape(task.delivery_json);
  const verdict = delivery?.reviewVerdict;
  const risk = delivery?.reviewRisk;
  return {
    review_of: typeof of === "string" && of ? of : null,
    review_verdict: typeof verdict === "string" && verdict ? verdict : null,
    review_risk: typeof risk === "string" && risk ? risk : null,
  };
}

/** The stored `WorkShape`, or null when the row has none or it is unreadable. */
function parseShape(json: string | null): JsonRecord | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : null;
  } catch {
    return null;
  }
}

/** The card's declared actions, or an empty list when the row has none. */
export function declaredActionsOf(actionsJson: string | null | undefined): JsonRecord[] {
  if (!actionsJson) return [];
  try {
    const parsed = JSON.parse(actionsJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((a): a is JsonRecord => !!a && typeof a === "object");
  } catch {
    return [];
  }
}

/** The captain's own dismissal id (`CrewSupervisor.dismissCard`). */
const CAPTAIN_DISMISS = "close";

/**
 * Whether an id that names no declared action was one of the pre-P1 CLOSE
 * CONTROLS (`dismiss`, `later`, `keep`). The answer comes from the one
 * shared legacy table - `migrateLegacyActions` drops exactly those ids, the
 * same mapping migration 29 ran - so this file keeps no reserved-id list of
 * its own, and a historical dismissal still reads as the dismissal it was.
 */
function wasCloseControl(id: string): boolean {
  return migrateLegacyActions([{ id, label: id }]).length === 0;
}

/**
 * The words the HOST itself writes into `chosen_action` when a card leaves
 * the stack without anyone choosing anything: an emitter's `close_card`
 * default, the duplicate label, a recovered credential, resumed activity,
 * and the closed-task reasons a settle retires its cards with
 * (`CrewSupervisor.retireTaskCards`, `taskClosedReasonSchema`). None of
 * them is a captain answer.
 */
const HOST_WITHDRAWALS = new Set([
  "closed",
  "duplicate",
  "recovered",
  "activity-resumed",
  "dropped",
  "superseded",
  "landed",
  "merged",
  "answered",
  "settled",
  "finished",
  "cancelled",
  "discarded",
  "failed",
]);

/**
 * What a resolved card says, read off the card's OWN actions rather than a
 * table of reserved ids:
 *
 * - the stored `chosen_action` naming one of the card's declared actions is
 *   the captain choosing it;
 * - `close` is the captain's dismissal (the X control);
 * - anything else is a host or emitter withdrawal - `closed` (close_card),
 *   `duplicate`, `recovered`, `activity-resumed`, a settled task retiring
 *   its cards - and is NOT a captain answer, so it must never read as one.
 *
 * The reserved-id table this replaces mislabelled every current card: real
 * ids are free-form since P1, so "not one of the ids I know" had become
 * "the captain answered".
 */
export function resolutionOf(
  card: {
    resolved_at?: number | null;
    chosen_action?: string | null;
    actions_json?: string | null;
  },
  /**
   * The record's own `card_resolved` row, when the timeline has one. Its
   * actor label is the authority on WHO closed the card - the host writes
   * an emitter's `close_card` reason verbatim, so the string alone cannot
   * always say.
   */
  event?: { actor: string; action?: string } | null,
  options: { legacy?: boolean } = {},
): "open" | "acted" | "dismissed" | "retired" {
  if (card.resolved_at === null || card.resolved_at === undefined) return "open";
  if (event && event.actor !== "captain") return "retired";
  const chosen = card.chosen_action;
  const declared = declaredActionsOf(card.actions_json);
  if (
    !options.legacy &&
    event?.action &&
    event.action === chosen &&
    declared.some((action) => action.id === chosen)
  ) {
    return "acted";
  }
  if (event?.action === "dismissed") return "dismissed";
  if (event?.action === "withdrawn" || event?.action === "closed") return "retired";
  if (options.legacy) {
    if (!chosen || chosen === CAPTAIN_DISMISS || wasCloseControl(chosen)) return "dismissed";
    if (HOST_WITHDRAWALS.has(chosen)) return "retired";
    if (declared.some((action) => action.id === chosen)) return "acted";
    return "acted";
  }
  if (chosen && declared.some((action) => action.id === chosen)) return "acted";
  if (!chosen || chosen === CAPTAIN_DISMISS) return "dismissed";
  return "retired";
}

/**
 * The effect the chosen action declared, and what the click therefore did.
 * A `settle` effect is host-owned teardown (`CrewSupervisor.act`): the
 * crewmate is never steered by it, so recording one as a steer invents
 * captain contact that never happened.
 */
export function chosenEffectOf(
  actions: JsonRecord[],
  chosen: string | null | undefined,
  resolution: "open" | "acted" | "dismissed" | "retired" | "unknown",
  options: { legacy?: boolean; cardId?: string | null; author?: string | null } = {},
): {
  chosen_effect: JsonRecord | null;
  effect_source: "declared" | "legacy-id" | null;
  captain_contact: "steer" | "settle" | "open" | "dismissed" | "withdrawn" | "none";
} {
  if (resolution === "open" || resolution === "unknown")
    return { chosen_effect: null, effect_source: null, captain_contact: "none" };
  if (resolution === "dismissed")
    return { chosen_effect: null, effect_source: null, captain_contact: "dismissed" };
  if (resolution === "retired")
    return { chosen_effect: null, effect_source: null, captain_contact: "withdrawn" };
  const action = actions.find((entry) => entry.id === chosen);
  const declared = action?.effect;
  if (declared && typeof declared === "object") {
    const effect = declared as JsonRecord;
    return {
      chosen_effect: effect,
      effect_source: options.legacy ? "legacy-id" : "declared",
      captain_contact: effect.kind === "settle" ? "settle" : effect.kind === "open" ? "open" : "none",
    };
  }
  const legacyShape = action ?? (chosen ? { id: chosen, label: chosen } : undefined);
  const migrated =
    options.legacy && legacyShape ? migrateLegacyActions([legacyShape as never])[0] : undefined;
  const legacy = migrated?.effect as JsonRecord | undefined;
  if (legacy) {
    return {
      chosen_effect: legacy,
      effect_source: "legacy-id",
      captain_contact: legacy.kind === "settle" ? "settle" : legacy.kind === "open" ? "open" : "none",
    };
  }
  const author = options.author ?? (options.cardId?.startsWith("card-fm-") ? "firstmate" : "crewmate");
  return {
    chosen_effect: null,
    effect_source: null,
    captain_contact: author === "crewmate" ? "steer" : "none",
  };
}

export function cardVersionAt(
  row: CardVersionSource,
  revisions: CardRevisionRow[],
  at: number,
): CardVersion | null {
  if (revisions.length === 0) {
    return {
      kind: row.kind,
      title: row.title,
      body: row.body,
      actions_json: row.actions_json,
      basis: "current",
    };
  }
  const revision = revisions.find((candidate) => at >= candidate.created_at && at < candidate.replaced_at);
  if (revision) {
    return {
      kind: revision.kind,
      title: revision.title,
      body: revision.body,
      actions_json: revision.actions_json,
      basis: "revision",
    };
  }
  const latest = revisions.at(-1);
  if (latest && at >= latest.replaced_at) {
    return {
      kind: row.kind,
      title: row.title,
      body: row.body,
      actions_json: row.actions_json,
      basis: "current",
    };
  }
  return null;
}

export type BuildOptions = {
  /**
   * False when no database was available: the joins are then absent
   * evidence, not counter-evidence, and no label may be contradicted by
   * a row that was never read.
   */
  joined?: boolean;
};

/** One turn + the tables → a labelled dispatch record. */
export function buildRecord(
  turn: DispatchTurn,
  tables: FleetTables,
  options: BuildOptions = {},
): DispatchRecord {
  const joined = options.joined ?? true;
  const { primary, classes, basis } = classifyTurn(turn.names, turn.cardKinds);
  const tasks: TaskJoin[] = [];
  const cards: CardJoin[] = [];
  for (const call of turn.calls) {
    if (SPAWN_TOOLS.includes(call.name)) {
      const taskId = call.result ? taskIdFromSpawnResult(call.result.text) : null;
      if (taskId) tasks.push(joinTask(taskId, call.name, tables));
      continue;
    }
    if (STEER_TOOLS.includes(call.name) || SETTLE_TOOLS.includes(call.name)) {
      const taskId = stringArg(call.args, "task_id");
      if (taskId) tasks.push(joinTask(taskId, call.name, tables));
      continue;
    }
    if (call.name === CARD_TOOL) {
      const recordedKind = stringArg(call.args, "kind");
      const kind = recordedKind ?? cardWordOf(call.args);
      const title = stringArg(call.args, "title") ?? "";
      const cardId = call.result ? cardIdFromEmitResult(call.result.text) : null;
      const observedAt = call.result?.at;
      const byId = cardId ? tables.cards.get(cardId) : undefined;
      // Older results carry no id: fall back to the emitted title, which the
      // store keeps verbatim, and only when it is unambiguous.
      const byTitle = byId
        ? undefined
        : pickByTitle(
            tables.cardsByTitle.get(title),
            title,
            observedAt ?? turn.at,
            tables.cardRevisions,
          );
      const row = byId ?? byTitle;
      if (!row) {
        cards.push({ card_id: cardId, kind, title, found: false });
        continue;
      }
      const raised = tables.cardRaised.get(row.id);
      const resolved = tables.cardResolved.get(row.id);
      const decision = tables.decisionByCard.get(row.id);
      const work = raised?.taskId ?? row.task_id ?? decision?.id ?? null;
      const revisions = tables.cardRevisions.get(row.id) ?? [];
      const version =
        observedAt === undefined || observedAt === null
          ? revisions.length === 0
            ? cardVersionAt(row, revisions, turn.at)
            : null
          : cardVersionAt(row, revisions, observedAt);
      const actions = version ? declaredActionsOf(version.actions_json) : [];
      const legacy =
        version !== null && (recordedKind !== undefined || version.kind !== "card");
      const resolution = version
        ? resolutionOf({ ...row, actions_json: version.actions_json }, resolved, { legacy })
        : row.resolved_at === null
          ? "open"
          : "unknown";
      cards.push({
        card_id: row.id,
        kind,
        title: version?.title ?? title,
        found: true,
        joined_via: byId ? "tool-result-id" : "title",
        task_id: work,
        task_via: raised
          ? "task-event"
          : row.task_id
            ? "cards.task_id"
            : decision
              ? "decision-record"
              : null,
        ...(version ? { body: version.body, actions } : {}),
        actions_version: version?.basis ?? "unknown",
        author: row.author,
        status: row.status,
        created_at: row.created_at,
        resolved_at: row.resolved_at,
        chosen_action: row.chosen_action,
        ...chosenEffectOf(actions, row.chosen_action, resolution, {
          legacy,
          cardId: row.id,
          author: row.author,
        }),
        resolved_by: resolved?.actor ?? null,
        revisions: revisions.length,
        resolution,
        duplicate_of: row.duplicate_of ?? null,
        duplicate_note: row.duplicate_note ?? null,
        duplicate_at: row.duplicate_at ?? null,
      });
      // The work a decision joins to is part of the turn's outcome: without
      // it a card-only turn had no task at all in the record.
      if (work && !tasks.some((task) => task.task_id === work)) {
        tasks.push(joinTask(work, "emit_card", tables));
      }
    }
  }

  const evidence: string[] = [];
  let confidence: DispatchRecord["label"]["confidence"] = "observed";
  const referenced = joined ? tasks : [];
  if (!joined && (tasks.length > 0 || cards.length > 0)) {
    evidence.push("no database was joined, so the turn's effects are unverified");
  }
  if (referenced.length > 0) {
    if (referenced.every((task) => task.found)) {
      confidence = "corroborated";
      for (const task of referenced) {
        evidence.push(`task ${task.task_id} (${task.via}) is ${task.status} in tasks`);
      }
    } else {
      confidence = "contradicted";
      for (const task of referenced.filter((t) => !t.found)) {
        evidence.push(`task ${task.task_id} (${task.via}) has no row in tasks`);
      }
    }
  }
  const decisionCards = joined ? cards.filter((card) => card.kind === "decision") : [];
  for (const card of decisionCards) {
    if (!card.found) continue;
    if (card.resolution === "acted") {
      if (confidence !== "contradicted") confidence = "corroborated";
      evidence.push(
        `decision card ${card.card_id} answered with "${card.chosen_action}" (${card.captain_contact})`,
      );
    } else if (card.resolution === "dismissed") {
      confidence = "contradicted";
      evidence.push(`decision card ${card.card_id} was dismissed without an action`);
    } else if (card.resolution === "retired") {
      // Withdrawn by the host or its emitter: the captain never answered it,
      // so it neither corroborates nor contradicts anything.
      evidence.push(
        `decision card ${card.card_id} was withdrawn ("${card.chosen_action}"), not answered`,
      );
    } else if (card.resolution === "unknown") {
      evidence.push(`decision card ${card.card_id} has no persisted version covering this turn`);
    } else {
      evidence.push(`decision card ${card.card_id} is still open`);
    }
  }
  if (turn.turnFailed) {
    evidence.push("the provider turn failed, so the tools are not the whole decision");
  }

  const label = goldLabel(primary, basis, confidence, evidence);
  if (
    turn.kind_basis === "ambiguous-framing" ||
    cards.some((card) => card.actions_version === "unknown")
  ) {
    label.gold_class = null;
    label.unknown = true;
    label.evidence.push(
      turn.kind_basis === "ambiguous-framing"
        ? "turn framing is ambiguous: no captain boundary was established"
        : "a joined card has no persisted version covering this turn",
    );
  }

  return redactDeep({
    ...turn,
    inferred: inferClassFromNames(turn.names),
    observed_class: primary,
    classes,
    restraint: {
      tool_calls: turn.calls.length,
      spawns: turn.names.filter((n) => SPAWN_TOOLS.includes(n)).length,
      steers: turn.names.filter((n) => STEER_TOOLS.includes(n)).length,
      cards: turn.cardKinds.length,
      decision_cards: turn.cardKinds.filter((k) => k === "decision").length,
      note_cards: turn.cardKinds.filter((k) => k === "note").length,
    },
    outcome: { tasks, cards },
    label,
  });
}

/**
 * The honest label. A class the turn's own tools exercised is a (weak)
 * gold target; a class read off the SHAPE of a card it emitted is not - a
 * card with actions reads as a decision, which says how the host dresses
 * it, not what the Firstmate set out to do. Such a turn now exports with no
 * gold class and `unknown: true` rather than a guess a trainer would read
 * as ground truth.
 */
function goldLabel(
  primary: DispatchClass,
  basis: "tool" | "card-shape" | "fallback",
  confidence: DispatchRecord["label"]["confidence"],
  evidence: string[],
): DispatchRecord["label"] {
  if (basis === "card-shape") {
    return {
      gold_class: null,
      weak: true,
      unknown: true,
      basis,
      confidence,
      evidence: [
        ...evidence,
        `class ${primary} is the emitted card's shape, not an observed move: no gold intent`,
      ],
    };
  }
  return { gold_class: primary, weak: true, unknown: false, basis, confidence, evidence };
}

function pickByTitle(
  rows: CardRow[] | undefined,
  title: string,
  at: number,
  revisionsByCard: Map<string, CardRevisionRow[]>,
): CardRow | undefined {
  if (!rows || rows.length === 0) return undefined;
  const covering = rows.filter((row) => {
    if (row.created_at > at) return false;
    const version = cardVersionAt(row, revisionsByCard.get(row.id) ?? [], at);
    return version?.title === title;
  });
  return covering.length === 1 ? covering[0] : undefined;
}

// --------------------------------------------------------------------------
// The extractor
// --------------------------------------------------------------------------

export type ExtractOptions = {
  /** Explicit transcript files, of either dialect; override the directories when non-empty. */
  sessionFiles?: string[];
  sessionsDir?: string;
  /** The Claude-served sessions' copies (`firstmate/claude/`, W1 S11). */
  claudeSessionsDir?: string;
  dbPath?: string;
  /** Keep `[fm-op]` operational wakes (default true - they are dispatch too). */
  includeOps?: boolean;
};

export type ExtractResult = {
  records: DispatchRecord[];
  /** The transcripts actually read, after the backup copies were excluded. */
  sources: string[];
  dbPath: string | null;
  skippedOps: number;
  /** Files dropped as a second copy of a session already read. */
  backupCopies: string[];
  /** Turns those copies would have contributed - the double count avoided. */
  backupRecordsExcluded: number;
  /** Entries dropped as history a forked session copied from its parent. */
  copiedEntriesExcluded: number;
};

/**
 * One session's file on disk: its header identity, and how much of it there
 * is. Two files carrying the SAME session id are the same session twice - a
 * copy of the sessions directory, a restored backup, a sync conflict - and
 * only the most complete of them is evidence.
 */
type SessionFile = {
  path: string;
  raw: string;
  sessionId: string | null;
  at: number;
  entries: number;
};

function readSessionFile(path: string): SessionFile {
  // The one reader: a Claude-served session arrives in the Pi dialect.
  const raw = readSession(path).text;
  let sessionId: string | null = null;
  let at = 0;
  let entries = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: JsonRecord;
    try {
      entry = JSON.parse(trimmed) as JsonRecord;
    } catch {
      continue;
    }
    if (entry.type === "session") {
      if (typeof entry.id === "string") sessionId = entry.id;
      at = timestampOf(entry) ?? at;
      continue;
    }
    entries += 1;
  }
  return { path, raw, sessionId, at, entries };
}

/**
 * The backup split: for every session id, the most complete file is the one
 * that is read, and every other copy of it is reported as a backup. A file
 * with no readable session header is never grouped - it can only stand for
 * itself. Ties break on the path so a second run picks the same file.
 */
export function splitBackupCopies(files: SessionFile[]): {
  kept: SessionFile[];
  backups: SessionFile[];
} {
  const groups = new Map<string, SessionFile[]>();
  for (const file of files) {
    const key = file.sessionId ? `id:${file.sessionId}` : `path:${file.path}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(file);
    groups.set(key, bucket);
  }
  const kept: SessionFile[] = [];
  const backups: SessionFile[] = [];
  for (const bucket of groups.values()) {
    const ranked = [...bucket].sort(
      (a, b) => b.entries - a.entries || b.raw.length - a.raw.length || a.path.localeCompare(b.path),
    );
    const [first, ...rest] = ranked;
    if (first) kept.push(first);
    backups.push(...rest);
  }
  kept.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
  backups.sort((a, b) => a.path.localeCompare(b.path));
  return { kept, backups };
}

export function extractDispatchCorpus(options: ExtractOptions): ExtractResult {
  const dbPath = options.dbPath && existsSync(options.dbPath) ? options.dbPath : null;
  const tables = dbPath ? readFleetTables(dbPath) : EMPTY_TABLES;
  const files = resolveSessionFiles(options, dbPath);
  const { kept, backups } = splitBackupCopies(files.map(readSessionFile));
  const records: DispatchRecord[] = [];
  // A forked session file carries its parent's entries verbatim (ids and
  // all), so an entry read once is never read again - within this run the
  // copied history is history, not a second turn.
  const seenEntryIds = new Set<string>();
  let skippedOps = 0;
  for (const file of kept) {
    const turns = extractTurnsFromJsonl(file.raw, file.path, { seenEntryIds });
    for (const turn of turns) {
      if (turn.kind === "op" && options.includeOps === false) {
        skippedOps += 1;
        continue;
      }
      records.push(buildRecord(turn, tables, { joined: dbPath !== null }));
    }
  }
  const entriesRead = seenEntryIds.size;
  const copiedEntriesExcluded = kept.reduce((sum, file) => sum + file.entries, 0) - entriesRead;
  // What the excluded copies WOULD have added, counted the same way the
  // kept files are: the number is the point of the exclusion.
  let backupRecordsExcluded = 0;
  for (const file of backups) {
    const turns = extractTurnsFromJsonl(file.raw, file.path, { seenEntryIds: new Set() });
    backupRecordsExcluded += turns.filter(
      (turn) => !(turn.kind === "op" && options.includeOps === false),
    ).length;
  }
  records.sort((a, b) => a.at - b.at || a.turn_index - b.turn_index);
  return {
    records,
    sources: kept.map((file) => file.path),
    dbPath,
    skippedOps,
    backupCopies: backups.map((file) => file.path),
    backupRecordsExcluded,
    copiedEntriesExcluded,
  };
}

function resolveSessionFiles(options: ExtractOptions, dbPath: string | null): string[] {
  const explicit = (options.sessionFiles ?? []).filter((file) => existsSync(file));
  if (explicit.length > 0) return explicit.map((file) => resolve(file));
  const found = new Set<string>();
  for (const dir of [options.sessionsDir, options.claudeSessionsDir]) {
    if (!dir) continue;
    for (const file of sessionFilesIn(dir)) found.add(resolve(file));
  }
  // The settings row names the rolling session even when it sits elsewhere.
  if (dbPath) {
    const recorded = readFirstmateSessionFile(dbPath);
    if (recorded && existsSync(recorded)) found.add(resolve(recorded));
  }
  return [...found].sort();
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const typed = part as JsonRecord;
      return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolCallsFromContent(
  content: unknown,
): { id: string; name: string; args: JsonRecord }[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const typed = part as JsonRecord;
    if (typed.type !== "toolCall" || typeof typed.name !== "string") return [];
    const args =
      typed.arguments && typeof typed.arguments === "object"
        ? (typed.arguments as JsonRecord)
        : {};
    return [{ id: typeof typed.id === "string" ? typed.id : "", name: typed.name, args }];
  });
}

/**
 * The word for a card emitted under one card shape (cards/tasks/agents P1):
 * nothing on the wire declares a kind, so a card with actions is a decision
 * and one without is a note - the same rule the host dresses it by. A
 * recorded session from before P1 still names its kind, and that name is
 * kept verbatim (the caller reads it first).
 */
function cardWordOf(args: JsonRecord): "decision" | "note" {
  const actions = args.actions;
  return Array.isArray(actions) && actions.length > 0 ? "decision" : "note";
}

function stringArg(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}

function modelLabel(provider: unknown, id: unknown): string | null {
  return typeof provider === "string" && typeof id === "string" && provider && id
    ? `${provider}/${id}`
    : null;
}

function timestampOf(entry: JsonRecord): number | null {
  const value = entry.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

export function defaultUserDataDir(): string {
  const override = settingFrom(process.env, "USER_DATA_DIR");
  if (override) return override;
  const appData =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  // The installed app's folder under its newest name that is there: Firstmate
  // 3000's until the one-time move brings it to Infinitary's.
  const folders = userDataFoldersNewestFirst("release").map((folder) => join(appData, folder));
  return folders.find((folder) => existsSync(folder)) ?? join(appData, RELEASE_USER_DATA_FOLDER);
}

export type CliArgs = {
  userData: string;
  sessionsDir: string;
  claudeSessionsDir: string;
  dbPath: string;
  sessionFiles: string[];
  out: string | null;
  includeOps: boolean;
  help: boolean;
};

export function parseArgs(argv: string[]): CliArgs {
  let userData = defaultUserDataDir();
  let sessionsDir: string | null = null;
  let claudeSessionsDir: string | null = null;
  let dbPath: string | null = null;
  const sessionFiles: string[] = [];
  let out: string | null = null;
  let includeOps = true;
  let help = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    // pnpm forwards its own `--` separator; it is not an argument.
    if (arg === "--") continue;
    if (arg === "--user-data") userData = next();
    else if (arg === "--sessions") sessionsDir = next();
    else if (arg === "--claude-sessions") claudeSessionsDir = next();
    else if (arg === "--db") dbPath = next();
    else if (arg === "--session-file") sessionFiles.push(next());
    else if (arg === "--out" || arg === "-o") out = next();
    else if (arg === "--user-turns-only") includeOps = false;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return {
    userData,
    sessionsDir: sessionsDir ?? join(userData, "firstmate", "sessions"),
    claudeSessionsDir: claudeSessionsDir ?? join(userData, "firstmate", "claude"),
    dbPath: dbPath ?? join(userData, "firstmate.db"),
    sessionFiles,
    out,
    includeOps,
    help,
  };
}

const USAGE = `Extract the Infinitary dispatch corpus (PoC-2 C5) from the Firstmate's sessions + firstmate.db.

  pnpm extract:dispatch [options]      (or: node scripts/extract-dispatch-corpus.ts)

  --user-data <dir>     app userData dir (default: the platform userData path,
                        or INFINITARY_USER_DATA_DIR); an exported copy works too
  --sessions <dir>      transcripts dir (default: <user-data>/firstmate/sessions)
  --claude-sessions <dir>
                        Claude-served transcripts (default: <user-data>/firstmate/claude)
  --db <path>           firstmate.db (default: <user-data>/firstmate.db)
  --session-file <path> one transcript; repeatable, overrides --sessions
  --out, -o <path>      write JSONL here (default: stdout)
  --user-turns-only     drop [fm-op] operational wakes
  --help, -h

Everything stays on this machine: it reads, it never writes to the app.`;

export function summarize(result: ExtractResult): string {
  const byClass = new Map<string, number>();
  for (const record of result.records) {
    byClass.set(record.observed_class, (byClass.get(record.observed_class) ?? 0) + 1);
  }
  const classes = [...byClass.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
  const corroborated = result.records.filter((r) => r.label.confidence === "corroborated").length;
  const unknown = result.records.filter((r) => r.label.unknown).length;
  return [
    `sources: ${result.sources.length} transcript(s)`,
    `db: ${result.dbPath ?? "none (records carry no joins)"}`,
    `records: ${result.records.length} (${corroborated} corroborated by the join, ` +
      `${unknown} with no gold intent)`,
    `classes: ${classes || "none"}`,
    `excluded: ${result.backupCopies.length} backup copy/copies ` +
      `(${result.backupRecordsExcluded} turn(s)), ` +
      `${result.copiedEntriesExcluded} copied entry/entries`,
  ].join("\n");
}

export function main(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const result = extractDispatchCorpus({
    sessionFiles: args.sessionFiles,
    sessionsDir: args.sessionsDir,
    claudeSessionsDir: args.claudeSessionsDir,
    dbPath: args.dbPath,
    includeOps: args.includeOps,
  });
  if (result.sources.length === 0) {
    process.stderr.write(
      `No transcripts found in ${args.sessionsDir} or ${args.claudeSessionsDir}. Point --user-data or --sessions at an exported copy.\n`,
    );
    return 1;
  }
  const jsonl = `${result.records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  if (args.out) {
    writeFileSync(args.out, jsonl);
    process.stderr.write(`${summarize(result)}\nwrote: ${args.out}\n`);
  } else {
    process.stdout.write(jsonl);
    process.stderr.write(`${summarize(result)}\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
