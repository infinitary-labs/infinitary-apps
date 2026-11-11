import { afterEach, describe, expect, it, vi } from "vitest";
import { createDarwinFreshAuthentication } from "./darwinFreshAuthentication";

// Intent: INF-1105 - fresh system authentication for a human Allow: the macOS
// binding reaches LocalAuthentication, and a confirmation the system could not
// ask the person for approves nothing (docs/secrets.md, "Trusted approvals").
// No prompt appears: interaction is refused, so the system answers at once.
describe.skipIf(process.platform !== "darwin")("macOS fresh authentication", () => {
  it("answers whether this Mac can confirm its owner, and approves nothing it could not ask", async () => {
    const silent = createDarwinFreshAuthentication({ interactionNotAllowed: true });
    expect(silent).toBeDefined();
    expect(typeof (await silent?.available())).toBe("boolean");
    expect(await silent?.confirm("Check the Secrets binding")).toBe(false);
    // A second confirmation gets a new context of its own and answers the same.
    expect(await silent?.confirm("Check the Secrets binding again")).toBe(false);
  });
});

/**
 * A stand-in for koffi's view of the Objective-C runtime, so no system prompt
 * appears and nothing reaches LocalAuthentication: a context can be refused
 * once, and each evaluation answers through the registered reply block, as
 * LocalAuthentication does when the person confirms.
 */
function fakeObjectiveC() {
  const state = { refuseNextContext: false, evaluated: [] as string[] };
  let reply: ((block: unknown, ok: number, error: unknown) => void) | undefined;
  const func = (name: string, result: string, args: unknown[]) => {
    if (name === "objc_getClass") return (cls: string) => ({ cls });
    if (name === "sel_registerName") return (selector: string) => selector;
    if (result === "uint8") return () => 1;
    if (result === "void" && args.length === 5)
      return (_made: unknown, _selector: string, _policy: number, text: { reason: string }) => {
        state.evaluated.push(text.reason);
        queueMicrotask(() => reply?.(null, 1, null));
      };
    if (result === "void") return () => undefined;
    if (args.length === 3)
      return (_object: unknown, _selector: string, reason: string) => ({ reason });
    return (object: { cls?: string }, selector: string) => {
      if (selector === "alloc" && object?.cls === "LAContext" && state.refuseNextContext) {
        state.refuseNextContext = false;
        return null;
      }
      if (selector === "alloc") return { of: object?.cls };
      if (selector === "init") return object;
      return undefined;
    };
  };
  const koffi = {
    load: () => ({ func, symbol: (name: string) => ({ symbol: name }) }),
    proto: (signature: string) => ({ signature }),
    struct: (name: string) => ({ name }),
    pointer: (type: unknown) => ({ pointer: type }),
    out: (type: unknown) => ({ out: type }),
    register: (callback: typeof reply) => {
      reply = callback;
      return { registered: true };
    },
    alloc: () => ({}),
    encode: () => undefined,
    sizeof: () => 32,
  };
  return { koffi, state };
}

describe("macOS fresh authentication after a failed confirmation", () => {
  afterEach(() => {
    vi.doUnmock("koffi");
    vi.doUnmock("../../core/platform");
    vi.resetModules();
  });

  // INF-3307 audit: one confirmation that failed before reaching the person
  // left the binding's queue rejected, so every later confirmation answered
  // no without asking until the app restarted.
  it("asks the person again for the next confirmation after one fails", async () => {
    const { koffi, state } = fakeObjectiveC();
    vi.resetModules();
    vi.doMock("koffi", () => ({ default: koffi }));
    vi.doMock("../../core/platform", () => ({ hostPlatform: () => "darwin" }));
    const { createDarwinFreshAuthentication: create } = await import("./darwinFreshAuthentication");
    const authentication = create();
    expect(authentication).toBeDefined();

    state.refuseNextContext = true;
    expect(await authentication?.confirm("Allow reading GITHUB_TOKEN for this task")).toBe(false);
    expect(state.evaluated).toEqual([]);

    expect(await authentication?.confirm("Allow reading GITHUB_TOKEN for this task")).toBe(true);
    expect(state.evaluated).toEqual(["Allow reading GITHUB_TOKEN for this task"]);
  });
});
