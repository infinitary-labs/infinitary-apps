import { describe, expect, it } from "vitest";
import { heldPress } from "./heldKeys";

const on = (pressable: boolean): EventTarget =>
  ({ closest: () => (pressable ? {} : null) }) as unknown as EventTarget;

describe("a held key presses a control once", () => {
  it("drops a held Enter's repeats on a button, a link or a summary", () => {
    expect(heldPress({ key: "Enter", repeat: true, target: on(true) })).toBe(true);
  });

  it("lets the first press through, and every key that presses nothing", () => {
    expect(heldPress({ key: "Enter", repeat: false, target: on(true) })).toBe(false);
    expect(heldPress({ key: "Enter", repeat: true, target: on(false) })).toBe(false);
    expect(heldPress({ key: "ArrowDown", repeat: true, target: on(true) })).toBe(false);
    expect(heldPress({ key: "Enter", repeat: true, target: null })).toBe(false);
  });
});
