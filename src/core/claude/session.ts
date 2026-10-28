import { hostPlatform } from "../platform";
import { stageRunbookSkills } from "../runbooks/runbooks";
import { SESSION_COMPACTION_TOKENS } from "../session/compaction";
import { attributedClaudeProcess } from "./processResources";
import { claudeCodingReasoning } from "./reasoning";

export { claudeCodingReasoning } from "./reasoning";

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type Options,
  type Query,
  type SDKUserMessage,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  query as sdkQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { FmEvent, FmUsage } from "@shared/events";
import type { Reasoning } from "@shared/reasoning";
import { hostEnv, withTaskShell } from "../hostEnv";
import type { ServedInstructions, ServedMessage, ServedState } from "../orchestrator/seat";
import { TICK_PERIOD_MS } from "../orchestrator/ticker";
import { outputCapErrorMessage, type SessionClock } from "../session/bounds";
import {
  PERSONAL_RESOURCE_RULES,
  type PersonalResourceDigests,
  personalInstructionsText,
  personalResources,
} from "../session/personalResources";
import { projectInstructions, projectSkillFolders } from "../session/projectResources";
import {
  admits,
  type ContractStamp,
  type ControlProfile,
  LOCAL_MACHINE_ID,
  type ModelSession,
  type SessionEvent,
  type SessionFactory,
  type SessionImage,
  type SessionRenewal,
  type SessionResume,
  type SessionSpec,
  type ThinkingLevel,
} from "../session/session";
import type { BoundTool } from "../session/tools";
import { bareToolName, CLAUDE_SEAT_TOOL_SERVER } from "../storage/sessionReader";
import {
  type SessionRecordEntry,
  SessionRecordStore,
  type SessionSidecarRecord,
} from "../storage/sessionRecordStore";
import {
  type ClaudeClientCheck,
  checkClaudeClient,
  claudeClientIssueText,
  claudeEnvFor,
  resolveClaudeExecutable,
} from "./claudeCli";
import {
  type ClaudeNormalizeResult,
  type ClaudeRateLimit,
  type ClaudeTurnFailure,
  createNormalizerState,
} from "./claudeEvents";
import { canonicalClaudeModelId } from "./claudeModelCatalog";
import { CLAUDE_MODELS } from "./claudeModels";
import {
  type ClaudeProjectResources,
  claudeProjectInstructionsText,
  claudeProjectResources,
  stageClaudeSkills,
} from "./claudeProjectResources";
import { ClaudeQueryCore, MessageQueue, userMessage } from "./claudeQueryCore";
import { acquireSessionLease } from "./claudeStoreLease";
import { claudeToolServer } from "./claudeTaskTools";
import { locateClaudeTranscript } from "./claudeTranscript";

/**
 * Claude's implementation of the one session contract
 * (`src/core/session/`): the only place a Claude session is built from a
 * `SessionSpec`, on the machine's own client. It serves the three roles'
 * shapes with two classes: a rolling session - the Firstmate seat's with no
 * built-ins (W1 S6), the crewmate's with the client's own coding set - and
 * the adapted decision model's one-shot question (W1 S10).
 *
 * Every Claude session runs the machine's default login and nothing ambient
 * (`claudeEnvFor`), nothing of the person's own Claude setup
 * (`settingSources: []`, `strictMcpConfig: true`, and the client's auto
 * memory off: `CLAUDE_SESSION_ENV`), no built-in tool unless the spec asks
 * for the coding set - which also brings its working copy's own instruction
 * file and skills (`claudeProjectResources.ts`) and turns the client's
 * commit and pull request attribution off (`CLAUDE_CODING_SETTINGS`) - and
 * the spec's tools served always-load by the app's own in-process server,
 * spoken by their bare names. Nothing here is emulated: Claude's
 * streaming-input mode gives native mid-turn steer, a turn-granular
 * `interrupt()`, live deltas and resume by id. The shapes differ in what the
 * spec asks for:
 *
 * - A one-shot is ONE query: the spec's base instruction as the only system
 *   prompt the app supplies (the client adds its own identity line, and a
 *   date reminder to the user message), the question as one user message,
 *   and one answer read off it. `maxTurns` bounds the agent's turns, not the
 *   client's requests: an answer the output cap cut short would be asked
 *   for again, up to three more times, by the client's own recovery. The
 *   first answer is the one read - cut short or not, as Pi reads it - and
 *   the client is stopped before it can ask again. No transcript
 *   (`persistSession: false`), and the account's shared store lease held for
 *   the session's whole life, so a renewal never races the client over its
 *   single-use refresh token. The spec's request bounds apply in the
 *   client's own terms: an explicit output cap as
 *   `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, the model-turn cap as `maxTurns`. An
 *   explicit cap at or under the legacy thinking floor requests thinking
 *   disabled, but newer models need not honor it. The question preset
 *   therefore leaves Claude's output allowance to its client: Sonnet 5.5
 *   can consume a small cap entirely in hidden thinking (INF-1451). The
 *   adapter still bounds the whole question with its own wall clock.
 * - A rolling session keeps one conversation across prompts, steers and
 *   client attachments. With no built-ins its prompt is the spec's base,
 *   the dynamic boundary and the captain's served text; with the coding set
 *   it is the client's own coding preset with the base appended. Its rules
 *   are measured against the real client and pinned by
 *   `claudeFirstmateSession.integration.test.ts` and
 *   `claudeSession.integration.test.ts`:
 *   - A steer rides `priority: "next"`. On the pinned client that folds the
 *     message into the running turn at its next step, after the in-flight
 *     tool's result, and the exchange ends in ONE result - Pi's steer. `now`
 *     aborts the tool in flight (its result becomes an error the model
 *     reads) and answers in a second turn; `later` waits for the turn to end.
 *   - A prompt settles when the client says its session is idle
 *     (`session_state_changed`, turned on by
 *     `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`): after every turn the prompt
 *     and its steers started, however many results that took. Should a
 *     client ever stop saying so, a result with every pushed message
 *     acknowledged settles it instead.
 *   - Every pushed message carries a uuid and the client acknowledges each
 *     as a turn takes it in (`--replay-user-messages`), which is how the
 *     session knows a steer was delivered and where it landed. A steer no
 *     turn took in goes back to the owner (`takeUndeliveredSteers`).
 *   - The client works on its own too: a background command it started
 *     can finish after the prompt settled, and the client then runs a turn
 *     no prompt asked for. It says `running` before that turn and `idle`
 *     after it, which the session reports as a continuation
 *     (`continuation_started`, `continuation_ended`): the host-owned turn
 *     boundary its owner gives it. A steer joins a continuation as it joins
 *     a prompt.
 *
 *   Every rolling session's durable record is the app's own
 *   (`SessionRecordStore`, in the spec's record dir: the seat's
 *   `firstmate/claude/`, a crewmate's `crewmates/<task>/sessions/`): at
 *   every idle boundary, attach and exit, on each tick while its client
 *   is attached, and when the home's copy order requests a refresh, the
 *   session copies what the client appended to its own
 *   transcript, so the record outlives the client's 30-day sweep, and
 *   stamps the spec's contract, when it has one, in a sidecar. A resume
 *   reads the client's own file; when that is gone, the session starts
 *   fresh under a new id (and the app's copy of the old one stays). A
 *   resumed client serves the system prompt it recorded when the session
 *   started, and the tools it had then as they were described then, not
 *   the ones it is handed, so a session with a contract whose prompt array
 *   (or, where the contract fingerprints each tool, a tool it had, or
 *   which tools it has) changed since it started never resumes: it
 *   starts over under a new id with the new array, at open or at the idle
 *   boundary `serveInstructions` is, and
 *   says so once (`takeRenewal`). (Not
 *   the SDK's session store: resuming from it has the SDK read the
 *   person's credential and copy it into a temporary config dir, and the
 *   app never reads a provider token.) The account's
 *   store is leased per client attachment. The spec's request bounds apply
 *   in the client's own terms, as a one-shot's do: the output cap as
 *   `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, the model-turn cap as `maxTurns`.
 *   Measured on the pinned client and the installed 2.1.283 (decision D5),
 *   the cap reaches every request as `max_tokens` with the model's own
 *   thinking inside it (adaptive, or a budget one below the cap on Haiku),
 *   and an answer that runs past it is asked to carry on three times before
 *   the turn fails, which the session reports in its own words. The watched
 *   time bounds are not Claude's to keep: the one watcher on the host's
 *   clock (`session/bounds.ts`) cuts a turn with `abort(failure)`, and the
 *   session's own tick stops a client that does not answer that interrupt.
 *
 * A typed cut-off rides the `turn_failed` it produces (`cutOff`), which the
 * owner records on the account; the words the client said stay off the
 * owner's record. Like every Claude touchpoint it sits behind
 * `src/core/claude/`.
 */

/**
 * Claude's streaming-input session delivers the whole contract natively.
 * One constant, so the factory's declaration and each session's own cannot
 * drift apart.
 */
export const CLAUDE_CONTROL_PROFILE: ControlProfile = {
  steer: "native",
  interruptGranularity: "turn",
  quotaEvents: true,
  // The client owns its own background work and keeps working after a
  // prompt settles, so the host sees activity but never a provable stop.
  // The whose-turn rule answers "cannot tell" here (S7c, R4.8 q2).
  backgroundWork: "client",
  // Every failed turn is classified from the SDK's typed fields
  // (`classifyClaudeSignal`), never from the words it reports.
  failureSignals: "typed",
};

export type ClaudeQueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => Query;

