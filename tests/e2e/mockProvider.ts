import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import type { ServedSegment } from "@shared/servedFrame";
import {
  ANSWER_MISSING_ENDED_OPENING,
  ANSWER_MISSING_OPENING,
} from "../../src/core/orchestrator/captainWakes";
import { WELCOME_WAKE_WORDS } from "../../src/core/orchestrator/noticeWakes";
import { FINISHED_REPORT_WORDS } from "../../src/core/orchestrator/reportWakes";
import { FIRSTMATE_PERSONA, KIND_CLASSIFIER_OPENING } from "../../src/core/pi/piResources";
import { CLAUDE_SEAT_TOOL_PREFIX } from "../../src/core/storage/sessionReader";
import {
  beginAnthropicStream,
  finishAnthropicStream,
  writeAnthropicError,
  writeAnthropicText,
  writeAnthropicToolUse,
} from "../helpers/anthropicDialect";
import type { ScriptedArgs, ScriptedCall } from "../helpers/scriptedCalls";
import { WRITE_ASK_ANSWER_MARKER } from "./apiWriteCases";
import {
  CLAUDE_CREW_PROMPT_MARKER,
  CLAUDE_ORG_REFUSAL_MESSAGE,
  type CrewScriptAnswer,
  crewScriptAnswer,
  MOCK_CLAUDE_HELD_PROGRESS,
} from "./crewScripts";
import { MOCK_MODEL_ID } from "./mockModels";
import {
  contextRepos,
  findCrewTaskId,
  holdsSegment,
  latestServedTurn,
  type ServedTurn,
  scriptedResponseInput,
} from "./providerRequest";
import { starterFor } from "./starters";

/**
 * A minimal OpenAI-completions-compatible server so e2e runs exercise the
 * real Pi pipeline (session -> provider request -> streamed deltas -> card)
 * without real credentials or network. The app points at it through its
 * app-scoped models.json - exactly how a real custom provider would connect
 * (`mockModels.ts`). It answers the first mate's own commands, a journey's
 * scenarios (`scenarios/`) and the built-in crew scripts (`crewScripts.ts`),
 * and reads each request through `providerRequest.ts`.
 */
export const MOCK_COMPLETION_TEXT =
  "Steady as she goes. The worktree is ready and this report streamed from the mock provider.";

/** Where the fetch probe card aims: the mock server itself, which counts every hit. */
export const CARD_FETCH_PROBE_PATH = "/card-fetch-probe";
export const SCRIPT_CARD_TITLES = {
  canvas: "Canvas probe",
  fetch: "Fetch probe",
  runaway: "Runaway probe",
  figure: "Figure probe",
} as const;

/**
 * The risk every mock crewmate declares on its completion decision
 * (FI3-1128; docs/card-authoring.md "The risk chart"): the real emit_card
 * refuses a merge card without one, so a scripted crewmate call that
 * merges and names none is given this one on the wire, as a crewmate is
 * told to give its own. A saved-story card takes its risk from that story instead.
 */
export const MOCK_RISK = {
  blast: { level: "medium", why: "The meter and its settings row" },
  behavior: { level: "low", why: "Corrects how the meter reads" },
  undo: { level: "low", why: "A revert restores the old meter" },
  evidence: { level: "medium", why: "The meter test" },
  sensitivity: { level: "low", why: "No sign-in, data or release code" },
  novelty: { level: "low", why: "Edits the existing reading" },
  deps: { level: "low", why: "Nothing added" },
} as const;

function withDeclaredRisk(call: ScriptedCall): ScriptedCall {
  if (call.name !== "emit_card") return call;
  // Named, not narrowed: the live tool set is a union too wide for the
  // compiler to narrow by name alone.
  const args = call.args as ScriptedArgs<"emit_card">;
  const merges = args.actions?.some((action) => action.effect?.kind === "merge");
  return merges && (!("presentation" in args) || args.presentation === undefined)
    ? ({
        ...call,
        args: {
          ...args,
          risk: ("risk" in args ? args.risk : undefined) ?? MOCK_RISK,
          required_actions: args.required_actions ?? [],
        },
      } as ScriptedCall)
    : call;
}

/**
 * Delivery rigor, phase 1 (the standard tier): a spawn whose title carries
 * this asks for the standard tier; the crewmate that reports under its five
 * headings is `scenarios/standardTier.ts`, its words `crewCards.ts`.
 */
export const STANDARD_TIER_PROMPT_MARKER = "ship at the standard tier";
/**
 * A spawn whose title carries either of these is filed under
 * THREAD_TREE_PARENT_KEY; the sibling that keeps working is held open by
 * `scenarios/threadSettle.ts`.
 */
export const THREAD_TREE_PROMPT_MARKER = "with a waiting tree";
export const THREAD_TREE_PARENT_KEY = "SCR-1";
export const THREAD_WORKING_SIBLING_MARKER = "keep the sibling working";

/** Scripted retrieval exercises plumbing, not live semantic accuracy. */
export const RETRIEVAL_TASK_ASK =
  "Explain why meterlab's release-info.json says this release has video demos, with a citation.";
export const RETRIEVAL_TASK_GOAL =
  "Explain from release-info.json why its release reports video demos, citing its fields; do not test playback.";

/**
 * The host-attached completion buttons and the freed body (contract v3.6,
 * captain lock 3). Briefed with this marker on a direct-pr repository, the
 * mock crewmate emits a completion card that declares ONE action - a merge
 * under a label of its own invention - and a body with the completion
 * outline and a figure rather than the five-heading report record. Both are
 * what the audit's
 * locks changed: the host writes the pair from the task's posture, and the
 * lint no longer asks a card for the record the report and the PR carry.
 */
export const STANDARD_TIER_HOST_BUTTONS_MARKER = "ship at the standard tier with host buttons";
/**
 * Review carefully (INF-562). A spawn whose title carries this asks for the
 * standard tier; the careful builder and its review are
 * `scenarios/reviewCarefully.ts`.
 */
