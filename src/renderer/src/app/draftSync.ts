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
 * draft revision it goes against (`since`): the newest this window took, or
 * for a part changed while the first mate's computer was out of reach, the
 * one it had then, so that pick goes on return unless another window
 * changed the same question meanwhile. Those revisions and the card's
 * opening are kept in this window's own storage beside its saved picks
 * (./savedCardAnswers.ts), so the rule holds across a restart.
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
const isAnswerPart = (part: string) => part !== WORDS && part !== NOTES;

type Parts = Map<string, unknown>;

/** What a change asks to set, or another window's change to take here. */
export type DraftParts = { answers?: FrameAnswer[]; words?: string; notes?: CardNote[] };

/** This window's own state of a card: what it holds, each null where it holds nothing. */
export type DraftLocal = {
  answers: readonly FrameAnswer[] | null;
  words: string | null;
  notes: readonly CardNote[] | null;
};

/**
 * What this window keeps of a card's draft in its own storage, so the
 * revision rule holds across a restart: the card's opening it belongs to,
 * the revision it last took, and for each part changed here and not yet
 * kept there, the revision it was changed at.
 */
export type DraftBase = { lifecycle?: string; revision: number; parts: Record<string, number> };

export type DraftDeps = {
  local: (cardId: string) => DraftLocal;
  /**
   * The card's current opening as this window's stack holds it: null for a
   * card written before openings were kept, undefined for a card the stack
   * does not hold, which sends nothing until it does.
   */
  lifecycle: (cardId: string) => string | null | undefined;
  apply: (cardId: string, parts: DraftParts) => void;
  send: (cardId: string, change: CardDraftChange) => Promise<CardDraftChanged>;
  /** Whether a change can reach the first mate's computer now. */
  canSend: () => boolean;
  loadBase: (cardId: string) => DraftBase | null;
  saveBase: (cardId: string, base: DraftBase | null) => void;
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

/** Whether an answer holds a pick: a skip's Default is the card's, never one. */
const hasPick = (answer: FrameAnswer) =>
  !answer.skipped && (answer.values.length > 0 || answer.written !== undefined);

/**
 * The revision a waiting part goes against: null for a part changed while in
 * reach, which is the later change and goes against the newest revision this
 * window took; the revision then taken for one changed out of reach, which
 * keeps a change another window made meanwhile.
 */
type Base = number | null;

/** A request in flight: the parts it carries and the revision each goes against. */
type Flying = { parts: Parts; bases: Map<string, Base> };

export class DraftSync {
  /** The draft as the first mate's computer last said it, by card. */
  private readonly heard = new Map<string, CardDraft>();
  /** Live frames heard before the first welcome's reading answered, by card. */
  private readonly early = new Map<string, CardDraft>();
  /** Parts changed here and not yet sent, with the revision each goes against, by card. */
  private readonly dirty = new Map<string, Map<string, Base>>();
  private readonly flying = new Map<string, Flying>();
  private readonly timers = new Map<string, unknown>();
  /**
   * Questions this window's reading moved from no pick to a pick, by card.
   * A pick of the option the card recommends reads unchanged, as the card
   * proposed it, yet it is the captain's own and worth a draft; a question
   * another window's draft filled in is here too, but the draft already
   * holds it, so it sends nothing.
   */
  private readonly picked = new Map<string, Set<string>>();
  /** Each card's changes refused for their size, none sent again unchanged. */
  private readonly refused = new Map<string, Set<string>>();
  private welcomed = false;

  constructor(private readonly deps: DraftDeps) {}

  /** Whether the first mate's computer keeps drafts, as its last welcome said. */
  get enabled(): boolean {
    return this.welcomed;
  }

  /**
   * Every open card's draft, as this window read them at a welcome. The
   * first welcome after this window started also counts each saved pick
   * that differs from the draft as changed here, at the revision it was
   * changed at, so a question another window changed since keeps that
   * window's pick; only picks saved for the card's current opening count.
   */
  welcome(drafts: readonly CardDraft[], cardIds: readonly string[]): void {
    const first = !this.welcomed;
    this.welcomed = true;
    const byCard = new Map(drafts.map((draft) => [draft.cardId, draft]));
    for (const draft of this.early.values()) {
      const read = byCard.get(draft.cardId);
      if (!read || read.revision < draft.revision) byCard.set(draft.cardId, draft);
    }
    this.early.clear();
    for (const cardId of new Set([...cardIds, ...byCard.keys()])) {
      // A card the stack does not hold yet is read again once it does.
      if (this.deps.lifecycle(cardId) === undefined) continue;
      const read = byCard.get(cardId);
      // A card with no draft has an empty one of its current opening.
      if (read && !this.current(read)) continue;
      const draft = read ?? emptyDraft(cardId);
      const saved = first ? this.saved(cardId) : null;
      if (saved) {
        const marked = this.dirtyOf(cardId);
        // A part this window kept as unsent is the captain's own change.
        for (const [part, value] of this.localParts(cardId, true))
          if (
            !marked.has(part) &&
            this.differs(part, value, partsOfDraft(draft), saved.parts[part] !== undefined)
          )
            marked.set(part, saved.parts[part] ?? saved.revision);
      }
      this.adopt(draft);
      this.flush(cardId);
    }
  }

  /** Another window changed a card's draft. */
  heardLive(draft: CardDraft): void {
    if (!this.current(draft)) return;
    if (this.welcomed) {
      this.adopt(draft);
      return;
    }
    const held = this.early.get(draft.cardId);
    if (!held || held.revision < draft.revision) this.early.set(draft.cardId, draft);
  }

  /**
   * This window's state of a card changed: each part that now differs from
   * the draft - as it will stand once the request in flight is kept - waits
   * to go, and one that came back to it goes nowhere.
   */
  changed(cardId: string, before: DraftLocal, after: DraftLocal): void {
    const was = this.partsOf(before, false);
    const now = this.partsOf(after, false);
    const expected = this.heardParts(cardId);
    for (const [part, value] of this.flying.get(cardId)?.parts ?? []) expected.set(part, value);
    const marked = this.dirtyOf(cardId);
    let moved = false;
    for (const [part, value] of now) {
      const before = was.get(part);
      if (canonical(before) === canonical(value)) continue;
      moved = true;
      // The body's first reading has no answer before it, so an authored default is never a pick.
      if (
        isAnswerPart(part) &&
        before !== undefined &&
        !hasPick(before as FrameAnswer) &&
        hasPick(value as FrameAnswer)
      )
        this.pickedOf(cardId).add(part);
      const own = this.picked.get(cardId)?.has(part) === true;
      if (!this.differs(part, value, expected, own)) marked.delete(part);
      else if (!marked.has(part))
        marked.set(part, this.deps.canSend() ? null : this.revisionOf(cardId));
    }
    if (!moved) return;
    this.persist(cardId);
    this.schedule(cardId);
  }

  /** The card left the stack, or opened anew: its draft here goes with it. */
  forget(cardId: string): void {
    this.heard.delete(cardId);
    this.early.delete(cardId);
    this.dirty.delete(cardId);
    this.picked.delete(cardId);
    this.flying.delete(cardId);
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

  /**
   * Sends what changed here, one request per card at a time and never
   * before the captain pauses. One request carries the parts changed at the
   * oldest revision, naming it; parts changed later go next with their own.
   */
  private flush(cardId: string): void {
    if (!this.welcomed || this.timers.has(cardId) || this.flying.has(cardId)) return;
    if (!this.deps.canSend()) return;
    const marked = this.dirty.get(cardId);
    if (!marked?.size) return;
    const local = this.localParts(cardId, false);
    const ready = [...marked].filter(([part]) => {
      const value = local.get(part);
      return (
        value !== undefined && !(part === WORDS && (value as string).length > CARD_REPLY_MAX_CHARS)
      );
    });
    const lifecycle = this.deps.lifecycle(cardId);
    if (lifecycle === undefined) return;
    const taken = this.revisionOf(cardId);
    // One group per revision, oldest first; a group refused for its size unchanged is passed by.
    const picked = [...new Set(ready.map(([, base]) => base ?? taken))]
      .sort((a, b) => a - b)
      .map((since) => {
        const sent: Parts = new Map();
        const bases = new Map<string, Base>();
        for (const [part, base] of ready) {
          if ((base ?? taken) !== since) continue;
          sent.set(part, local.get(part));
          bases.set(part, base);
        }
        const change: CardDraftChange = {
          since,
          ...(lifecycle !== null ? { lifecycle } : {}),
          ...draftParts(sent),
        };
        return { since, sent, bases, change, key: canonical({ ...change, since: 0 }) };
      })
      .find((group) => !this.refused.get(cardId)?.has(group.key));
    if (!picked) return;
    const { since, sent, bases, change, key } = picked;
    for (const part of sent.keys()) marked.delete(part);
    const flight: Flying = { parts: sent, bases };
    this.flying.set(cardId, flight);
    // A change that did not go waits out of reach, against the revision it went with.
    const unsent = () => {
      const again = this.dirtyOf(cardId);
      for (const part of bases.keys()) if (!again.has(part)) again.set(part, since);
      this.persist(cardId);
    };
    void this.deps.send(cardId, change).then(
      (answer) => {
        // The card left, or opened anew, while this was on its way.
        if (this.flying.get(cardId) !== flight) return;
        this.flying.delete(cardId);
        if ("refused" in answer) {
          if (answer.refused === "closed") this.forget(cardId);
          else {
            const refused = this.refused.get(cardId) ?? new Set<string>();
            this.refused.set(cardId, refused.add(key));
            unsent();
            // The card's other changes still go.
            this.flush(cardId);
          }
          return;
        }
        // A part changed out of reach again while on its way goes against
        // what this window just kept - only where the draft took this
        // window's change, not where a newer change passed it over.
        const again = this.dirty.get(cardId);
        const passed = new Set([
          ...(answer.passed?.answers ?? []).map(answerPart),
          ...(answer.passed?.words ? [WORDS] : []),
          ...(answer.passed?.notes ? [NOTES] : []),
        ]);
        for (const part of sent.keys()) {
          const base = again?.get(part);
          if (base === undefined || base === null || passed.has(part)) continue;
          again?.set(part, Math.max(base, answer.draft.revision));
        }
        this.adopt(answer.draft, sent);
        this.flush(cardId);
      },
      () => {
        // Out of reach, or the link dropped: it goes again at the next welcome.
        if (this.flying.get(cardId) !== flight) return;
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
  private adopt(draft: CardDraft, sent?: Parts): void {
    const cardId = draft.cardId;
    const before = this.heard.get(cardId);
    // An answer older than what this window already took settles only what it refused.
    const stale = before !== undefined && draft.revision < before.revision;
    const latest = stale ? before : draft;
    const was = before ? partsOfDraft(before) : null;
    const local = this.localParts(cardId, false);
    const marked = this.dirty.get(cardId);
    const flying = this.flying.get(cardId)?.parts;
    const take: Parts = new Map();
    for (const [part, value] of partsOfDraft(latest)) {
      const elsewhere = !was || canonical(was.get(part)) !== canonical(value);
      const refused = sent?.has(part) === true && canonical(sent.get(part)) !== canonical(value);
      if (!elsewhere && !refused) continue;
      if (marked?.has(part) || flying?.has(part)) continue;
      // A value this window already shows goes nowhere at the first take;
      // after it, it still goes, so it replaces an older change that waits
      // on a question being typed in.
      if (!was && canonical(local.get(part)) === canonical(value)) continue;
      take.set(part, value);
    }
    if (!stale) this.heard.set(cardId, draft);
    this.persist(cardId);
    if (take.size > 0) this.deps.apply(cardId, draftParts(take));
  }

  /**
   * Whether a draft is of the card's current opening as this window's stack
   * holds it; a draft of a card it does not hold, or of another opening, is
   * read again once the stack holds that card or opening.
   */
  private current(draft: CardDraft): boolean {
    const lifecycle = this.deps.lifecycle(draft.cardId);
    return lifecycle !== undefined && (draft.lifecycle ?? null) === lifecycle;
  }

  private saved(cardId: string): DraftBase | null {
    const saved = this.deps.loadBase(cardId);
    return saved && (saved.lifecycle ?? null) === this.deps.lifecycle(cardId) ? saved : null;
  }

  /** The revision a change here is made at: the newest this window took. */
  private revisionOf(cardId: string): number {
    return this.heard.get(cardId)?.revision ?? this.saved(cardId)?.revision ?? 0;
  }

  /** Keeps the revision taken and each part changed out of reach's own in this window's storage. */
  private persist(cardId: string): void {
    const lifecycle = this.deps.lifecycle(cardId);
    // A card this window's stack does not hold yet keeps what was saved of it.
    if (lifecycle === undefined) return;
    const revision = this.revisionOf(cardId);
    // A part not yet sent keeps the revision it goes against, even on an empty draft.
    const parts: Record<string, number> = {};
    for (const [part, base] of this.flying.get(cardId)?.bases ?? []) parts[part] = base ?? revision;
    for (const [part, base] of this.dirty.get(cardId) ?? []) parts[part] = base ?? revision;
    if (revision === 0 && Object.keys(parts).length === 0) {
      this.deps.saveBase(cardId, null);
      return;
    }
    this.deps.saveBase(cardId, { ...(lifecycle !== null ? { lifecycle } : {}), revision, parts });
  }

  private pickedOf(cardId: string): Set<string> {
    let picked = this.picked.get(cardId);
    if (!picked) {
      picked = new Set();
      this.picked.set(cardId, picked);
    }
    return picked;
  }

  private dirtyOf(cardId: string): Map<string, Base> {
    let marked = this.dirty.get(cardId);
    if (!marked) {
      marked = new Map();
      this.dirty.set(cardId, marked);
    }
    return marked;
  }

  private heardParts(cardId: string): Parts {
    return partsOfDraft(this.heard.get(cardId) ?? emptyDraft(cardId));
  }

  /** Whether a value here is worth sending against the draft's; `own` marks the captain's pick. */
  private differs(part: string, value: unknown, heard: Parts, own = false): boolean {
    const there = heard.get(part);
    if (there === undefined) return own || ownAnswer(value as FrameAnswer);
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