/** The provider id a Claude session reports as its model's provider. */
export const CLAUDE_MODEL_PROVIDER = "anthropic-claude";

export type ClaudeSessionDeps = {
  /**
   * The machine's default Claude config root: the store the lease guards,
   * and where the client keeps a rolling session's own transcript.
   */
  configDir: string;
  /**
   * The host's one clock: every rolling session reads it, and its record's
   * copy and its client hygiene ride its ticks.
   */
  clock?: SessionClock;
  /**
   * The app's durable record of the rolling sessions in a directory;
   * production keeps one store per directory. Tests hand in their own.
   */
  records?: (dir: string) => SessionRecordStore;
  /** A plan-window reading the client pushed, for the account's quota. */
  onRateLimit?: (accountId: string, reading: ClaudeRateLimit) => void;
  /** A turn succeeded on this account: the provider accepted its login. */
  onServed?: (accountId: string) => void;
  /** The client's own stderr, and the session's notes about the client. */
  log?: (line: string) => void;
  /** The environment the client is found in and run from; production reads the host's. */
  env?: () => NodeJS.ProcessEnv;
  /** Is the client there and new enough; production spawns `claude --version` once per binary. */
  checkClient?: (env: NodeJS.ProcessEnv) => Promise<ClaudeClientCheck>;
  /** The SDK's query; tests script one. */
  query?: ClaudeQueryFactory;
};

/**
 * Anthropic's legacy extended-thinking floor. A fixed thinking budget
 * must fit below `max_tokens`; newer adaptive models may still think
 * when asked to disable it.
 */
const CLAUDE_THINKING_FLOOR_TOKENS = 1024;

/**
 * The client's documented switch for its auto memory, set on every session
 * (FI3-795). Left on, the client keeps notes per project in the person's
 * Claude folder (`projects/<the working copy's main checkout>/memory/`),
 * serves their index to every session started there and, in the coding
 * preset, tells the model to write more, whatever `settingSources` says:
 * measured on the installed 2.1.288 and the SDK's 2.1.234, the crewmate, the
 * seat and the question were each served a planted index. Those notes are
 * the person's own Claude setup, and the project's own knowledge lives in
 * its committed instructions (`claudeAutoMemory.integration.test.ts`).
 */
export const CLAUDE_SESSION_ENV = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } as const;

/**
 * The client's documented attribution setting, handed to every coding
 * session as flag settings (the captain, 2026-10-15: "disable commit and PR
 * author attribution for all claude crewmates in infinitary (it's a claude
 * setting)"). Left to its default the client has the model end each commit
 * message with a `Co-Authored-By` trailer and each pull request description
 * with a "Generated with Claude Code" line; empty text hides both
 * (`claudeAttribution.integration.test.ts`). Flag settings are the app's
 * own layer, so the person's own Claude settings stay unread.
 */
export const CLAUDE_CODING_SETTINGS = { attribution: { commit: "", pr: "" } } as const;

/** Claude clamps this to its model window, then subtracts output room and a 13k buffer. */
export const CLAUDE_COMPACTION_SETTINGS = {
  autoCompactEnabled: true,
  autoCompactWindow: SESSION_COMPACTION_TOKENS + 8192 + 13_000,
} as const;

/** A person's client switches must not disable or enlarge the app's compaction budget. */
function claudeSessionEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = claudeEnvFor(base);
  for (const key of [
    "DISABLE_COMPACT",
    "DISABLE_AUTO_COMPACT",
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
    "CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE",
  ])
    delete env[key];
  return env;
}

/** Where a coding session stages its working copy's skills, inside its record dir. */
export const CLAUDE_PROJECT_SKILLS_DIR = "project-skills";

/** The client's own words a rolling session turns on: the idle signal the settle rule reads. */
export const CLAUDE_ROLLING_ENV = { CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" } as const;

// INF-133 F1: the captain chose a higher, host-owned first mate tool-result cap.
// An explicit positive value takes precedence over the client's remote configuration.
export const CLAUDE_FIRSTMATE_MCP_OUTPUT_TOKENS = 100_000;

/**
 * The first mate's tool-result band in characters: the client takes a result
 * whose estimate (a quarter token per character) is at most half the cap
 * without counting it (docs/claude-client.md). INF-451: each of the seat's
 * tools declares it, or the client saves a result past 50,000 characters to a
 * file and serves a preview the seat has no tool to open.
 */
export const CLAUDE_FIRSTMATE_TOOL_RESULT_CHARACTERS = (CLAUDE_FIRSTMATE_MCP_OUTPUT_TOKENS / 2) * 4;

/**
 * The client's documented switch that keeps its per-turn extras off the
 * seat: without it the installed 2.1.283 tells a seat that ran a few tool
 * calls without a word that "the user hasn't heard from you"
 * (`silent_turn_reminder`), and counts down a token budget after every
 * request. The Firstmate's turn ends with brief output by contract, and its
 * captain speaks only through the app. What the switch cannot reach - the
 * start-of-session `environment`, `model`, `session_context` and `date` -
 * is the accepted exposure in docs/claude-client.md, and
 * `claudeToolSurface.test.ts` holds the set on the real client. A coding
 * session keeps the client's extras: they are its own coding aids.
 */
export const CLAUDE_SEAT_ENV = {
  CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
  MAX_MCP_OUTPUT_TOKENS: String(CLAUDE_FIRSTMATE_MCP_OUTPUT_TOKENS),
} as const;

/** The priority a steer rides; measured, see the module comment. */
export const CLAUDE_STEER_PRIORITY = "next" as const;

export type ClaudeSessionOptionsInput = {
  spec: SessionSpec;
  /** The host environment; the client's own is derived from it. */
  env: NodeJS.ProcessEnv;
  executable: string | undefined;
  stderr: (data: string) => void;
  /**
   * A rolling session's client attachment: the model it asks for (never
   * one the client swapped in), the captain's text served right now, and
   * whether it resumes the recorded session or starts one under the
   * session's id.
   */
  attachment?: {
    model?: string;
    served?: string;
    session: { resume: string } | { sessionId: string };
    /** A coding session's working copy: its instruction file and staged skills. */
    project?: ClaudeProjectResources;
  };
};

/**
 * The app's in-process server for the spec's tools, served always-load, with
 * the result length the client serves whole when one is given.
 */
function toolServer(
  tools: readonly BoundTool[],
  wholeResultCharacters?: number,
): Options["mcpServers"] {
  return { [CLAUDE_SEAT_TOOL_SERVER]: claudeToolServer(tools, wholeResultCharacters) };
}

/**
 * The exact options a session's query hands the SDK, from its spec (and, for
 * a rolling session, its attachment) alone. Its call shape is the backend's
 * one Claude touchpoint, pinned by the seat's and the question's tests;
 * change them together.
 */
export function claudeSessionOptions(input: ClaudeSessionOptionsInput): Options {
  const { spec } = input;
  const request = spec.bounds?.request;
  const level = spec.thinking.level;
  const attachment = input.attachment;
  const opened = claudeCodingReasoning(spec).level;
  const codingEffort = opened === "default" ? undefined : opened;
  // The spec's output cap, in the client's own terms, and the one backend
  // rule it brings: a legacy thinking budget must fit below the cap, so a
  // cap at or under that floor requests thinking off.
  const maxOutput = request?.maxOutputTokens;
  const outputCap =
    maxOutput !== undefined ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxOutput) } : {};
  const thinks =
    level !== "off" && !(maxOutput !== undefined && maxOutput <= CLAUDE_THINKING_FLOOR_TOKENS);
  if (spec.shape.turns === "rolling") {
    if (!attachment) throw new Error("A rolling Claude session attaches with a session.");
    const coding = spec.builtins === "coding";
    const project = attachment.project;
    const staged =
      coding &&
      Boolean(
        project?.skillsPlugin || project?.personalSkillsPlugin || project?.runbookSkillsPlugin,
      );
    return {
      cwd: spec.cwd,
      ...(coding && hostPlatform() !== "win32"
        ? { spawnClaudeCodeProcess: attributedClaudeProcess(spec.owner, input.stderr) }
        : {}),
      // The machine's default login and nothing ambient, none of the
      // person's Claude notes, plus the session state events the settle rule
      // reads, the output bound, and for the seat none of the client's
      // per-turn extras.
      env: {
        ...claudeSessionEnv(input.env),
        ...CLAUDE_SESSION_ENV,
        ...CLAUDE_ROLLING_ENV,
        ...(coding ? {} : CLAUDE_SEAT_ENV),
        ...outputCap,
      },
      // The person's own Claude configuration is not the app's: a session
      // imports no settings on any machine. Nor is a project's: its settings
      // file would bring its hooks, permission rules and environment, so a
      // coding session is handed its working copy's instructions and skills
      // instead (`claudeProjectResources.ts`).
      settingSources: [],
      // With the coding set, the client's own coding prompt with the role's
      // appended, then the working copy's instruction file. Without it, the
      // byte-stable prompt is the cached static prefix and the captain's own
      // instructions follow the boundary (docs/sequences.md).
      systemPrompt: coding
        ? {
            type: "preset",
            preset: "claude_code",
            append: [
              spec.instructions.base,
              ...(project?.instructions
                ? [claudeProjectInstructionsText(project.instructions)]
                : []),
              ...(project?.personalInstructions ? [project.personalInstructions] : []),
            ].join("\n\n"),
          }
        : [
            spec.instructions.base,
            SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
            ...(attachment.served ? [attachment.served] : []),
          ],
      // With the coding set, the client serves every one of its own tools
      // (none named is all of them). Without it, no built-in tool at all:
      // the session's whole surface is the spec's own typed tools
      // (docs/orchestrator-contract.md).
      ...(coding ? {} : { tools: [] }),
      // The spec's tools, served always-load, when it has any; the seat's
      // whole band reaches it, since it has no tool to open a saved result.
      ...(spec.tools.length > 0
        ? {
            mcpServers: toolServer(
              spec.tools,
              coding ? undefined : CLAUDE_FIRSTMATE_TOOL_RESULT_CHARACTERS,
            ),
          }
        : {}),
      // Only the app's tool server: nothing of the person's mounts.
      strictMcpConfig: true,
      // The working copy's skills, listed as `project:<skill>`, and no hook
      // a skill declares: the app's session runs no project code of its own.
      ...(staged
        ? {
            plugins: [
              project?.skillsPlugin,
              project?.personalSkillsPlugin,
              project?.runbookSkillsPlugin,
            ].flatMap((path) => (path ? [{ type: "local" as const, path }] : [])),
          }
        : {}),
      // A coding session's commits and pull requests carry no attribution,
      // and with a skill staged no hook runs.
      settings: {
        ...CLAUDE_COMPACTION_SETTINGS,
        ...(coding ? CLAUDE_CODING_SETTINGS : {}),
        ...(staged ? { disableAllHooks: true } : {}),
      },
      // The app's tools are its own and typed, and a coding session works
      // alone in its own worktree - the isolation Pi's has (docs/architecture.md
      // section 4: social and a worktree, not a filesystem jail) - so there
      // is nothing to ask about.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      // Set the coding level on the query itself: the per-turn update skips
      // it when the recorded effort already matches the requested level.
      ...(coding
        ? codingEffort
          ? { effort: codingEffort }
          : {}
        : level !== "off"
          ? { effort: level }
          : {}),
      ...(coding || thinks ? {} : { thinking: { type: "disabled" as const } }),
      ...(request?.maxModelTurns !== undefined ? { maxTurns: request.maxModelTurns } : {}),
      ...(attachment.model ? { model: attachment.model } : {}),
      ...("resume" in attachment.session
        ? { resume: attachment.session.resume }
        : { sessionId: attachment.session.sessionId }),
      ...(input.executable ? { pathToClaudeCodeExecutable: input.executable } : {}),
      stderr: input.stderr,
      // The client acknowledges each pushed message, by its uuid, as a turn
      // takes it in.
      extraArgs: { "replay-user-messages": null },
    };
  }
  return {
    cwd: spec.cwd,
    // The machine's default login and nothing ambient, none of the person's
    // Claude notes, plus the output bound.
    env: {
      ...claudeSessionEnv(input.env),
      ...CLAUDE_SESSION_ENV,
      // A one-shot without an explicit bound uses the client's allowance,
      // never an answer-only cap inherited from the shell (INF-1451).
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: undefined,
      ...outputCap,
    },
    settings: CLAUDE_COMPACTION_SETTINGS,
    // The person's own Claude configuration is not the app's.
    settingSources: [],
    // The spec's instruction is the only system prompt the app supplies: no
    // preset (the client still adds its identity line).
    systemPrompt: spec.instructions.base,
    // No built-in tool: the model answers from what it was given, and can
    // reach only the spec's own tools, when it has any.
    tools: [],
    ...(spec.tools.length > 0
      ? {
          mcpServers: toolServer(spec.tools),
          permissionMode: "bypassPermissions" as const,
          allowDangerouslySkipPermissions: true,
        }
      : {}),
    strictMcpConfig: true,
    ...(request?.maxModelTurns !== undefined ? { maxTurns: request.maxModelTurns } : {}),
    ...(level !== "off" ? { effort: level } : {}),
    // Request no extended thinking when an explicit cap leaves it no room.
    // Newer models may still think; the question preset supplies no cap.
    ...(thinks ? {} : { thinking: { type: "disabled" as const } }),
    // One bounded call leaves no transcript behind.
    persistSession: false,
    ...(spec.model ? { model: spec.model.id } : {}),
    ...(input.executable ? { pathToClaudeCodeExecutable: input.executable } : {}),
    stderr: input.stderr,
    // The request's typed stop rides its streamed `message_delta`: how an
    // answer the output cap cut short is known in time to stop the client's
    // own recovery from asking again.
    includePartialMessages: true,
  };
}

