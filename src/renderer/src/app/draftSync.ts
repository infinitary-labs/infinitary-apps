import {
  type CardDraft,
  type CardDraftChange,
  type CardDraftChanged,
  emptyDraft,
} from "@shared/cardDrafts";
import type { CardNote } from "@shared/cardNotes";
import { CARD_REPLY_MAX_CHARS } from "@shared/cards";
import type { FrameAnswer, FrameAnswers } from "@shared/plugins/bridge";

/**
 * Unsent picks follow you (docs/card-authoring.md): this window's side of
 * each open card's draft, which the first mate's computer keeps for every
 * window that shows the card. The window reads every draft at each welcome,
 * sends what the captain changed here - the body's answers by question, the
 * card field's words and its queued notes - and takes what another window
 * changed from the `inf:cards:draft` live frame.
 *
 * A change goes up once the captain pauses (`DRAFT_QUIET_MS`), so words
 * typed into a field never go up keystroke by keystroke, and one request per
 * card is in flight at a time, the newest change waiting behind it. A part
 * changed here and not yet sent is never overwritten by another window's
 * change: it goes next and is the later change. Each request names the
 * draft revision this window last took (`since`), so a pick made while the
 * first mate's computer was out of reach goes on return unless another
 * window changed the same question meanwhile; that revision is kept in this
 * window's own storage beside its saved picks (./savedCardAnswers.ts), so
 * the rule holds across a restart.
 */

/**
 * How long the captain pauses before a change goes up: a run of keystrokes
 * or quick picks goes as one request. A typing pause, not a measured
 * optimum; shorter sends more requests, longer shows other windows the words later.
 */
export const DRAFT_QUIET_MS = 400;

const WORDS = "words";
const NOTES = "notes";
const answerPart = (name: string) => `answer:${name}`;

/** One card's parts as values, by part. */
type Parts = Map<string, unknown>;

/** What a change asks to set, or another window's change to take here. */
export type DraftParts = { answers?: FrameAnswer[]; words?: string; notes?: CardNote[] };

/** This window's own state of a card: what it holds, each null where it holds nothing. */
export type DraftLocal = {
  answers: readonly FrameAnswer[] | null;
  words: string | null;
  notes: readonly CardNote[] | null;
};

export type DraftDeps = {
  local: (cardId: string) => DraftLocal;
  apply: (cardId: string, parts: DraftParts) => void;
  send: (cardId: string, change: CardDraftChange) => Promise<CardDraftChanged>;
  /** Whether a change can reach the first mate's computer now. */
  canSend: () => boolean;
  loadBase: (cardId: string) => number;
  saveBase: (cardId: string, revision: number | null) => void;
  later: (run: () => void, ms: number) => unknown;
  cancel: (handle: unknown) => void;
};

/** JSON with its keys in order, so two readings of one value compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) =>
    held && typeof held === "object" && !Array.isArray(held)
      ? Object.fromEntries(
          Object.entries(held as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : held,
  );
}

function partsOfDraft(draft: CardDraft): Parts {
  const parts: Parts = new Map();
  for (const answer of draft.answers) parts.set(answerPart(answer.name), answer);
  parts.set(WORDS, draft.words);
  parts.set(NOTES, draft.notes);
  return parts;
}

/** Parts as a change names them. */
function draftParts(parts: Parts): DraftParts {
  const named: DraftParts = {};
  const answers: FrameAnswer[] = [];
  for (const [part, value] of parts) {
    if (part === WORDS) named.words = value as string;
    else if (part === NOTES) named.notes = value as CardNote[];
    else answers.push(value as FrameAnswer);
  }
  if (answers.length > 0) named.answers = answers;
  return named;
}

/** An answer worth a draft where the draft holds none for its question: the captain's own. */
const ownAnswer = (answer: FrameAnswer) =>
  !answer.skipped && (answer.changed || answer.written !== undefined);

