import { describe, expect, it } from "vitest";
import { canStillScrollExpression, wheelScroll } from "./wheelScroll";

/**
 * The task browser's scroll up and down returned as soon as the wheel was
 * sent, so a read on a busy Linux runner could still see the top
 * (task-browser.spec.ts, "a page too long for one answer"). The wheel is
 * real input; the call waits until that scroller's scroll has ended.
 */

type Call = { method: string; params?: Record<string, unknown> };

const size = { width: 800, height: 600 };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("a wheel scroll waits until the page has moved", () => {
  it("does not return until the scroll it armed has ended", async () => {
    const calls: Call[] = [];
    const ended = deferred<void>();
    const reachedWait = deferred<void>();
    let returned = false;
    const send = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") {
        expect(params?.awaitPromise).toBe(false);
        expect(String(params?.expression)).toContain("scrollend");
        return { result: { objectId: "promise-1" } } as T;
      }
      if (method === "Runtime.awaitPromise") {
        expect(params?.promiseObjectId).toBe("promise-1");
        reachedWait.resolve();
        await ended.promise;
        return { result: { value: true } } as T;
      }
      return {} as T;
    };
    const scrolling = wheelScroll(send, "down", size).then(() => {
      returned = true;
    });
    await reachedWait.promise;
    expect(returned).toBe(false);
    expect(calls.map((call) => call.method)).toEqual([
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
      "Runtime.awaitPromise",
    ]);
    expect(calls[1]?.params).toMatchObject({
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: 0,
      deltaY: 480,
    });
    ended.resolve();
    await scrolling;
    expect(returned).toBe(true);
  });

  it("sends the wheel and returns without waiting when the page is already at that edge", async () => {
    const calls: Call[] = [];
    const send = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === "Runtime.awaitPromise") throw new Error("a stuck edge must not wait");
      if (method === "Runtime.evaluate") return { result: { value: false } } as T;
      return {} as T;
    };
    await wheelScroll(send, "up", size);
    expect(calls.map((call) => call.method)).toEqual([
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
    ]);
    expect(calls[1]?.params).toMatchObject({ type: "mouseWheel", deltaY: -480 });
    expect(String(calls[0]?.params?.expression)).toContain("elementFromPoint");
  });

  it("still sends the wheel when the scroller cannot be read", async () => {
    const calls: Call[] = [];
    const send = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") throw new Error("layout unread");
      if (method === "Runtime.awaitPromise") throw new Error("an unread page must not hang");
      return {} as T;
    };
    await wheelScroll(send, "down", size);
    expect(calls.map((call) => call.method)).toEqual([
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
    ]);
  });

  it("returns on the host bound when the page never settles the scroll", async () => {
    const calls: Call[] = [];
    const send = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate") return { result: { objectId: "promise-3" } } as T;
      if (method === "Runtime.awaitPromise") return new Promise(() => undefined) as T;
      return {} as T;
    };
    await wheelScroll(send, "down", size, 0);
    // It did wait on the page's promise, and the host bound ended that wait.
    expect(calls.map((call) => call.method)).toEqual([
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
      "Runtime.awaitPromise",
    ]);
    expect(calls[2]?.params?.promiseObjectId).toBe("promise-3");
  });
});

type Box = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  overflowY: string;
  flexDirection?: string;
  parentElement: Box | null;
};

type Armed = {
  settled: Promise<boolean> | false;
  fire: (target: unknown) => void;
  document: object;
};

/** Run the page expression against a small document, not a string match. */
function armScroll(direction: "up" | "down", hit: Box | null, scrollingElement: Box): Armed {
  const listeners: Array<(event: { target: unknown }) => void> = [];
  const document = {
    scrollingElement,
    documentElement: scrollingElement,
    body: scrollingElement,
    elementFromPoint: () => hit,
  };
  const getComputedStyle = (node: Box): { overflowY: string; flexDirection: string } => ({
    overflowY: node.overflowY,
    flexDirection: node.flexDirection ?? "column",
  });
  const expression = canStillScrollExpression(direction, 400, 300, 1_000);
  const settled = new Function(
    "document",
    "getComputedStyle",
    "addEventListener",
    "removeEventListener",
    "setTimeout",
    `return (${expression})`,
  )(
    document,
    getComputedStyle,
    (_type: string, fn: (event: { target: unknown }) => void) => {
      listeners.push(fn);
    },
    () => undefined,
    () => 0,
  ) as Promise<boolean> | false;
  return {
    settled,
    document,
    fire: (target) => {
      for (const fn of [...listeners]) fn({ target });
    },
  };
}