/**
 * A session speaks the spec's tools by their own names: the client serves
 * each under the app's server (`mcp__infinitary__<name>`), and the decision
 * record, the feed and the replay read the bare one.
 */
function bareToolNames(events: readonly FmEvent[]): FmEvent[] {
  return events.map((event) =>
    event.type === "tool_start" || event.type === "tool_end"
      ? { ...event, toolName: bareToolName(event.toolName) }
      : event,
  );
}

/** Where a session's notes go: the deps' log, or the console. */
function noteTo(deps: ClaudeSessionDeps): (line: string) => void {
  return deps.log ?? ((line) => console.warn(`[claude] ${line}`));
}

/** What a second prompt, a steer, or a prompt after dispose is told. */
const ONE_QUESTION_TEXT = "A one-shot session answers one question.";

class ClaudeOneShotSession extends ClaudeQueryCore<SessionEvent> implements ModelSession {
  readonly sessionId = randomUUID();
  readonly controlProfile = CLAUDE_CONTROL_PROFILE;
  private query: Query | undefined;
  private input: MessageQueue | undefined;
  private asked = false;
  /** A result arrived: the client exits on its own once its input ends. */
  private answered = false;
  /** The request in flight, as it streams. */
  private readonly request: RequestReading = {};
  private markClosed!: () => void;
  private readonly closedPromise = new Promise<void>((resolve) => {
    this.markClosed = resolve;
  });

  constructor(
    private readonly spec: SessionSpec,
    private readonly accountId: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly deps: ClaudeSessionDeps,
    /** Hands the account's store back; the lease ignores a second call. */
    private readonly releaseLease: () => void,
  ) {
    super(spec.owner);
  }

  resume(): undefined {
    return undefined;
  }

  recordPath(): undefined {
    return undefined;
  }

  isStreaming(): boolean {
    return this.turn !== undefined;
  }

  modelRef(): { provider: string; id: string } | undefined {
    return this.spec.model
      ? { provider: CLAUDE_MODEL_PROVIDER, id: this.spec.model.id }
      : undefined;
  }

  modelLabel(): string | undefined {
    return CLAUDE_MODELS.find((model) => model.id === this.spec.model?.id)?.name;
  }

  /** The one question. Settles on the client's one result, however it ends. */
  prompt(text: string): Promise<void> {
    if (this.disposed || this.asked) return Promise.reject(new Error(ONE_QUESTION_TEXT));
    this.asked = true;
    const input = new MessageQueue();
    const options = claudeSessionOptions({
      spec: this.spec,
      env: this.env,
      executable: resolveClaudeExecutable(this.env),
      stderr: (data) => this.deps.log?.(data.trimEnd()),
    });
    let query: Query;
    try {
      query = (this.deps.query ?? sdkQuery)({ prompt: input, options });
    } catch (caught) {
      this.release();
      return Promise.reject(caught);
    }
    this.query = query;
    this.input = input;
    const settled = new Promise<void>((resolve, reject) => {
      this.turn = { resolve, reject };
    });
    input.push(userMessage(text));
    void this.pumpQuery(query);
    return settled;
  }

  steer(): Promise<void> {
    return Promise.reject(new Error(ONE_QUESTION_TEXT));
  }

  takeUndeliveredSteers(): string[] {
    return [];
  }

  /** A one-shot's thinking is fixed by its spec. */
  setThinkingLevel(): void {}

  reasoning(): undefined {
    return undefined;
  }

  /** A one-shot's instructions are fixed by its spec. */
  serveInstructions(): void {}

  takeRenewal(): undefined {
    return undefined;
  }

  servedState(): undefined {
    return undefined;
  }

  /**
   * The caller's bound fired: the question is given up on now, and the
   * client stopped. A one-shot session has nothing to keep steerable, so it
   * does not wait for the client to agree. With a failure, the question
   * reports it as its turn's.
   */
  async abort(failure?: string): Promise<void> {
    if (this.disposed) return;
    if (failure !== undefined && this.turn && !this.answered) {
      this.answered = true;
      this.emit({ type: "turn_failed", taskId: this.taskId, error: failure });
      this.emit({ type: "turn_end", taskId: this.taskId });
      this.emit({ type: "turn_closed" });
    }
    this.settleTurn();
    this.query?.close();
  }

  /** A one-shot's client ends with its one answer; there is nothing to let go of between turns. */
  async detach(): Promise<void> {}

  /** Resolves once the client has exited and the store is free. */
  closed(): Promise<void> {
    return this.closedPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.settleTurn();
    if (!this.query) {
      this.release();
      return;
    }
    this.input?.close();
    // A client that has answered exits on its own once its input ends; one
    // that has not is stopped. The lease comes back when the stream ends.
    if (!this.answered) this.query.close();
  }

  protected override emitAll(events: readonly FmEvent[]): void {
    super.emitAll(bareToolNames(events));
  }

