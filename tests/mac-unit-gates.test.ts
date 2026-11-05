import { globSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAC_UNIT_FILES } from "../scripts/mac-unit-tests.ts";
import { macOnlyFiles, macOnlyGates } from "./lint/macUnitGates";

/**
 * Every Vitest case only a Mac runs sits in a file the Mac lane runs
 * (docs/principles.md, 2026-10-28: "A test runs on the Mac only when it needs
 * a Mac"; docs/testing.md, "Tests that need a Mac"). Linux skips such a case,
 * and the full check's Mac lane runs only the files `scripts/mac-unit-tests.ts`
 * lists, so a case behind a macOS-only gate in any other file runs nowhere in
 * CI. INF-2625's plan asks for this check before the devices piece moves
 * `remoteLogin.test.ts`'s macOS-only download cases into a file of their own.
 */

/**
 * Files with a macOS-only case that the Mac lane does not run yet, each with
 * the task that brings it there. The list only shrinks: an entry whose file
 * joins the Mac list, or loses its last macOS-only case, fails until it goes.
 */
const NOT_RUN_ON_THE_MAC_YET: Readonly<Record<string, string>> = {
  // INF-2728: its local phone gate case.
  "tests/heavy-run-place.test.ts": "INF-2728",
};

/** Every file Vitest's Node projects and browser project collect, as `vitest.config.ts` includes them. */
function testFiles(): string[] {
  return globSync(["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"], {
    exclude: (path) => path.includes("node_modules"),
  }).sort();
}

describe("Mac-only cases", () => {
  it("sit in files the Mac lane runs, apart from the shrinking list", () => {
    const listed = new Set<string>(MAC_UNIT_FILES);
    const unlisted = [...macOnlyFiles(testFiles()).keys()].filter((file) => !listed.has(file));
    expect(unlisted).toEqual(Object.keys(NOT_RUN_ON_THE_MAC_YET).sort());
  });

  it("read each gate as Linux and macOS see it", () => {
    const gates = (source: string) => macOnlyGates(source).map((gate) => gate.text.split("(")[0]);
    // The forms the project's own test files use, each read as it is written there.
    expect(
      gates(`describe.runIf(process.platform === "darwin")("a Mac's copy", () => {});`),
    ).toEqual(["describe.runIf"]);
    expect(gates(`it.skipIf(process.platform !== "darwin")("a Mac fact", () => {});`)).toEqual([
      "it.skipIf",
    ]);
    expect(
      gates(
        `const SSH_SERVER_AVAILABLE = sshServerAvailable();\n` +
          `describe.runIf(SSH_SERVER_AVAILABLE)("adding by its address", () => {});\n` +
          `describe.runIf(SSH_SERVER_AVAILABLE && process.platform === "darwin")("downloads", () => {});`,
      ),
    ).toEqual(["describe.runIf"]);
    expect(
      gates(
        `const onMacOS = process.platform === "darwin";\n` +
          `describe.skipIf(onMacOS)("off macOS", () => {});\n` +
          `describe.skipIf(!onMacOS)("signing opens the keychain", () => {});`,
      ),
    ).toEqual(["describe.skipIf"]);
    // A gate that only Windows or an opt-in decides runs on Linux too.
    expect(gates(`describe.skipIf(process.platform === "win32")("locks", () => {});`)).toEqual([]);
    expect(
      gates(
        `const enabled = process.env.KEYCHAIN === "1";\nit.runIf(enabled)("scratch", () => {});`,
      ),
    ).toEqual([]);
    // A Linux-only case is not a Mac case.
    expect(gates(`it.runIf(process.platform === "linux")("avahi", () => {});`)).toEqual([]);
  });
});