describe("whether a wheel can still move the page", () => {
  const root = (scrollTop: number): Box => ({
    scrollHeight: 2000,
    clientHeight: 600,
    scrollTop,
    overflowY: "visible",
    parentElement: null,
  });

  it("can move down from the top and not up", () => {
    const page = root(0);
    expect(armScroll("down", page, page).settled).toBeInstanceOf(Promise);
    expect(armScroll("up", page, page).settled).toBe(false);
  });

  it("cannot move down when the document is already at its end", () => {
    const page = root(1400);
    const painted = {
      scrollHeight: 900,
      clientHeight: 100,
      scrollTop: 0,
      overflowY: "visible",
      parentElement: page,
    };
    expect(armScroll("down", painted, page).settled).toBe(false);
  });

  it("can move a nested scroller that is not at its edge", () => {
    const page = root(1400);
    const nested: Box = {
      scrollHeight: 900,
      clientHeight: 100,
      scrollTop: 0,
      overflowY: "auto",
      parentElement: page,
    };
    expect(armScroll("down", nested, page).settled).toBeInstanceOf(Promise);
    nested.scrollTop = 800;
    expect(armScroll("down", nested, page).settled).toBe(false);
  });

  it("keeps looking when a nested scroller is stuck and the document can still move", () => {
    const page = root(0);
    const nested: Box = {
      scrollHeight: 900,
      clientHeight: 100,
      scrollTop: 800,
      overflowY: "auto",
      parentElement: page,
    };
    expect(armScroll("down", nested, page).settled).toBeInstanceOf(Promise);
  });

  it("accepts that scroller's scroll end, and the document when the page itself scrolls", async () => {
    const page = root(0);
    const other = {
      scrollHeight: 400,
      clientHeight: 100,
      scrollTop: 0,
      overflowY: "auto",
      parentElement: page,
    };
    const documentScroll = armScroll("down", page, page);
    expect(documentScroll.settled).toBeInstanceOf(Promise);
    documentScroll.fire(other);
    let settled = false;
    void Promise.resolve(documentScroll.settled).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    documentScroll.fire(documentScroll.document);
    await expect(documentScroll.settled).resolves.toBe(true);

    const nested: Box = {
      scrollHeight: 900,
      clientHeight: 100,
      scrollTop: 0,
      overflowY: "auto",
      parentElement: page,
    };
    const inner = armScroll("down", nested, page);
    inner.fire(inner.document);
    inner.fire(page);
    let innerSettled = false;
    void Promise.resolve(inner.settled).then(() => {
      innerSettled = true;
    });
    await Promise.resolve();
    expect(innerSettled).toBe(false);
    inner.fire(nested);
    await expect(inner.settled).resolves.toBe(true);
  });

  it("returns a native promise when the page replaces Promise", () => {
    const page = root(0);
    const zone = function ZonePromise(executor: (done: (value: unknown) => void) => void) {
      executor(() => undefined);
      return { zone: true };
    };
    const expression = canStillScrollExpression("down", 400, 300, 1_000);
    const document = {
      scrollingElement: page,
      documentElement: page,
      body: page,
      elementFromPoint: () => page,
    };
    const result: unknown = new Function(
      "document",
      "getComputedStyle",
      "addEventListener",
      "removeEventListener",
      "setTimeout",
      "Promise",
      `return (${expression})`,
    )(
      document,
      () => ({ overflowY: "visible", flexDirection: "column" }),
      () => undefined,
      () => undefined,
      () => 0,
      zone,
    );
    expect(result).toBeInstanceOf(Promise);
    expect(result).not.toMatchObject({ zone: true });
  });

  it("can move up from a column-reverse scroller's resting edge, and not down", () => {
    const page = root(1400);
    const reversed: Box = {
      scrollHeight: 900,
      clientHeight: 100,
      scrollTop: 0,
      overflowY: "auto",
      flexDirection: "column-reverse",
      parentElement: page,
    };
    expect(armScroll("down", reversed, page).settled).toBe(false);
    expect(armScroll("up", reversed, page).settled).toBeInstanceOf(Promise);
    reversed.scrollTop = -800;
    page.scrollTop = 0;
    expect(armScroll("down", reversed, page).settled).toBeInstanceOf(Promise);
    expect(armScroll("up", reversed, page).settled).toBe(false);
  });
});
