import {
  PERSONAL_STORE_VALUE_MAX_BYTES,
  type PersonalStoreChange,
  type PersonalStoreRequest,
} from "@shared/personal/manifest";
import type { HostMessage } from "@shared/plugins/bridge";
import { FRAME_MAX_IN_FLIGHT, FRAME_MAX_SUBSCRIPTIONS } from "@shared/plugins/bridge";
import type { MediatedFetchResult } from "@shared/plugins/fetch";
import { PANEL_SERVER_ACTION } from "@shared/plugins/frameDocument";
import { describe, expect, it, vi } from "vitest";
import { COALESCE_MS, type ReadApi, ReadExecutor } from "../reads/executor";
import {
  FRAME_WATCHDOG_INTERVAL_MS,
  FRAME_WATCHDOG_MISSES,
  FrameController,
  type FrameMountSpec,
  type FrameStoreDeps,
} from "./frameController";

/**
 * The host side of bridge v2 against a fake frame: every verb answered by
 * exactly one correlated response, every refusal by its code, and the
 * plugin's declaration enforced per mount.
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

describe("FrameController", () => {
  it("separates initialized drawing from birth, zero/provisional sizes and stale documents", () => {
    const onResize = vi.fn();
    const onDrawn = vi.fn();
    const onInteraction = vi.fn();
    const { controller, posted } = harness({ onResize, onDrawn, onInteraction, width: "wide" });
    controller.receive({ fm: 2, type: "ready", document: "old" });
    expect(posted.at(-1)).toEqual({ fm: 2, type: "initialize", document: "old" });
    expect(posted.findIndex((m) => m.type === "width")).toBeLessThan(posted.length - 1);
    controller.receive({
      fm: 2,
      type: "resize",
      document: "old",
      height: 48,
      width: 752,
      initialized: false,
    });
    controller.receive({
      fm: 2,
      type: "resize",
      document: "old",
      height: 0,
      width: 752,
      initialized: true,
    });
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onDrawn).not.toHaveBeenCalled();
    controller.expectDocument();
    const births = posted.length;
    controller.receive({ fm: 2, type: "ready", document: "old" });
    expect(posted).toHaveLength(births);
    controller.receive({ fm: 2, type: "ready", document: "new" });
    controller.receive({
      fm: 2,
      type: "resize",
      document: "old",
      height: 900,
      width: 510,
      initialized: true,
    });
    controller.receive({ fm: 2, type: "interaction", document: "old" });
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onInteraction).not.toHaveBeenCalled();
    controller.receive({
      fm: 2,
      type: "resize",
      document: "new",
      height: 410.2,
      width: 752,
      initialized: true,
    });
    expect(onDrawn).toHaveBeenCalledWith(410.2, 752, false);
    controller.receive({ fm: 2, type: "interaction", document: "new" });
    expect(onInteraction).toHaveBeenCalledOnce();
  });
  it("answers ready with the theme and pushes later themes", () => {
    const { controller, posted } = harness();
    controller.setTheme("light");
    expect(posted).toEqual([]);
    controller.receive({ fm: 2, type: "ready" });
    expect(posted).toEqual([{ fm: 2, type: "theme", theme: "light" }]);
    controller.setTheme("dark");
    expect(posted.at(-1)).toEqual({ fm: 2, type: "theme", theme: "dark" });
  });

  it("pushes view state on a document's birth, and every change after it", () => {
    // The now panel's selected row: host-owned state the frame paints.
    const { controller, posted } = harness({ state: { selectedTaskId: null } });
    controller.setState({ selectedTaskId: "t1" });
    // Nothing reaches a document that is not born yet.
    expect(posted).toEqual([]);
    controller.receive({ fm: 2, type: "ready" });
    expect(posted).toEqual([
      { fm: 2, type: "theme", theme: "dark" },
      { fm: 2, type: "state", state: { selectedTaskId: "t1" } },
    ]);
    controller.setState({ selectedTaskId: "t2" });
    expect(posted.at(-1)).toEqual({ fm: 2, type: "state", state: { selectedTaskId: "t2" } });
    // A card body rebuilt is a new document: it is born into the state the
    // host holds now, without the frame asking for it.
    controller.receive({ fm: 2, type: "ready" });
    expect(posted.at(-1)).toEqual({ fm: 2, type: "state", state: { selectedTaskId: "t2" } });
  });

  it("tells a card's document the size it is shown at, on its birth and on every change", () => {
    const { controller, posted } = harness({ width: "wide" });
    controller.receive({ fm: 2, type: "ready" });
    expect(posted).toEqual([
      { fm: 2, type: "theme", theme: "dark" },
      { fm: 2, type: "width", width: "wide" },
    ]);
    controller.setWidth("full");
    expect(posted.at(-1)).toEqual({ fm: 2, type: "width", width: "full" });
    // A rebuilt body is born into the size the card has now.
    controller.receive({ fm: 2, type: "ready" });
    expect(posted.at(-1)).toEqual({ fm: 2, type: "width", width: "full" });
  });

  it("drops anything outside the envelope", () => {
    const { controller, posted } = harness();
    controller.receive({ type: "ready" });
    controller.receive({ fm: 1, type: "action", actionId: "choose" });
    controller.receive("nonsense");
    controller.receive({ fm: 2, type: "request", id: 1, verb: "teleport" });
    expect(posted).toEqual([
      {
        fm: 2,
        type: "response",
        id: 1,
        ok: false,
        error: { code: "bad_request", message: "malformed request" },
      },
    ]);
  });

  it("serves a declared read as a subscription, pushing values until unsubscribed", async () => {
    const api = fakeApi({ "observe.sessions": [{ id: "firstmate" }] });
    const { controller, posted } = harness({}, undefined, api);
    controller.receive({
      fm: 2,
      type: "request",
      id: 1,
      verb: "subscribe",
      sub: 7,
      read: "observe.sessions",
    });
    expect(posted).toEqual([{ fm: 2, type: "response", id: 1, ok: true }]);
    await flush();
    expect(posted.at(-1)).toEqual({ fm: 2, type: "data", sub: 7, value: [{ id: "firstmate" }] });
    expect(controller.subscriptionCount).toBe(1);
    controller.receive({ fm: 2, type: "request", id: 2, verb: "unsubscribe", sub: 7 });
    expect(posted.at(-1)).toEqual({ fm: 2, type: "response", id: 2, ok: true });
    expect(controller.subscriptionCount).toBe(0);
    controller.receive({ fm: 2, type: "request", id: 3, verb: "unsubscribe", sub: 7 });
    expect(posted.at(-1)).toMatchObject({
      id: 3,
      ok: false,
      error: { code: "subscription_unknown" },
    });
  });

  // INF-2221: compact reads only for a document that understands them;
  // a replacement document must receive its own complete first value.
  it("negotiates retained read rows per document and resets the base at birth", async () => {
    vi.useFakeTimers();
    const firstmate = { id: "firstmate" };
    const crew = { id: "crewmate:review" };
    const values = { "observe.sessions": [firstmate] };
    const api = fakeApi(values);
    let resync: () => void = () => {};
    api.onResync = (listener) => {
      resync = listener;
      return () => {};
    };
    const { controller, posted } = harness({}, undefined, api);
    const lastValue = () => posted.filter((message) => message.type === "data").at(-1);
    try {
      for (const reuseReads of [true, false, true]) {
        values["observe.sessions"] = [firstmate];
        controller.receive({ fm: 2, type: "ready", reuseReads });
        controller.receive({
          fm: 2,
          type: "request",
          id: 1,
          verb: "subscribe",
          sub: 7,
          read: "observe.sessions",
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(lastValue()).toEqual({ fm: 2, type: "data", sub: 7, value: [firstmate] });
        values["observe.sessions"] = [firstmate, crew];
        resync();
        await vi.advanceTimersByTimeAsync(COALESCE_MS);
        expect(lastValue()).toEqual({
          fm: 2,
          type: "data",
          sub: 7,
          ...(reuseReads
            ? { value: [crew], reuse: [{ key: null, indices: [0, -1] }] }
            : { value: [firstmate, crew] }),
        });
      }
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("runs a frame's sql subscription with the plugin's grant, which the frame cannot widen", async () => {
    const api = fakeApi({
      sql: { columns: ["n"], rows: [{ n: 1 }], truncated: false, elapsedMs: 1 },
    });
    const { controller, posted } = harness(
      { reads: ["sql"], grant: { sql: ["v_usage_v1"] } },
      undefined,
      api,
    );
    controller.receive({
      fm: 2,
      type: "request",
      id: 1,
      verb: "subscribe",
      sub: 1,
      read: "sql",
      args: { sql: "SELECT COUNT(*) AS n FROM v_usage_v1" },
    });
    await flush();
    expect(api.read).toHaveBeenCalledWith(
      "sql",
      { sql: "SELECT COUNT(*) AS n FROM v_usage_v1" },
      { sql: ["v_usage_v1"] },
    );
    expect(posted.at(-1)).toMatchObject({ type: "data", sub: 1, value: { rows: [{ n: 1 }] } });
    controller.receive({
      fm: 2,
      type: "request",
      id: 2,
      verb: "subscribe",
      sub: 2,
      read: "sql",
      args: { sql: "SELECT 1", views: ["v_tasks_v1"] },
    });
    expect(posted.at(-1)).toMatchObject({ id: 2, ok: false, error: { code: "bad_args" } });
  });

  it("refuses a read the plugin did not declare, an unknown read, and bad args", async () => {
    const { controller, posted } = harness();
    controller.receive({
      fm: 2,
      type: "request",
      id: 1,
      verb: "subscribe",
      sub: 1,
      read: "feed.recent",
    });
    expect(posted.at(-1)).toMatchObject({
      id: 1,
      ok: false,
      error: {
        code: "read_not_declared",
        message: 'plugin "acme" does not declare the read "feed.recent"',
      },
    });
    const { controller: lax, posted: laxPosted } = harness({ reads: ["nope", "observe.session"] });
    lax.receive({ fm: 2, type: "request", id: 2, verb: "subscribe", sub: 1, read: "nope" });
    expect(laxPosted.at(-1)).toMatchObject({ id: 2, ok: false, error: { code: "read_unknown" } });
    lax.receive({
      fm: 2,
      type: "request",
      id: 3,
      verb: "subscribe",
      sub: 2,
      read: "observe.session",
      args: { id: 42 },
    });
    expect(laxPosted.at(-1)).toMatchObject({ id: 3, ok: false, error: { code: "bad_args" } });
    expect(lax.subscriptionCount).toBe(0);
  });

  it("holds a frame to the subscription cap", () => {
    const { controller, posted } = harness();
    for (let sub = 1; sub <= FRAME_MAX_SUBSCRIPTIONS; sub++) {
      controller.receive({
        fm: 2,
        type: "request",
        id: sub,
        verb: "subscribe",
        sub,
        read: "observe.sessions",
      });
    }
    expect(controller.subscriptionCount).toBe(FRAME_MAX_SUBSCRIPTIONS);
    controller.receive({
      fm: 2,
      type: "request",
      id: 99,
      verb: "subscribe",
      sub: 99,
      read: "observe.sessions",
    });
    expect(posted.at(-1)).toMatchObject({
      id: 99,
      ok: false,
      error: { code: "too_many_subscriptions" },
    });
  });

  it("routes a declared action with a bounded value, refusing the rest", async () => {
    const onAction = vi.fn();
    const { controller, posted } = harness({ onAction });
    controller.receive({
      fm: 2,
      type: "request",
      id: 1,
      verb: "action",
      action: "choose",
      value: { pick: 2 },
    });
    await flush();
    expect(onAction).toHaveBeenCalledWith("choose", { pick: 2 });
    expect(posted.at(-1)).toEqual({ fm: 2, type: "response", id: 1, ok: true });
    controller.receive({ fm: 2, type: "request", id: 2, verb: "action", action: "other" });
    await flush();
    expect(posted.at(-1)).toMatchObject({
      id: 2,
      ok: false,
      error: { code: "action_not_declared" },
    });
    controller.receive({
      fm: 2,
      type: "request",
      id: 3,
      verb: "action",
      action: "choose",
      value: "x".repeat(5_000),
    });
    await flush();
    expect(posted.at(-1)).toMatchObject({ id: 3, ok: false, error: { code: "value_too_large" } });
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  // INF-2205 piece C: a panel's `invoke` rides the bridge to its background
  // work, carrying what a store value may hold, never more.
  it("lets a server call carry as much as a store value, and no more", async () => {
    const onAction = vi.fn(async () => "done");
    const { controller, posted } = harness({ actions: [PANEL_SERVER_ACTION], onAction });
    const call = (id: number, bytes: number) =>
      controller.receive({
        fm: 2,
        type: "request",
        id,
        verb: "action",
        action: PANEL_SERVER_ACTION,
        value: { action: "save", input: "x".repeat(bytes) },
      });
    call(1, 5_000);
    await flush();
    expect(posted.at(-1)).toEqual({ fm: 2, type: "response", id: 1, ok: true, result: "done" });
    call(2, PERSONAL_STORE_VALUE_MAX_BYTES);
    await flush();
    expect(posted.at(-1)).toMatchObject({ id: 2, ok: false, error: { code: "value_too_large" } });
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("answers an action with its handler's plain data, and never with anything else", async () => {
    const answers: unknown[] = ["card-1", { not: () => "data" }, new Map([["a", 1]])];
    const { controller, posted } = harness({ onAction: () => answers.shift() });
    for (const id of [1, 2, 3]) {
      controller.receive({ fm: 2, type: "request", id, verb: "action", action: "choose" });
      await flush();
    }
    expect(posted.slice(-3)).toEqual([
      { fm: 2, type: "response", id: 1, ok: true, result: "card-1" },
      // A function is not data: the object carries what of it is.
      { fm: 2, type: "response", id: 2, ok: true, result: {} },
      { fm: 2, type: "response", id: 3, ok: true, result: {} },
    ]);
  });

  it("forwards fetch to the core seam and relays its refusal as capability_not_granted", async () => {
    const { controller, posted, fetch } = harness();
    controller.receive({
      fm: 2,
      type: "request",
      id: 1,
      verb: "fetch",
      alias: "jira",
      request: { path: "/rest/api/3/myself" },
    });
    await flush();
    expect(fetch).toHaveBeenCalledWith({
      pluginId: "acme",
      alias: "jira",
      request: { method: "GET", path: "/rest/api/3/myself" },
    });
    expect(posted.at(-1)).toEqual({
      fm: 2,
      type: "response",
      id: 1,
      ok: false,
      error: { code: "capability_not_granted", message: "no grant" },
    });
  });

  it("relays a served fetch result and maps other failures to fetch_failed", async () => {
    const ok = harness({}, { ok: true, status: 200, headers: {}, body: "{}" });
    ok.controller.receive({
      fm: 2,
      type: "request",
      id: 1,
      verb: "fetch",
      alias: "a",
      request: { path: "/" },
    });
    await flush();
    expect(ok.posted.at(-1)).toMatchObject({
      id: 1,
      ok: true,
      result: { status: 200, body: "{}" },
    });
    const failed = harness({}, { ok: false, error: { code: "timeout", message: "15s" } });
    failed.controller.receive({
      fm: 2,
      type: "request",
      id: 2,
      verb: "fetch",
      alias: "a",
      request: { path: "/" },
    });
    await flush();
    expect(failed.posted.at(-1)).toMatchObject({
      id: 2,
      ok: false,
      error: { code: "fetch_failed", message: "timeout: 15s" },
    });
  });

  it("caps unanswered async requests per frame", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, posted } = harness({ onAction: () => gate });
    for (let id = 1; id <= FRAME_MAX_IN_FLIGHT; id++) {
      controller.receive({ fm: 2, type: "request", id, verb: "action", action: "choose" });
    }
    controller.receive({ fm: 2, type: "request", id: 99, verb: "action", action: "choose" });
    expect(posted.at(-1)).toMatchObject({
      id: 99,
      ok: false,
      error: { code: "too_many_in_flight" },
    });
    release();
    await flush();
    expect(posted.filter((m) => m.type === "response" && m.ok)).toHaveLength(FRAME_MAX_IN_FLIGHT);
  });

  it("forgets a document's subscriptions when a fresh one reports ready, and everything on dispose", async () => {
    const { controller, posted } = harness();
    controller.receive({
      fm: 2,
      type: "request",
      id: 1,
      verb: "subscribe",
      sub: 1,
      read: "observe.sessions",
    });
    expect(controller.subscriptionCount).toBe(1);
    controller.receive({ fm: 2, type: "ready" });
    expect(controller.subscriptionCount).toBe(0);
    controller.receive({
      fm: 2,
      type: "request",
      id: 2,
      verb: "subscribe",
      sub: 2,
      read: "observe.sessions",
    });
    controller.dispose();
    expect(controller.subscriptionCount).toBe(0);
    const before = posted.length;
    controller.receive({ fm: 2, type: "request", id: 3, verb: "unsubscribe", sub: 2 });
    await flush();
    expect(posted).toHaveLength(before);
  });

  describe("the watchdog", () => {
    function armed(
      onUnresponsive: () => void,
      paused?: () => boolean,
      askMain?: () => Promise<unknown>,
    ) {
      let tick: () => void = () => {};
      const cleared: unknown[] = [];
      const posted: HostMessage[] = [];
      const controller = new FrameController(
        { pluginId: "host", reads: [], actions: [], onAction: vi.fn(), onUnresponsive },
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
      return { controller, tick: () => tick(), cleared, pings };
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
      const { controller, tick, cleared, pings } = armed(onUnresponsive);
      controller.receive({ fm: 2, type: "ready" });
      tick();
      // One late answer resets the count: only consecutive misses count.
      tick();
      controller.receive({ fm: 2, type: "pong", seq: 2 });
      for (let round = 0; round < FRAME_WATCHDOG_MISSES; round++) tick();
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
      // A script that wedges its frame before `ready` reaches the host.
      controller.expectDocument();
      for (let round = 1; round < FRAME_WATCHDOG_MISSES; round++) tick();
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
      // A pause in the middle of a streak does not carry the misses over.
      hidden = false;
      tick();
      tick();
      hidden = true;
      for (let round = 0; round < FRAME_WATCHDOG_MISSES * 2; round++) tick();
      expect(onUnresponsive).not.toHaveBeenCalled();
      hidden = false;
      for (let round = 0; round < FRAME_WATCHDOG_MISSES; round++) tick();
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
      // A frame stuck on its own while the main process answers is still stopped.
      for (let round = 0; round < FRAME_WATCHDOG_MISSES; round++) {
        answer();
        await flush();
        tick();
      }
      expect(onUnresponsive).toHaveBeenCalledTimes(1);
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

  it("hands a starter's words to the mount only from the document it shows, one bounded line", () => {
    const onDraft = vi.fn();
    const { controller } = harness({ onDraft });
    // Before any document is born there is nothing to hear it from.
    controller.receive({ fm: 2, type: "draft", document: "doc-1", text: "Clone the project at " });
    controller.receive({ fm: 2, type: "ready", document: "doc-1" });
    controller.receive({ fm: 2, type: "draft", document: "doc-1", text: "Clone the project at " });
    expect(onDraft).toHaveBeenCalledWith("Clone the project at ");
    onDraft.mockClear();
    for (const bad of [
      // A document the frame no longer shows, or none named.
      { fm: 2, type: "draft", document: "doc-0", text: "Clone the project at " },
      { fm: 2, type: "draft", text: "Clone the project at " },
      // Words that are not the start of one sentence.
      { fm: 2, type: "draft", document: "doc-1", text: "" },
      { fm: 2, type: "draft", document: "doc-1", text: "Clone\nand then merge everything" },
      { fm: 2, type: "draft", document: "doc-1", text: "x".repeat(501) },
      { fm: 2, type: "draft", document: "doc-1", text: 7 },
    ]) {
      controller.receive(bad);
    }
    expect(onDraft).not.toHaveBeenCalled();
    // A mount that takes no words ignores them.
    const { controller: quiet } = harness();
    quiet.receive({ fm: 2, type: "ready", document: "doc-1" });
    expect(() =>
      quiet.receive({ fm: 2, type: "draft", document: "doc-1", text: "Work in the folder " }),
    ).not.toThrow();
  });

  it("hands a picture click to the mount, and drops one outside the envelope", () => {
    const onImage = vi.fn();
    const { controller } = harness({ onImage });
    const pictures = [
      { src: "data:image/png;base64,AA==", alt: "The lead", width: 2800, height: 520 },
      { src: "data:image/png;base64,AB==", alt: "", width: 0, height: 0 },
    ];
    controller.receive({ fm: 2, type: "image", index: 1, pictures });
    expect(onImage).toHaveBeenCalledWith(1, pictures);
    onImage.mockClear();
    for (const bad of [
      { fm: 2, type: "image", index: 2, pictures },
      { fm: 2, type: "image", index: -1, pictures },
      { fm: 2, type: "image", index: 0, pictures: [] },
      { fm: 2, type: "image", index: 0, pictures: [{ src: "", alt: "", width: 1, height: 1 }] },
      { fm: 2, type: "image", index: 0, pictures: [{ ...pictures[0], width: 1.5 }] },
      { fm: 2, type: "image", index: 0 },
    ]) {
      controller.receive(bad);
    }
    expect(onImage).not.toHaveBeenCalled();
  });

  it("hands a demo's press to the mount with its recording, poster and caption, and drops a malformed one", () => {
    const onDemo = vi.fn();
    const { controller } = harness({ onDemo });
    const demo = {
      src: `app-frame://media/t1-${"a".repeat(32)}.mp4`,
      poster: {
        src: `app-frame://images/t1-${"b".repeat(32)}.png`,
        alt: "The row",
        width: 480,
        height: 270,
      },
      caption: "Drag the row to the top",
      durationMs: 3000,
      play: true,
    };
    controller.receive({ fm: 2, type: "demo", ...demo });
    expect(onDemo).toHaveBeenCalledWith(demo);
    onDemo.mockClear();
    for (const bad of [
      { fm: 2, type: "demo", ...demo, play: "yes" },
      { fm: 2, type: "demo", ...demo, src: "" },
      { fm: 2, type: "demo", ...demo, poster: { ...demo.poster, src: "" } },
      { fm: 2, type: "demo", src: demo.src },
    ]) {
      controller.receive(bad);
    }
    expect(onDemo).not.toHaveBeenCalled();
  });
});

describe("an answer and the document that asked", () => {
  /** Every action, fetch and store call waits, in the order asked, until the test settles it. */
  function waitingHarness() {
    const waiting: ((fail: boolean) => void)[] = [];
    const wait = <T>(value: T) =>
      new Promise<T>((resolve, reject) => {
        waiting.push((fail) => (fail ? reject(new Error("gone")) : resolve(value)));
      });
    const posted: HostMessage[] = [];
    const controller = new FrameController(
      {
        pluginId: "acme",
        reads: [],
        actions: ["choose"],
        onAction: () => wait(undefined),
        store: { extensionId: "acme" },
      },
      "dark",
      {
        executor: new ReadExecutor(fakeApi()),
        fetch: () => wait<MediatedFetchResult>({ ok: true, status: 200, headers: {}, body: "{}" }),
        store: { request: () => wait({ value: "high water" }), onChange: () => () => {} },
      },
      { post: (message) => posted.push(message) },
    );
    const responses = () => posted.filter((message) => message.type === "response");
    return { controller, waiting, responses };
  }

  const asks = {
    action: { verb: "action", action: "choose" },
    fetch: { verb: "fetch", alias: "tides", request: { path: "/today" } },
    store: { verb: "store", op: "get", key: "tide" },
  };
  // A host-led rebuild expects the document first; a frame that reloads
  // itself is known only by its new document's `ready`.
  const replacements = {
    "a rebuilt document": (controller: FrameController) => {
      controller.expectDocument();
      controller.receive({ fm: 2, type: "ready", document: "new" });
    },
    "a document that reloaded itself": (controller: FrameController) => {
      controller.receive({ fm: 2, type: "ready", document: "new" });
    },
  };

  for (const [verb, ask] of Object.entries(asks)) {
    for (const [replacement, replace] of Object.entries(replacements)) {
      it(`drops an old document's ${verb} answers in ${replacement}, and answers its own request of the same id`, async () => {
        const { controller, waiting, responses } = waitingHarness();
        controller.receive({ fm: 2, type: "ready", document: "old" });
        controller.receive({ fm: 2, type: "request", document: "old", id: 1, ...ask });
        controller.receive({ fm: 2, type: "request", document: "old", id: 2, ...ask });
        replace(controller);
        // The new document numbers its requests from 1 again.
        controller.receive({ fm: 2, type: "request", document: "new", id: 1, ...ask });
        expect(waiting).toHaveLength(3);

        // The old document's answers, served and refused, finish late.
        waiting[0]?.(false);
        waiting[1]?.(true);
        await flush();
        expect(responses()).toEqual([]);

        waiting[2]?.(false);
        await flush();
        expect(responses()).toEqual([
          expect.objectContaining({ fm: 2, type: "response", id: 1, document: "new", ok: true }),
        ]);
      });
    }
  }

  it("addresses every answer, sync or async, to the document that asked", async () => {
    const { controller, waiting, responses } = waitingHarness();
    controller.receive({ fm: 2, type: "ready", document: "now" });
    controller.receive({
      fm: 2,
      type: "request",
      document: "now",
      id: 1,
      verb: "action",
      action: "x",
    });
    controller.receive({ fm: 2, type: "request", document: "now", id: 2, ...asks.store });
    waiting[0]?.(false);
    await flush();
    expect(responses()).toEqual([
      expect.objectContaining({ id: 1, document: "now", ok: false }),
      expect.objectContaining({
        id: 2,
        document: "now",
        ok: true,
        result: { value: "high water" },
      }),
    ]);
  });

  it("keeps a dropped answer's request under the cap until it settles, so a reload cannot escape it", async () => {
    const { controller, waiting, responses } = waitingHarness();
    controller.receive({ fm: 2, type: "ready", document: "old" });
    for (let id = 1; id <= FRAME_MAX_IN_FLIGHT; id++) {
      controller.receive({ fm: 2, type: "request", document: "old", id, ...asks.action });
    }
    controller.receive({ fm: 2, type: "ready", document: "new" });
    controller.receive({ fm: 2, type: "request", document: "new", id: 1, ...asks.action });
    expect(responses()).toEqual([
      expect.objectContaining({
        id: 1,
        document: "new",
        ok: false,
        error: expect.objectContaining({ code: "too_many_in_flight" }),
      }),
    ]);
    for (const settle of waiting) settle(false);
    await flush();
    controller.receive({ fm: 2, type: "request", document: "new", id: 2, ...asks.action });
    expect(waiting).toHaveLength(FRAME_MAX_IN_FLIGHT + 1);
    waiting.at(-1)?.(false);
    await flush();
    expect(responses().at(-1)).toEqual({
      fm: 2,
      type: "response",
      id: 2,
      document: "new",
      ok: true,
    });
  });
});

