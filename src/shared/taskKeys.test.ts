import { describe, expect, it } from "vitest";
import { TASK_KEYS_MAX, taskKeyParts, taskKeysIn } from "./taskKeys";

describe("taskKeysIn", () => {
  it("finds every key, once each, in order", () => {
    expect(taskKeysIn("FI3-572 and F13-572 (FM3K-1), then FI3-572 again; SCR-3. AB-90's")).toEqual([
      "FI3-572",
      "F13-572",
      "FM3K-1",
      "SCR-3",
      "AB-90",
    ]);
  });

  it("reads keys in markup and in the text around tags", () => {
    expect(
      taskKeysIn('<p>See <code>FI3-594</code>,<span class="inf-mono">SCR-2</span></p>'),
    ).toEqual(["FI3-594", "SCR-2"]);
  });

  it("leaves words that only look like keys", () => {
    expect(
      taskKeysIn(
        "fi3-572 FI3-594-plan card-FI3-594 xFI3-1 FI3_1 ABCDE-1 A-1 FI3- -12 FI3-1a 2026-10-03",
      ),
    ).toEqual([]);
  });

  it("stops at TASK_KEYS_MAX", () => {
    const text = Array.from({ length: TASK_KEYS_MAX + 5 }, (_, n) => `SCR-${n + 1}`).join(" ");
    const keys = taskKeysIn(text);
    expect(keys).toHaveLength(TASK_KEYS_MAX);
    expect(keys.at(-1)).toBe(`SCR-${TASK_KEYS_MAX}`);
  });
});

describe("taskKeyParts", () => {
  it("cuts out only the keys it is told to link, keeping every other word as written", () => {
    const known = new Set(["FI3-12", "SCR-3"]);
    expect(
      taskKeyParts("FI3-12 waits on SCR-3, not F13-572 or FI3-12-plan; then FI3-12.", (key) =>
        known.has(key),
      ),
    ).toEqual([
      { key: "FI3-12" },
      { text: " waits on " },
      { key: "SCR-3" },
      { text: ", not F13-572 or FI3-12-plan; then " },
      { key: "FI3-12" },
      { text: "." },
    ]);
  });

  it("leaves words with no linked key whole", () => {
    expect(taskKeyParts("SCR-3 is its own key", () => false)).toEqual([
      { text: "SCR-3 is its own key" },
    ]);
    expect(taskKeyParts("", () => true)).toEqual([]);
  });
});
