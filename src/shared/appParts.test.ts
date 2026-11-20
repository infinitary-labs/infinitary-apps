import { describe, expect, it } from "vitest";
import { appPartProblem, withAppParts } from "./appParts";
import sources from "./appParts.generated.json" with { type: "json" };

// The captain, on map cards carrying the map's code: "does our cards not
// support importing repetitive boilerplates, avoiding counting them in the
// card size?" A body names the app's own part; every reader puts the part's
// code in its place, and the card checks refuse a name no reader would fill.

const REFERENCE = '<script data-inf-part="map"></script>';
const BODY = `<p>The core's parts.</p><div class="mz" id="map"><script type="application/json" data-map>{"maps":{}}</script></div>${REFERENCE}`;

describe("a card body naming the app's map part", () => {
  it("is read with the app's own style and script in place of the reference, the rest as written", () => {
    const html = withAppParts(BODY);
    expect(html).toBe(
      // A replacer function: the minified code may hold "$&", which a
      // replacement string would read as the matched text.
      BODY.replace(
        REFERENCE,
        () => `<style>${sources.map.style}</style><script>${sources.map.script}</script>`,
      ),
    );
    expect(appPartProblem(BODY)).toBeUndefined();
  });

  it("leaves a name the app does not ship as an empty script, and the card checks refuse it", () => {
    const body = BODY.replace(REFERENCE, '<script data-inf-part="chart"></script>');
    expect(withAppParts(body)).toBe(body);
    expect(appPartProblem(body)).toContain("names no part the app ships; its parts are map");
  });

  it.each([
    ["with a source", '<script data-inf-part="map" src="map.js"></script>'],
    ["in single quotes", "<script data-inf-part='map'></script>"],
    ["holding code of its own", '<script data-inf-part="map">alert(1)</script>'],
  ])("is refused when the reference is written %s, which no reader fills", (_, reference) => {
    const body = BODY.replace(REFERENCE, reference);
    expect(withAppParts(body)).toBe(body);
    expect(appPartProblem(body)).toContain("is not a part reference the app fills");
  });
});
