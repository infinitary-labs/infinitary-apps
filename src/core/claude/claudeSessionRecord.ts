import { createHash } from "node:crypto";
import type { ServedMessage, ServedState } from "../orchestrator/seat";
import type { SessionClock } from "../session/bounds";
import type { PersonalResourceDigests } from "../session/personalResources";
import type { ContractStamp } from "../session/session";
import type {
  SessionRecordEntry,
  SessionRecordStore,
  SessionSidecarRecord,
} from "../storage/sessionRecordStore";
import type { ClaudeTranscriptLookup } from "./claudeTranscript";
import { chainTo, PrefixDigest } from "./prefixDigest";

/** A message a rolling session pushed to its client, and whether a turn took it in. */
export type Pushed = {
  uuid: string;
  kind: "prompt" | "steer";
  text: string;
  acked: boolean;
};

type ContractRecord = Extract<SessionSidecarRecord, { kind: "contract" }>;

/**
 * A rolling Claude session's durable record, by session id: the app's copy
 * of the client's own transcript (`SessionRecordStore`), brought up to it at
 * every boundary the session names, and the sidecar stamps beside it - the
 * contract each session started under, and where each prompt and its steers
 * landed. The session keeps the id and the turn; this keeps what is written.
 */
export class ClaudeSessionRecord {
  /** The fingerprint of the recorded chain each prompt was appended to, read as it grows. */
  private readonly prefix = new PrefixDigest();
  private readonly mirrors = new Set<Promise<void>>();
  /** The client's transcript stopped extending the app's copy, and the log says so. */
  private divergedNoted = false;

  constructor(
    readonly store: SessionRecordStore,
    private readonly transcripts: ClaudeTranscriptLookup,
    private readonly clock: SessionClock,
    private readonly note: (line: string) => void,
  ) {}

  /** Where the client keeps a session's transcript, or null when it has none. */
  clientTranscript(sessionId: string): string | null {
    return this.transcripts.read(sessionId);
  }

  /**
   * Bring the app's copy up to the client's transcript: an idle boundary's
   * durable record. A client a renewal left behind finishes its own id's copy.
   */
  mirror(sessionId: string): void {
    void this.bringUp(sessionId);
  }

  bringUp(sessionId: string): Promise<void> | undefined {
    const source = this.clientTranscript(sessionId);
    if (!source) return this.refreshMirror(sessionId);
    this.copyTranscript(sessionId, source);
    return undefined;
  }

  refreshMirror(sessionId: string): Promise<void> {
    const refresh = this.transcripts
      .find(sessionId)
      .then((source) => {
        this.copyTranscript(sessionId, source);
      })
      .catch((caught: unknown) => {
        this.note(`the transcript lookup failed: ${String(caught)}`);
      })
      .finally(() => this.mirrors.delete(refresh));
    this.mirrors.add(refresh);
    return refresh;
  }

  async settled(): Promise<void> {
    await Promise.all(this.mirrors);
  }

  /** A session id is done with: its parsed entries are never read again, and its copy on disk stays. */
  release(sessionId: string): void {
    this.store.release(sessionId);
    this.prefix.release();
    this.divergedNoted = false;
  }

  /**
   * The seat's turn close reads where its prompt landed (`locate`), and the
   * prefix fingerprint covers its whole recorded chain. Once a recorded
   * session opens and again while each turn runs, the copy is read and the
   * chain hashed a line at a time, so the close parses and hashes only what
   * the turn added (INF-2408). `current` says the session still runs under
   * this id once the read lands.
   */
  async readAhead(sessionId: string, current: () => boolean): Promise<void> {
    try {
      await this.store.catchUp(sessionId);
      // A session that ended or moved to a new id let go of this copy's entries.
      if (!current() || !this.store.holdsParsed(sessionId)) return;
      const { entries, byUuid } = this.store.index(sessionId);
      const leaf = entries.findLast((entry) => typeof entry.uuid === "string");
      if (leaf) await this.prefix.prime(chainTo(byUuid, leaf.uuid as string));
    } catch (caught) {
      this.note(`the transcript could not be read ahead of the turn's end: ${String(caught)}`);
    }
  }

  /**
   * Whether a session must start over under a new id, and for what: the
   * prompt array it would serve is not the one its client started under.
   * The client resumes a session on the system prompt it recorded at its
   * start (its `prompt_snapshot`), whatever it is handed, so a changed array
   * reaches no request on resume (measured on 2.1.283). It records each
   * tool's description there too and serves a tool it had with the recorded
   * one (measured on 2.1.295), and it serves the tool list it recorded as
   * well: a tool it lacked never arrives and a tool gone is still offered
   * (measured on 2.1.306). So a stamp that fingerprints each tool also
   * starts over when a tool the session had is described differently or a
   * tool came or went - or, when its start named no tool of its own (a
   * seat's from before seats did), when the whole tool surface moved. A
   * session the client has not recorded starts on whatever it is served,
   * and a session with no contract has nothing to compare. A recorded
   * session with no contract stamped before its first prompt started under
   * one nothing vouches for - a crewmate's from before crewmates were
   * stamped - and starts over too. A client that took a prompt
   * (`tookPrompt`) has recorded the session even when its file has not
   * landed yet (it writes on its own schedule, and on exit).
   */
  changedSinceStart(
    sessionId: string,
    stamp: ContractStamp | undefined,
    instructionsSha: string | undefined,
    tookPrompt: boolean,
  ): ("prompt" | "instructions")[] | undefined {
    if (!stamp || (!tookPrompt && this.clientTranscript(sessionId) === null)) return undefined;
    const started = this.startedUnder(sessionId);
    if (!started) return ["prompt"];
    const changed: ("prompt" | "instructions")[] = [];
    if (started.prompt_sha !== stamp.promptSha || toolsChanged(started, stamp)) {
      changed.push("prompt");
    }
    if (started.instructions_sha !== instructionsSha) changed.push("instructions");
    return changed.length > 0 ? changed : undefined;
  }

