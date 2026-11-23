/**
 * Crewmates' recorded sessions, played into the real host (`./engine.ts`):
 * each crewmate the host starts is a session whose turns are its
 * recording's, each matched to what the host served it, and whose
 * recorded tool calls play into the callbacks the host started it with.
 */

import type { CrewmateSpec } from "../../src/core/orchestrator/crewSession.ts";
import { isCardClosedSteer } from "../../src/core/orchestrator/captainWakes.ts";
import { PI_CONTROL_PROFILE } from "../../src/core/pi/session.ts";
import type { ModelSession, SessionEvent, SessionSpec } from "../../src/core/session/session.ts";
import type { FmEvent } from "../../src/shared/events.ts";
import { cardIdFromEmitResult } from "../dispatch-corpus/cards.ts";
import type { ReplayIds } from "./ids.ts";
import {
  type CrewPart,
  type CrewRecording,
  type CrewSegment,
  type JsonRecord,
  MATCH_LOOKAHEAD_MS,
  normalizeWording,
} from "./recording.ts";
import type { RecordedSteer } from "./timeline.ts";
import { recordedActions, recordedQuestions, syncCardId } from "./translation.ts";

/** The answer a recorded revision without one is replayed with. */
const RECORDED_REVISION_ANSWER = "(recorded before a revision carried its answer)";

/**
 * The two lines a recorded crewmate session shows for a background job: the
 * bash result that hands the job id back, and the `[job]` message its exit
 * arrives as. Between them the host's job registry held that id, which is
 * what the whose-turn rule reads as "provably still moving" (S7c). Both are
 * recorded facts; reading them replaces a registry the replay does not run,
 * and invents nothing.
 */
const JOB_STARTED = /Still running as background job ([0-9a-f]+)/;
const JOB_FINISHED = /background job ([0-9a-f]+) finished/;

export type CrewState = {
  alias: string | null;
  taskId: string;
  recording: CrewRecording | undefined;
  cursor: number;
  /** Guidance steered into the running turn, in order: each plays the recorded turn that answered it. */
  injected: string[];
  streaming: boolean;
  listeners: Set<(event: SessionEvent) => void>;
};

/**
 * A steer telling the crewmate the captain closed its card, served where its
 * recording's next turn answers something else: recordings from before
 * FI3-435 never saw the host tell a card's author of its close.
 */
function unrecordedClose(text: string, state: CrewState): boolean {
  if (!isCardClosedSteer(text)) return false;
  const next = state.recording?.segments[state.cursor];
  return !next || !isCardClosedSteer(next.user);
}

/** What crewmate playback reads from the rest of the replay. */
export type CrewPlaybackHost = {
  ids: ReplayIds;
  /** Each recorded crewmate session, by its recorded task id. */
  crew: ReadonlyMap<string, CrewRecording>;
  /** The report's fidelity counters a crewmate's turn moves. */
  fidelity: { played_crewmate_turns: number; unrecorded_crewmate_turns: number };
  /** The Firstmate's recorded steers to one crewmate. */
  steersTo: (alias: string) => readonly RecordedSteer[];
  /** The recorded task a spawn the replay is playing names, while it plays. */
  pendingSpawnAlias: () => string | null;
  /** A recorded task and its key, mapped to the replay's. */
  aliasTask: (recorded: string, replay: string) => void;
  /** The captain message a recorded line answers. */
  recordedAnswer: (args: JsonRecord, ids: string[]) => number | undefined;
};

export class CrewPlayback {
  /** Each crewmate as the host started it, by task id: the callbacks its recorded tool calls play into. */
  readonly specs = new Map<string, CrewmateSpec>();
  /** Each started crewmate's place in its recording, by its recorded task id. */
  readonly states = new Map<string, CrewState>();
  /** The cards crewmates showed in this replay. */
  readonly cardIds = new Set<string>();
  /** The crewmates' recorded turns the replay played. */
  readonly played = new Set<CrewSegment>();
  /** Crewmate turns still playing. */
  inflight = 0;
  /** Each recorded crewmate's served words the recording holds, read once (`heldInputs`). */
  private readonly heldWords = new Map<string, Set<string>>();
  /** Jobs the recording says were running, per task: the registry, replayed. */
  private readonly runningJobs = new Map<string, Set<string>>();

  constructor(private readonly host: CrewPlaybackHost) {}