export const REVIEW_CAREFULLY_MARKER = "ship at default care, then review carefully";
/** A spawn whose title carries this asks for the reviewed tier; the reviewer itself is `scenarios/reviewedTier.ts`. */
export const REVIEWED_TIER_PROMPT_MARKER = "ship at the reviewed tier";
/**
 * The captain's words on who merges (contract v3.9): a spawn whose title
 * carries this asks `autonomy_ask: true`; the autonomy-hold crewmate is
 * `scenarios/autonomy.ts`. Short on purpose: a task title is capped at 64
 * characters.
 */
export const AUTONOMY_ASK_MARKER = "merge it yourself";
/** "merge the task <title>" -> settle_task merge-pr, so a held merge is observable. */
export const MERGE_PROMPT_MARKER = "merge the task ";
/** The follow-up `scenarios/fileFollowup.ts` files; the kind classifier sorts it as research. */
export const MOCK_FOLLOWUP_TITLE = "Flaky meter test";

/**
 * The model a commission whose title carries CLAUDE_CREW_PROMPT_MARKER
 * (`crewScripts.ts`) or CLAUDE_CREWMATE_MARKER is pinned to through
 * `override_model_id`: a Claude crewmate.
 */
export const CLAUDE_CREW_MODEL = `anthropic-claude/${starterFor("anthropic-claude", "low")}`;
/**
 * A commission whose title carries this is put on the Claude crew model
 * too, like CLAUDE_CREW_PROMPT_MARKER, without that marker's own script:
 * the rest of the title picks the crewmate's script, so one journey runs on
 * a Pi crewmate and a Claude crewmate alike (task-browser-booking.spec.ts).
 */
export const CLAUDE_CREWMATE_MARKER = "with a Claude crewmate";

/**
 * The Firstmate on the Claude seat (W1 S12). A captain turn carrying
 * FM_SEAT_HOLD_MARKER looks at the crew, then its next step is held open -
 * the model still working - until the spec calls `releaseHeldFirstmate`,
 * which answers it with another look at the crew. A steer the captain sent
 * meanwhile rides into the running turn at that step; a request carrying
 * FM_SEAT_STEER_WORD answers with the FM_SEAT_STEERED_TITLE card.
 */
export const FM_SEAT_HOLD_MARKER = "keep looking at the crew";
export const FM_SEAT_STEER_WORD = "and check the anchor chain";
export const FM_SEAT_STEERED_TITLE = "Anchor chain checked";

/**
 * A Claude seat cut off (`cutClaudeSeat`): the typed refusal every
 * Firstmate request the Claude client makes meets, per class - the
 * vendor's 401, a 429 on a spent plan with its reset, or its 403
 * organisation refusal.
 */
type ClaudeSeatCut =
  | { class: "signed_out" }
  | { class: "no_headroom"; resetsAt: number }
  | { class: "refused" };

/**
 * Orchestrator markers. "commission a crewmate: <title>" makes the mock
 * Firstmate call spawn_crewmate with that title (bound to a registered repo
 * when the title names one from the context block); "answer with a card"
 * makes it emit one note answer card. Anything else is chit-chat: plain
 * text that the app does not map to a feed line or a card. A behavior only
 * some journeys need is a scenario under `tests/e2e/scenarios/`.
 */
// e2e-typed-words: the captain's own words that start a scripted spawn; they only share a phrase with the product's
export const SPAWN_PROMPT_MARKER = "commission a crewmate:";
/** The error the mock answers a non-auth failure turn with (`FAIL_PROVIDER_PROMPT_MARKER`). */
export const MOCK_PROVIDER_FAILURE = "mock deterministic provider failure";
/** The goal the mock Firstmate gives the crewmate it spawns for "commission a crewmate: <title>". */
export const mockSpawnGoal = (title: string) =>
  `Complete the task "${title}" and report the outcome.`;
// e2e-typed-words: the captain's own words that ask the mock for an answer card; they only share a phrase with the product's
export const ANSWER_PROMPT_MARKER = "answer with a card";
export const TALL_ANSWER_PROMPT_MARKER = `a tall ${ANSWER_PROMPT_MARKER}`;
/**
 * The first-launch welcome wake (docs/first-launch.md): the host's wake
 * says the captain "has never seen a card", and the mock Firstmate answers
 * it with one standalone note - the app's first card.
 */
const MOCK_WELCOME_TITLE = "How I work";
// e2e-typed-words: the mock Firstmate's own welcome note, written as the wake asks; it only shares a phrase with the wake
const MOCK_WELCOME_TEXT =
  "<p>Ask for something and a card comes back: an answer, a decision, or word that a crewmate is on it. There is no chat to scroll.</p><p>Start by pointing me at a project.</p>";
/**
 * Talk-to-personalize Step 1 (Tier A): the mock Firstmate answers
 * "catalog change <json>" with ONE app_change call of those arguments and
 * no card, the way the contract says.
 */
export const APP_CATALOG_PROMPT_MARKER = "catalog change ";
/** Provider-failure markers: the mock rejects the request itself, so the
 * turn ends with Pi's stopReason "error" path (report REPRO A). */
export const FAIL_AUTH_PROMPT_MARKER = "fail this turn with a 401";
export const FAIL_PROVIDER_PROMPT_MARKER = "fail this turn with a provider error";
export const LAND_PROMPT_MARKER = "land the task ";
/** Steer marker: "steer the task <title>: <guidance>" -> steer_crewmate on that task. */
export const STEER_PROMPT_MARKER = "steer the task ";
export const DISCARD_PROMPT_MARKER = "discard the task ";
/**
 * "finish the task <title>" -> settle it. WI-11 retired the `finish` mode
 * and the `delivered` status, so the mock now lands the task (the successor
 * close for an idle crewmate whose work is accepted): a scratch task lives
 * in the app-managed default repo, so landing its unchanged branch is a
 * clean fast-forward that closes the record as done/landed.
 */
