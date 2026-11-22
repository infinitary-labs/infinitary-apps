import type { OwnStyle } from "@shared/ambientOwn";
import { englishOf, said } from "@shared/i18n/said";
import type { Appearance } from "@shared/preferences";
import { describe, expect, it } from "vitest";
import type { CoreDispatch } from "../dispatcher";
import { panelChange } from "./panelChange";

// Intent: docs/ui-plugins.md, "Changing settings": a panel's change never
// deletes anything of the captain's. Your own ambient styles are a line that
// saves and removes, so a panel granted it saves a style and never removes one.

/** "Like Cold sleep, but warmer": the shortest style INF-5541's plan wrote. */
const warm: OwnStyle = {
  name: "Warm sleep",
  words: "Like Cold sleep, but warmer and a little faster, in a major key, with no heartbeat",
  like: "cold-sleep",
  bpm: 60,
  key: "G",
  scale: "lydian",
  mix: { kick: -60 },
};
const saved: Appearance = {
  theme: "dark",
  ambientMusic: true,
  ambientStyle: "own-warm-sleep",
  ambientOwnStyles: [{ ...warm, id: "own-warm-sleep" }],
};

/** The core's dispatch as a panel's change reaches it: the look read, every write kept. */
function core() {
  const writes: unknown[][] = [];
  const dispatch = (async (channel: string, args: unknown) => {
    if (channel === "inf:settings:appearance:get") return saved;
    writes.push([channel, args]);
    return undefined;
  }) as CoreDispatch;
  return { dispatch, writes };
}

describe("a panel's change of your own ambient styles", () => {
  it("saves a style and never removes one", async () => {
    const { dispatch, writes } = core();
    const grant = () => "Look";
    expect(
      await panelChange(dispatch, grant, "look", "ambient-own-style", { remove: "Warm sleep" }),
    ).toEqual({ ok: false, text: englishOf(said("panelChangeNoDelete")) });
    expect(writes).toEqual([]);

    const slower = { ...warm, bpm: 52 };
    expect(
      await panelChange(dispatch, grant, "look", "ambient-own-style", { save: slower }),
    ).toEqual({ ok: true });
    expect(writes).toEqual([
      [
        "inf:settings:appearance:set",
        [{ ...saved, ambientOwnStyles: [{ ...slower, id: "own-warm-sleep" }] }],
      ],
    ]);
  });
});