describe("a card's held page (FI3-871)", () => {
  const drawing = (document: string, held?: true) => ({
    fm: 2,
    type: "resize",
    document,
    height: 120,
    width: 510,
    initialized: true,
    ...(held ? { held } : {}),
  });

  it("tells a document born before the card is shown nothing until it is, then once", () => {
    const { controller, posted } = harness();
    controller.receive({ fm: 2, type: "ready", document: "prepared" });
    expect(posted.some((m) => m.type === "activate")).toBe(false);
    controller.activate();
    expect(posted.at(-1)).toEqual({ fm: 2, type: "activate" });
    controller.activate();
    expect(posted.filter((m) => m.type === "activate")).toHaveLength(1);
  });

  it("activates a card shown before its document is born last, after what it is born into", () => {
    const { controller, posted } = harness({ width: "wide" });
    controller.activate();
    expect(posted).toEqual([]);
    controller.receive({ fm: 2, type: "ready", document: "cold" });
    expect(posted.slice(-2)).toEqual([
      { fm: 2, type: "initialize", document: "cold" },
      { fm: 2, type: "activate" },
    ]);
    // A rebuilt body of a shown card is shown too.
    controller.receive({ fm: 2, type: "ready", document: "rebuilt" });
    expect(posted.at(-1)).toEqual({ fm: 2, type: "activate" });
  });

  it("hands the mount a held drawing as held, and each birth as it comes", () => {
    const onDrawn = vi.fn();
    const onBorn = vi.fn();
    const { controller } = harness({ onDrawn, onBorn });
    controller.receive({ fm: 2, type: "ready", document: "prepared" });
    expect(onBorn).toHaveBeenCalledOnce();
    controller.receive(drawing("prepared", true));
    expect(onDrawn).toHaveBeenLastCalledWith(120, 510, true);
    controller.activate();
    controller.receive(drawing("prepared"));
    expect(onDrawn).toHaveBeenLastCalledWith(120, 510, false);
  });
});