  protected observe(message: unknown, result: ClaudeNormalizeResult): void {
    if (result.rateLimit) this.deps.onRateLimit?.(this.accountId, result.rateLimit);
    readRequest(message, this.request);
    const cut = this.request.cutShort;
    if (!cut || this.answered) return;
    // The output cap cut the answer short. It is still the answer - Pi's
    // classifier reads the same truncated text and the parser takes the one
    // option word in it - and the client, left running, would ask for the
    // rest three more times. So it is read now and the client stopped.
    const usage: FmUsage = {
      ...(this.request.input ? { input: this.request.input } : {}),
      ...(cut.output ? { output: cut.output } : {}),
    };
    this.answer(
      {
        events: [
          {
            type: "turn_end",
            taskId: this.taskId,
            ...(Object.keys(usage).length > 0 ? { usage } : {}),
          },
        ],
      },
      this.request.text,
    );
    this.query?.close();
  }

  protected resultFailed(result: ClaudeNormalizeResult, failure: ClaudeTurnFailure): void {
    // A cut-short answer was already read: the client, stopped, has nothing
    // more to report about this question.
    if (this.answered) return;
    this.emit({
      type: "turn_failed",
      taskId: this.taskId,
      error: failure.error,
      ...(failure.cutOff ? { cutOff: failure.cutOff } : {}),
      ...(failure.contextOverflow ? { contextOverflow: true } : {}),
    });
    this.answer(result, undefined);
  }

  protected resultInterrupted(result: ClaudeNormalizeResult): void {
    this.answer(result, undefined);
  }

  protected resultClean(result: ClaudeNormalizeResult): void {
    this.deps.onServed?.(this.accountId);
    this.answer(result, result.finalText?.trim() || undefined);
  }

  protected streamFailed(caught: unknown): void {
    this.rejectTurn(caught);
  }

  protected streamEnded(): void {
    // The client has exited: the store is free.
    this.release();
    this.rejectTurn(new Error("Claude stopped before it answered."));
  }

  /** The store is free: the lease is back, and the session is closed. */
  private release(): void {
    this.releaseLease();
    this.markClosed();
  }

  /** The one answer: its events, the closing words, and the client let go. */
  private answer(result: ClaudeNormalizeResult, text: string | undefined): void {
    // A result the stopped client still delivers after a cut-short answer
    // was read is not a second answer.
    if (this.answered) return;
    this.answered = true;
    this.emitAll(result.events);
    this.emit({ type: "turn_closed", ...(text ? { text } : {}) });
    this.input?.close();
    this.settleTurn();
  }
}

/** What one streamed request says about the answer: its words, its tokens, and why it stopped. */
type RequestReading = { text?: string; input?: number; cutShort?: { output?: number } };

/**
 * Reads the main thread's request as it streams. The client hands over the
 * assistant message before the request's `message_delta`, and with
 * `stop_reason` still unset, so the typed stop - `max_tokens` - is read off
 * the streamed `message_delta` and the words off the message before it.
 */
function readRequest(message: unknown, reading: RequestReading): void {
  const record = message as {
    type?: unknown;
    parent_tool_use_id?: unknown;
    message?: { content?: unknown };
    event?: {
      type?: unknown;
      message?: { usage?: { input_tokens?: unknown } };
      delta?: { stop_reason?: unknown };
      usage?: { output_tokens?: unknown };
    };
  } | null;
  if (record?.parent_tool_use_id !== null && record?.parent_tool_use_id !== undefined) return;
  if (record?.type === "assistant") {
    const content = Array.isArray(record.message?.content) ? record.message.content : [];
    const text = content
      .flatMap((block: { type?: unknown; text?: unknown }) =>
        block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
      )
      .join("")
      .trim();
    if (text) reading.text = text;
    return;
  }
  if (record?.type !== "stream_event") return;
  const event = record.event;
  if (event?.type === "message_start") {
    const input = event.message?.usage?.input_tokens;
    if (typeof input === "number") reading.input = input;
  }
  if (event?.type === "message_delta" && event.delta?.stop_reason === "max_tokens") {
    const output = event.usage?.output_tokens;
    reading.cutShort = typeof output === "number" ? { output } : {};
  }
}

/** What a prompt or steer on a disposed rolling session is told. */
const ENDED_TEXT = "This Claude session has ended.";

/** What a continuation the client's exit cut short, or a prompt it stranded, is told. */
const STOPPED_TEXT = "Claude stopped before the turn finished.";

type Connection = {
  /** The session id this client runs, which a renewal can leave behind. */
  sessionId: string;
  query: Query;
  input: MessageQueue;
  /** The effort the client is serving at right now. */
  effort: ThinkingLevel | "off";
  /** The session is ending this attachment itself; its stream's end is expected. */
  closing: boolean;
  /** When the session ended its input; a client still running a tick later is stopped. */
  closedAt?: number;
  /** Resolves once the stream is over and the lease is back. */
  done: Promise<void>;
  /** Hands this client's lease on the account's store back. */
  release: () => void;
};

type Pushed = {
  uuid: string;
  kind: "prompt" | "steer";
  text: string;
  /** The client took it into a turn. */
  acked: boolean;
};

/** What a rolling session runs on, resolved at open. */
type RollingConfig = {
  accountId: string;
  env: NodeJS.ProcessEnv;
  /** The app's own record of the session, in the spec's record dir. */
  store: SessionRecordStore;
  stamp: ContractStamp | undefined;
  clock: SessionClock;
};

class ClaudeRollingSession extends ClaudeQueryCore<SessionEvent> implements ModelSession {
  readonly controlProfile = CLAUDE_CONTROL_PROFILE;
  private connection: Connection | undefined;
  /**
   * The model every attachment asks the client for: the spec's, else the
   * one a resumed session ran on before the client swapped it, else the
   * first one the client reported. Never what the client swapped in, so a
   * reattach or a resume does not keep a refusal fallback on its own.
   */
  private asked: string | undefined;
  /** The model the client last said answers, as Infinitary names it; what the session reports. */
  private answering: string | undefined;
  private instructions: ServedInstructions | undefined;
  /** New instructions wait for the next prompt's attachment. */
  private reopen = false;
  private wantedEffort: ThinkingLevel | "off";
  /** A prompt is in flight, from its call until the client is idle again. */
  private promptOpen = false;
  /** The client is running a turn no prompt asked for, until it is idle again. */
  private continuing = false;
  /** The prompt's message or a continuation is in the client's hands: a steer can join it. */
  private accepting = false;
  private pushed: Pushed[] = [];
  /** Steers that arrived while the client was starting, pushed after the prompt. */
  private early: { text: string; images?: SessionImage[] }[] = [];
  /** Each prompt's number, so a late start of an abandoned one pushes nothing. */
  private generation = 0;
  /** Steers that arrived while no prompt could take them, for the next one. */
  private held: string[] = [];
  /** The client has said something since the prompt was pushed. */
  private ran = false;
  /** The client reports its session state; without it a result settles. */
  private statesSeen = false;
  private acksSeen = false;
  /** This prompt already reported a failure. */
  private failed = false;
  /** The failure an `abort(failure)` asked the cut turn to report, and when it asked. */
  private cut: { message: string; at: number } | undefined;
  /** When the client was first asked to interrupt the running turn, until that turn answers. */
  private interruptedAt: number | undefined;
  /** Run once the open prompt settles: a dispose or a detach waiting for it. */
  private afterSettle: (() => void)[] = [];
  private disposing = false;
  /** The last settled prompt's messages, where `servedState` locates them. */
  private served: Pushed[] | undefined;
  /** The session is gone: its client has exited and its store is free. */
  private retired = false;
  /** The session this one started over from, until the owner takes it. */
  private renewal: SessionRenewal | undefined;
  /** The client took a prompt under the current id: a reattach resumes it. */
  private tookPrompt = false;
  /** The client's transcript stopped extending the app's copy, and the log says so. */
  private divergedNoted = false;
  private readonly retirement: { promise: Promise<void>; resolve: () => void };

  constructor(
    private id: string,
    private readonly spec: SessionSpec,
    private readonly config: RollingConfig,
    private readonly deps: ClaudeSessionDeps,
    private readonly unregister: () => void,
  ) {
    super(spec.owner);
    this.asked = spec.model?.id;
    this.instructions = spec.instructions.served;
    // Coding care is fixed at open; only the seat changes effort per turn.
    this.wantedEffort = spec.thinking.quick ? "off" : spec.thinking.level;
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.retirement = { promise, resolve };
  }

  /** Resolves once the session is disposed, its client has exited and the account's store is free. */
  closed(): Promise<void> {
    return this.retirement.promise;
  }

  /** The id the client runs under: the resumed one, or the one a renewal minted. */
  get sessionId(): string {
    return this.id;
  }

  resume(): SessionResume {
    return { backend: "claude", sessionId: this.sessionId };
  }

  /** The app's copy of the client's transcript: the session's durable record. */
  recordPath(options?: { refresh?: boolean }): string {
    if (options?.refresh) this.mirror(this.connection?.sessionId ?? this.id);
    return this.config.store.transcriptPath(this.sessionId);
  }

  isStreaming(): boolean {
    return this.promptOpen || this.continuing;
  }

  modelRef(): { provider: string; id: string } | undefined {
    const id = this.answering ?? this.asked;
    return id ? { provider: CLAUDE_MODEL_PROVIDER, id } : undefined;
  }

  modelLabel(): string | undefined {
    const id = this.answering ?? this.asked;
    return CLAUDE_MODELS.find((model) => model.id === id)?.name;
  }

  prompt(text: string, images?: SessionImage[]): Promise<void> {
    if (this.disposing) return Promise.reject(new Error(ENDED_TEXT));
    if (this.promptOpen || this.continuing) {
      // Overwriting the running turn would orphan whoever awaits it; work
      // for a running turn belongs in steer().
      return Promise.reject(new Error("This session is still working on its current turn."));
    }
    this.promptOpen = true;
    this.generation += 1;
    this.pushed = [];
    this.early = [];
    this.ran = false;
    this.failed = false;
    this.cut = undefined;
    this.interruptedAt = undefined;
    this.served = undefined;
    return new Promise<void>((resolve, reject) => {
      this.turn = { resolve, reject };
      void this.start(this.generation, text, images);
    });
  }