  personalAtStart(sessionId: string): PersonalResourceDigests | undefined {
    const started = this.store.sidecar(sessionId).find((record) => record.kind === "served");
    return started?.kind === "served" ? started.personalResources : undefined;
  }

  async stampContract(
    sessionId: string,
    stamp: ContractStamp | undefined,
    instructionsSha: string | undefined,
  ): Promise<void> {
    if (!stamp) return;
    const recorded = this.store
      .sidecar(sessionId)
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
    await this.store.stamp(sessionId, {
      kind: "contract",
      at: this.clock.now(),
      version: stamp.version,
      prompt_sha: stamp.promptSha,
      ...(instructionsSha ? { instructions_sha: instructionsSha } : {}),
      tools_sha: stamp.toolsSha,
      ...(stamp.tools ? { tool_shas: { ...stamp.tools } } : {}),
    });
  }

  /**
   * The durable join for a settled prompt: the ids the client acknowledged
   * each message by, which is how its transcript names them (the prompt as
   * its own entry, a folded steer as an attachment naming it as its source).
   */
  stampServed(
    sessionId: string,
    pushed: Pushed[],
    personalDigests: PersonalResourceDigests | undefined,
  ): void {
    const [first] = pushed;
    const asStamp = (entry: Pushed) => ({ textSha256: sha256(entry.text), uuid: entry.uuid });
    void this.store
      .stamp(sessionId, {
        kind: "served",
        ...(personalDigests ? { personalResources: personalDigests } : {}),
        at: this.clock.now(),
        prompt: first?.kind === "prompt" && first.acked ? asStamp(first) : null,
        steers: pushed.filter((entry) => entry.acked && entry.kind === "steer").map(asStamp),
      })
      .catch((error: unknown) => this.note(`the served stamp was not written: ${String(error)}`));
  }

  /**
   * Where a prompt and its steers landed in the recorded transcript: the
   * prompt is recorded under the uuid the session gave it, a steer folded
   * into a running turn under an attachment naming that uuid as its source.
   * The prefix is the chain of recorded entries the prompt was appended to.
   * A message the copy does not hold keeps null locations, never a guess.
   */
  locate(sessionId: string, pushed: Pushed[]): ServedState {
    const { entries, byUuid } = this.store.index(sessionId);
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
              prefix: found ? this.prefix.of(chainTo(byUuid, served.parentEntryId)) : null,
            };
          })()
        : null;
    const steers = (first?.kind === "prompt" ? rest : pushed)
      .filter((entry) => entry.acked)
      .map((entry) => {
        const { found: _found, ...served } = asServed(entry);
        return served;
      });
    return { sessionFile: this.store.transcriptPath(sessionId), prompt, steers };
  }

  /**
   * The model the client swapped a session off, read from the app's copy of
   * its transcript: the first session-wide refusal fallback it recorded
   * (`model_refusal_fallback`, `scope` absent on an older client). Undefined
   * when the session never fell back.
   */
  swappedFrom(sessionId: string): string | undefined {
    const entry = this.store
      .entries(sessionId)
      .find(
        (each) =>
          each.type === "system" &&
          each.subtype === "model_refusal_fallback" &&
          each.scope !== "local" &&
          typeof each.originalModel === "string",
      );
    return entry ? (entry.originalModel as string) : undefined;
  }

  /**
   * The contract the client started a session under: the newest one stamped
   * before its first served prompt. With no served prompt on the record (a
   * stamp that never landed), the first one, so a doubt starts over rather
   * than resuming on a stale prompt; with none before it, undefined.
   */
  private startedUnder(sessionId: string): ContractRecord | undefined {
    const records = this.store.sidecar(sessionId);
    const firstServed = records.findIndex((record) => record.kind === "served");
    const contracts = (firstServed === -1 ? records : records.slice(0, firstServed)).filter(
      (record): record is ContractRecord => record.kind === "contract",
    );
    return firstServed === -1 ? contracts[0] : contracts.at(-1);
  }

  private copyTranscript(sessionId: string, source: string | null): void {
    try {
      const outcome = this.store.mirror(sessionId, source);
      // Said once: every tick while the client stays attached finds it again.
      if (outcome.kind === "diverged" && !this.divergedNoted) {
        this.divergedNoted = true;
        this.note("the client's transcript no longer extends the app's copy; the copy is kept");
      }
    } catch (caught) {
      this.note(`the transcript copy failed: ${String(caught)}`);
    }
  }
}

export function sha256(text: string): string {
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
  started: Pick<ContractRecord, "tools_sha" | "tool_shas">,
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
