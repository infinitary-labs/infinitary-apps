import { describe, expect, it } from "vitest";
import { canStillScrollExpression, wheelScroll } from "./wheelScroll";

/**
 * The task browser's scroll up and down returned as soon as the wheel was
 * sent, so a read on a busy Linux runner could still see the top
 * (task-browser.spec.ts, "a page too long for one answer"). The wheel is
 * real input; the call waits until that scroll has ended.
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
    let objectId: string | undefined;
    let returned = false;
    const send = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate" && String(params?.expression).includes("canMove")) {
        return { result: { value: true } } as T;
      }
      if (method === "Runtime.evaluate") {
        objectId = "promise-1";
        expect(params?.awaitPromise).toBe(false);
        expect(String(params?.expression)).toContain("scrollend");
        return { result: { objectId } } as T;
      }
      if (method === "Runtime.awaitPromise") {
        expect(params?.promiseObjectId).toBe(objectId);
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
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
      "Runtime.awaitPromise",
    ]);
    expect(calls[2]?.params).toMatchObject({
      type: "mouseWheel",
      x: 400,
      y: 300,
      deltaX: 0,
      deltaY: 480,
    });
    expect(calls.findIndex((call) => call.method === "Input.dispatchMouseEvent")).toBeGreaterThan(
      calls.findIndex((call) => String(call.params?.expression).includes("scrollend")),
    );
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

  it("still waits when the page's position cannot be read", async () => {
    const calls: Call[] = [];
    const send = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate" && params?.returnByValue === true) {
        throw new Error("layout unread");
      }
      if (method === "Runtime.evaluate") return { result: { objectId: "promise-2" } } as T;
      return {} as T;
    };
    await wheelScroll(send, "down", size);
    expect(calls.map((call) => call.method)).toEqual([
      "Runtime.evaluate",
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
      "Runtime.awaitPromise",
    ]);
  });

  it("still sends the wheel when the scroll listener cannot be armed", async () => {
    const calls: Call[] = [];
    const send = async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (method === "Runtime.evaluate" && params?.returnByValue === true) {
        return { result: { value: true } } as T;
      }
      if (method === "Runtime.evaluate") throw new Error("cannot arm");
      return {} as T;
    };
    await wheelScroll(send, "down", size);
    expect(calls.map((call) => call.method)).toContain("Input.dispatchMouseEvent");
    expect(calls.map((call) => call.method)).not.toContain("Runtime.awaitPromise");
  });
});

type Box = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  overflowY: string;
  parentElement: Box | null;
};

/** Run the page expression against a small document, not a string match. */
function pageCanStillScroll(
  direction: "up" | "down",
  hit: Box | null,
  scrollingElement: Box,
): boolean {
  const document = {
    scrollingElement,
    documentElement: scrollingElement,
    elementFromPoint: () => hit,
  };
  const getComputedStyle = (node: Box): { overflowY: string } => ({ overflowY: node.overflowY });
  const expression = canStillScrollExpression(direction, 400, 300);
  return new Function("document", "getComputedStyle", `return (${expression})`)(
    document,
    getComputedStyle,
  ) as boolean;
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
    expect(pageCanStillScroll("down", page, page)).toBe(true);
    expect(pageCanStillScroll("up", page, page)).toBe(false);
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
    expect(pageCanStillScroll("down", painted, page)).toBe(false);
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
    expect(pageCanStillScroll("down", nested, page)).toBe(true);
    nested.scrollTop = 800;
    expect(pageCanStillScroll("down", nested, page)).toBe(false);
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
    expect(pageCanStillScroll("down", nested, page)).toBe(true);
  });
});
