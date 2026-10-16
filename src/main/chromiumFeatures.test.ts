import { expect, it } from "vitest";
import { type ChromiumCommandLine, disableChromiumFeatures } from "./chromiumFeatures";

/** Chromium's command line: one value per switch, the last one written. */
function commandLine(initial: Record<string, string> = {}): ChromiumCommandLine {
  const switches = new Map(Object.entries(initial));
  return {
    getSwitchValue: (name) => switches.get(name) ?? "",
    appendSwitch(name, value = "") {
      switches.set(name, value);
    },
  };
}

it("turns off the bounce-tracking store when nothing else is disabled", () => {
  const line = commandLine();
  disableChromiumFeatures(line);
  expect(line.getSwitchValue("disable-features")).toBe("DIPS");
});

it("keeps a list set before the app's code ran, such as Playwright's", () => {
  const line = commandLine({ "disable-features": "PaintHolding,Translate" });
  disableChromiumFeatures(line);
  expect(line.getSwitchValue("disable-features").split(",")).toEqual([
    "PaintHolding",
    "Translate",
    "DIPS",
  ]);
});
