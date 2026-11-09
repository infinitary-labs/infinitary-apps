import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { HERE } from "@shared/deviceNames";
import { type AppPaths, crewmateSessionsDir } from "../paths";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import {
  buildCrewmateSystemPrompt,
  type CrewmateComputers,
  type CrewmateProcedureFacts,
  crewmateProcedureFor,
  toolFingerprints,
  toolsFingerprint,
} from "../pi/piResources";
import { timeZoneFact } from "../prompts/timeZone";
import type { SelfSourceFacts } from "../selfSource/resolve";
import { sourceContext, sourceIdentity } from "../selfSource/resolve";
import { serveAnswerFiles } from "../session/answerFiles";
import type { OpenReads } from "../session/openReads";
import {
  type ContractStamp,
  LOCAL_MACHINE_ID,
  type SessionBackend,
  type SessionBinding,
  type SessionRenewal,
  type SessionResume,
  type SessionSpec,
  type TaskShell,
  type ThinkingLevel,
} from "../session/session";
import { type BoundTool, bindTools, type CrewmateToolDelegate } from "../session/tools";

export { type CrewmateComputers, type CrewmateProcedureFacts, crewmateProcedureFor };

/**
 * The crewmate's preset on the one session contract (`src/core/session/`):
 * what the supervisor opens a crewmate's session from, on whichever backend
 * its account binds to. A crewmate works in its task's worktree with the
 * backend's own coding set beside the tools its callbacks bind, keeps one
 * rolling record per task, and runs as long as its work does - no time
 * bound, the backend's retries.
 */

/** A crewmate as the supervisor starts it: the task's facts, and the callbacks its tools run on. */
export type CrewmateSpec = CrewmateToolDelegate & {
  runbookText?: string;
  source?: SelfSourceFacts;
  taskId: string;
  /** The machine it runs on (D-11): "local", or the computer that runs work its task names. */
  machineId: string;
  /**
   * The app's own reads its conversation here has open, which the quiet
   * watchdog may answer (INF-2603); a computer that runs work keeps its own.
   */
  openReads?: OpenReads;
  /** The task worktree the crewmate operates in. */
  cwd: string;
  /**
   * The captain's computers and the one it runs on (INF-992); absent while
   * no computer that runs work is listed.
   */
  computers?: CrewmateComputers;
  /**
   * The task's temporary folder on the computer it runs on. Bulk working
   * material goes here and is removed when the task closes.
   */
  tempDir?: string;
  /**
   * The conversation to reopen, as the task record keeps it: the Pi session
   * file, or the Claude session id. Read by the binding's backend.
   */
  resumeToken?: string;
  /** Routed model choice; absent defers to the backend (a resumed session keeps its own). */
  model?: { provider: string; id: string };
  /** Requested effort associated with the model's actually served tier. */
  thinkingLevel?: ThinkingLevel;
  /** Quick care lowers effort once, after the backend clamps to its model. */
  quick?: boolean;
  /** What its shell carries: its task's commands (docs/axi-commands.md). */
  shell?: TaskShell;
  /** This computer supports the declared heavy-run command. */
  load?: boolean;
  /**
   * Delivery and care already known at dispatch. Absent keeps the full
   * prompt, which is the unknown-case fallback.
   */
  procedure?: CrewmateProcedureFacts;
};

/** The effort a crewmate asks for when routing named none. */
const CREWMATE_THINKING: ThinkingLevel = "medium";

/** The retries a crewmate's provider gets before a turn fails. */
const CREWMATE_RETRIES = 2;

/** A Claude session id, as the app mints it and the client reports it. */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The recorded resume token, read by the backend that will reopen it: a Pi
 * session file is an absolute `.jsonl` path, a Claude session a uuid. A
 * token of the wrong shape (a record another backend wrote) reopens
 * nothing, so the crewmate starts a fresh conversation rather than failing
 * its resume.
 */
