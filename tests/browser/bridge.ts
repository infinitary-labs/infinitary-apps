/// <reference types="@vitest/browser-playwright" />

import {
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  invokeContract,
  type PushChannel,
  type PushPayload,
  pushContract,
} from "@shared/ipc";
import type { FirstmateApi } from "@shared/windowApi";
import { type BridgeIpc, createApi } from "../../src/preload/api";

/**
 * The one shared fake of the window bridge for the browser tests
 * (docs/testing.md, "The browser layer"). It builds the window's API with the
 * preload's own `createApi` over a fake IPC, so a browser test draws the real
 * window against the very API Electron exposes: every request the window
 * sends is read against the published contract's request schema, every
 * answer and push the test gives is read against its answer or payload
 * schema, and a shape the contract refuses fails the test instead of
 * drawing a state the real app can never reach.
 *
 * A request with no answer rejects and is listed in `unanswered`, so a test
 * names every answer the screen it draws needs.
 */

/**
 * What an answer throws when it has nothing for the request the window sent,
 * such as a home asked for a card it did not read: the request rejects and
 * its channel is listed in `unanswered`, as a channel with no answer is.
 */
export class NoAnswer extends Error {}

type Handler = (event: unknown, raw: unknown) => void;

/** A channel's answer: the value itself, or a function of the request that returns it. */
export type Answer<C extends InvokeChannel> =
  | InvokeResponse<C>
  | ((...request: InvokeRequest<C>) => InvokeResponse<C> | Promise<InvokeResponse<C>>);

export type Answers = { [C in InvokeChannel]?: Answer<C> };

export type FakeBridge = {
  /** The window API, as `window.infinitary` holds it. */
  api: FirstmateApi;
  /** Gives, or replaces, one channel's answer. */
  answer<C extends InvokeChannel>(channel: C, answer: Answer<C>): void;
  /** Pushes one payload to the window, as main does. */
  push<C extends PushChannel>(channel: C, payload: PushPayload<C>): void;
  /** Every request the window sent on a channel, in order. */
  requests<C extends InvokeChannel>(channel: C): InvokeRequest<C>[];
  /** The channels the window asked that had no answer, or no answer for its request, in order. */
  unanswered: string[];
};

export function fakeBridge(answers: Answers = {}): FakeBridge {
  const table = new Map<string, unknown>(Object.entries(answers));
  const listeners = new Map<string, Set<Handler>>();
  const received = new Map<string, unknown[][]>();
  const unanswered: string[] = [];
  const ipc: BridgeIpc = {
    async invoke(channel, ...args) {
      const entry = invokeContract[channel as InvokeChannel];
      if (!entry) throw new Error(`${channel} is not a channel of the contract`);
      const request = entry.request.safeParse(args);
      if (!request.success)
        throw new Error(
          `The window sent ${channel} a request the contract refuses: ${request.error}`,
        );
      received.set(channel, [...(received.get(channel) ?? []), args]);
      if (!table.has(channel)) {
        unanswered.push(channel);
        throw new Error(`The browser test gave no answer for ${channel}`);
      }
      const answer = table.get(channel);
      if (typeof answer !== "function") return structuredClone(answer);
      try {
        // A copy each time, as an answer crosses the process boundary.
        return structuredClone(await answer(...args));
      } catch (error) {
        if (error instanceof NoAnswer) unanswered.push(channel);
        throw error;
      }
    },
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
    },
    off(channel, handler) {
      listeners.get(channel)?.delete(handler);
    },
  };
  return {
    // Electron's `webUtils` reads a dropped file's path; a page has none.
    api: createApi(ipc, { pathForFile: () => "" }),
    answer(channel, answer) {
      table.set(channel, answer);
    },
    push(channel, payload) {
      const parsed = pushContract[channel].payload.safeParse(payload);
      if (!parsed.success)
        throw new Error(
          `The test pushed ${channel} a payload the contract refuses: ${parsed.error}`,
        );
      for (const handler of [...(listeners.get(channel) ?? [])])
        handler(undefined, structuredClone(payload));
    },
    requests(channel) {
      return (received.get(channel) ?? []) as never;
    },
    unanswered,
  };
}