export class DraftSync {
  /** The draft as the first mate's computer last said it, by card. */
  private readonly heard = new Map<string, CardDraft>();
  /** Parts changed here and not yet sent, by card. */
  private readonly dirty = new Map<string, Set<string>>();
  /** What the request in flight carries, by card. */
  private readonly flying = new Map<string, Parts>();
  private readonly timers = new Map<string, unknown>();
  /** The last change refused for its size, which is not sent again unchanged. */
  private readonly refused = new Map<string, string>();
  private welcomed = false;

  constructor(private readonly deps: DraftDeps) {}

  /** Whether the first mate's computer keeps drafts, as its last welcome said. */
  get enabled(): boolean {
    return this.welcomed;
  }

  /**
   * Every open card's draft, as this window read them at a welcome. The
   * first welcome after this window started also counts each saved pick
   * that differs from the draft as changed here: it goes with the revision
   * this window last took, so a question another window changed since keeps
   * that window's pick.
   */
  welcome(drafts: readonly CardDraft[], cardIds: readonly string[]): void {
    const first = !this.welcomed;
    this.welcomed = true;
    const byCard = new Map(drafts.map((draft) => [draft.cardId, draft]));
    for (const cardId of new Set([...cardIds, ...byCard.keys()])) {
      const draft = byCard.get(cardId) ?? emptyDraft(cardId);
      if (first) {
        const marked = this.dirtyOf(cardId);
        for (const [part, value] of this.localParts(cardId, true))
          if (this.differs(part, value, partsOfDraft(draft))) marked.add(part);
      }
      // Until what changed here is answered, the revision taken stays.
      this.adopt(draft, undefined, (this.dirty.get(cardId)?.size ?? 0) > 0);
      this.flush(cardId);
    }
  }

  /** Another window changed a card's draft. */
  heardLive(draft: CardDraft): void {
    if (!this.welcomed) return;
    this.adopt(draft);
  }

  /**
   * This window's state of a card changed: each part that now differs from
   * the draft waits to go, and one that came back to it goes nowhere.
   */
  changed(cardId: string, before: DraftLocal, after: DraftLocal): void {
    const was = this.partsOf(before, false);
    const now = this.partsOf(after, false);
    const heard = this.heardParts(cardId);
    const marked = this.dirtyOf(cardId);
    let moved = false;
    for (const [part, value] of now) {
      if (canonical(was.get(part)) === canonical(value)) continue;
      moved = true;
      if (this.differs(part, value, heard)) marked.add(part);
      else marked.delete(part);
    }
    if (!moved) return;
    this.refused.delete(cardId);
    this.schedule(cardId);
  }

  /** The card left the stack: its draft here goes with it. */
  forget(cardId: string): void {
    this.heard.delete(cardId);
    this.dirty.delete(cardId);
    this.refused.delete(cardId);
    const timer = this.timers.get(cardId);
    if (timer !== undefined) this.deps.cancel(timer);
    this.timers.delete(cardId);
    this.deps.saveBase(cardId, null);
  }

  private schedule(cardId: string): void {
    if (!this.welcomed) return;
    const timer = this.timers.get(cardId);
    if (timer !== undefined) this.deps.cancel(timer);
    this.timers.set(
      cardId,
      this.deps.later(() => {
        this.timers.delete(cardId);
        this.flush(cardId);
      }, DRAFT_QUIET_MS),
    );
  }

  /** Sends what changed here, one request per card at a time. */
  private flush(cardId: string): void {
    if (!this.welcomed || this.flying.has(cardId) || !this.deps.canSend()) return;
    const marked = this.dirty.get(cardId);
    if (!marked?.size) return;
    const local = this.localParts(cardId, false);
    const sent: Parts = new Map();
    for (const part of marked) {
      const value = local.get(part);
      if (value === undefined) continue;
      if (part === WORDS && (value as string).length > CARD_REPLY_MAX_CHARS) continue;
      sent.set(part, value);
    }
    if (sent.size === 0) return;
    const change: CardDraftChange = { since: this.deps.loadBase(cardId), ...draftParts(sent) };
    const key = canonical({ ...change, since: 0 });
    if (this.refused.get(cardId) === key) return;
    for (const part of sent.keys()) marked.delete(part);
    this.flying.set(cardId, sent);
    const unsent = () => {
      const again = this.dirtyOf(cardId);
      for (const part of sent.keys()) again.add(part);
    };
    void this.deps.send(cardId, change).then(
      (answer) => {
        this.flying.delete(cardId);
        if ("refused" in answer) {
          if (answer.refused === "closed") this.forget(cardId);
          else {
            this.refused.set(cardId, key);
            unsent();
          }
          return;
        }
        this.adopt(answer.draft, sent);
        if (this.dirty.get(cardId)?.size) this.flush(cardId);
      },
      () => {
        // Out of reach, or the link dropped: it goes again at the next welcome.
        this.flying.delete(cardId);
        unsent();
      },
    );
  }