export function crewmateResume(
  token: string | undefined,
  backend: SessionBackend,
): SessionResume | undefined {
  if (!token) return undefined;
  if (backend === "pi") {
    return isAbsolute(token) && token.endsWith(".jsonl")
      ? { backend: "pi", sessionFile: token }
      : undefined;
  }
  return CLAUDE_SESSION_ID.test(token) ? { backend: "claude", sessionId: token } : undefined;
}

/** What the task record keeps to reopen a crewmate's conversation. */
export function crewmateResumeToken(resume: SessionResume | undefined): string | undefined {
  if (!resume) return undefined;
  return resume.backend === "pi" ? resume.sessionFile : resume.sessionId;
}

/**
 * A crewmate's contract has no revision count of its own; the stamp's
 * hashes are the proof of what served it.
 */
export const CREWMATE_CONTRACT_VERSION = "crewmate";

/**
 * The contract a crewmate's conversation is served, as its record stamps
 * it: the prompt exactly as the session serves it, the tool surface, and
 * each tool's own sha. A Claude client resumes a conversation on the
 * prompt, tool list and tool descriptions it recorded at its start, so an
 * upgrade that changed any of them, or a tool the task gained or lost,
 * starts the conversation over (`renewIfChanged`) rather than running
 * this build's tools under an earlier build's words or list.
 */
export function crewmateContractStamp(
  instructions: string,
  tools: readonly BoundTool[],
): ContractStamp {
  return {
    version: CREWMATE_CONTRACT_VERSION,
    promptSha: createHash("sha256").update(instructions).digest("hex"),
    toolsSha: toolsFingerprint(tools),
    tools: toolFingerprints(tools),
  };
}

/**
 * Why a task's conversation is a new one: its session renewed, the recorded
 * one could not be reopened, or the task moved to a provider whose client
 * cannot reopen it (INF-849), named in `to`.
 */
export type CrewmateRestart =
  | SessionRenewal
  | { from: string; changed: "unopenable" }
  /** The earlier one reached its model's context limit and could not go on (`CrewTurns.recoverContext`). */
  | { from: string; changed: "context" }
  | { from: string; changed: "moved"; to: string }
  /** The task moved to another computer (docs/helper.md, "Moving a started task"). */
  | { from: string; changed: "computer"; to: string };

/** The task timeline's line for a renewed conversation: what changed, and that the earlier one is kept. */
export function crewmateRenewedNote(renewal: SessionRenewal): string {
  const changed = renewal.changed.includes("prompt")
    ? "the instructions and tools its earlier one started under changed with an update"
    : `${HERE.this}'s own instructions and skills changed since its earlier one began`;
  return `it moved to a new conversation, because ${changed}; the earlier one is kept`;
}

/**
 * What a crewmate is told on the first prompt of a conversation that
 * replaced its task's earlier one: why, that it continues rather than
 * starts, where its record and its earlier conversation are, and the brief
 * it first received. The message that brought it back follows.
 */
export function crewmateRestartText(input: {
  restart: CrewmateRestart;
  /** The task's key, which `tasks` reads its record by. */
  taskKey: string;
  /** The brief its first turn served, when the record holds it. */
  brief?: string;
  /** Where the transcript of its earlier conversation is saved, on the computer it runs on. */
  earlier?: string;
}): string {
  const { restart } = input;
  const kept =
    "A reopened conversation would have kept the old ones, so you continue in a new conversation on the current ones.";
  const why =
    restart.changed === "unopenable"
      ? "your earlier conversation could not be reopened, so you continue in a new one."
      : restart.changed === "context"
        ? "your earlier conversation reached the model's context limit, so you continue in a new one."
        : restart.changed === "moved"
          ? `your task moved to ${restart.to}, which cannot reopen a conversation another provider held, so you continue in a new one.`
          : restart.changed === "computer"
            ? `your task moved to ${restart.to}, where your working copy, your evidence, your card bodies and your handed files were moved with it, in the folders your instructions name now. Paths in your earlier messages and your brief name the folders on the computer it left, so use the ones your instructions name now.`
            : restart.changed.includes("prompt")
              ? `the app was updated, and the instructions and tools you started this task under changed. ${kept}`
              : `${HERE.this}'s own instructions and skills changed since your earlier conversation began. ${kept}`;
  return [
    `Your conversation has restarted: ${why} Your earlier conversation is not in this one.`,
    `You are continuing your task, not starting it. What you committed and changed is in your working copy, and your reports, your last card and your brief are on your task's record: read it with tasks (key ${input.taskKey}) before you act, and do not redo work it shows done.${input.earlier ? ` If you need more, the transcript of your earlier conversation is saved at ${input.earlier}; read only the parts you need.` : ""}`,
    ...(input.brief ? [`Your task's brief, as you first received it:\n\n${input.brief}`] : []),
    "The message that brought you back follows.",
  ].join("\n\n");
}