export const FINISH_PROMPT_MARKER = "finish the task ";
export const CANCEL_PROMPT_MARKER = "cancel the task ";
/**
 * The mock Firstmate's one sentence for each close of started work it makes
 * (INF-547): the tools refuse such a close without one, and a close that
 * leaves nothing of the task on the stack puts it up as the Firstmate's note.
 */
export const MOCK_CLOSING_SENTENCES = {
  "merge-pr": "The pull request is merged, as the captain asked.",
  land: "The branch is merged into the project, as the captain asked.",
  discard: "Not needed any more, as the captain asked.",
  released: "It went out in the verified external release.",
  cancel: "Stopped, as the captain asked.",
} as const;

/**
 * The Responses dialect Codex's client speaks (`POST .../codex/responses`,
 * server-sent events), for a Firstmate seat moved onto Codex. Its client
 * tries a WebSocket first; this server takes no upgrade, so the client falls
 * back to these events, as it does wherever a socket cannot open.
 */
function writeResponsesEvent(
  res: ServerResponse,
  data: { type: string } & Record<string, unknown>,
) {
  res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function beginResponsesStream(res: ServerResponse, request: number): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  writeResponsesEvent(res, {
    type: "response.created",
    response: { id: `resp_mock_${request}`, status: "in_progress" },
  });
}

function finishResponsesStream(
  res: ServerResponse,
  request: number,
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): void {
  writeResponsesEvent(res, {
    type: "response.completed",
    response: {
      id: `resp_mock_${request}`,
      status: "completed",
      usage: {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
      },
    },
  });
  res.end();
}

/** Claude's client serves its own shell to a coding session as `Bash`, where Pi serves `bash`. */
const CLAUDE_SHELL = "Bash";

/**
 * The name a scripted call goes out under: the way the request serves the
 * tool. Claude's client serves an in-process tool under a prefix: the app's
 * tool server is named `infinitary`, so `emit_card` reaches the model as
 * `mcp__infinitary__emit_card` (docs/claude-client.md). The scripts name
 * tools as the app does; the Anthropic dialect adds the prefix where the
 * request declared it, so one marker drives a Pi turn and a Claude turn.
 */
function servedToolName(body: string, name: string): string {
  const prefixed = `${CLAUDE_SEAT_TOOL_PREFIX}${name}`;
  if (body.includes(`"name":"${prefixed}"`)) return prefixed;
  if (name === "bash" && body.includes(`"name":"${CLAUDE_SHELL}"`)) return CLAUDE_SHELL;
  return name;
}

/** Work whose title carries this is sorted as a chore by the mock classifier. */
export const CLASSIFY_CHORE_MARKER = "tidy the rivet gauge";
export const MOCK_ANSWER_TITLE = "Mock answer";
export const MOCK_ANSWER_TEXT = "Codex has 62% of the weekly window left and is on pace.";
export const MOCK_FM_CHAT_TEXT = "All quiet on deck.";

/**
 * Answer delivery (docs/task-capture.md): a captain message the mock answers
 * with hidden closing words only. The retry then shows one answer card
 * (default), nothing at all (`RETRY_SILENT_MARKER`) or tries to put work on
 * the record, which the retry refuses (`RETRY_ACTS_MARKER`).
 */
export const SILENT_ANSWER_MARKER = "say nothing the captain can see";
/** A captain message the mock acknowledges with a reaction, which covers it. */
export const REACT_PROMPT_MARKER = "give a thumbs up";
export const RETRY_SILENT_MARKER = "stay silent again";
export const RETRY_ACTS_MARKER = "try to start work in the retry";
const RETRY_ACTS_TASK_TITLE = "Work the retry tried to start";
export const RETRY_ANSWER_TITLE = "Here is the answer";
const RETRY_ANSWER_BODY = "<p>The retry showed this answer in a card.</p>";
/** Closing words with markup and a script, which must never become a card. */
const SILENT_CLOSING_WORDS = "<p>HIDDEN closing words</p><script>alert(1)</script>";
export const MOCK_FM_DONE_TEXT = "The crew has it under way.";

/** The step goal a sequences reproduce step carries; the kind classifier sorts it (`scenarios/sequences.ts`). */
export const SEQ_REPRODUCE_GOAL =
  "as reported, in a clean setup; open your report with reproduced:";

/**
 * What became of a Firstmate turn a spec scripted ahead: `armed` until its
 * input is served, `answered` once its calls went out, `closed` once their
 * results came back. `unmatched` is the bounded diagnostic - the other
 * inputs the Firstmate was served while it waited, newest last - and
 * `results` what came back for its calls.
 */
type ScriptedTurnOutcome = {
  state: "armed" | "answered" | "closed";
  unmatched: string[];
  results: string[];
};

/** How many unmatched inputs a scripted turn keeps, and how much of each. */
const SCRIPTED_DIAGNOSTIC_LIMIT = 5;
const SCRIPTED_DIAGNOSTIC_CHARS = 240;

const clipped = (text: string) =>
  text.length > SCRIPTED_DIAGNOSTIC_CHARS ? `${text.slice(0, SCRIPTED_DIAGNOSTIC_CHARS)}...` : text;

/** A served turn, in brief: who each non-context segment came from and what it opens with. */
function servedSummary(turn: ServedTurn | undefined): string {
  if (!turn) return "(an input the host did not frame)";
  const parts = turn.segments
    .filter((segment) => segment.kind !== "context")
    .map((segment) => `${segment.kind} ${segment.origin ?? "(no origin)"}: ${segment.body}`);
  return clipped(parts.join(" | ") || "(context only)");
}

/** What a journey's scenario reads of one request. */
export type ScenarioRequest = {
  body: string;
  isFirstmate: boolean;
  wantsStream: boolean;
  latestUserTail: string;
  hasToolResults: boolean;
  /** Whether it came on Anthropic's messages wire, the one Claude's client speaks. */
  anthropicMessages: boolean;
  /** The stand-in's own port, for a card that loads a page the stand-in serves. */
  port: number;
};
/**
 * A scenario's answer: tool calls, text, or a refusal the way the service
 * sends one, or `held`, a turn the stand-in keeps open the way a crewmate
 * goes on working. `afterMs` holds the answer back that long, the way a real
 * model takes its time over a turn's last line.
 */
