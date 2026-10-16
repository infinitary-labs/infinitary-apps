import { describe, expect, it } from "vitest";
import { probeViolations, verifyWebPreferences } from "./baseline";

describe("verifyWebPreferences", () => {
  it("passes the required baseline", () => {
    expect(
      verifyWebPreferences({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      }),
    ).toEqual([]);
  });

  it("flags every weakened setting", () => {
    const violations = verifyWebPreferences({
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      webSecurity: false,
      webviewTag: true,
    });
    expect(violations).toHaveLength(5);
  });

  it("treats a missing sandbox flag as a violation", () => {
    const violations = verifyWebPreferences({
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    });
    expect(violations).toEqual(["webPreferences.sandbox must be true, found undefined"]);
  });
});

describe("probeViolations", () => {
  it("passes a healthy probe", () => {
    expect(probeViolations({ nodeGlobalsAbsent: true, bridgePresent: true })).toEqual([]);
  });

  it("names each broken invariant", () => {
    const violations = probeViolations({
      nodeGlobalsAbsent: false,
      bridgePresent: false,
    });
    expect(violations).toHaveLength(2);
  });
});
