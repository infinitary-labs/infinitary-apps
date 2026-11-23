import { randomUUID } from "node:crypto";
import {
  OWN_WINDOW_WORDS,
  type OwnWindowAnswer,
  type OwnWindowAsk,
  type OwnWindowAsked,
} from "@shared/ownWindow";
import type { BrowserViewer } from "./browser/browserViews";

type Kind = OwnWindowAsk["kind"];
type AnswerOf<K extends Kind> = Extract<OwnWindowAnswer, { kind: K }>;
type Waiting = {
  kind: Kind;
  resolve: (answer: OwnWindowAnswer) => void;
  reject: (error: Error) => void;
};

/**
 * This computer's window, as a first mate a command started reaches it
 * (docs/run.md, "The window opened beside it"). That first mate has no
 * desktop: what only a program in the person's own session can do, it asks
 * of the window opened beside it, over the window's own connection, and
 * the window answers from its own program. With no window open there is
 * nobody to ask, which each caller says in its own plain words.
 */
export class OwnWindow {
  private window: BrowserViewer | null = null;
  private readonly waiting = new Map<string, Waiting>();

  constructor(private readonly send: (asked: OwnWindowAsked) => void) {}

  /** The window says it is open, on the connection that asked; it is forgotten when that connection drops. */
  here(window: BrowserViewer): void {
    if (this.window === window) return;
    this.window = window;
    window.onGone(() => {
      if (this.window !== window) return;
      this.window = null;
      for (const [id, ask] of this.waiting) {
        this.waiting.delete(id);
        ask.reject(new Error(OWN_WINDOW_WORDS.windowLeft));
      }
    });
  }

  open(): boolean {
    return this.window !== null;
  }

  /** Asks the window one thing; rejects in plain words when none is open, it leaves, or it could not. */
  async ask<K extends Kind>(ask: Extract<OwnWindowAsk, { kind: K }>): Promise<AnswerOf<K>> {
    if (!this.window) throw new Error(OWN_WINDOW_WORDS.noWindow);
    const id = randomUUID();
    const answered = new Promise<OwnWindowAnswer>((resolve, reject) => {
      this.waiting.set(id, { kind: ask.kind, resolve, reject });
    });
    this.send({ id, ask });
    const answer = await answered;
    if (answer.kind === "failed") throw new Error(answer.message);
    return answer as AnswerOf<K>;
  }

  /** The window's answer to one ask; an answer to none, or of another kind, changes nothing. */
  answer(id: string, answer: OwnWindowAnswer): void {
    const ask = this.waiting.get(id);
    if (!ask || (answer.kind !== "failed" && answer.kind !== ask.kind)) return;
    this.waiting.delete(id);
    ask.resolve(answer);
  }
}
