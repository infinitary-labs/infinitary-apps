import { describe, expect, it } from "vitest";
import { ACTIONS } from "./actions";
import type { OwnStyle } from "./ambientOwn";
import { type Appearance, DEFAULT_AMBIENT_STYLE } from "./preferences";

// INF-5541's approved plan: the first mate saves the music a person
// describes as their own style and it plays at once; saving under the same
// name changes that style; a faulty style is refused in words with nothing
// saved; and removing the style playing brings back the default.

const own = ACTIONS["ambient-own-style"];
const music = ACTIONS["ambient-music"];
const apply = (line: typeof own, value: Record<string, unknown>, look: Appearance) =>
  line.toRequest(value, look, (path) => path)[0] as Appearance;

/** "Like Cold sleep, but warmer": the shortest style the plan's first mate wrote. */
const warm: OwnStyle = {
  name: "Warm sleep",
  words: "Like Cold sleep, but warmer and a little faster, in a major key, with no heartbeat",
  like: "cold-sleep",
  bpm: 60,
  key: "G",
  scale: "lydian",
  mix: { kick: -60 },
};
const start: Appearance = { theme: "dark", ambientMusic: false, ambientStyle: "harbor-dawn" };

describe("the first mate's own ambient styles", () => {
  it("saves a described style and plays it at once, and the music line can choose it", () => {
    const look = apply(own, { save: warm }, start);
    expect(look.ambientOwnStyles).toEqual([{ ...warm, id: "own-warm-sleep" }]);
    expect(look).toMatchObject({ ambientStyle: "own-warm-sleep", ambientMusic: true });
    expect(own.readValue(look)).toMatchObject({ playing: "own-warm-sleep" });
    const back = apply(music, { on: true, style: "harbor-dawn" }, look);
    expect(apply(music, { on: true, style: "own-warm-sleep" }, back).ambientStyle).toBe(
      "own-warm-sleep",
    );
    expect(() => apply(music, { on: true, style: "own-nothing" }, back)).toThrow(
      /No style own-nothing\. Styles: .*own-warm-sleep/,
    );
  });

  it("changes the same style when saved under its name", () => {
    const first = apply(own, { save: warm }, start);
    const slower = apply(own, { save: { ...warm, bpm: 52 } }, first);
    expect(slower.ambientOwnStyles).toEqual([{ ...warm, bpm: 52, id: "own-warm-sleep" }]);
  });

  it("refuses a faulty style with its fault in words, and saves nothing", () => {
    expect(() => apply(own, { save: { ...warm, like: undefined } }, start)).toThrow(
      /^The style was not saved, and nothing changed\. beats is missing/,
    );
  });

  it("removes a style by its name, and the default plays when it was playing", () => {
    const saved = apply(own, { save: warm }, start);
    const removed = apply(own, { remove: "warm sleep" }, saved);
    expect(removed.ambientOwnStyles).toEqual([]);
    expect(removed.ambientStyle).toBe(DEFAULT_AMBIENT_STYLE);
    expect(() => apply(own, { remove: "Warm sleep" }, removed)).toThrow(
      "No own style Warm sleep. Saved: none.",
    );
  });
});