  /** A crewmate the host started, as a session whose turns are its recording's. */
  open(session: SessionSpec): ModelSession {
    const spec = this.specs.get(session.owner);
    if (!spec) throw new Error(`the replay opened no crewmate ${session.owner}`);
    const alias = this.host.ids.toRecorded.get(spec.taskId) ?? this.host.pendingSpawnAlias();
    if (alias && !this.host.ids.toReplay.has(alias)) this.host.aliasTask(alias, spec.taskId);
    const state: CrewState = {
      alias,
      taskId: spec.taskId,
      recording: alias ? this.host.crew.get(alias) : undefined,
      cursor: 0,
      injected: [],
      streaming: false,
      listeners: new Set(),
    };
    if (alias) this.states.set(alias, state);
    const emit = (event: FmEvent) => {
      for (const listener of state.listeners) listener(event);
    };
    return {
      sessionId: `replay-crewmate-${alias ?? spec.taskId}`,
      controlProfile: PI_CONTROL_PROFILE,
      // The recordings are the record: the replay keeps none of its own.
      resume: () => undefined,
      recordPath: () => undefined,
      isStreaming: () => state.streaming,
      modelRef: () => ({ provider: "replay", id: "recorded" }),
      modelLabel: () => undefined,
      subscribe: (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      prompt: (text) => this.playCrewTurn(state, spec, emit, text),
      steer: async (text) => {
        // Guidance into a running turn: the recording's turn that answered it
        // is the same turn continuing, not a new prompt (`playCrewTurn`).
        if (state.streaming) state.injected.push(text);
      },
      // A steer during a recorded turn is played as that turn continuing.
      takeUndeliveredSteers: () => [],
      // The recorded turns ran at whatever level and on whatever prompt they ran.
      setThinkingLevel: () => {},
      reasoning: () => undefined,
      serveInstructions: () => {},
      takeRenewal: () => undefined,
      servedState: () => undefined,
      abort: async () => {},
      detach: async () => {},
      dispose: () => {},
      closed: async () => {},
    };
  }

  private playCrewTurn(
    state: CrewState,
    spec: CrewmateSpec,
    emit: (event: FmEvent) => void,
    text = "",
  ): Promise<void> {
    this.inflight += 1;
    state.streaming = true;
    return new Promise((resolve) => {
      setTimeout(() => {
        void (async () => {
          try {
            const first = this.answering(state, text);
            // Words the recording holds no answer to from here - a close a
            // recording from before FI3-435 never saw, a steer it refused -
            // are a silent turn, never the crewmate's recorded answer to
            // something else.
            if (!first) {
              this.host.fidelity.unrecorded_crewmate_turns += 1;
              emit({ type: "turn_end", taskId: state.taskId });
              return;
            }
            this.playCrewSegment(first, state, spec, emit);
            for (let steer = state.injected.shift(); steer !== undefined; steer = state.injected.shift()) {
              const next = this.answering(state, steer);
              if (next) this.playCrewSegment(next, state, spec, emit);
            }
          } finally {
            state.streaming = false;
            state.injected = [];
            this.inflight -= 1;
            resolve();
          }
        })();
      }, 0);
    });
  }

  /**
   * The recorded turn that answers what the host just served a crewmate,
   * with its cursor moved on; null when the recording holds no answer.
   *
   * Served words are answered by the turn not yet played whose input holds
   * the same words, within ten minutes of when the recording shows it, as a
   * wake is matched to its recorded answer. A steer reaches the replay as
   * its Firstmate turn begins, a moment before the crewmate's recording
   * shows it, so that turn plays, and the turns before it whose moment has
   * gone by waited on inputs the current host never served. One that
   * arrives late still plays the turn that answered it. Words the recording
   * holds no answer to from here - a steer it refused, an input whose turn
   * has played - and a close a recording from before FI3-435 never saw play
   * nothing. Anything else (a brief, a choice in today's words) is the next
   * recorded turn, as before.
   */
  private answering(state: CrewState, text: string): CrewSegment | null {
    const segments = state.recording?.segments ?? [];
    const played = (index: number) =>
      this.played.has(segments[index] as CrewSegment);
    while (state.cursor < segments.length && played(state.cursor)) state.cursor += 1;
    const words = this.host.ids.normalize(text);
    const now = Date.now();
    const holds = (index: number) => {
      const segment = segments[index] as CrewSegment;
      return (
        !played(index) &&
        Math.abs(segment.at - now) <= MATCH_LOOKAHEAD_MS &&
        normalizeWording(segment.user) === words
      );
    };
    for (let index = state.cursor; index < segments.length; index += 1) {
      if (!holds(index)) continue;
      // Never past a turn whose input is still to come.
      while (state.cursor < index && (segments[state.cursor] as CrewSegment).at <= now) {
        state.cursor += 1;
      }
      if (state.cursor === index) state.cursor += 1;
      return segments[index] as CrewSegment;
    }
    for (let index = state.cursor - 1; index >= 0; index -= 1) {
      if (holds(index)) return segments[index] as CrewSegment;
    }
    if (this.heldInputs(state).has(words) || unrecordedClose(text, state)) return null;
    const next = segments[state.cursor];
    if (next) state.cursor += 1;
    return next ?? null;
  }

  /** The words a crewmate's recording holds as served to it: its turns' inputs and the Firstmate's steers. */
  private heldInputs(state: CrewState): Set<string> {
    const alias = state.alias ?? "";
    const known = this.heldWords.get(alias);
    if (known) return known;
    const words = new Set([
      ...(state.recording?.segments ?? []).map((segment) => normalizeWording(segment.user)),
      ...this.host.steersTo(alias).map((steer) => steer.words),
    ]);
    this.heldWords.set(alias, words);
    return words;
  }

  private noteJobStarted(taskId: string, jobId: string): void {
    const running = this.runningJobs.get(taskId) ?? new Set<string>();
    running.add(jobId);
    this.runningJobs.set(taskId, running);
  }

  /** A recorded background job's exit notice: the job is no longer running. */
  jobFinished(taskId: string, notice: string): void {
    const finished = JOB_FINISHED.exec(notice);
    if (finished?.[1]) this.runningJobs.get(taskId)?.delete(finished[1]);
  }

  hasRunningJobs(taskId: string): boolean {
    return (this.runningJobs.get(taskId)?.size ?? 0) > 0;
  }

  private playCrewSegment(
    segment: CrewSegment,
    state: CrewState,
    spec: CrewmateSpec,
    emit: (event: FmEvent) => void,
  ): void {
    if (!this.played.has(segment)) {
      this.played.add(segment);
      this.host.fidelity.played_crewmate_turns += 1;
    }
    for (const message of segment.messages) {
      for (const part of message.parts) {
        if (part.type === "text") {
          emit({ type: "assistant_delta", taskId: state.taskId, text: part.text });
          continue;
        }
        const result = segment.results.get(part.id);
        const started = result ? JOB_STARTED.exec(result) : null;
        if (started?.[1]) this.noteJobStarted(state.taskId, started[1]);
        this.crewTool(part, result, spec);
      }
      if (message.error) emit({ type: "turn_failed", taskId: state.taskId, error: message.error });
      emit({ type: "turn_end", taskId: state.taskId });
    }
  }

  private crewTool(
    part: Extract<CrewPart, { type: "toolCall" }>,
    recordedResult: string | undefined,
    spec: CrewmateSpec,
  ): void {
    const args = this.host.ids.mapArgs(part.args) as JsonRecord;
    const text = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : "");
    try {
      switch (part.name) {
        case "emit_card": {
          const shown = syncCardId(
            spec.onCard?.({
              title: text("title"),
              body: recordedQuestions(text("body"), args.actions),
              actions: recordedActions(args.actions),
              ...(text("id") ? { id: text("id") } : {}),
              // A revision recorded before revisions carried an answer stands
              // in with one, or today's host refuses it while the captain waits.
              reply: text("reply") || RECORDED_REVISION_ANSWER,
              answersMessage: this.host.recordedAnswer(args, [
                text("id"),
                `card-${spec.taskId}-${text("id")}`,
              ]),
            }),
          );
          if (shown) {
            this.cardIds.add(shown);
            const was = recordedResult ? cardIdFromEmitResult(recordedResult) : null;
            if (was) this.host.ids.alias(was, shown);
          }
          break;
        }
        case "close_card":
          spec.onCloseCard?.({ cardId: text("card_id"), reason: text("reason") || undefined });
          break;
        case "reply":
          spec.onReply?.({
            cardId: text("card_id"),
            text: text("text"),
            answersMessage: args.interim === true ? undefined : this.host.recordedAnswer(args, [text("card_id")]),
          });
          break;
        case "report":
          spec.onReport?.(text("text"));
          break;
        case "note_progress":
          spec.onProgress?.(text("text"));
          break;
        case "file_followup":
          spec.onFollowup?.({
            title: text("title"),
            goal: text("goal"),
            why: text("why"),
            blocksMe: args.blocks_me === true,
          });
          break;
        default:
          break;
      }
    } catch {
      // A refusal at the crewmate's own boundary: the card is simply not shown.
    }
  }
}