  /** Attach, set the turn's effort, then hand the client the prompt and any steer that waited. */
  private async start(generation: number, text: string, images?: SessionImage[]): Promise<void> {
    let connection: Connection;
    try {
      connection = await this.attach(generation);
      await this.applyEffort(connection);
    } catch (caught) {
      if (generation === this.generation) this.finish(caught);
      return;
    }
    // An abort may have given up on this prompt while the client started.
    if (generation !== this.generation || !this.promptOpen) return;
    this.accepting = true;
    this.push(connection, "prompt", text, images);
    for (const steer of this.early.splice(0)) {
      this.push(connection, "steer", steer.text, steer.images);
    }
    // A dispose that came while the client started ends this turn early too.
    if (this.disposing) void this.interrupt();
  }

  /** Honored when the spec asked for a per-turn level (WI-13). */
  setThinkingLevel(level: ThinkingLevel): void {
    if (!this.spec.thinking.perTurn) return;
    this.wantedEffort = level;
  }

  /** A coding session's effort is set once, on its opening query. */
  reasoning(): Reasoning | undefined {
    return this.spec.builtins === "coding" && this.spec.model
      ? claudeCodingReasoning(this.spec)
      : undefined;
  }

  serveInstructions(instructions: ServedInstructions): void {
    if (this.instructions?.sha === instructions.sha) return;
    // Never mid-turn: a change waits for the next prompt's own boundary. A
    // prompt cannot be patched in place, so the next prompt reattaches -
    // under a new id when the client has recorded this one (`renewIfChanged`).
    if (this.promptOpen || this.continuing) return;
    this.instructions = instructions;
    this.reopen = true;
    this.renewIfChanged();
    void this.stampContract().catch((error: unknown) =>
      this.note(`the contract stamp was not written: ${String(error)}`),
    );
  }

  takeRenewal(): SessionRenewal | undefined {
    const renewal = this.renewal;
    this.renewal = undefined;
    return renewal;
  }

  /**
   * Start over under a new id when the prompt array this session would
   * serve is not the one its client started under. The client resumes a
   * session on the system prompt it recorded at its start (its
   * `prompt_snapshot`), whatever it is handed, so a changed array reaches
   * no request on resume (measured on 2.1.283). It records each tool's
   * description there too and serves a tool it had with the recorded one
   * (measured on 2.1.295), and it serves the tool list it recorded as well:
   * a tool it lacked never arrives and a tool gone is still offered
   * (measured on 2.1.306). So a stamp that fingerprints each tool also
   * starts over when a tool the session had is described differently or
   * a tool came or went - or, when its start named no tool of its own (a
   * seat's from before seats did), when the whole tool surface moved. A
   * session the client has not recorded starts on whatever it is served,
   * and a session with no contract has nothing to compare. A recorded
   * session with no contract stamped before its first prompt started under
   * one nothing vouches for - a crewmate's from before crewmates were
   * stamped - and starts over too. A client that took a prompt has
   * recorded the session even when its file has not landed yet (it writes
   * on its own schedule, and on exit). The app's copy of the old session
   * stays; a client still attached exits at the next attach and its copy
   * is finished under its own id.
   */
  renewIfChanged(): void {
    const stamp = this.config.stamp;
    if (!stamp || (!this.tookPrompt && this.clientTranscript() === null)) return;
    const started = this.startedUnder();
    if (!started) {
      this.renewFor(["prompt"]);
      return;
    }
    const changed: ("prompt" | "instructions")[] = [];
    if (started.prompt_sha !== stamp.promptSha || toolsChanged(started, stamp)) {
      changed.push("prompt");
    }
    if (started.instructions_sha !== this.instructions?.sha) changed.push("instructions");
    if (changed.length === 0) return;
    this.renewFor(changed);
  }

  /** Claude restores its recorded opening prompt; renew when the personal opt-in or files changed. */
  renewPersonalIfChanged(): void {
    if (this.spec.builtins !== "coding" || this.clientTranscript() === null) return;
    const started = this.config.store.sidecar(this.id).find((record) => record.kind === "served");
    const previous = started?.kind === "served" ? started.personalResources : undefined;
    const current = this.spec.personalResources
      ? personalResources(
          this.config.env.HOME,
          new Set(projectSkillFolders(this.spec.cwd).map((skill) => skill.name)),
        ).digests
      : undefined;
    if (JSON.stringify(previous) !== JSON.stringify(current)) this.renewFor(["instructions"]);
  }

  private renewFor(changed: ("prompt" | "instructions")[]): void {
    const from = this.id;
    this.mirror();
    this.id = randomUUID();
    this.tookPrompt = false;
    this.reopen = true;
    this.served = undefined;
    this.divergedNoted = false;
    this.renewal = { from, changed };
    this.note(
      `the ${changed.join(" and ")} changed since session ${from} started; starting ${this.id}`,
    );
  }

  /**
   * The contract the client started this session under: the newest one
   * stamped before its first served prompt. With no served prompt on the
   * record (a stamp that never landed), the first one, so a doubt starts
   * over rather than resuming on a stale prompt; with none before it,
   * undefined.
   */
  private startedUnder(): Extract<SessionSidecarRecord, { kind: "contract" }> | undefined {
    const records = this.config.store.sidecar(this.id);
    const firstServed = records.findIndex((record) => record.kind === "served");
    const contracts = (firstServed === -1 ? records : records.slice(0, firstServed)).filter(
      (record): record is Extract<SessionSidecarRecord, { kind: "contract" }> =>
        record.kind === "contract",
    );
    return firstServed === -1 ? contracts[0] : contracts.at(-1);
  }

  /**
   * Into the running turn - a prompt's or a continuation's - at its next
   * step; with no turn to join, held for the owner to take back.
   */
  steer(text: string, images?: SessionImage[]): Promise<void> {
    if (this.disposing) return Promise.reject(new Error(ENDED_TEXT));
    const connection = this.connection;
    if (this.accepting && connection) {
      this.push(connection, "steer", text, images);
    } else if (this.promptOpen) {
      // The client is still starting: the steer follows the prompt in.
      this.early.push({ text, ...(images ? { images } : {}) });
    } else {
      this.held.push(text);
    }
    return Promise.resolve();
  }

  takeUndeliveredSteers(): string[] {
    if (this.promptOpen || this.continuing) return [];
    return this.held.splice(0);
  }

  /**
   * Interrupt the running turn. With a failure (a watched bound's, say), the
   * cut turn reports it as a failed turn. A client that does not answer the
   * interrupt within a tick is stopped, and the turn ends anyway.
   */
  async abort(failure?: string): Promise<void> {
    if (failure !== undefined && (this.promptOpen || this.continuing) && !this.cut) {
      this.cut = { message: failure, at: this.config.clock.now() };
    }
    await this.interrupt();
  }

  /** Interrupt the turn the client runs: a prompt's once it holds it, or a continuation. */
  private async interrupt(): Promise<void> {
    const connection = this.connection;
    if (!this.accepting || !connection || connection.closing) return;
    this.interrupting = true;
    this.interruptedAt ??= this.config.clock.now();
    try {
      await connection.query.interrupt();
    } catch (caught) {
      this.note(`interrupt failed: ${String(caught)}`);
    }
  }

