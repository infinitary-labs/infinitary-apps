import type { HostMessage } from "@shared/plugins/bridge";
import type { MediatedFetchResult } from "@shared/plugins/fetch";
import { describe, expect, it, vi } from "vitest";
import { type ReadApi, ReadExecutor } from "../reads/executor";
import {
  FRAME_WATCHDOG_INTERVAL_MS,
  FRAME_WATCHDOG_MISSES,
  FRAME_WATCHDOG_STOP_INTERVALS,
  FrameController,
  type FrameMountSpec,
} from "./frameController";

/**
 * The host side of bridge v2's liveness check: the ping a mounted frame must
 * answer, the misses that mark it unresponsive and the pauses that spare it.
 */

function fakeApi(
  values: Record<string, unknown> = {},
): ReadApi & { read: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn(async (name: string) => values[name] ?? { name }),
    onEvent: () => () => {},
    onPush: () => () => {},
  };
}

function harness(
  overrides: Partial<FrameMountSpec> = {},
  fetchResult: MediatedFetchResult = {
    ok: false,
    error: { code: "capability_not_granted", message: "no grant" },
  },
  api: ReadApi = fakeApi(),
) {
  const posted: HostMessage[] = [];
  const spec: FrameMountSpec = {
    pluginId: "acme",
    reads: ["observe.sessions", "observe.session"],
    actions: ["choose"],
    onAction: vi.fn(),
    ...overrides,
  };
  const fetch = vi.fn(async () => fetchResult);
  const controller = new FrameController(
    spec,
    "dark",
    { executor: new ReadExecutor(api), fetch },
    { post: (message) => posted.push(message) },
  );
  return { controller, posted, spec, fetch };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the watchdog", () => {
  function armed(
    onUnresponsive: () => void,
    paused?: () => boolean,
    askMain?: () => Promise<unknown>,
    onSteady?: () => void,
  ) {
    let tick: () => void = () => {};
    const cleared: unknown[] = [];
    const posted: HostMessage[] = [];
    const controller = new FrameController(
      {
        pluginId: "host",
        reads: [],
        actions: [],
        onAction: vi.fn(),
        onUnresponsive,
        ...(onSteady ? { onSteady } : {}),
      },
      "dark",
      {
        executor: new ReadExecutor(fakeApi()),
        fetch: vi.fn(),
        ...(paused ? { paused } : {}),
        ...(askMain ? { askMain } : {}),
        timers: {
          setInterval: (callback, ms) => {
            expect(ms).toBe(FRAME_WATCHDOG_INTERVAL_MS);
            tick = callback;
            return "handle";
          },
          clearInterval: (handle) => {
            cleared.push(handle);
            tick = () => {};
          },
        },
      },
      { post: (message) => posted.push(message) },
    );
    const pings = () => posted.filter((m) => m.type === "ping");
    const lastPing = () => {
      const last = pings().at(-1);
      return last?.type === "ping" ? last.seq : 0;
    };
    return { controller, tick: () => tick(), cleared, pings, lastPing };
  }

  /** A main process that answers the questions it was asked when the test says. */
  function heldMain() {
    const waiting: (() => void)[] = [];
    const askMain = vi.fn(() => new Promise<void>((resolve) => waiting.push(resolve)));
    const answer = async () => {
      for (const resolve of waiting.splice(0)) resolve();
      await flush();
    };
    return { askMain, answer };
  }

  it("stays quiet while the frame answers every ping", () => {
    const onUnresponsive = vi.fn();
    const { controller, tick, pings } = armed(onUnresponsive);
    tick();
    expect(pings()).toEqual([]); // not armed before the document is born
    controller.receive({ fm: 2, type: "ready" });
    for (let round = 0; round < FRAME_WATCHDOG_MISSES * 3; round++) {
      tick();
      const last = pings().at(-1);
      controller.receive({ fm: 2, type: "pong", seq: last?.type === "ping" ? last.seq : 0 });
    }
    expect(pings()).toHaveLength(FRAME_WATCHDOG_MISSES * 3);
    expect(onUnresponsive).not.toHaveBeenCalled();
  });

  // INF-1146: a pointing from a frame decides on focus once the frame has
  // answered a ping sent then, so a press it began first has been heard.
  it("hears a frame out on the answer to its own ping, which the watchdog counts as no miss", async () => {
    const onUnresponsive = vi.fn();
    const { controller, tick, pings } = armed(onUnresponsive);
    const lastPing = () => {
      const last = pings().at(-1);
      return last?.type === "ping" ? last.seq : 0;
    };
    await expect(controller.heard()).resolves.toBeUndefined(); // no document born yet
    controller.receive({ fm: 2, type: "ready" });
    let heard = 0;
    let asked = 0;
    for (let round = 0; round < FRAME_WATCHDOG_MISSES; round++) {
      tick();
      const watched = lastPing();
      void controller.heard().then(() => {
        heard += 1;
      });
      asked = lastPing();
      // The frame answers the watchdog's ping, sent before the pointing's;
      // the pointing's answer is still on its way at the next tick.
      controller.receive({ fm: 2, type: "pong", seq: watched });
    }
    tick();
    expect(onUnresponsive).not.toHaveBeenCalled();
    await flush();
    // Each pointing was heard out by an answer to a later ping; the last is not yet.
    expect(heard).toBe(FRAME_WATCHDOG_MISSES - 1);
    controller.receive({ fm: 2, type: "pong", seq: asked });
    await flush();
    expect(heard).toBe(FRAME_WATCHDOG_MISSES);
  });

  it("reports a frame that misses consecutive pings once, and stops pinging it", () => {
    const onUnresponsive = vi.fn();
    const { controller, tick, cleared, pings, lastPing } = armed(onUnresponsive);
    controller.receive({ fm: 2, type: "ready" });
    // The first ping is judged missed two ticks after it went out; one late
    // answer then resets the count: only consecutive misses count.
    tick();
    tick();
    tick();
    controller.receive({ fm: 2, type: "pong", seq: lastPing() });
    for (let round = 1; round < FRAME_WATCHDOG_STOP_INTERVALS; round++) tick();
    expect(onUnresponsive).not.toHaveBeenCalled();
    tick();
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    expect(cleared).toEqual(["handle"]);
    expect(controller.isReady).toBe(false);
    const sent = pings().length;
    tick();
    expect(pings()).toHaveLength(sent);
    // A fresh document (Retry) re-arms it.
    controller.receive({ fm: 2, type: "ready" });
    tick();
    expect(pings()).toHaveLength(sent + 1);
  });

  it("gives an expected document the same window to be born, then reports it", () => {
    const onUnresponsive = vi.fn();
    const { controller, tick, pings } = armed(onUnresponsive);
    // A script that wedges its frame before `ready` reaches the host. The
    // first tick asks the main process; each tick it has answered counts.
    controller.expectDocument();
    for (let round = 0; round < FRAME_WATCHDOG_MISSES; round++) tick();
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(pings()).toEqual([]); // nothing to ping before the bridge exists
    tick();
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    // A document born in time is watched by pings from then on.
    const healthy = armed(vi.fn());
    healthy.controller.expectDocument();
    healthy.tick();
    healthy.controller.receive({ fm: 2, type: "ready" });
    for (let round = 0; round < FRAME_WATCHDOG_MISSES * 2; round++) {
      healthy.tick();
      const last = healthy.pings().at(-1);
      healthy.controller.receive({
        fm: 2,
        type: "pong",
        seq: last?.type === "ping" ? last.seq : 0,
      });
    }
    expect(healthy.pings()).toHaveLength(FRAME_WATCHDOG_MISSES * 2);
  });

  it("does not count misses while the page is hidden, and starts the streak again when it shows", () => {
    let hidden = true;
    const onUnresponsive = vi.fn();
    const { controller, tick, pings } = armed(onUnresponsive, () => hidden);
    controller.receive({ fm: 2, type: "ready" });
    for (let round = 0; round < FRAME_WATCHDOG_MISSES * 3; round++) tick();
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(pings()).toEqual([]);
    // A pause one tick short of a stop does not carry its misses over.
    hidden = false;
    for (let round = 1; round < FRAME_WATCHDOG_STOP_INTERVALS; round++) tick();
    hidden = true;
    for (let round = 0; round < FRAME_WATCHDOG_MISSES * 2; round++) tick();
    expect(onUnresponsive).not.toHaveBeenCalled();
    hidden = false;
    for (let round = 1; round < FRAME_WATCHDOG_STOP_INTERVALS; round++) tick();
    expect(onUnresponsive).not.toHaveBeenCalled();
    tick();
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
  });

  it("does not count an unborn document while the page is hidden", () => {
    const onUnresponsive = vi.fn();
    const { controller, tick, pings } = armed(onUnresponsive, () => true);
    controller.expectDocument();
    for (let round = 0; round < FRAME_WATCHDOG_MISSES * 3; round++) tick();
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(pings()).toEqual([]);
  });

  // INF-935: every message between the window and a frame passes through
  // the main process, so a main-process pause of four seconds stopped an
  // idle panel ("This panel stopped responding.").
  it("counts nothing while the main process has not answered, and still stops a frame that is stuck", async () => {
    const onUnresponsive = vi.fn();
    let answer: () => void = () => {};
    const askMain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          answer = resolve;
        }),
    );
    const { controller, tick, pings } = armed(onUnresponsive, undefined, askMain);
    controller.receive({ fm: 2, type: "ready" });
    tick();
    expect(askMain).toHaveBeenCalledTimes(1);
    // The main process is busy: neither the question nor the frame's answer comes back.
    for (let round = 0; round < FRAME_WATCHDOG_MISSES * 3; round++) tick();
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(askMain).toHaveBeenCalledTimes(1);
    expect(pings()).toHaveLength(1);
    // It answers, and the frame's held answer arrives with it.
    answer();
    await flush();
    controller.receive({ fm: 2, type: "pong", seq: 1 });
    tick();
    expect(pings()).toHaveLength(2);
    // A frame stuck on its own while the main process answers is still
    // stopped: the last of four unanswered pings, the first sent just now,
    // is judged two answered ticks after it went out.
    for (let round = 0; round < FRAME_WATCHDOG_MISSES; round++) {
      answer();
      await flush();
      tick();
    }
    expect(onUnresponsive).not.toHaveBeenCalled();
    answer();
    await flush();
    tick();
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
  });

  // INF-3798: on 0.7.1-alpha.549 the main process stalled back to back for
  // 0.1 to 9.6 s with a median gap of 3 ms, and four healthy panels were
  // stopped. In each gap the main process answered the window's question
  // and passed the newest ping on; the frame's answer reached it after the
  // next stall began, so the next tick found that ping unanswered.
  it("counts no miss when the main process answers between stalls and holds the frame's answer through the next", async () => {
    const onUnresponsive = vi.fn();
    const main = heldMain();
    const { controller, tick, pings, lastPing } = armed(onUnresponsive, undefined, main.askMain);
    controller.receive({ fm: 2, type: "ready" });
    let held: number | undefined;
    const stallAndGap = async (frameAnswers: boolean) => {
      // The window ticks during a stall: it pings and asks the main process.
      tick();
      // A gap: the frame's answer held through the stall comes through
      // first, then the main process answers, and the newest ping reaches
      // the frame, whose answer waits through the next stall.
      if (held !== undefined) controller.receive({ fm: 2, type: "pong", seq: held });
      await main.answer();
      held = frameAnswers ? lastPing() : undefined;
    };
    const cycles = FRAME_WATCHDOG_MISSES * 3;
    for (let cycle = 0; cycle < cycles; cycle++) await stallAndGap(true);
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(pings()).toHaveLength(cycles);
    // A frame that stops answering in the same stalls is still stopped.
    for (let cycle = 1; cycle < FRAME_WATCHDOG_STOP_INTERVALS; cycle++) await stallAndGap(false);
    expect(onUnresponsive).not.toHaveBeenCalled();
    await stallAndGap(false);
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
  });

  // INF-3798: a page mounted again during the same stalls waits on the main
  // process at every step of its load, one step per gap.
  it("does not stop a document being born while the main process stalls past each tick", async () => {
    const onUnresponsive = vi.fn();
    const main = heldMain();
    const { controller, tick, pings } = armed(onUnresponsive, undefined, main.askMain);
    controller.expectDocument();
    for (let cycle = 0; cycle < FRAME_WATCHDOG_MISSES * 3; cycle++) {
      tick(); // answered: it counts, and asks again
      tick(); // a stall past the tick: the question is still waiting
      await main.answer(); // a gap
    }
    expect(onUnresponsive).not.toHaveBeenCalled();
    controller.receive({ fm: 2, type: "ready" });
    tick();
    expect(pings()).toHaveLength(1);
    // A document that is not born while the main process answers every tick is stopped.
    const stuckMain = heldMain();
    const unborn = armed(onUnresponsive, undefined, stuckMain.askMain);
    unborn.controller.expectDocument();
    for (let round = 0; round < FRAME_WATCHDOG_MISSES; round++) {
      unborn.tick();
      await stuckMain.answer();
    }
    expect(onUnresponsive).not.toHaveBeenCalled();
    unborn.tick();
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
  });

  // INF-3798: a panel mounts a stopped page again on its own once per
  // start, and a page that answered the watchdog this long is a start.
  it("calls a document steady once it answered as many pings in a row as a stop misses, once per document", () => {
    const onSteady = vi.fn();
    const { controller, tick, lastPing } = armed(vi.fn(), undefined, undefined, onSteady);
    const answering = (rounds: number) => {
      for (let round = 0; round < rounds; round++) {
        tick();
        controller.receive({ fm: 2, type: "pong", seq: lastPing() });
      }
    };
    controller.receive({ fm: 2, type: "ready" });
    // A miss before the run is complete starts it again: an answer to a
    // later ping answers every earlier one, so two pings go unanswered
    // until the first of them is judged.
    answering(FRAME_WATCHDOG_MISSES - 1);
    tick();
    tick();
    answering(FRAME_WATCHDOG_MISSES);
    expect(onSteady).not.toHaveBeenCalled();
    answering(1);
    expect(onSteady).toHaveBeenCalledTimes(1);
    answering(FRAME_WATCHDOG_STOP_INTERVALS * 2);
    expect(onSteady).toHaveBeenCalledTimes(1);
    // A new document of the mount earns it again.
    controller.receive({ fm: 2, type: "ready" });
    answering(FRAME_WATCHDOG_STOP_INTERVALS);
    expect(onSteady).toHaveBeenCalledTimes(2);
  });

  it("does not count an unborn document while the main process has not answered", async () => {
    const onUnresponsive = vi.fn();
    const { controller, tick } = armed(onUnresponsive, undefined, () => new Promise(() => {}));
    controller.expectDocument();
    for (let round = 0; round < FRAME_WATCHDOG_MISSES * 3; round++) tick();
    expect(onUnresponsive).not.toHaveBeenCalled();
  });

  it("never arms for a frame that asked for no watchdog, and disarms on dispose", () => {
    const { controller, posted } = harness();
    controller.expectDocument();
    controller.receive({ fm: 2, type: "ready" });
    expect(posted.filter((m) => m.type === "ping")).toEqual([]);
    const { controller: watched, cleared } = armed(vi.fn());
    watched.receive({ fm: 2, type: "ready" });
    watched.dispose();
    expect(cleared).toEqual(["handle"]);
  });
});
