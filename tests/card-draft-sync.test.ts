import type { CardDraft, CardDraftChange, CardDraftChanged } from "@shared/cardDrafts";
import type { Card } from "@shared/cards";
import type { FrameAnswer } from "@shared/plugins/bridge";
import { describe, expect, it } from "vitest";
import { CardDrafts } from "../src/core/orchestrator/cardDrafts";
import { CardStore } from "../src/core/storage/cardStore";
import { openInMemoryDatabase } from "../src/core/storage/db";
import {
  DRAFT_QUIET_MS,
  type DraftLocal,
  type DraftParts,
  DraftSync,
} from "../src/renderer/src/app/draftSync";

// Intent (INF-5446): the captain's ask, "it would be cool if the answers you
// selected on cards showed up on other devices too (like if you don't finish
// the card completely)", and their added words, "make sure the words are not
// literally resending on every keystroke". Two windows run against the
// first mate's real draft store; only the clock and the link are stand-ins.

const card: Card = {
  id: "card-1",
  taskId: "task-1",
  author: "crewmate",
  priority: 30,
  title: "Choose how the export runs",
  meta: "crewmate 1",
  body: "<fieldset><legend>Format</legend></fieldset>",
  actions: [{ id: "go", label: "Approve and build", variant: "primary" }],
  status: "ready",
  createdAt: 1000,
};

const pick = (name: string, value: string): FrameAnswer => ({
  name,
  values: [value],
  labels: [value],
  changed: true,
});

/** One clock both windows share; `advance` runs each timer that comes due. */
function clock() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let next = 1;
  return {
    later: (run: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    cancel: (id: unknown) => void timers.delete(id as number),
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at);
        const first = due[0];
        if (!first) break;
        timers.delete(first[0]);
        now = first[1].at;
        first[1].run();
        await settle();
      }
      now = until;
      await settle();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function home() {
  const db = openInMemoryDatabase();
  new CardStore(db).upsert(card);
  const windows: Window[] = [];
  const drafts = new CardDrafts(db, (draft) => {
    // A live frame reaches only the windows in reach.
    for (const w of windows) if (w.reachable) w.sync.heardLive(draft);
  });
  return { db, drafts, windows };
}

type Home = ReturnType<typeof home>;
type Clock = ReturnType<typeof clock>;

class Window {
  local: DraftLocal = { answers: null, words: null, notes: null };
  reachable = true;
  requests: CardDraftChange[] = [];
  /** Answers held back until `release`, to show one request in flight. */
  hold = false;
  private held: (() => void)[] = [];
  readonly bases = new Map<string, number>();
  readonly sync: DraftSync;

  constructor(
    private readonly at: Home,
    time: Clock,
  ) {
    this.sync = new DraftSync({
      local: () => this.local,
      apply: (_cardId, parts: DraftParts) => {
        const answers = new Map((this.local.answers ?? []).map((a) => [a.name, a]));
        for (const answer of parts.answers ?? []) answers.set(answer.name, answer);
        this.local = {
          answers: [...answers.values()],
          words: parts.words ?? this.local.words,
          notes: parts.notes ?? this.local.notes,
        };
      },
      send: (cardId, change) => {
        this.requests.push(change);
        if (!this.reachable) return Promise.reject(new Error("out of reach"));
        return new Promise<CardDraftChanged>((resolve) => {
          const answer = () => resolve(at.drafts.change(cardId, change));
          if (this.hold) this.held.push(answer);
          else answer();
        });
      },
      canSend: () => this.reachable,
      loadBase: (cardId) => this.bases.get(cardId) ?? 0,
      saveBase: (cardId, revision) => {
        if (revision === null) this.bases.delete(cardId);
        else this.bases.set(cardId, revision);
      },
      later: time.later,
      cancel: time.cancel,
    });
    at.windows.push(this);
  }

  welcome() {
    this.sync.welcome(this.at.drafts.read(), [card.id]);
  }

  /** The captain changes something in this window. */
  edit(next: Partial<DraftLocal>) {
    const before = this.local;
    this.local = { ...before, ...next };
    this.sync.changed(card.id, before, this.local);
  }

  release() {
    this.hold = false;
    for (const answer of this.held.splice(0)) answer();
  }

  answer(name: string): string[] | undefined {
    return this.local.answers?.find((a) => a.name === name)?.values;
  }
}

function twoWindows() {
  const at = home();
  const time = clock();
  const desk = new Window(at, time);
  const laptop = new Window(at, time);
  desk.welcome();
  laptop.welcome();
  return { at, time, desk, laptop };
}

const stored = (at: Home): CardDraft | undefined => at.drafts.read()[0];

