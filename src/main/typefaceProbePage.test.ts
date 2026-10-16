import { describe, expect, it } from "vitest";
import { sanitizerReasons, TYPEFACE_LOAD_MS, typefaceScript } from "./typefaceProbePage";

// INF-145's re-review: each font in the probe page keeps its own clock, so a
// refusal names the font that stalled, not every font the card names.

type Load = "loads" | "refused" | "stalls";

/** Runs the probe page's script against stand-ins for the page's font loader and its clock. */
async function runScript(loads: Record<string, Load>) {
  const timers = new Map<number, () => void>();
  let next = 0;
  class FontFace {
    constructor(
      readonly family: string,
      readonly source: string,
    ) {}
    load(): Promise<void> {
      const file = /^url\((.*)\)$/.exec(this.source)?.[1] ?? "";
      if (loads[file] === "loads") return Promise.resolve();
      if (loads[file] === "refused") return Promise.reject(new Error("NetworkError"));
      return new Promise(() => {});
    }
  }
  const setTimeout = (callback: () => void) => {
    next += 1;
    timers.set(next, callback);
    return next;
  };
  const clearTimeout = (id: number) => timers.delete(id);
  const run = new Function(
    "FontFace",
    "setTimeout",
    "clearTimeout",
    `return ${typefaceScript(Object.keys(loads))};`,
  )(FontFace, setTimeout, clearTimeout) as Promise<unknown>;
  // Every load that settled has had its turn; then the clocks still running run out.
  await new Promise((resolve) => setImmediate(resolve));
  for (const callback of timers.values()) callback();
  return run;
}

describe("the probe page's script", () => {
  it("answers each font on its own: loaded, refused, or stalled past its own limit", async () => {
    expect(
      await runScript({
        "app-frame://probe/t/file/0": "loads",
        "app-frame://probe/t/file/1": "refused",
        "app-frame://probe/t/file/2": "stalls",
      }),
    ).toEqual({
      ok: true,
      loaded: [
        { ok: true },
        { ok: false, reason: "it did not load" },
        { ok: false, reason: `it did not load within ${TYPEFACE_LOAD_MS / 1000} seconds` },
      ],
    });
  });
});

describe("sanitizerReasons", () => {
  it("gives each refused font the sanitizer's words that follow it in the console", () => {
    const urls = ["app-frame://probe/t/file/0", "app-frame://probe/t/file/1"];
    // As Chromium writes them (INF-128's probe of a truncated WOFF2).
    const said = [
      `Failed to decode downloaded font: ${urls[1]}`,
      "OTS parsing error: Failed to convert WOFF 2.0 font to SFNT",
    ];
    expect([...sanitizerReasons(said, urls)]).toEqual([
      [1, "its sanitizer said: Failed to convert WOFF 2.0 font to SFNT"],
    ]);
  });
});
