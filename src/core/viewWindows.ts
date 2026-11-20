import { randomUUID } from "node:crypto";
import { invokeContract, parseInvokeRequest } from "@shared/ipc";
import {
  WINDOW_ANSWER_WAIT_MS,
  WINDOW_ASK_LIVE,
  WINDOW_ASK_WORDS,
  WINDOW_VALUE_OF,
  type WindowAnswer,
  type WindowAsk,
  type WindowChannel,
  windowAnswerSchema,
  windowAskSchema,
} from "@shared/windowAsks";
import { LOCAL_CLIENT } from "./connection/connection";
import { contractChange } from "./connection/contractChanges";
import type { CoreActor } from "./dispatcher";

/** A window answers asks (`window-asks.md`). */
export const WINDOW_ASKS = contractChange("window-asks");

type Waiting = {
  deviceId: string;
  resolve: (answer: WindowAnswer) => void;
};

/**
 * The windows the first mate asks (docs/view.md, "What the first mate asks
 * of a window"): one ask goes to one computer's window as a live frame, and
 * that window's own answer, by the ask's id, resolves it. The id goes to one
 * connection alone, so only that connection can answer it. A window that is
 * not connected, or is from before, is never asked; one that does not answer
 * in time may or may not have made the change, and the first mate says so.
 */
export class ViewWindows {
  private readonly waiting = new Map<string, Waiting>();

  constructor(
    private readonly options: {
      /** Sends a live frame to each welcomed window of one device that lists the change; false when none. */
      liveToView: (deviceId: string, channel: string, payload: unknown, change: string) => boolean;
      /** Waits; a test plays the clock. */
      wait?: (ms: number, then: () => void) => void;
    },
  ) {}

  /**
   * Asks one computer's window one of its own requests; resolves its answer,
   * and for a change with `changes` the window's own value just before it,
   * or rejects in plain words.
   */
  async ask(
    window: { deviceId: string; name: string },
    channel: WindowChannel,
    args: readonly unknown[],
    changes?: readonly { field: string; was?: unknown }[],
  ): Promise<{ result: unknown; before?: unknown }> {
    // The window is asked only what the contract admits, and its answer is
    // used only once the contract admits it too.
    const asked: WindowAsk = windowAskSchema.parse({
      id: randomUUID(),
      deviceId: window.deviceId,
      channel,
      args: parseInvokeRequest(channel, args),
      ...(changes ? { changes } : {}),
    });
    const answered = new Promise<WindowAnswer | null>((resolve) => {
      this.waiting.set(asked.id, { deviceId: window.deviceId, resolve });
      (this.options.wait ?? ((ms, then) => setTimeout(then, ms).unref?.()))(
        WINDOW_ANSWER_WAIT_MS,
        () => {
          if (!this.waiting.delete(asked.id)) return;
          resolve(null);
        },
      );
    });
    if (!this.options.liveToView(window.deviceId, WINDOW_ASK_LIVE, asked, WINDOW_ASKS)) {
      this.waiting.delete(asked.id);
      throw new Error(WINDOW_ASK_WORDS.noWindow(window.name));
    }
    const answer = await answered;
    if (!answer) throw new Error(WINDOW_ASK_WORDS.noAnswer(window.name));
    if (!answer.ok) throw new Error(answer.message);
    const result = invokeContract[channel].response.safeParse(answer.result);
    const wholeRead = WINDOW_VALUE_OF[channel];
    const before =
      changes && wholeRead
        ? invokeContract[wholeRead].response.safeParse(answer.before)
        : undefined;
    if (!result.success || before?.success === false)
      throw new Error(WINDOW_ASK_WORDS.badAnswer(window.name));
    return { result: result.data, ...(before ? { before: before.data } : {}) };
  }

  /**
   * A window's answer (`inf:view:answer`): heard only from the window that
   * was asked, as the captain at that computer, or as the window on this
   * one; any other answer changes nothing.
   */
  answered(id: string, answer: unknown, actor: CoreActor | undefined): { ok: true } {
    const ask = this.waiting.get(id);
    const from = actor?.kind === "captain" ? (actor.view ?? LOCAL_CLIENT) : undefined;
    const parsed = windowAnswerSchema.safeParse(answer);
    if (!ask || from !== ask.deviceId || !parsed.success) return { ok: true };
    this.waiting.delete(id);
    ask.resolve(parsed.data);
    return { ok: true };
  }
}