describe("a card body's task keys (FI3-594)", () => {
  const box = { top: 4, right: 70, bottom: 20, left: 12 };
  const born = (controller: FrameController, document = "doc-1") =>
    controller.receive({ fm: 2, type: "ready", document });
  const gesture = (gesture: string, key: string, extra: object = {}, document = "doc-1") => ({
    fm: 2,
    type: "task",
    document,
    gesture,
    key,
    ...extra,
  });

  it("tells every new document the keys it links, before it starts drawing, and every change after", () => {
    const { controller, posted } = harness({ taskKeys: ["FI3-572"] });
    born(controller);
    const types = posted.map((message) => message.type);
    expect(posted).toContainEqual({ fm: 2, type: "tasks", keys: ["FI3-572"] });
    expect(types.indexOf("tasks")).toBeLessThan(types.indexOf("initialize"));
    posted.length = 0;
    controller.setTaskKeys(["FI3-572", "SCR-3"]);
    expect(posted).toEqual([{ fm: 2, type: "tasks", keys: ["FI3-572", "SCR-3"] }]);
    posted.length = 0;
    born(controller, "doc-2");
    expect(posted).toContainEqual({ fm: 2, type: "tasks", keys: ["FI3-572", "SCR-3"] });
  });

  it("tells a document the key a rest elsewhere lights, at once and again to every new document (INF-237)", () => {
    const { controller, posted } = harness({ taskKeys: ["FI3-572"] });
    born(controller);
    posted.length = 0;
    controller.setLitKey("FI3-572");
    expect(posted).toEqual([{ fm: 2, type: "lit", key: "FI3-572" }]);
    posted.length = 0;
    controller.setLitKey("FI3-572");
    expect(posted).toEqual([]);
    born(controller, "doc-2");
    expect(posted).toContainEqual({ fm: 2, type: "lit", key: "FI3-572" });
    posted.length = 0;
    controller.setLitKey(null);
    expect(posted).toEqual([{ fm: 2, type: "lit", key: null }]);
    posted.length = 0;
    born(controller, "doc-3");
    expect(posted.some((message) => message.type === "lit")).toBe(false);
  });

  it("hands a rest, a leave and an open on a linked key to the mount", () => {
    const onTask = vi.fn();
    const { controller } = harness({ taskKeys: ["FI3-572"], onTask });
    born(controller);
    controller.receive(gesture("rest", "FI3-572", { box }));
    controller.receive(gesture("leave", "FI3-572"));
    controller.receive(gesture("open", "FI3-572"));
    expect(onTask.mock.calls).toEqual([
      ["rest", "FI3-572", box],
      ["leave", "FI3-572", undefined],
      ["open", "FI3-572", undefined],
    ]);
  });

  it("drops a gesture on a key the document was not told, a rest with no box, and an old document's", () => {
    const onTask = vi.fn();
    const { controller } = harness({ taskKeys: ["FI3-572"], onTask });
    born(controller);
    controller.receive(gesture("open", "FI3-1"));
    controller.receive(gesture("rest", "FI3-572"));
    controller.receive(gesture("open", "FI3-572", {}, "doc-0"));
    born(controller, "doc-2");
    controller.receive(gesture("open", "FI3-572"));
    expect(onTask).not.toHaveBeenCalled();
    controller.receive(gesture("open", "FI3-572", {}, "doc-2"));
    expect(onTask).toHaveBeenCalledWith("open", "FI3-572", undefined);
  });
});