  /**
   * Ends input only after a settled turn - an open prompt or continuation
   * is interrupted first - and lets the client exit on its own, which is
   * when it writes the last of its transcript. The store stays leased until
   * it has.
   */
  dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    const finish = () => {
      this.disposed = true;
      const connection = this.connection;
      if (connection) this.close(connection);
      else this.retire();
    };
    if (this.promptOpen || this.continuing) {
      this.afterSettle.push(finish);
      void this.interrupt();
    } else {
      finish();
    }
  }

  /**
   * End the client at an idle boundary - after the open prompt or
   * continuation settles, never mid-turn - and hand the account's store
   * back once it has exited. The next prompt reattaches, resuming the
   * session. The owner detaches before anything else may rewrite that store
   * (a sign-in or sign-out) and while the session is benched.
   */
  detach(): Promise<void> {
    return new Promise((resolve) => {
      const end = () => {
        const connection = this.connection;
        if (!connection) {
          resolve();
          return;
        }
        this.close(connection);
        void connection.done.then(() => resolve());
      };
      if (this.promptOpen || this.continuing) this.afterSettle.push(end);
      else end();
    });
  }

  /**
   * Where the last prompt and its steers landed in the recorded transcript
   * (R2 provenance), read from the app's copy as it stands. The client
   * writes its transcript on its own schedule, so a location it has not
   * written yet is null here; the sidecar's served stamp keeps the ids to
   * find it by once it has.
   */
  servedState(): ServedState | undefined {
    const served = this.served;
    if (!served) return undefined;
    this.mirror();
    return this.locate(this.config.store, served);
  }

  /**
   * One tick of the host's clock. The client writes its transcript on its
   * own schedule, so the tail of a turn can land after the idle boundary
   * copied it; while a client stays attached (a crewmate's does, between
   * prompts), each tick brings the app's copy up to it. Then the client's
   * hygiene.
   */
  tick(now: number): void {
    if (this.connection) this.mirror(this.connection.sessionId);
    this.checkClient(now);
  }

  /**
   * A client that has not done what it was asked a tick later is stopped:
   * one still running after its input ended, and one that never answered
   * an interrupt - that turn ends anyway, failed when a failing abort cut it.
   */
  checkClient(now: number): void {
    const connection = this.connection;
    if (
      connection?.closing &&
      connection.closedAt !== undefined &&
      now - connection.closedAt >= TICK_PERIOD_MS
    ) {
      // Its input ended a tick ago and the client is still running: stop it.
      this.close(connection, true);
    }
    // The interrupt never landed within a tick: the client is wedged.
    const asked = this.cut?.at ?? this.interruptedAt;
    if (
      (this.promptOpen || this.continuing) &&
      asked !== undefined &&
      now - asked >= TICK_PERIOD_MS
    )
      this.abandon();
  }

  /** Write the spec's contract stamp when it differs from the session's newest one. */
  async stampContract(): Promise<void> {
    const { stamp, store } = this.config;
    if (!stamp) return;
    const instructionsSha = this.instructions?.sha;
    const recorded = store
      .sidecar(this.sessionId)
      .filter((record) => record.kind === "contract")
      .at(-1);
    if (
      recorded?.version === stamp.version &&
      recorded.prompt_sha === stamp.promptSha &&
      recorded.tools_sha === stamp.toolsSha &&
      recorded.instructions_sha === instructionsSha &&
      JSON.stringify(recorded.tool_shas) === JSON.stringify(stamp.tools)
    ) {
      return;
    }
    await store.stamp(this.sessionId, {
      kind: "contract",
      at: this.config.clock.now(),
      version: stamp.version,
      prompt_sha: stamp.promptSha,
      ...(instructionsSha ? { instructions_sha: instructionsSha } : {}),
      tools_sha: stamp.toolsSha,
      ...(stamp.tools ? { tool_shas: { ...stamp.tools } } : {}),
    });
  }

  private personalDigests: PersonalResourceDigests | undefined;

  /**
   * A coding session's working copy as this attach hands it to the client:
   * its instruction file, read now, and its skills, staged beside the
   * session's record. A stage that fails costs the skills, never the attach.
   */
  private async projectResources(): Promise<ClaudeProjectResources | undefined> {
    const shape = this.spec.shape;
    if (this.spec.builtins !== "coding" || shape.turns !== "rolling") return undefined;
    let project: ClaudeProjectResources;
    try {
      project = await claudeProjectResources(
        this.spec.cwd,
        join(shape.record.dir, CLAUDE_PROJECT_SKILLS_DIR),
      );
    } catch (error) {
      this.note(`the working copy's skills were not staged: ${String(error)}`);
      const instructions = projectInstructions(this.spec.cwd);
      project = instructions ? { instructions } : {};
    }
    this.personalDigests = undefined;
    if (this.spec.personalResources) {
      const names = new Set(projectSkillFolders(this.spec.cwd).map((skill) => skill.name));
      const personal = personalResources(this.config.env.HOME, names);
      this.personalDigests = personal.digests;
      project.personalInstructions = personal.instructions
        ? personalInstructionsText(personal.instructions)
        : PERSONAL_RESOURCE_RULES;
      try {
        project.personalSkillsPlugin = await stageClaudeSkills(
          personal.skills,
          join(shape.record.dir, "personal-skills"),
          "personal",
        );
      } catch (error) {
        this.note(`the personal skills were not staged: ${String(error)}`);
      }
    }
    if (this.spec.runbookSkills) {
      const names = new Set(projectSkillFolders(this.spec.cwd).map((skill) => skill.name));
      if (this.spec.personalResources)
        for (const skill of personalResources(this.config.env.HOME, names).skills)
          names.add(skill.name);
      const folders = await stageRunbookSkills(
        this.spec.runbookSkills.filter((skill) => !names.has(skill.name)),
        join(shape.record.dir, "runbook-files"),
      );
      project.runbookSkillsPlugin = await stageClaudeSkills(
        folders,
        join(shape.record.dir, "runbook-skills"),
        "runbooks",
      );
    }
    return project;
  }

  /**
   * The live attachment, reopened when it ended or new instructions wait,
   * for the prompt numbered `generation`. An attach can outlive its prompt
   * (the bounds give up on it while it waits for a sign-in to finish), so
   * after every wait it checks the prompt is still the one it serves and
   * spawns nothing otherwise: a later attach, a detach or a dispose never
   * has an orphaned client beside it.
   */
  private async attach(generation: number): Promise<Connection> {
    const current = this.connection;
    if (current && !current.closing && !this.reopen) return current;
    if (current) {
      this.close(current);
      await current.done;
    }
    // Whatever the client wrote since the last boundary, before it runs again.
    this.mirror();
    this.reopen = false;
    const env = this.config.env;
    // The machine's own client (F14), checked at every attachment: refuse
    // with its sentence, before anything is leased, when it is gone or old.
    const issue = claudeClientIssueText(await (this.deps.checkClient ?? checkClaudeClient)(env));
    if (issue) throw new Error(issue);
    this.stillServing(generation);
    // This client holds the account's store for as long as it runs: it
    // refreshes its own login inside the run, and the refresh token behind
    // it is single use. A sign-in in progress is waited out first.
    const release = await acquireSessionLease(this.deps.configDir);
    try {
      this.stillServing(generation);
    } catch (caught) {
      release();
      throw caught;
    }
    // A session the client has recorded resumes; one it has not (no turn
    // yet) starts under the same id.
    const recorded = this.clientTranscript() !== null;
    // A resume that names no model would get back the model the client
    // swapped in (it restores its transcript's last one): ask for the one
    // it swapped out instead.
    if (this.asked === undefined && recorded) this.asked = this.swappedFrom();
    const input = new MessageQueue();
    const project = await this.projectResources();
    const options = claudeSessionOptions({
      spec: this.spec,
      env,
      executable: resolveClaudeExecutable(env),
      stderr: (data) => this.note(data.trimEnd()),
      attachment: {
        ...(this.asked ? { model: this.asked } : {}),
        ...(this.instructions?.text ? { served: this.instructions.text } : {}),
        session: recorded ? { resume: this.sessionId } : { sessionId: this.sessionId },
        ...(project ? { project } : {}),
      },
    });
    let query: Query;
    try {
      query = (this.deps.query ?? sdkQuery)({ prompt: input, options });
    } catch (caught) {
      release();
      throw caught;
    }
    // A new client starts the normalizer over: its usage counts from zero
    // (the running totals turn its cumulative figures into each turn's
    // delta), and nothing the last client said about its turn - a pushed
    // reading, an error, a tool in flight - classifies this one's.
    this.normalizer = createNormalizerState();
    if (this.spec.builtins === "coding")
      this.emit({ type: "background_work_changed", count: undefined });
    const connection: Connection = {
      sessionId: this.id,
      query,
      input,
      effort: this.spec.thinking.quick ? "off" : this.spec.thinking.level,
      closing: false,
      done: Promise.resolve(),
      release,
    };
    this.connection = connection;
    connection.done = this.pumpQuery(query);
    return connection;
  }

  /** Throws, spawning nothing, when the prompt an attach serves is no longer the open one. */
  private stillServing(generation: number): void {
    if (this.disposed) throw new Error(ENDED_TEXT);
    if (generation !== this.generation || !this.promptOpen) {
      throw new Error("The turn ended before Claude attached.");
    }
  }

  /** Per turn (WI-13): the client changes effort from its next request on. */
  private async applyEffort(connection: Connection): Promise<void> {
    if (connection.effort === this.wantedEffort || this.wantedEffort === "off") return;
    const effort = this.wantedEffort;
    try {
      await connection.query.applyFlagSettings({ effortLevel: effort });
      connection.effort = effort;
    } catch (caught) {
      // The turn still runs, at the effort the client has.
      this.note(`effort ${effort} was not applied: ${String(caught)}`);
    }
  }

  private push(
    connection: Connection,
    kind: Pushed["kind"],
    text: string,
    images: SessionImage[] | undefined,
  ): void {
    const uuid = randomUUID();
    this.pushed.push({ uuid, kind, text, acked: false });
    connection.input.push(
      userMessage(text, kind === "steer" ? CLAUDE_STEER_PRIORITY : undefined, images, uuid),
    );
  }

  /**
   * End an attachment: its input ends and the client exits on its own,
   * writing the last of its transcript; `hard` stops it outright (a client
   * that stopped answering).
   */
  private close(connection: Connection, hard = false): void {
    if (!connection.closing) {
      connection.closing = true;
      connection.closedAt = this.config.clock.now();
      connection.input.close();
    }
    if (hard) connection.query.close();
  }

  /** The session is gone: its record is final, the store is free, the clock forgets it. */
  private retire(): void {
    if (this.retired) return;
    this.retired = true;
    this.mirror();
    this.unregister();
    this.retirement.resolve();
  }

  protected observe(message: unknown, result: ClaudeNormalizeResult): void {
    const record = message as {
      type?: unknown;
      subtype?: unknown;
      model?: unknown;
      state?: unknown;
      isReplay?: unknown;
      uuid?: unknown;
      event?: { type?: unknown };
    };
    if (record.type === "system" && record.subtype === "compact_boundary") {
      this.emit({ type: "context_compacted" });
    }
    if (this.spec.builtins === "coding" && result.backgroundJobs !== undefined) {
      this.emit({
        type: "background_work_changed",
        count: result.backgroundJobs,
        tasks: result.backgroundTasks ?? [],
      });
    }
    if (record.type === "system" && record.subtype === "init" && typeof record.model === "string") {
      // A session that named no model keeps the one it opened on.
      this.asked ??= record.model;
      this.serve(record.model);
    }
    // The client moved the session off the model it asked for (a refusal
    // fallback). A subagent's own fallback leaves the session's model as it was.
    if (result.fallback?.scope === "session") this.serve(result.fallback.to, result.fallback);
    if (record.type === "system" && record.subtype === "session_state_changed") {
      this.statesSeen = true;
      if (record.state === "running") {
        // Running with no prompt open is the client resuming on its own.
        if (this.promptOpen) this.ran = true;
        else this.beginContinuation();
      }
      if (record.state === "idle") {
        if (this.promptOpen) {
          if (this.accepting && this.ran) this.finish();
        } else {
          this.endContinuation();
        }
      }
      return;
    }
    if (record.type === "user" && record.isReplay === true && typeof record.uuid === "string") {
      this.acksSeen = true;
      const pushed = this.pushed.find((entry) => entry.uuid === record.uuid);
      if (pushed && !pushed.acked) {
        pushed.acked = true;
        this.emit({
          type: "input_read",
          textSha256: createHash("sha256").update(pushed.text).digest("hex"),
        });
      }
    }
    if (record.type === "stream_event" && record.event?.type === "message_start") {
      // One model request begins: the per-inference clock starts over.
      this.emit({ type: "request_started" });
    }
    if (result.rateLimit) this.deps.onRateLimit?.(this.config.accountId, result.rateLimit);
  }

  protected resultFailed(result: ClaudeNormalizeResult, failure: ClaudeTurnFailure): void {
    this.failed = true;
    // An answer that kept running past the spec's output cap is the cap's
    // failure, said in the session's words rather than the client's.
    const cap = this.spec.bounds?.request?.maxOutputTokens;
    this.emit({
      type: "turn_failed",
      taskId: this.taskId,
      error: failure.outputCapped && cap !== undefined ? outputCapErrorMessage(cap) : failure.error,
      ...(failure.cutOff ? { cutOff: failure.cutOff } : {}),
      ...(failure.contextOverflow ? { contextOverflow: true } : {}),
    });
    this.closeTurn(result, undefined);
  }

  protected resultInterrupted(result: ClaudeNormalizeResult): void {
    // An abort with a failure (a watched bound's) interrupted the turn: say
    // it, the way the Pi session rewrites its cut turn. A plain abort ends
    // quietly.
    const cut = this.cut;
    if (cut && !this.failed) {
      this.failed = true;
      this.emit({ type: "turn_failed", taskId: this.taskId, error: cut.message });
    }
    this.closeTurn(result, undefined);
  }

  protected resultClean(result: ClaudeNormalizeResult): void {
    this.deps.onServed?.(this.config.accountId);
    this.closeTurn(result, result.finalText?.trim() || undefined);
  }

  protected streamFailed(caught: unknown, stream: AsyncIterable<unknown>): void {
    const connection = this.connection;
    if (!connection || connection.query !== stream || connection.closing) return;
    const message = caught instanceof Error ? caught.message : String(caught);
    this.note(`the client stopped: ${message}`);
    // The failure was already told; the throw is the same failure ending the stream.
    if (this.continuing) {
      this.endContinuation(this.failed ? undefined : message);
      return;
    }
    if (!this.promptOpen) return;
    if (this.failed) this.finish();
    else this.finish(caught);
  }

  protected streamEnded(stream: AsyncIterable<unknown>): void {
    const connection = this.connection;
    if (!connection || connection.query !== stream) return;
    this.connection = undefined;
    if (this.spec.builtins === "coding")
      this.emit({ type: "background_work_changed", count: undefined });
    // The client has exited: its store is free, and its transcript is
    // complete up to here.
    connection.release();
    this.mirror(connection.sessionId);
    this.endContinuation(STOPPED_TEXT);
    if (connection.closing) {
      if (this.disposing) this.retire();
      return;
    }
    if (this.promptOpen) this.finish(new Error(STOPPED_TEXT));
  }

  protected override emitAll(events: readonly FmEvent[]): void {
    super.emitAll(bareToolNames(events));
  }

  /** One result: its events, then the session's closing text for it. */
  private closeTurn(result: ClaudeNormalizeResult, text: string | undefined): void {
    this.ran = true;
    this.emitAll(result.events);
    this.emit({ type: "turn_closed", ...(text ? { text } : {}) });
    if (this.cut) {
      // The cut's interrupt landed. A steer the client still holds is
      // answered in a turn of its own, under bounds of its own: the wedge
      // watch stands down, and a bound that cuts that turn is reported as
      // this one was.
      this.cut = undefined;
      this.failed = false;
    }
    // The client answered: it is not wedged.
    this.interruptedAt = undefined;
    // A client that never reports its state settles on the result that
    // follows the last acknowledged message.
    if (!this.statesSeen && (!this.acksSeen || this.pushed.every((entry) => entry.acked))) {
      this.finish();
    }
  }

  /**
   * The client did not answer its interrupt: end it, and the turn with it -
   * failed when a failing abort cut it, quietly as a plain interrupt ends
   * otherwise. A continuation ends once the stopped client's stream does.
   */
  private abandon(): void {
    const cut = this.cut;
    this.cut = undefined;
    this.interruptedAt = undefined;
    if (this.promptOpen && !this.failed) {
      if (cut) {
        this.failed = true;
        this.emit({ type: "turn_failed", taskId: this.taskId, error: cut.message });
      }
      this.emit({ type: "turn_end", taskId: this.taskId });
      this.emit({ type: "turn_closed" });
    }
    const connection = this.connection;
    if (connection) this.close(connection, true);
    this.finish();
  }

  /** The prompt is over: record where it landed, then settle it. */
  private finish(caught?: unknown): void {
    if (!this.promptOpen) return;
    this.promptOpen = false;
    this.accepting = false;
    this.interrupting = false;
    this.interruptedAt = undefined;
    this.holdUnacknowledgedSteers();
    for (const steer of this.early.splice(0)) this.held.push(steer.text);
    this.mirror();
    this.served = this.pushed;
    // The durable join: the ids the client acknowledged each message by,
    // which is how its transcript names them (the prompt as its own entry,
    // a folded steer as an attachment naming it as its source).
    const acked = this.pushed.filter((entry) => entry.acked);
    const store = this.config.store;
    if (acked.length > 0) {
      this.tookPrompt = true;
      const [first] = this.pushed;
      const asStamp = (entry: Pushed) => ({ textSha256: sha256(entry.text), uuid: entry.uuid });
      void store
        .stamp(this.sessionId, {
          kind: "served",
          ...(this.personalDigests ? { personalResources: this.personalDigests } : {}),
          at: this.config.clock.now(),
          prompt: first?.kind === "prompt" && first.acked ? asStamp(first) : null,
          steers: acked.filter((entry) => entry.kind === "steer").map(asStamp),
        })
        .catch((error: unknown) => this.note(`the served stamp was not written: ${String(error)}`));
    }
    if (caught === undefined) this.settleTurn();
    else this.rejectTurn(caught);
    for (const after of this.afterSettle.splice(0)) after();
  }

  /** A steer the client never took in goes back to the owner. */
  private holdUnacknowledgedSteers(): void {
    for (const entry of this.pushed) {
      if (entry.kind === "steer" && !entry.acked) this.held.push(entry.text);
    }
  }

  /**
   * The client said it is running with no prompt open: it resumed on its
   * own (a background command it started finished), and the owner gets the
   * same turn boundary a prompt has. A client whose input is ending is not
   * starting work for anyone.
   */
  private beginContinuation(): void {
    const connection = this.connection;
    if (this.continuing || this.disposing || !connection || connection.closing) return;
    this.continuing = true;
    this.accepting = true;
    this.pushed = [];
    this.failed = false;
    this.cut = undefined;
    this.interruptedAt = undefined;
    this.emit({ type: "continuation_started" });
  }

  /**
   * The continuation is over: the client is idle again, or it exited
   * (`error`). Its own failure, when it had one, was already told as its
   * turn's `turn_failed`.
   */
  private endContinuation(error?: string): void {
    if (!this.continuing) return;
    this.continuing = false;
    this.accepting = false;
    this.interrupting = false;
    this.cut = undefined;
    this.interruptedAt = undefined;
    this.holdUnacknowledgedSteers();
    this.mirror();
    this.emit({ type: "continuation_ended", ...(error !== undefined ? { error } : {}) });
    for (const after of this.afterSettle.splice(0)) after();
  }

  /**
   * Where a prompt and its steers landed in the recorded transcript: the
   * prompt is recorded under the uuid the session gave it, a steer folded
   * into a running turn under an attachment naming that uuid as its source.
   * The prefix is the chain of recorded entries the prompt was appended to.
   * A message the copy does not hold keeps null locations, never a guess.
   */
  private locate(store: SessionRecordStore, pushed: Pushed[]): ServedState {
    const { entries, byUuid } = store.index(this.sessionId);
    // A folded steer is recent: search for its attachment from the end back.
    const find = (uuid: string): SessionRecordEntry | undefined =>
      byUuid.get(uuid) ??
      entries.findLast(
        (entry) =>
          entry.type === "attachment" &&
          (entry.attachment as { source_uuid?: unknown } | undefined)?.source_uuid === uuid,
      );
    const asServed = (message: Pushed): ServedMessage & { found: boolean } => {
      const entry = message.acked ? find(message.uuid) : undefined;
      const parent = entry?.parentUuid;
      return {
        textSha256: sha256(message.text),
        entryId: entry?.uuid ?? null,
        parentEntryId: typeof parent === "string" ? parent : null,
        found: entry !== undefined,
      };
    };
    const [first, ...rest] = pushed;
    const prompt =
      first?.kind === "prompt" && first.acked
        ? (() => {
            const { found, ...served } = asServed(first);
            return {
              ...served,
              prefix: found ? prefixOf(byUuid, served.parentEntryId) : null,
            };
          })()
        : null;
    const steers = (first?.kind === "prompt" ? rest : pushed)
      .filter((entry) => entry.acked)
      .map((entry) => {
        const { found: _found, ...served } = asServed(entry);
        return served;
      });
    return { sessionFile: store.transcriptPath(this.sessionId), prompt, steers };
  }

  /**
   * The model the client answers on now, said to the owner when it is news:
   * its first report, and every change after it.
   */
  private serve(raw: string, fallback?: { from: string; category?: string }): void {
    const id = this.named(raw);
    if (!id || id === this.answering) return;
    this.answering = id;
    this.emit({
      type: "model_served",
      model: { provider: CLAUDE_MODEL_PROVIDER, id },
      ...(fallback
        ? {
            fallback: {
              from: { provider: CLAUDE_MODEL_PROVIDER, id: this.named(fallback.from) },
              ...(fallback.category ? { category: fallback.category } : {}),
            },
          }
        : {}),
    });
  }

  /**
   * A model the client reported, as Infinitary names it: the client's own
   * variant and snapshot marks (`[1m]`, a date) name the same model, and the
   * spec's model keeps the id the spec gave it.
   */
  private named(raw: string): string {
    const id = canonicalClaudeModelId({ value: raw });
    const spec = this.spec.model?.id;
    return spec && canonicalClaudeModelId({ value: spec }) === id ? spec : id;
  }

  /**
   * The model the client swapped this session off, read from the app's copy
   * of its transcript: the first session-wide refusal fallback it recorded
   * (`model_refusal_fallback`, `scope` absent on an older client). Undefined
   * when the session never fell back.
   */
  private swappedFrom(): string | undefined {
    const entry = this.config.store
      .entries(this.sessionId)
      .find(
        (each) =>
          each.type === "system" &&
          each.subtype === "model_refusal_fallback" &&
          each.scope !== "local" &&
          typeof each.originalModel === "string",
      );
    return entry ? (entry.originalModel as string) : undefined;
  }

  /** Where the client keeps a session's transcript (this one's by default), or null when it has none. */
  private clientTranscript(sessionId = this.id): string | null {
    return locateClaudeTranscript({
      configDir: this.deps.configDir,
      cwd: this.spec.cwd,
      sessionId,
    });
  }

  /**
   * Bring the app's copy up to the client's transcript: an idle boundary's
   * durable record. A client a renewal left behind finishes its own id's copy.
   */
  private mirror(sessionId = this.id): void {
    const store = this.config.store;
    try {
      const outcome = store.mirror(sessionId, this.clientTranscript(sessionId));
      // Said once: every tick while the client stays attached finds it again.
      if (outcome.kind === "diverged" && !this.divergedNoted) {
        this.divergedNoted = true;
        this.note("the client's transcript no longer extends the app's copy; the copy is kept");
      }
    } catch (caught) {
      this.note(`the transcript copy failed: ${String(caught)}`);
    }
  }

  private note(line: string): void {
    if (!line) return;
    noteTo(this.deps)(line);
  }
}