  /**
   * Takes a draft the first mate's computer said: each part another window
   * changed, or that refused what this window sent, shows here, unless the
   * captain changed it here since and that change has yet to go.
   */
  private adopt(draft: CardDraft, sent?: Parts, keepBase = false): void {
    const cardId = draft.cardId;
    const before = this.heard.get(cardId);
    // An answer older than what this window already took settles only what it refused.
    const stale = before !== undefined && draft.revision < before.revision;
    const latest = stale ? before : draft;
    const was = before ? partsOfDraft(before) : null;
    const local = this.localParts(cardId, false);
    const marked = this.dirty.get(cardId);
    const flying = this.flying.get(cardId);
    const take: Parts = new Map();
    for (const [part, value] of partsOfDraft(latest)) {
      const elsewhere = !was || canonical(was.get(part)) !== canonical(value);
      const refused = sent?.has(part) === true && canonical(sent.get(part)) !== canonical(value);
      if (!elsewhere && !refused) continue;
      if (marked?.has(part) || flying?.has(part)) continue;
      if (canonical(local.get(part)) === canonical(value)) continue;
      take.set(part, value);
    }
    if (!stale) {
      this.heard.set(cardId, draft);
      if (!keepBase && draft.revision > 0) this.deps.saveBase(cardId, draft.revision);
    }
    if (take.size > 0) this.deps.apply(cardId, draftParts(take));
  }

  private dirtyOf(cardId: string): Set<string> {
    let marked = this.dirty.get(cardId);
    if (!marked) {
      marked = new Set();
      this.dirty.set(cardId, marked);
    }
    return marked;
  }

  private heardParts(cardId: string): Parts {
    return partsOfDraft(this.heard.get(cardId) ?? emptyDraft(cardId));
  }

  /** Whether a value here is worth sending against the draft's. */
  private differs(part: string, value: unknown, heard: Parts): boolean {
    const there = heard.get(part);
    if (there === undefined) return ownAnswer(value as FrameAnswer);
    return canonical(there) !== canonical(value);
  }

  private localParts(cardId: string, presentOnly: boolean): Parts {
    return this.partsOf(this.deps.local(cardId), presentOnly);
  }

  /**
   * A window's state as parts. Words and notes it holds none of read as
   * none, except where only what it holds counts (a restart's first
   * welcome, when this window's words were never kept).
   */
  private partsOf(local: DraftLocal, presentOnly: boolean): Parts {
    const parts: Parts = new Map();
    for (const answer of local.answers ?? []) parts.set(answerPart(answer.name), answer);
    if (local.words !== null || !presentOnly) parts.set(WORDS, local.words ?? "");
    if (local.notes !== null || !presentOnly) parts.set(NOTES, local.notes ?? []);
    return parts;
  }
}

/** The reading a card's body would give with another window's answers in it. */
export function withDraftAnswers(
  reading: FrameAnswers | undefined,
  answers: readonly FrameAnswer[],
): FrameAnswers {
  const byName = new Map(answers.map((answer) => [answer.name, answer]));
  const kept = (reading?.answers ?? []).map((answer) => byName.get(answer.name) ?? answer);
  const known = new Set(kept.map((answer) => answer.name));
  const merged = [...kept, ...answers.filter((answer) => !known.has(answer.name))];
  if (reading) return { ...reading, answers: merged };
  const own = merged.filter(ownAnswer).length;
  // Counts the body gives once it is born; until then the footer shows none.
  return { answered: 0, of: 0, changed: own, picked: own, answers: merged };
}
