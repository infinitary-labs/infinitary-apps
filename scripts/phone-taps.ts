/**
 * The tap check (INF-2485; docs/ios.md, "Every tap a native journey sends ...
 * goes through `tapOnPhone`"). XCTest no longer waits out the app's
 * animations before an action (INF-1541, PhoneAnimationWait.swift), so a tap
 * checks its own target: `tapOnPhone` waits until the target, and the screen
 * inside it, hold still, then reads whether the simulator delivered the
 * touch. A plain XCTest tap skips both, and UIKit drops a touch that lands
 * while a sheet or an alert is still arriving: the choice card's Discard and
 * close, tapped that way, left the close question open. This check refuses
 * `.tap()` in the phone UI tests anywhere but inside `tapOnPhone` itself.
 * Plain Node type stripping, no install; `pnpm check` runs it.
 *
 *   node scripts/phone-taps.ts    exits 1 naming each plain tap
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blankSwift, swiftFunctions, UI_TESTS } from "./affected-phone.ts";

/** The one function that sends XCTest's tap, and its file. */
export const TAP_OWNER = { path: `${UI_TESTS}PhoneKeys.swift`, function: "tapOnPhone" } as const;

export type PlainTap = { path: string; line: number };

/** Every XCTest tap a UI test file's code sends outside `tapOnPhone`, by line. */
export function plainTaps(path: string, text: string): PlainTap[] {
  const code = blankSwift(text);
  const owners =
    path === TAP_OWNER.path
      ? (swiftFunctions(text) ?? []).filter((each) => each.name === TAP_OWNER.function)
      : [];
  const taps: PlainTap[] = [];
  for (const call of code.matchAll(/\.\s*tap\s*\(\s*\)/g)) {
    const line = code.slice(0, call.index).split("\n").length;
    if (owners.some((each) => each.start <= line && each.end >= line)) continue;
    taps.push({ path, line });
  }
  return taps;
}

export function tapProblem(tap: PlainTap): string {
  return `${tap.path}:${tap.line}: a plain XCTest tap skips tapOnPhone, which waits for its target and the screen inside it to hold still and reads whether the simulator delivered the touch; UIKit drops a touch while a sheet or an alert is still arriving. Send it through tapOnPhone (docs/ios.md)`;
}

function main(): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Tracked files and new ones git does not ignore, as CI will read them.
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", UI_TESTS],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
    .split("\0")
    .filter((path) => path.endsWith(".swift"));
  const taps = paths.flatMap((path) => {
    try {
      return plainTaps(path, readFileSync(resolve(root, path), "utf8"));
    } catch {
      // A tracked file deleted in the working copy.
      return [];
    }
  });
  for (const tap of taps) console.error(tapProblem(tap));
  if (taps.length) {
    console.error(`phone taps: ${taps.length} plain tap(s) outside tapOnPhone`);
    return 1;
  }
  console.log(`phone taps: every tap in ${paths.length} UI test file(s) goes through tapOnPhone`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main();
