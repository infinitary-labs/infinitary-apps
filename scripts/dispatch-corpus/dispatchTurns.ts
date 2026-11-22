/**
 * The dispatch extractor's turns (`scripts/extract-dispatch-corpus.ts`):
 * the tool sets each dispatch class reads, one session's Pi-dialect text
 * back into the Firstmate turns it holds, the `[fm-op]` context block back
 * into the fleet it described, and the class each turn exercised.
 */

import { decode } from "@toon-format/toon";
import { basename } from "node:path";
import { parseServedInput } from "../../src/shared/servedFrame.ts";
import { cardWordOf } from "./cards.ts";

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
export const SPAWN_TOOLS = ["spawn_crewmate", "create_task"];
export const SETTLE_TOOLS = ["settle_task"];
export const STEER_TOOLS = ["steer_crewmate", "interrupt_crewmate"];
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
  // Moving a started task to another computer (INF-1713) changes where it
  // runs, never what it does: fleet management, like the graph edits.
  "move_task",
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
  // A flagged case can publish an offer, recover its effect and guide affected work.
  "correction_case",
];
/** Reading: it serves a class, it is never one. A turn that only read has
 * still answered the user out of what it read. `app_state` looks at the
 * action catalog and `knowledge` at what the crew learned; neither changes
 * anything. `integrations` lists what the captain connected and
 * `use_integration` reads through one: a change there waits for the
 * captain's click on a card the host raises, not on the first mate's move
 * (docs/integrations.md). `open_work` reads open messages and cards back. */
const READ_TOOLS = [
  "crew_status",
  "supervision_log",
  "check_pr_ci",
  "tasks",
  "app_state",
  "knowledge",
  "integrations",
  "use_integration",
  "open_work",
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
export const CARD_TOOL = "emit_card";
/**
 * The first mate's ask to keep a secret (src/core/pi/secretTools.ts): the
 * host raises its own decision card for the captain, so the turn asked.
 */
const SECRET_ASK_TOOL = "ask_secret";

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
 * `FirstmateContext.buildContextBlock` writes. Anything it cannot parse stays
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
    // A context of changes (INF-1712) holds only what moved since the one
    // before it: its fleet is not stated, so it lists none.
    if (typeof record.delivery === "string" && record.delivery.startsWith("changes"))
      return { ...record, repos: [], crew: [] };
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
  if (names.includes(SECRET_ASK_TOOL)) return "ask";
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
  if (names.includes(SECRET_ASK_TOOL)) classes.push("ask");
  const fromTools = classes.length;
  if (cardKinds.includes("decision") && !classes.includes("ask")) classes.push("ask");
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

export function stringArg(args: JsonRecord, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value ? value : undefined;
}

function modelLabel(provider: unknown, id: unknown): string | null {
  return typeof provider === "string" && typeof id === "string" && provider && id
    ? `${provider}/${id}`
    : null;
}

export function timestampOf(entry: JsonRecord): number | null {
  const value = entry.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