export type ScenarioAnswer = (
  | { calls: ScriptedCall[] }
  | { text: string }
  | { refusal: { status: number; error: { type: string; message: string } } }
  | { held: true }
) & { afterMs?: number };
/**
 * A journey's own stand-in behavior, in its own file under
 * `tests/e2e/scenarios/` (`docs/testing.md`, "A journey's own scenarios").
 * The stand-in starts each named scenario once, so its state lives as long
 * as that stand-in, and asks the answerers in the order named; an
 * answerer returns undefined to pass the request on.
 */
export type Scenario = () => (request: ScenarioRequest) => ScenarioAnswer | undefined;

export type MockProviderServer = {
  port: number;
  requests: () => number;
  /** Observe decoded requests, including history, without retaining authentication headers. */
  recordRequests: (record: (body: string) => void) => () => void;
  /** Reject every Firstmate inference, including any unexpected setup composition. */
  failFirstmate: (fail: boolean) => void;
  /** Raw completion request bodies, oldest first (contract tests). */
  requestBodies: () => string[];
  /** The headers of each completion request, in the same order as requestBodies. */
  requestHeaders: () => IncomingHttpHeaders[];
  /** Requests that reached CARD_FETCH_PROBE_PATH (a scripted card must never land one). */
  cardFetchProbeHits: () => number;
  /** Crewmate steps held open right now, a turn waiting on the model (CLAUDE_CREW_PROMPT_MARKER). */
  heldRequests: () => number;
  /** Answer every held crewmate step with a progress note (MOCK_CLAUDE_HELD_PROGRESS). */
  releaseHeldCrew: () => void;
  /** Refuse the refused-login crewmate's turns (CLAUDE_REFUSED_PROMPT_MARKER), or stop. */
  refuseClaude: (refusing: boolean) => void;
  /** Cut the Firstmate's Claude seat off with a class's typed refusal, or stop (null). */
  cutClaudeSeat: (cut: ClaudeSeatCut | null) => void;
  /** Firstmate steps held open right now (FM_SEAT_HOLD_MARKER). */
  heldFirstmate: () => number;
  /** Answer every held Firstmate step with another look at the crew. */
  releaseHeldFirstmate: () => void;
  /** Thread-crewmate steps held after an acknowledgement (THREAD_ACK_REPLY). */
  heldThreadAnswers: () => number;
  /** Let every held thread answer go on: the revision, then the report. */
  releaseThreadAnswer: () => void;
  /**
   * Script the Firstmate's answer to one input the spec knows ahead: when a
   * Firstmate turn's newest served input holds exactly this segment - kind,
   * origin and body, as `captainCardChoice` renders it - the mock answers
   * with these calls, once, and closes the loop briefly. Nothing else
   * answers it, and no phrase in a body is read. The outcome is the spec's
   * checkpoint.
   */
  scriptFirstmateTurn: (
    input: ServedSegment,
    calls: ScriptedCall[],
  ) => { outcome: () => ScriptedTurnOutcome };
  close: () => Promise<void>;
};