/** The crewmate preset: its spec for a session on `binding`. */
export function crewmateSessionSpec(
  paths: AppPaths,
  spec: CrewmateSpec,
  binding: SessionBinding,
): SessionSpec {
  const resume = crewmateResume(spec.resumeToken, binding.backend);
  // The captain's zone as this Mac reads it when the session opens.
  const instructions =
    buildCrewmateSystemPrompt(
      binding.backend,
      spec.evidenceDir,
      spec.cardBodiesDir,
      timeZoneFact(Date.now()),
      // A task on another computer is granted its command by that computer's
      // own task channel, beside its shell there.
      spec.browser !== undefined &&
        (spec.shell !== undefined || spec.machineId !== LOCAL_MACHINE_ID),
      spec.procedure,
      spec.tempDir,
      // Its files command rides the same channel, here or there (docs/files.md).
      spec.computers &&
        spec.files !== undefined &&
        (spec.shell !== undefined || spec.machineId !== LOCAL_MACHINE_ID)
        ? { ...spec.computers, files: true }
        : spec.computers,
      // Its integrations' command rides the same channel, here or there.
      spec.integrations !== undefined &&
        (spec.shell !== undefined || spec.machineId !== LOCAL_MACHINE_ID),
      spec.load,
      spec.runbookText,
    ) +
    (spec.machineId === LOCAL_MACHINE_ID
      ? `\n${sourceContext(spec.source, spec.source && sourceIdentity(spec.source))}`
      : "\nThe executing computer supplies its own Infinitary source facts separately. If absent, its source is unknown; never reuse a path from another computer.");
  const bound = bindTools(CREWMATE_TOOLS, spec);
  const served = spec.openReads ? spec.openReads.serve(bound) : bound;
  // An answer too long to read whole goes to a file beside the crewmate's
  // shell; a computer that runs work saves its own (`SessionHost`).
  const tools =
    spec.tempDir !== undefined && spec.machineId === LOCAL_MACHINE_ID
      ? serveAnswerFiles(served, spec.tempDir)
      : served;
  return {
    ...(spec.source ? { homeSource: sourceIdentity(spec.source) } : {}),
    machine: spec.machineId,
    owner: spec.taskId,
    cwd: spec.cwd,
    binding,
    ...(spec.requestedSpeed
      ? {
          speed: {
            requested: spec.requestedSpeed,
            record: (model, selection) => spec.onSpeed?.(model, selection),
          },
        }
      : {}),
    ...(spec.model ? { model: spec.model } : {}),
    thinking: {
      level: spec.thinkingLevel ?? CREWMATE_THINKING,
      ...(spec.quick ? { quick: true } : {}),
    },
    instructions: { base: instructions },
    builtins: "coding",
    tools,
    ...(spec.shell ? { shell: spec.shell } : {}),
    ...(spec.load ? { load: true } : {}),
    callbacks: spec,
    shape: {
      turns: "rolling",
      record: {
        dir: crewmateSessionsDir(paths, spec.taskId),
        ...(resume ? { resume } : {}),
        stamp: crewmateContractStamp(instructions, tools),
      },
    },
    // Crew turns are long by design: no time bound, the provider's retries.
    bounds: { request: { retries: CREWMATE_RETRIES } },
  };
}