describe('a card body\'s keyboard (docs/keyboard.md, "Cards and frames")', () => {
  const born = (controller: FrameController, document = "doc-1") =>
    controller.receive({ fm: 2, type: "ready", document });
  const escapeFrom = (document = "doc-1") => ({ fm: 2, type: "escape", document });

  it("tells every new document which of its keys the host hears, before it starts drawing", () => {
    const { controller, posted } = harness({ onImage: vi.fn(), onEscape: vi.fn() });
    born(controller);
    const types = posted.map((message) => message.type);
    expect(posted).toContainEqual({ fm: 2, type: "keys", pictures: true, escape: true });
    expect(types.indexOf("keys")).toBeLessThan(types.indexOf("initialize"));
    posted.length = 0;
    born(controller, "doc-2");
    expect(posted).toContainEqual({ fm: 2, type: "keys", pictures: true, escape: true });
  });

  it("tells a mount that opens no pictures and hears no Escape nothing, so its pictures stay out of Tab", () => {
    const { controller, posted } = harness();
    born(controller);
    expect(posted.filter((message) => message.type === "keys")).toEqual([]);
    const pictures = harness({ onImage: vi.fn() });
    born(pictures.controller);
    expect(pictures.posted).toContainEqual({ fm: 2, type: "keys", pictures: true, escape: false });
  });

  it("hands the current document's Escape to the mount, and drops an old document's or an unsigned one", () => {
    const onEscape = vi.fn();
    const { controller } = harness({ onEscape });
    born(controller);
    controller.receive(escapeFrom("doc-0"));
    controller.receive({ fm: 2, type: "escape" });
    expect(onEscape).not.toHaveBeenCalled();
    controller.receive(escapeFrom());
    expect(onEscape).toHaveBeenCalledTimes(1);
    born(controller, "doc-2");
    controller.receive(escapeFrom());
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("asks a born document to give focus back to what it held, and nothing before birth or after dispose", () => {
    const { controller, posted } = harness();
    controller.returnFocus();
    expect(posted).toEqual([]);
    born(controller);
    posted.length = 0;
    controller.returnFocus();
    expect(posted).toEqual([{ fm: 2, type: "focus" }]);
    controller.dispose();
    posted.length = 0;
    controller.returnFocus();
    expect(posted).toEqual([]);
  });
});

describe("a card body's form (inline decisions, contract 4.22)", () => {
  const draft = [{ name: "speed", values: ["fast"], labels: ["Fast"], changed: true }];
  const reading = {
    answered: 1,
    of: 2,
    changed: 1,
    picked: 1,
    answers: [...draft, { name: "note", values: [], changed: false }],
  };

  function formHarness() {
    const onAnswers = vi.fn();
    const fill = vi.fn(() => draft);
    return { onAnswers, fill, ...harness({ form: { fill, onAnswers } }) };
  }

  it("tells every new document to watch its form, handing it the shell's draft", () => {
    const { controller, posted, fill } = formHarness();
    controller.receive({ fm: 2, type: "ready" });
    expect(posted).toEqual([
      { fm: 2, type: "theme", theme: "dark" },
      { fm: 2, type: "form", fill: draft },
    ]);
    // A revised body is a new document: it gets the draft as it is now.
    fill.mockReturnValueOnce([]);
    controller.receive({ fm: 2, type: "ready" });
    expect(posted.at(-1)).toEqual({ fm: 2, type: "form", fill: [] });
  });

  it("never asks a mount without a form to watch one, and drops its readings", () => {
    const { controller, posted } = harness();
    controller.receive({ fm: 2, type: "ready" });
    controller.receive({ fm: 2, type: "answers", ...reading });
    expect(posted).toEqual([{ fm: 2, type: "theme", theme: "dark" }]);
  });

  it("hands each reading to the mount and drops one whose count does not add up", () => {
    const { controller, onAnswers } = formHarness();
    controller.receive({ fm: 2, type: "ready" });
    controller.receive({ fm: 2, type: "answers", ...reading });
    expect(onAnswers).toHaveBeenCalledWith(reading);
    onAnswers.mockClear();
    for (const bad of [
      { ...reading, answered: 3 },
      { ...reading, picked: 3 },
      { ...reading, of: 3 },
      { ...reading, answers: [{ name: "", values: [], changed: false }] },
      { ...reading, answers: [{ name: "x", values: [1], changed: false }] },
    ]) {
      controller.receive({ fm: 2, type: "answers", ...bad });
    }
    expect(onAnswers).not.toHaveBeenCalled();
  });

  it("collects a fresh reading for a footer click, and gives up on a frame that does not answer", async () => {
    vi.useFakeTimers();
    try {
      const { controller, posted } = formHarness();
      // Before the document is born there is nothing to ask.
      await expect(controller.collect()).resolves.toBeUndefined();
      controller.receive({ fm: 2, type: "ready" });
      const asked = controller.collect();
      expect(posted.at(-1)).toEqual({ fm: 2, type: "collect", seq: 1, focusUnpicked: false });
      controller.receive({ fm: 2, type: "answers", ...reading, seq: 1 });
      await expect(asked).resolves.toEqual(reading);

      const wedged = controller.collect();
      vi.advanceTimersByTime(1_000);
      await expect(wedged).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a collect's question definitions (docs/card-evidence.md)", () => {
  const reading = {
    answered: 1,
    of: 1,
    changed: 0,
    picked: 0,
    answers: [{ name: "wash", values: ["clear"], labels: ["Clear"], changed: false }],
  };
  const question = {
    name: "wash",
    kind: "single",
    control: "radio",
    prompt: "Which wash?",
    promptBasis: "legend",
    options: [
      { value: "clear", label: "Clear", authoredDefault: true, disabled: false, hidden: false },
      { value: "full", label: "Full wash", authoredDefault: false, disabled: false, hidden: false },
    ],
    defaultBasis: "authored",
    required: false,
    gaps: [],
    complete: true,
  };

  async function collected(extra: Record<string, unknown>) {
    const onAnswers = vi.fn();
    const { controller } = harness({ form: { fill: () => [], onAnswers } });
    controller.receive({ fm: 2, type: "ready" });
    const asked = controller.collect();
    controller.receive({ fm: 2, type: "answers", ...reading, seq: 1, ...extra });
    return { reading: await asked, drafted: onAnswers.mock.calls.at(-1)?.[0] };
  }

  it("hands them to the click that asked, and never into the shell's draft", async () => {
    const { reading: fresh, drafted } = await collected({ questions: [question] });
    expect(fresh).toEqual({ ...reading, questions: [question] });
    expect(drafted).toEqual(reading);
  });

  it("turns definitions it cannot read into the reason, and keeps the answers", async () => {
    const { reading: unreadable } = await collected({ questions: [{ ...question, kind: "vote" }] });
    expect(unreadable).toEqual({ ...reading, questionsGap: "invalid" });
    const { reading: large } = await collected({ questionsGap: "too-large" });
    expect(large).toEqual({ ...reading, questionsGap: "too-large" });
  });
});

describe("the store verb (the frame realm's PanelProps.store)", () => {
  function storeHarness(bound: string | null, draft = false) {
    const posted: HostMessage[] = [];
    const requests: PersonalStoreRequest[] = [];
    const listeners: ((change: PersonalStoreChange) => void)[] = [];
    const store: FrameStoreDeps = {
      request: async (request) => {
        requests.push(request);
        return request.op === "get" ? { value: `${request.extensionId}:${request.key}` } : {};
      },
      onChange: (listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    };
    const controller = new FrameController(
      {
        pluginId: "installed-meter",
        reads: [],
        actions: [],
        onAction: vi.fn(),
        ...(bound
          ? { store: { extensionId: bound, ...(draft ? { draft: true as const } : {}) } }
          : {}),
      },
      "dark",
      { executor: new ReadExecutor(fakeApi()), fetch: vi.fn(), store },
      { post: (message) => posted.push(message) },
    );
    const change = (extensionId: string, key: string, draft?: true) => {
      for (const listener of listeners) listener({ extensionId, key, ...(draft ? { draft } : {}) });
    };
    return { controller, posted, requests, listeners, change };
  }

  it("reaches the slice the host bound, whatever slice the frame names", async () => {
    const { controller, posted, requests } = storeHarness("meter");
    controller.receive({ fm: 2, type: "ready" });
    controller.receive({
      fm: 2,
      type: "request",
      id: 1,
      verb: "store",
      op: "get",
      key: "secret",
      extensionId: "victim",
    });
    controller.receive({
      fm: 2,
      type: "request",
      id: 2,
      verb: "store",
      op: "set",
      key: "k",
      value: { n: 1 },
    });
    await flush();
    expect(requests).toEqual([
      { op: "get", extensionId: "meter", key: "secret" },
      { op: "set", extensionId: "meter", key: "k", value: { n: 1 } },
    ]);
    expect(posted.filter((message) => message.type === "response")).toEqual([
      { fm: 2, type: "response", id: 1, ok: true, result: { value: "meter:secret" } },
      { fm: 2, type: "response", id: 2, ok: true, result: {} },
    ]);
  });

  it("refuses the verb on a mount bound to no slice, and a malformed request on one that is", async () => {
    const unbound = storeHarness(null);
    unbound.controller.receive({ fm: 2, type: "ready" });
    unbound.controller.receive({
      fm: 2,
      type: "request",
      id: 1,
      verb: "store",
      op: "get",
      key: "k",
    });
    await flush();
    expect(unbound.requests).toEqual([]);
    expect(unbound.posted.at(-1)).toMatchObject({
      type: "response",
      id: 1,
      ok: false,
      error: { code: "capability_not_granted" },
    });

    const bound = storeHarness("meter");
    bound.controller.receive({ fm: 2, type: "ready" });
    // A get with no key is not a store request.
    bound.controller.receive({ fm: 2, type: "request", id: 2, verb: "store", op: "get" });
    await flush();
    expect(bound.requests).toEqual([]);
    expect(bound.posted.at(-1)).toMatchObject({ id: 2, ok: false, error: { code: "bad_request" } });
  });

  it("tells the frame which keys of its own slice changed, and nothing of another's", () => {
    const { controller, posted, listeners, change } = storeHarness("meter");
    change("meter", "early");
    expect(listeners).toHaveLength(0);
    controller.receive({ fm: 2, type: "ready" });
    change("victim", "secret");
    change("meter", "count");
    expect(posted.filter((message) => message.type === "store")).toEqual([
      { fm: 2, type: "store", key: "count" },
    ]);
    controller.dispose();
    expect(listeners).toHaveLength(0);
  });

  // INF-2205 piece C: a crewmate's build draws its panel in a frame too, and
  // that page keeps its draft's own store, never the captain's saved one.
  it("binds a draft's page to its draft slice, both ways", async () => {
    const draft = storeHarness("meter", true);
    draft.controller.receive({ fm: 2, type: "ready" });
    draft.controller.receive({ fm: 2, type: "request", id: 1, verb: "store", op: "get", key: "k" });
    await flush();
    expect(draft.requests).toEqual([{ op: "get", extensionId: "meter", key: "k", draft: true }]);
    draft.change("meter", "saved");
    draft.change("meter", "drafted", true);
    expect(draft.posted.filter((message) => message.type === "store")).toEqual([
      { fm: 2, type: "store", key: "drafted" },
    ]);

    const saved = storeHarness("meter");
    saved.controller.receive({ fm: 2, type: "ready" });
    saved.change("meter", "drafted", true);
    saved.change("meter", "saved");
    expect(saved.posted.filter((message) => message.type === "store")).toEqual([
      { fm: 2, type: "store", key: "saved" },
    ]);
  });
});

describe("a fact strip refreshed in place (FI3-1093)", () => {
  const born = (controller: FrameController, document = "doc-1") =>
    controller.receive({ fm: 2, type: "ready", document });

  it("tells every new document its markup before it starts drawing, and every change after", () => {
    const { controller, posted } = harness({ markup: "<p>read 2 min ago</p>" });
    controller.setMarkup("<p>read 2 min ago</p>");
    expect(posted).toEqual([]);
    born(controller);
    const types = posted.map((message) => message.type);
    expect(posted).toContainEqual({ fm: 2, type: "markup", html: "<p>read 2 min ago</p>" });
    expect(types.indexOf("markup")).toBeLessThan(types.indexOf("initialize"));
    posted.length = 0;
    controller.setMarkup("<p>read 2 min ago</p>");
    expect(posted).toEqual([]);
    controller.setMarkup("<p>read 3 min ago</p>");
    expect(posted).toEqual([{ fm: 2, type: "markup", html: "<p>read 3 min ago</p>" }]);
    posted.length = 0;
    born(controller, "doc-2");
    expect(posted).toContainEqual({ fm: 2, type: "markup", html: "<p>read 3 min ago</p>" });
  });
});

describe("a frame's link on the console (FI3-1093)", () => {
  const PR = "https://github.com/octo/meterlab/pull/58";
  const lines = () =>
    (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
      String(call[0]),
    );

  it("says it heard the link before it hands it to the mount", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const onLink = vi.fn();
      const { controller } = harness({ onLink });
      controller.receive({ fm: 2, type: "ready", document: "doc-1" });
      controller.receive({ fm: 2, type: "link", document: "doc-1", href: PR });
      expect(onLink).toHaveBeenCalledWith(PR);
      expect(lines()).toEqual([`[infinitary] link ${PR}: heard from its frame`]);
    } finally {
      info.mockRestore();
    }
  });

  it("says why it drops a link from a document the frame no longer shows, or outside the envelope", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const onLink = vi.fn();
      const { controller } = harness({ onLink });
      controller.receive({ fm: 2, type: "ready", document: "doc-1" });
      controller.expectDocument();
      controller.receive({ fm: 2, type: "link", document: "doc-1", href: PR });
      controller.receive({ fm: 2, type: "link", document: "doc-2", href: "" });
      expect(onLink).not.toHaveBeenCalled();
      expect(lines()).toEqual([
        `[infinitary] link ${PR}: heard from its frame`,
        `[infinitary] link ${PR}: not opened, it came from a document the frame no longer shows`,
        "[infinitary] link : not opened, its message is not one the bridge sends",
      ]);
      info.mockClear();
      controller.dispose();
      controller.receive({ fm: 2, type: "link", document: "doc-2", href: PR });
      expect(lines()).toEqual([`[infinitary] link ${PR}: not opened, its frame is gone`]);
    } finally {
      info.mockRestore();
    }
  });
});

it("reveals only an allowed target on the requested offer and document", async () => {
  const { controller, posted } = harness({ revision: { offerId: "offer", starts: [12] } });
  controller.receive({ fm: 2, type: "ready", document: "doc" });
  expect(await controller.reveal("old", 12, false)).toBeUndefined();
  expect(await controller.reveal("offer", 99, false)).toBeUndefined();
  const result = controller.reveal("offer", 12, true);
  const request = posted.at(-1);
  if (request?.type !== "reveal") throw new Error("No reveal request");
  const answer = {
    fm: 2,
    type: "revealed",
    document: "doc",
    seq: request.seq,
    offerId: "offer",
    top: 200,
    height: 40,
  };
  controller.receive({ ...answer, document: "stale" });
  controller.receive({ ...answer, offerId: "wrong" });
  controller.receive({ ...answer, top: Infinity });
  controller.receive({ ...answer, top: -1 });
  controller.receive(answer);
  expect(await result).toEqual({ top: 200, height: 40 });
  const stale = controller.reveal("offer", 12, false);
  controller.expectDocument();
  expect(await stale).toBeUndefined();
  controller.dispose();
});
