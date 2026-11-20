import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { plainTaps, TAP_OWNER, tapProblem } from "../scripts/phone-taps";

/**
 * The tap check (INF-2485: the choice card's Discard and close, sent as a plain
 * XCTest tap, reached the app while UIKit still ignored touches for the arriving
 * alert, and the close question stayed open; docs/ios.md's rule, from INF-1477 and
 * INF-1541's "checks each target itself", is that every journey tap goes through
 * tapOnPhone). `pnpm check` runs it over the tree; here, what it refuses. The owner
 * is the code's own file; the refused line is the one that dropped its tap.
 */
describe("the tap check", () => {
  const JOURNEY = "ios/Infinitary/InfinitaryUITests/PhoneJourney.swift";
  const owner = readFileSync(TAP_OWNER.path, "utf8");

  it("passes the taps tapOnPhone itself sends", () => {
    const sent = owner.split("\n").filter((line) => line.includes(".tap()"));
    expect(sent).toHaveLength(2);
    expect(plainTaps(TAP_OWNER.path, owner)).toEqual([]);
  });

  it("refuses the plain tap that left the close question open, at its line", () => {
    const text = [
      "    private func verifyCardMediaAndBody() async throws {",
      '        tapOnPhone(app.buttons["close-card"])',
      '        let question = app.alerts[try XCTUnwrap(fixture["closeTitle"] as? String)]',
      "        XCTAssertTrue(question.waitForPresence(timeout: 10), app.debugDescription)",
      '        question.buttons[try XCTUnwrap(fixture["discardAndClose"] as? String)].tap()',
      "    }",
    ].join("\n");
    const taps = plainTaps(JOURNEY, text);
    expect(taps).toEqual([{ path: JOURNEY, line: 5 }]);
    expect(taps.map(tapProblem)[0]).toMatch(
      /^ios\/Infinitary\/InfinitaryUITests\/PhoneJourney\.swift:5: .* tapOnPhone/,
    );
  });

  it("owns the tap in tapOnPhone, not in its file: a plain tap elsewhere in PhoneKeys.swift is refused", () => {
    const helper = [
      "@MainActor func closeKeyboard(_ app: XCUIApplication) {",
      '    app.buttons["Done"].tap()',
      "}",
    ];
    const text = `${owner}\n${helper.join("\n")}\n`;
    expect(plainTaps(TAP_OWNER.path, text)).toEqual([
      { path: TAP_OWNER.path, line: owner.split("\n").length + 2 },
    ]);
  });

  it("reads only code: a tap a comment or a string names is no tap", () => {
    const text = [
      "// A plain button.tap() skips the steady wait.",
      "/* Never sheet.tap(): /* nested */ the sheet is still arriving. */",
      'let advice = "use tapOnPhone, not .tap()"',
      'let raw = #"element.tap()"#',
      '    tapOnPhone(app.buttons["Done"])',
    ].join("\n");
    expect(plainTaps(JOURNEY, text)).toEqual([]);
  });
});