/** The recorded chain a message was appended to, root first, as the client resumes it. */
function prefixOf(
  byUuid: ReadonlyMap<string, SessionRecordEntry>,
  parentId: string | null,
): { messageCount: number; sha256: string } {
  const chain: SessionRecordEntry[] = [];
  const visited = new Set<string>();
  let id = parentId;
  while (id && !visited.has(id)) {
    visited.add(id);
    const entry = byUuid.get(id);
    if (!entry) break;
    chain.unshift(entry);
    id = typeof entry.parentUuid === "string" ? entry.parentUuid : null;
  }
  return { messageCount: chain.length, sha256: sha256(JSON.stringify(chain)) };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The tools a resumed client would serve are not the ones it is handed: a
 * tool both fingerprints name is described differently now, or one names
 * a tool the other lacks. A stamp that names no tool of its own has
 * nothing to say. A start recorded before its role named each tool (a
 * seat's from before seats did) names only the whole surface: one that
 * moved since may have reworded a tool the session had, so it counts as
 * changed.
 */
function toolsChanged(
  started: Pick<Extract<SessionSidecarRecord, { kind: "contract" }>, "tools_sha" | "tool_shas">,
  stamp: ContractStamp,
): boolean {
  const current = stamp.tools;
  if (!current) return false;
  const recorded = started.tool_shas;
  if (!recorded) return started.tools_sha !== stamp.toolsSha;
  const names = Object.keys(current);
  return (
    names.length !== Object.keys(recorded).length ||
    names.some((name) => recorded[name] !== current[name])
  );
}

/**
 * Claude's session factory. Refuses with the client's sentence when the
 * machine's client is gone or too old, before anything is leased, the way
 * every Claude touchpoint does.
 *
 * One registration on the host's clock brings every live rolling session's
 * record up to its client's transcript and stops a client that did not
 * exit or answer an interrupt, the way the quiet watchdog rides it; no
 * session owns a timer.
 */
export function createClaudeSessionFactory(deps: ClaudeSessionDeps): SessionFactory {
  const live = new Set<ClaudeRollingSession>();
  let unregisterTick: (() => void) | undefined;
  const track = (clock: SessionClock, session: ClaudeRollingSession) => {
    live.add(session);
    unregisterTick ??= clock.register("claude-sessions", TICK_PERIOD_MS, (now) => {
      for (const rolling of live) rolling.tick(now);
    });
  };
  const untrack = (session: ClaudeRollingSession) => {
    live.delete(session);
    if (live.size === 0) {
      unregisterTick?.();
      unregisterTick = undefined;
    }
  };
  // One store per record dir, so every session's stamps on it land in order.
  const stores = new Map<string, SessionRecordStore>();
  const records =
    deps.records ??
    ((dir: string) => {
      let store = stores.get(dir);
      if (!store) {
        store = new SessionRecordStore(dir);
        stores.set(dir, store);
      }
      return store;
    });

  const openRolling = async (
    spec: SessionSpec,
    record: Extract<SessionSpec["shape"], { turns: "rolling" }>["record"],
    accountId: string,
    clock: SessionClock,
    env: NodeJS.ProcessEnv,
  ): Promise<ModelSession> => {
    // The client resumes what it has recorded. An id it has no transcript
    // for (a crash before its first turn, or the client's own sweep) cannot
    // resume, so the session starts fresh under a new id rather than failing
    // every attach on a stale one; the app's copy of the old one stays.
    const requested = record.resume?.backend === "claude" ? record.resume.sessionId : undefined;
    const recorded =
      requested !== undefined &&
      locateClaudeTranscript({ configDir: deps.configDir, cwd: spec.cwd, sessionId: requested }) !==
        null;
    if (requested !== undefined && !recorded) {
      noteTo(deps)(`the client has no transcript for session ${requested}; starting fresh`);
    }
    // The session id is the app's, minted before the client starts, so the
    // owner records the real resumable id the moment the session attaches.
    const sessionId = recorded ? (requested as string) : randomUUID();
    // The store lease is per client, taken as each one attaches (`attach`).
    const session: ClaudeRollingSession = new ClaudeRollingSession(
      sessionId,
      spec,
      {
        accountId,
        env,
        store: records(record.dir),
        stamp: record.stamp,
        clock,
      },
      deps,
      () => untrack(session),
    );
    // Resumed on a changed prompt array, the client would serve the old one.
    if (recorded) {
      session.renewIfChanged();
      session.renewPersonalIfChanged();
    }
    await session.stampContract();
    track(clock, session);
    return session;
  };

  return {
    backend: "claude",
    controlProfile: CLAUDE_CONTROL_PROFILE,
    open: async (spec) => {
      if (spec.machine !== LOCAL_MACHINE_ID) {
        throw new Error(`A Claude session cannot run on machine ${spec.machine}.`);
      }
      const binding = spec.binding;
      if (binding.backend !== "claude") {
        throw new Error(`A Claude session cannot serve a ${binding.backend} binding.`);
      }
      if (!admits(CLAUDE_CONTROL_PROFILE, spec.needs)) {
        throw new Error("A Claude session cannot steer the way this session needs.");
      }
      if (spec.builtins === "coding" && spec.shape.turns !== "rolling") {
        throw new Error("A Claude session serves the coding built-ins on a rolling session only.");
      }
      const clock = deps.clock;
      if (spec.shape.turns === "rolling" && !clock) {
        throw new Error("A rolling Claude session needs the host's clock.");
      }
      // The session's own shell (its task's commands) rides the client's
      // environment, so every command the client runs carries it.
      const env = withTaskShell((deps.env ?? (() => hostEnv()))(), spec.shell);
      // The machine's own client (F14): a session whose client is gone or too
      // old fails its open with the client's sentence, as any attach does.
      const issue = claudeClientIssueText(await (deps.checkClient ?? checkClaudeClient)(env));
      if (issue) throw new Error(issue);
      if (spec.shape.turns === "rolling" && clock) {
        return openRolling(spec, spec.shape.record, binding.accountId, clock, env);
      }
      // Held for the session's life: the client refreshes its own login
      // inside the run, and the refresh token behind it is single use.
      const release = await acquireSessionLease(deps.configDir);
      return new ClaudeOneShotSession(spec, binding.accountId, env, deps, release);
    },
  };
}