describe("DraftSync", () => {
  it("sends words typed key by key as one request once the captain pauses", async () => {
    const { at, time, desk, laptop } = twoWindows();
    const words = "Keep the header row";
    for (let i = 1; i <= words.length; i++) {
      desk.edit({ words: words.slice(0, i) });
      await time.advance(80);
    }
    expect(desk.requests).toEqual([]);
    await time.advance(DRAFT_QUIET_MS);
    expect(desk.requests).toHaveLength(1);
    expect(stored(at)?.words).toBe(words);
    expect(laptop.local.words).toBe(words);
    expect(laptop.requests).toEqual([]);
  });

  it("shows a pick in the other window and merges two windows' picks by question", async () => {
    const { at, time, desk, laptop } = twoWindows();
    desk.edit({ answers: [pick("format", "csv")] });
    laptop.edit({ answers: [pick("when", "nightly")] });
    await time.advance(DRAFT_QUIET_MS);
    expect(desk.answer("when")).toEqual(["nightly"]);
    expect(laptop.answer("format")).toEqual(["csv"]);
    expect(
      stored(at)
        ?.answers.map((a) => a.name)
        .sort(),
    ).toEqual(["format", "when"]);
  });

  it("keeps one request in flight and sends the newest change after it", async () => {
    const { at, time, desk } = twoWindows();
    desk.hold = true;
    desk.edit({ answers: [pick("format", "csv")] });
    await time.advance(DRAFT_QUIET_MS);
    desk.edit({ answers: [pick("format", "json")] });
    await time.advance(DRAFT_QUIET_MS);
    expect(desk.requests).toHaveLength(1);
    desk.release();
    await settle();
    await settle();
    expect(desk.requests).toHaveLength(2);
    expect(stored(at)?.answers[0]?.values).toEqual(["json"]);
    expect(desk.answer("format")).toEqual(["json"]);
  });

  it("never overwrites a pick changed here and not yet sent", async () => {
    const { at, time, desk, laptop } = twoWindows();
    desk.edit({ answers: [pick("format", "csv")] });
    await time.advance(DRAFT_QUIET_MS - 100);
    laptop.edit({ answers: [pick("format", "json")] });
    // The desk's pick goes and reaches the laptop, whose own pick is still waiting.
    await time.advance(100);
    expect(stored(at)?.answers[0]?.values).toEqual(["csv"]);
    expect(laptop.answer("format")).toEqual(["json"]);
    // The laptop's pick is the later change, so it goes and every window shows it.
    await time.advance(DRAFT_QUIET_MS);
    expect(stored(at)?.answers[0]?.values).toEqual(["json"]);
    expect(desk.answer("format")).toEqual(["json"]);
  });

  it("sends a pick made out of reach on return, unless another window changed that question", async () => {
    const { at, time, desk, laptop } = twoWindows();
    laptop.reachable = false;
    laptop.edit({ answers: [pick("format", "csv"), pick("when", "weekly")] });
    await time.advance(DRAFT_QUIET_MS);
    expect(laptop.requests).toEqual([]);
    desk.edit({ answers: [pick("format", "json")] });
    await time.advance(DRAFT_QUIET_MS);
    laptop.reachable = true;
    laptop.welcome();
    await settle();
    const draft = stored(at);
    expect(draft?.answers.find((a) => a.name === "format")?.values).toEqual(["json"]);
    expect(draft?.answers.find((a) => a.name === "when")?.values).toEqual(["weekly"]);
    expect(laptop.answer("format")).toEqual(["json"]);
    expect(desk.answer("when")).toEqual(["weekly"]);
  });

  it("sends a restarted window's kept picks with the revision it last took", async () => {
    const { at, time, desk, laptop } = twoWindows();
    desk.edit({ answers: [pick("format", "csv")] });
    await time.advance(DRAFT_QUIET_MS);
    // The laptop restarts holding its saved picks and the revision it took, then
    // changes a question while it is closed.
    const restarted = new Window(at, time);
    restarted.bases.set(card.id, laptop.bases.get(card.id) ?? 0);
    restarted.local = {
      answers: [pick("format", "csv"), pick("when", "monthly")],
      words: null,
      notes: null,
    };
    restarted.welcome();
    await settle();
    expect(restarted.requests).toHaveLength(1);
    expect(restarted.requests[0]?.answers?.map((a) => a.name)).toEqual(["when"]);
    expect(desk.answer("when")).toEqual(["monthly"]);
  });

  it("lets go of a card's draft when the card closes", async () => {
    const { at, time, desk } = twoWindows();
    desk.edit({ words: "half a thought" });
    await time.advance(DRAFT_QUIET_MS);
    expect(desk.bases.has(card.id)).toBe(true);
    new CardStore(at.db).resolve(card.id, "go");
    desk.edit({ words: "half a thought, and more" });
    await time.advance(DRAFT_QUIET_MS);
    expect(at.drafts.read()).toEqual([]);
    expect(desk.bases.has(card.id)).toBe(false);
  });
});
