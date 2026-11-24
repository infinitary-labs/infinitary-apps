import { DEFAULT_SHELL_PREFERENCES, type ShellPreferences } from "@shared/preferences";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SizeDoor, sizeCommands } from "./windowSize";

/** A door that saves each write a moment later, as the core does once its queue reaches it. */
function door(size?: ShellPreferences["appearance"]["size"]) {
  let preferences: ShellPreferences = {
    ...DEFAULT_SHELL_PREFERENCES,
    appearance: { theme: "light", washStrength: 37, ...(size ? { size } : {}) },
  };
  const writes: unknown[][] = [];
  const dispatch = vi.fn<SizeDoor["dispatch"]>(async (channel, args) => {
    writes.push([channel, ...args]);
    await new Promise((resolve) => setTimeout(resolve, 1));
    preferences = { ...preferences, appearance: args[0] as ShellPreferences["appearance"] };
    return args[0];
  });
  return {
    door: { preferences: { get: () => preferences }, dispatch } satisfies SizeDoor,
    writes,
    dispatch,
    size: () => preferences.appearance.size,
  };
}

/**
 * Each stand-in save is a fake timer and every step between saves is promise
 * work, so draining the timers runs every queued step whatever the machine's
 * load, and a step that writes nothing still runs before the drain returns.
 */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const settled = () => vi.runAllTimersAsync();

describe("the size keys, View menu and command search", () => {
  it("write the window-size choice through the picker's door, keeping the rest of the look", async () => {
    const at = door();
    const size = sizeCommands(at.door);
    size["size.larger"]();
    await settled();
    expect(at.writes).toEqual([
      ["inf:settings:appearance:set", { theme: "light", washStrength: 37, size: 110 }],
    ]);
  });

  it("climb one choice per press while earlier presses are still being saved", async () => {
    const at = door();
    const size = sizeCommands(at.door);
    size["size.larger"]();
    size["size.larger"]();
    size["size.larger"]();
    size["size.larger"]();
    await settled();
    expect(at.writes.map((write) => (write[1] as { size: number }).size)).toEqual([110, 125, 150]);
    size["size.smaller"]();
    size["size.reset"]();
    await settled();
    expect(at.writes.map((write) => (write[1] as { size: number }).size)).toEqual([
      110, 125, 150, 125, 100,
    ]);
  });

  it("write nothing at either end, and a refused write leaves the next press working", async () => {
    const at = door(100);
    const size = sizeCommands(at.door);
    size["size.smaller"]();
    size["size.reset"]();
    await settled();
    expect(at.dispatch).not.toHaveBeenCalled();
    at.dispatch.mockRejectedValueOnce(new Error("Infinitary is still starting."));
    size["size.larger"]();
    size["size.larger"]();
    await settled();
    expect(at.size()).toBe(110);
    expect(at.dispatch).toHaveBeenCalledTimes(2);
  });
});
