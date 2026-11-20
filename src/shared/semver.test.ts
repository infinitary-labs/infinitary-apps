import { describe, expect, it } from "vitest";
import {
  compareSemver,
  isAlphaVersion,
  isNewerVersion,
  isStableVersion,
  parseSemver,
} from "./semver";

describe("compareSemver", () => {
  it("orders numeric cores", () => {
    expect(compareSemver("1.2.3", "1.2.2")).toBe(1);
    expect(compareSemver("1.2.3", "1.10.0")).toBe(-1);
    expect(compareSemver("0.1.24", "0.1.24")).toBe(0);
    expect(compareSemver("10.0.0", "9.99.99")).toBe(1);
  });

  it("orders alpha runs numerically, not as text", () => {
    expect(compareSemver("0.1.25-alpha.10", "0.1.25-alpha.2")).toBe(1);
    expect(compareSemver("0.1.25-alpha.2", "0.1.25-alpha.10")).toBe(-1);
    expect(compareSemver("0.1.25-alpha.43", "0.1.25-alpha.43")).toBe(0);
  });

  it("ranks the matching stable above its alphas and the next core above both", () => {
    expect(compareSemver("0.1.25", "0.1.25-alpha.99")).toBe(1);
    expect(compareSemver("0.1.25-alpha.1", "0.1.25")).toBe(-1);
    expect(compareSemver("0.1.26-alpha.1", "0.1.25")).toBe(1);
    expect(compareSemver("0.2.0", "0.1.26-alpha.43")).toBe(1);
  });

  it("never compares an unreadable version", () => {
    for (const bad of ["", "v1.2.3", "1.2", "1.02.3", "1.2.3-alpha.01", " 1.2.3", "latest"]) {
      expect(parseSemver(bad)).toBeNull();
      expect(compareSemver(bad, "0.0.1")).toBeNull();
      expect(isNewerVersion(bad, "0.0.1")).toBe(false);
      expect(isNewerVersion("9.9.9", bad)).toBe(false);
    }
  });
});

describe("channel version shapes", () => {
  it("reads stable and alpha logical versions exactly", () => {
    expect(isStableVersion("0.1.25")).toBe(true);
    expect(isStableVersion("0.1.25-alpha.3")).toBe(false);
    expect(isStableVersion("0.1.25+build")).toBe(false);
    expect(isAlphaVersion("0.1.25-alpha.3")).toBe(true);
    for (const notAlpha of ["0.1.25", "0.1.25-alpha", "0.1.25-alpha.x", "0.1.25-beta.3"]) {
      expect(isAlphaVersion(notAlpha)).toBe(false);
    }
    expect(isAlphaVersion("0.1.25-alpha.3.1")).toBe(false);
    expect(isAlphaVersion("0.1.25-alpha.3+sha")).toBe(false);
  });
});