export function settleNeedle(haystack: string, marker: string): string {
  const after = haystack.split(marker)[1] ?? "";
  return after.split(/["\\]/)[0]?.trim() ?? "";
}

export async function startMockProvider(
  options: { scenarios?: readonly Scenario[] } = {},
): Promise<MockProviderServer> {
  const scenarios = (options.scenarios ?? []).map((start) => start());
  let requestCount = 0;
  let failFirstmate = false;
  let cardFetchProbeHits = 0;
  const requestBodies: string[] = [];
  const recorders = new Set<(body: string) => void>();
  const requestHeaders: IncomingHttpHeaders[] = [];
  /** Held crewmate steps, each with the request that opened it. */
  const held = new Map<ServerResponse, { body: string; request: number }>();
  /** The thread crewmate's work after its acknowledgement, waiting on the spec. */
  const heldThreadAnswers: (() => void)[] = [];
  let refusingClaude = true;
  let seatCut: ClaudeSeatCut | null = null;
  /** Held Firstmate steps, each with the request that opened it. */
  const heldFirstmate = new Map<ServerResponse, { body: string; request: number }>();
  /** The Firstmate turns a spec scripted ahead (`scriptFirstmateTurn`), oldest first. */
  const scripted: Array<{
    input: ServedSegment;
    calls: ScriptedCall[];
    outcome: ScriptedTurnOutcome;
  }> = [];
  const server: Server = createServer((req, res) => {
    if (req.method === "HEAD" && req.url === "/api/hello") {
      // Claude's client checks it can reach its API before a session starts.
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.url?.startsWith(CARD_FETCH_PROBE_PATH)) {
      // A scripted card that could reach the network would land here.
      cardFetchProbeHits += 1;
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      res.end("reached");
      return;
    }
    // Claude's client, and Pi's OpenRouter catalog for Claude models, take
    // Anthropic's messages wire. The mock still decides from the raw body
    // (the markers are in the text); only the wire format changes
    // (`tests/helpers/anthropicDialect.ts`). A follow-up leg carries
    // `tool_use_id`.
    const anthropicMessages =
      req.method === "POST" &&
      Boolean(req.url?.includes("/messages")) &&
      !req.url?.includes("/chat/completions");
    // The Responses dialect: Codex's client at `/codex/responses`, and a key
    // provider served over Responses (Grok, `/v1/responses`) at its own path.
    const responsesDialect =
      req.method === "POST" && Boolean(req.url?.split("?")[0]?.endsWith("/responses"));
    if (
      req.method === "POST" &&
      (req.url?.includes("/chat/completions") || anthropicMessages || responsesDialect)
    ) {
      requestCount += 1;
      const requestNumber = requestCount;
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        // Codex's client compresses its request body (zstd); read it plain.
        const raw = Buffer.concat(chunks);
        const rawBody = (
          req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw
        ).toString("utf8");
        requestBodies.push(rawBody);
        for (const record of recorders) record(rawBody);
        requestHeaders.push(req.headers);
        // Persona detection: requests carry their session's system prompt,
        // so the persona line identifies who is asking (the Firstmate or a
        // crewmate).
        const isFirstmate = rawBody.includes(FIRSTMATE_PERSONA);
        const scriptedInput = scriptedResponseInput(rawBody, !isFirstmate);
        const body = scriptedInput.body;
        const wantsStream = body.includes('"stream":true') || body.includes('"stream": true');
        // The body carries the whole conversation history, so every check
        // scopes to what follows the LATEST user message: markers from old
        // turns must not re-trigger, and tool results count only when this
        // request is the follow-up leg of the current tool loop.
        const lastUserIndex = Math.max(
          body.lastIndexOf('"role":"user"'),
          body.lastIndexOf('"role": "user"'),
        );
        const latestUserTail = lastUserIndex >= 0 ? body.slice(lastUserIndex) : body;
        const usage = { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 };
        const hasToolResults =
          latestUserTail.includes('"tool_call_id"') ||
          latestUserTail.includes('"tool_use_id"') ||
          latestUserTail.includes('"function_call_output"');

        const streamToolCalls = (scripted: ScriptedCall[]) => {
          // A crewmate's completion decision carries its risk, as the real
          // tool asks; the Firstmate's cards carry none.
          const calls = isFirstmate ? scripted : scripted.map(withDeclaredRisk);
          if (responsesDialect) {
            beginResponsesStream(res, requestNumber);
            calls.forEach((call, index) => {
              const item = {
                type: "function_call",
                id: `fc_${requestNumber}_${index + 1}`,
                call_id: `call_${requestNumber}_${index + 1}`,
                name: call.name,
              };
              const args = JSON.stringify(call.args);
              writeResponsesEvent(res, {
                type: "response.output_item.added",
                output_index: index,
                item: { ...item, arguments: "" },
              });
              writeResponsesEvent(res, {
                type: "response.function_call_arguments.delta",
                output_index: index,
                delta: args,
              });
              writeResponsesEvent(res, {
                type: "response.output_item.done",
                output_index: index,
                item: { ...item, arguments: args },
              });
            });
            finishResponsesStream(res, requestNumber, usage);
            return;
          }
          if (anthropicMessages) {
            beginAnthropicStream(res, usage.prompt_tokens, requestNumber);
            calls.forEach((call, index) => {
              writeAnthropicToolUse(res, index, {
                id: `toolu_${requestNumber}_${index + 1}`,
                name: servedToolName(body, call.name),
                args: call.args,
              });
            });
            finishAnthropicStream(res, "tool_use", usage.completion_tokens);
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
          const base = {
            id: "chatcmpl-mock-tools",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: MOCK_MODEL_ID,
          };
          chunk({
            ...base,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          });
          calls.forEach((call, index) => {
            chunk({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index,
                        id: `call_${requestNumber}_${index + 1}`,
                        type: "function",
                        function: { name: call.name, arguments: "" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            });
            chunk({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }],
                  },
                  finish_reason: null,
                },
              ],
            });
          });
          chunk({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage,
          });
          res.write("data: [DONE]\n\n");
          res.end();
        };

        const streamText = (text: string) => {
          if (responsesDialect) {
            beginResponsesStream(res, requestNumber);
            const item = { type: "message", id: `msg_${requestNumber}`, role: "assistant" };
            writeResponsesEvent(res, {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, content: [] },
            });
            writeResponsesEvent(res, {
              type: "response.output_text.delta",
              output_index: 0,
              delta: text,
            });
            writeResponsesEvent(res, {
              type: "response.output_item.done",
              output_index: 0,
              item: { ...item, content: [{ type: "output_text", text }] },
            });
            finishResponsesStream(res, requestNumber, usage);
            return;
          }
          if (anthropicMessages) {
            beginAnthropicStream(res, usage.prompt_tokens, requestNumber);
            writeAnthropicText(res, 0, text);
            finishAnthropicStream(res, "end_turn", usage.completion_tokens);
            return;
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const chunk = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
          const base = {
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: MOCK_MODEL_ID,
          };
          chunk({
            ...base,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          });
          for (const piece of text.match(/[\s\S]{1,12}/g) ?? []) {
            chunk({
              ...base,
              choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
            });
          }
          chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage });
          res.write("data: [DONE]\n\n");
          res.end();
        };

        // A crewmate's step left waiting on the model: the response starts
        // and never ends, until the spec releases it (`releaseHeldCrew`),
        // the client closes it, or the server does.
        const holdOpen = () => {
          if (anthropicMessages) beginAnthropicStream(res, usage.prompt_tokens, requestNumber);
          else res.writeHead(200, { "Content-Type": "text/event-stream" });
          held.set(res, { body, request: requestNumber });
          res.on("close", () => held.delete(res));
        };

        // One answer a scenario or a built-in crew script gives, sent on
        // this request's wire; `afterMs` holds it back that long.
        const send = (answer: CrewScriptAnswer) => {
          const now = () => {
            if ("calls" in answer) streamToolCalls(answer.calls);
            else if ("text" in answer) streamText(answer.text);
            else if ("held" in answer) holdOpen();
            else if ("threadHeld" in answer) {
              const calls = answer.threadHeld;
              heldThreadAnswers.push(() => streamToolCalls(calls));
            } else writeAnthropicError(res, answer.refusal.status, answer.refusal.error);
          };
          if ("afterMs" in answer && answer.afterMs) setTimeout(now, answer.afterMs);
          else now();
        };

        if (isFirstmate && failFirstmate) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: "mock deterministic inference failure", type: "mock_error" },
            }),
          );
          return;
        }

        // Provider failures: reject the HTTP request itself. Pi converts
        // these into an assistant message with stopReason "error" and
        // RESOLVES the turn - the exact silent-failure path under test.
        if (isFirstmate && !hasToolResults && latestUserTail.includes(FAIL_AUTH_PROMPT_MARKER)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "Incorrect API key provided: mock-key.",
                type: "invalid_request_error",
                code: "invalid_api_key",
              },
            }),
          );
          return;
        }
        if (
          isFirstmate &&
          !hasToolResults &&
          latestUserTail.includes(FAIL_PROVIDER_PROMPT_MARKER)
        ) {
          // 400 with non-retryable text: fails fast, carries no auth signal.
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: { message: MOCK_PROVIDER_FAILURE, type: "mock_error" },
            }),
          );
          return;
        }

        // The Firstmate's Claude seat cut off (`cutClaudeSeat`): the class's
        // typed refusal, the way the vendor answers it.
        if (isFirstmate && anthropicMessages && seatCut) {
          if (seatCut.class === "signed_out") {
            writeAnthropicError(res, 401, {
              type: "authentication_error",
              message: "invalid x-api-key",
            });
          } else if (seatCut.class === "no_headroom") {
            const reset = String(Math.floor(seatCut.resetsAt / 1000));
            writeAnthropicError(
              res,
              429,
              { type: "rate_limit_error", message: "rate limited" },
              {
                "anthropic-ratelimit-unified-status": "rejected",
                "anthropic-ratelimit-unified-reset": reset,
                "anthropic-ratelimit-unified-5h-status": "rejected",
                "anthropic-ratelimit-unified-5h-reset": reset,
                "anthropic-ratelimit-unified-5h-utilization": "1.0",
                "anthropic-ratelimit-unified-representative-claim": "five_hour",
              },
            );
          } else {
            writeAnthropicError(res, 403, {
              type: "permission_error",
              message: CLAUDE_ORG_REFUSAL_MESSAGE,
            });
          }
          return;
        }

        // The Firstmate holding its turn open for a steer (FM_SEAT_HOLD_MARKER).
        if (isFirstmate && wantsStream && body.includes(FM_SEAT_HOLD_MARKER)) {
          if (latestUserTail.includes(FM_SEAT_STEER_WORD)) {
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: FM_SEAT_STEERED_TITLE,
                  body: "<p>The anchor chain is sound, and the crew is idle.</p>",
                },
              },
            ]);
            return;
          }
          if (hasToolResults && body.includes(FM_SEAT_STEER_WORD)) {
            streamText("Done.");
            return;
          }
          if (hasToolResults) {
            if (anthropicMessages) beginAnthropicStream(res, usage.prompt_tokens, requestNumber);
            else res.writeHead(200, { "Content-Type": "text/event-stream" });
            heldFirstmate.set(res, { body, request: requestNumber });
            res.on("close", () => heldFirstmate.delete(res));
            return;
          }
          streamToolCalls([{ name: "crew_status", args: {} }]);
          return;
        }

        // The mock kind classifier (routing S3): the real stateless call is
        // made on every spawn, so the mock answers it rather than letting it
        // fall through to the chat default. It abstains, which is exactly
        // what an unclassified spawn did before S3 - so every spec's routing
        // is unchanged while the real call path is still exercised.
        if (body.includes(KIND_CLASSIFIER_OPENING)) {
          // A sequences reproduce step is sorted as what it is, so it is an
          // answer task the way a real classifier makes it one.
          if (body.includes(RETRIEVAL_TASK_GOAL)) streamText("retrieval");
          else if (body.includes(SEQ_REPRODUCE_GOAL)) streamText("reproduce");
          else if (body.includes(CLASSIFY_CHORE_MARKER)) streamText("chore");
          // A crewmate's filed follow-up is sorted as research, so started
          // it runs as an answer the way a real classifier can make it one.
          else if (body.includes(MOCK_FOLLOWUP_TITLE)) streamText("research");
          else streamText("unclear");
          return;
        }

        // The mock Firstmate: spawn on the commission marker, settle on
        // land/discard/finish, one answer card on the answer marker, a
        // short close-out after tool results, plain chat text otherwise.
        if (isFirstmate && wantsStream) {
          // The answer-delivery retry (a captain message nothing took effect
          // after, such as plain chat the mock answers in closing words, or
          // one whose work ended with no card answering it, such as a
          // crewmate that failed):
          // the mock reacts, as a model with nothing more to show does, so
          // the message is covered quietly. Both openings are the one retry
          // (docs/task-capture.md, "How a message ends"); it never re-reads
          // the captain's quoted words as a new ask.
          if (
            latestUserTail.includes(ANSWER_MISSING_OPENING) ||
            latestUserTail.includes(ANSWER_MISSING_ENDED_OPENING)
          ) {
            if (latestUserTail.includes(RETRY_SILENT_MARKER) || hasToolResults) {
              streamText(MOCK_FM_DONE_TEXT);
            } else if (latestUserTail.includes(RETRY_ACTS_MARKER)) {
              // Tries to put work on the record; the retry refuses it, and the
              // turn then shows nothing, so the message ends in the notice.
              streamToolCalls([
                {
                  name: "create_task",
                  args: {
                    title: RETRY_ACTS_TASK_TITLE,
                    goal: "Do the work the captain asked for.",
                    user_words: RETRY_ACTS_MARKER,
                  },
                },
              ]);
            } else if (latestUserTail.includes(SILENT_ANSWER_MARKER)) {
              streamToolCalls([
                {
                  name: "emit_card",
                  args: { title: RETRY_ANSWER_TITLE, body: RETRY_ANSWER_BODY },
                },
              ]);
            } else {
              streamToolCalls([{ name: "emote", args: { emote: "nod" } }]);
            }
            return;
          }
          // A captain message the mock acknowledges with a reaction: an action
          // that covers it, so it is never retried.
          if (
            !hasToolResults &&
            latestUserTail.includes("[user]") &&
            latestUserTail.includes(REACT_PROMPT_MARKER)
          ) {
            streamToolCalls([{ name: "emote", args: { emote: "nod" } }]);
            return;
          }
          // A captain message the mock answers with closing words only: no
          // card, no reaction, no work - what answer delivery exists to catch.
          if (
            !hasToolResults &&
            latestUserTail.includes("[user]") &&
            latestUserTail.includes(SILENT_ANSWER_MARKER)
          ) {
            streamText(SILENT_CLOSING_WORDS);
            return;
          }
          // A turn a spec scripted ahead: recognized by the whole segment
          // it expects in the newest served input, and by nothing else.
          if (scripted.length > 0) {
            const turn = latestServedTurn(body);
            const fresh = turn !== undefined && turn.toolResults.length === 0;
            const script = turn && scripted.find((entry) => holdsSegment(turn, entry.input));
            if (script && fresh && script.outcome.state === "armed") {
              script.outcome.state = "answered";
              streamToolCalls(script.calls);
              return;
            }
            if (script && !fresh && script.outcome.state === "answered") {
              script.outcome.state = "closed";
              script.outcome.results = (turn?.toolResults ?? []).map(clipped);
              streamText(MOCK_FM_DONE_TEXT);
              return;
            }
            if (fresh || !turn) {
              for (const entry of scripted) {
                if (entry.outcome.state === "closed" && entry !== script) continue;
                const seen =
                  entry === script ? `served again: ${servedSummary(turn)}` : servedSummary(turn);
                entry.outcome.unmatched = [...entry.outcome.unmatched, seen].slice(
                  -SCRIPTED_DIAGNOSTIC_LIMIT,
                );
              }
            }
          }
        }
        // New response notifications quote prior assignments as context,
        // not as another scripted action. The raw request remains recorded.
        if (scriptedInput.onlyNotices) {
          streamText("Response notification handled.");
          return;
        }
        // A journey's own scenarios (`docs/testing.md`, "A journey's own
        // scenarios"): asked in the order the journey named them, after the
        // first mate's answer-missing retry and scripted turns and before
        // every shared answer below. The first to answer wins.
        const scenarioRequest = {
          body,
          isFirstmate,
          wantsStream,
          latestUserTail,
          hasToolResults,
          anthropicMessages,
          port: (server.address() as AddressInfo).port,
        };
        for (const scenario of scenarios) {
          const answer = scenario(scenarioRequest);
          if (!answer) continue;
          send(answer);
          return;
        }
        if (isFirstmate && wantsStream) {
          const settleCall = (
            marker: string,
            mode: "land" | "discard",
          ): ScriptedCall | undefined => {
            if (hasToolResults || !latestUserTail.includes(marker)) return undefined;
            const needle = settleNeedle(latestUserTail, marker);
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            return {
              name: "settle_task",
              args: { task_id: taskId, mode, closing_sentence: MOCK_CLOSING_SENTENCES[mode] },
            };
          };
          if (!hasToolResults && latestUserTail.includes(MERGE_PROMPT_MARKER)) {
            const needle = settleNeedle(latestUserTail, MERGE_PROMPT_MARKER);
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            streamToolCalls([
              {
                name: "settle_task",
                args: {
                  task_id: taskId,
                  mode: "merge-pr",
                  closing_sentence: MOCK_CLOSING_SENTENCES["merge-pr"],
                },
              },
            ]);
            return;
          }
          const land = settleCall(LAND_PROMPT_MARKER, "land");
          if (land) {
            streamToolCalls([land]);
            return;
          }
          const discard = settleCall(DISCARD_PROMPT_MARKER, "discard");
          if (discard) {
            streamToolCalls([discard]);
            return;
          }
          // WI-11 retired `finish`: the successor close for an accepted idle
          // crewmate is a land.
          const finish = settleCall(FINISH_PROMPT_MARKER, "land");
          if (finish) {
            streamToolCalls([finish]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(CANCEL_PROMPT_MARKER)) {
            const needle = settleNeedle(latestUserTail, CANCEL_PROMPT_MARKER);
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            streamToolCalls([
              {
                name: "interrupt_crewmate",
                args: {
                  task_id: taskId,
                  mode: "cancel",
                  closing_sentence: MOCK_CLOSING_SENTENCES.cancel,
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(STEER_PROMPT_MARKER)) {
            const after = latestUserTail.split(STEER_PROMPT_MARKER)[1] ?? "";
            const needle = after.split(/[:"\\]/)[0]?.trim() ?? "";
            const message = after.includes(":")
              ? (after.split(":")[1] ?? "").split(/["\\]/)[0]?.trim() || "carry on"
              : "carry on";
            const taskId =
              findCrewTaskId(latestUserTail, needle) ?? findCrewTaskId(body, needle) ?? "missing";
            streamToolCalls([{ name: "steer_crewmate", args: { task_id: taskId, message } }]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(FINISHED_REPORT_WORDS)) {
            const taskId = latestUserTail.match(/reported on task ([\w-]+)/)?.[1] ?? "missing";
            streamToolCalls([
              { name: "settle_task", args: { task_id: taskId, mode: "done", why: "answered" } },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(SPAWN_PROMPT_MARKER)) {
            const titleMatches = [
              ...latestUserTail.matchAll(new RegExp(`${SPAWN_PROMPT_MARKER} ([^"\\\\]+)`, "g")),
            ];
            const title = titleMatches[0]?.[1]?.trim() ?? "Mock task";
            const repoMatches = contextRepos(body);
            const bound = repoMatches.find(([name]) => title.includes(name));
            // spawn v2: a structured intent, never an authored brief. The
            // user's verbatim words carry any crewmate-side marker through
            // the host-rendered template.
            streamToolCalls([
              {
                name: "spawn_crewmate",
                args: {
                  title,
                  goal: mockSpawnGoal(title),
                  user_words: `${SPAWN_PROMPT_MARKER} ${title}`,
                  ...(bound ? { repo_id: bound[1] } : {}),
                  // A task that only answers, in its project (FI3-1571 piece 4).
                  ...(title.includes(WRITE_ASK_ANSWER_MARKER)
                    ? { constraints: [{ kind: "read-only" as const }] }
                    : {}),
                  ...(title.includes(THREAD_TREE_PROMPT_MARKER) ||
                  title.includes(THREAD_WORKING_SIBLING_MARKER)
                    ? { parent: THREAD_TREE_PARENT_KEY }
                    : {}),
                  // Rigor derives standard by default (captain ruling
                  // 2026-09-19); reviewed is only ever asked for, so the
                  // marker is the captain's words on care. Every other
                  // scripted spawn asks quick: the specs that ride it
                  // exercise settle and card machinery with plain card
                  // bodies, not the standard tier's evidence contract
                  // (rigor-standard.spec.ts covers that on its own repo).
                  // The captain's words on who merges this one (v3.9);
                  // omitted entirely when he said nothing.
                  // Both ride the work-shape group (contract v4.12).
                  shape: {
                    ...(title.includes(AUTONOMY_ASK_MARKER) ? { autonomy_ask: true } : {}),
                    ...(title.includes(CLAUDE_CREW_PROMPT_MARKER) ||
                    title.includes(CLAUDE_CREWMATE_MARKER)
                      ? { override_model_id: CLAUDE_CREW_MODEL }
                      : {}),
                    rigor_ask: title.includes(REVIEWED_TIER_PROMPT_MARKER)
                      ? "reviewed"
                      : title.includes(STANDARD_TIER_PROMPT_MARKER) ||
                          title.includes(STANDARD_TIER_HOST_BUTTONS_MARKER) ||
                          title.includes(REVIEW_CAREFULLY_MARKER)
                        ? "standard"
                        : "quick",
                  },
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(WELCOME_WAKE_WORDS)) {
            // The welcome: one note in the Firstmate's own voice.
            streamToolCalls([
              {
                name: "emit_card",
                args: { title: MOCK_WELCOME_TITLE, body: MOCK_WELCOME_TEXT },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(ANSWER_PROMPT_MARKER)) {
            // An answer is the first mate's own note (INF-2714): the host
            // files it as its own question.
            streamToolCalls([
              {
                name: "emit_card",
                args: {
                  title: MOCK_ANSWER_TITLE,
                  body: latestUserTail.includes(TALL_ANSWER_PROMPT_MARKER)
                    ? MOCK_ANSWER_TEXT.repeat(100)
                    : MOCK_ANSWER_TEXT,
                },
              },
            ]);
            return;
          }
          if (!hasToolResults && latestUserTail.includes(APP_CATALOG_PROMPT_MARKER)) {
            const input =
              latestServedTurn(body)?.segments.findLast((part) =>
                part.body.includes(APP_CATALOG_PROMPT_MARKER),
              )?.body ?? "";
            const json = input
              .slice(
                input.lastIndexOf(APP_CATALOG_PROMPT_MARKER) + APP_CATALOG_PROMPT_MARKER.length,
              )
              .split("\n")[0];
            streamToolCalls([
              {
                name: "app_change",
                args: {
                  ...JSON.parse(json ?? "{}"),
                  on_words: true,
                  evidence: "captain requested catalog change",
                },
              },
            ]);
            return;
          }
          streamText(hasToolResults ? MOCK_FM_DONE_TEXT : MOCK_FM_CHAT_TEXT);
          return;
        }

        // The built-in crew scripts (`crewScripts.ts`): the panel crewmate,
        // the thread crewmate and the Claude crewmate, asked after the first
        // mate's own commands and before the default close-out.
        const crewAnswer = crewScriptAnswer({ ...scenarioRequest, refusingClaude });
        if (crewAnswer) {
          send(crewAnswer);
          return;
        }

        if (wantsStream || anthropicMessages) {
          // The default close-out. Anthropic catalog models (Pi 0.87 OpenRouter
          // Claude) take the messages wire; everything else stays completions.
          streamText(MOCK_COMPLETION_TEXT);
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: MOCK_MODEL_ID,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: MOCK_COMPLETION_TEXT },
                  finish_reason: "stop",
                },
              ],
              usage,
            }),
          );
        }
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider failed to bind");
  return {
    port: address.port,
    requests: () => requestCount,
    recordRequests: (record) => {
      for (const body of requestBodies) record(body);
      recorders.add(record);
      return () => {
        recorders.delete(record);
      };
    },
    failFirstmate: (fail) => {
      failFirstmate = fail;
    },
    requestBodies: () => [...requestBodies],
    requestHeaders: () => [...requestHeaders],
    cardFetchProbeHits: () => cardFetchProbeHits,
    heldRequests: () => held.size,
    heldThreadAnswers: () => heldThreadAnswers.length,
    releaseThreadAnswer: () => {
      for (const answer of heldThreadAnswers.splice(0)) answer();
    },
    releaseHeldCrew: () => {
      for (const [res, opened] of held) {
        held.delete(res);
        writeAnthropicToolUse(res, 0, {
          id: `toolu_${opened.request}_held`,
          name: servedToolName(opened.body, "note_progress"),
          args: { text: MOCK_CLAUDE_HELD_PROGRESS },
        });
        finishAnthropicStream(res, "tool_use", 17);
      }
    },
    refuseClaude: (refusing) => {
      refusingClaude = refusing;
    },
    cutClaudeSeat: (cut) => {
      seatCut = cut;
    },
    scriptFirstmateTurn: (input, calls) => {
      const outcome: ScriptedTurnOutcome = { state: "armed", unmatched: [], results: [] };
      scripted.push({ input, calls, outcome });
      return { outcome: () => structuredClone(outcome) };
    },
    heldFirstmate: () => heldFirstmate.size,
    releaseHeldFirstmate: () => {
      for (const [res, opened] of heldFirstmate) {
        heldFirstmate.delete(res);
        writeAnthropicToolUse(res, 0, {
          id: `toolu_${opened.request}_held`,
          name: servedToolName(opened.body, "crew_status"),
          args: {},
        });
        finishAnthropicStream(res, "tool_use", 17);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        // `server.close` alone waits for every socket still open, and an
        // app that has just exited can leave a keep-alive connection the
        // kernel has not torn down yet - a teardown that then never
        // finishes and takes its `afterAll` hook's whole timeout with it.
        // Nothing is in flight here by definition, so drop the sockets.
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
