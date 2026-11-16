import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./moduleRunner.ts";

// INF-4241 piece 8 (the captain's "Keep a small helper of our own in the project that opens the hinge through the
// undocumented interface; it can break when Xcode changes"): the phone check opens and closes a simulated iPhone Duo's
// hinge through scripts/phone-hinge.m, a helper it builds for the iOS simulator and runs inside the Duo, then reads
// the pose back and fails the part, by name and with no second try, when the Duo did not reach it.

/** The two flat hinges the Duo pass checks: closed, the one column on the outer screen, and open like a book. */
export type PhoneHinge = "closed" | "open";
const DEGREES: Record<PhoneHinge, number> = { closed: 0, open: 180 };

/** How far the angle CoreMotion reads back may stand from the hinge asked for; the helper's sweep ends on the angle. */
const ANGLE_TOLERANCE = 2;

/**
 * How long the gate waits, once the sweep ended, for the Duo to show the hinge on its screens. A sweep on a Mac mini's
 * Duo switched screens within the second it waited (INF-4241 piece 8), as duoctl's own eight-second wait expects.
 * The wait is a reading of a move already made, never a second move.
 */
export const PHONE_HINGE_SETTLE_MS = 10_000;

/** What the Duo shows: CoreMotion's hinge angle and whether the inner screen, the one that opens like a book, is lit. */
export type PhonePose = { angle: number; inner: boolean };

type Run = (command: string, args: string[]) => Promise<string>;

/** Builds the helper once for the iOS simulator into `folder`, signed ad hoc as any simulator program is, and answers
 * its path. Nothing here reads a keychain or a signing identity. */
export async function buildPhoneHinge(run: Run, folder: string): Promise<string> {
  const helper = join(folder, "phone-hinge");
  await run("xcrun", ["-sdk", "iphonesimulator", "clang", "-fobjc-arc", "-O2", "-arch", "arm64",
    "-mios-simulator-version-min=17.0", "-framework", "Foundation", "-framework", "IOKit", "-framework", "CoreMotion",
    join(REPO_ROOT, "scripts/phone-hinge.m"), "-o", helper]);
  await run("codesign", ["--force", "--sign", "-", helper]);
  return helper;
}

/** Whether the inner screen is the lit one, from `devicectl device info displays`'s JSON: the Duo's outer screen is
 * its primary display, and exactly one of its two screens is active. */
export function innerScreenLit(reading: string): boolean {
  const displays = (JSON.parse(reading) as { result?: { displays?: { name?: string; active?: boolean; primary?: boolean }[] } })
    .result?.displays?.filter((display) => display.name?.startsWith("LCD")) ?? [];
  const lit = displays.filter((display) => display.active);
  if (lit.length !== 1) throw new Error(`The Duo lit ${lit.length} of its ${displays.length} screens, so its pose cannot be read`);
  return !lit[0]!.primary;
}

/** What is wrong with a pose read back for `hinge`, or undefined when the Duo shows it. */
export function phonePoseFault(hinge: PhoneHinge, pose: PhonePose): string | undefined {
  const faults = [
    ...(Math.abs(pose.angle - DEGREES[hinge]) > ANGLE_TOLERANCE ? [`its hinge reads ${pose.angle} degrees, not ${DEGREES[hinge]}`] : []),
    ...(pose.inner !== (hinge === "open") ? [`its ${pose.inner ? "inner" : "outer"} screen is lit`] : []),
  ];
  return faults.length ? faults.join(" and ") : undefined;
}

/**
 * Moves the Duo `simulator`'s hinge to `hinge` once, through the helper `buildPhoneHinge` built, then reads the pose
 * back until it shows the hinge or `settle` milliseconds pass. A pose that never shows it fails, naming the hinge asked
 * for and what the Duo showed instead; the gate fails the part, and nothing moves the hinge a second time.
 */
export async function setPhoneHinge({ run, simulator, helper, hinge, reading, settle = PHONE_HINGE_SETTLE_MS }: {
  run: Run; simulator: string; helper: string; hinge: PhoneHinge;
  /** A file the display reading is written to, since devicectl's own lines share its output. */
  reading: string;
  settle?: number;
}): Promise<PhonePose> {
  const angle = async () => {
    const said = (await run("xcrun", ["simctl", "spawn", simulator, helper, "angle"])).trim().split("\n").at(-1) ?? "";
    const degrees = Number(said);
    if (!said || !Number.isFinite(degrees)) throw new Error(`The Duo's hinge angle could not be read: ${said}`);
    return degrees;
  };
  const pose = async (): Promise<PhonePose> => {
    await run("xcrun", ["devicectl", "device", "info", "displays", "-d", simulator, "--json-output", reading]);
    return { angle: await angle(), inner: innerScreenLit(readFileSync(reading, "utf8")) };
  };
  const from = await angle();
  if (from !== DEGREES[hinge]) await run("xcrun", ["simctl", "spawn", simulator, helper, "sweep", String(from), String(DEGREES[hinge]), "0.5"]);
  const until = Date.now() + settle;
  let shown = await pose();
  while (phonePoseFault(hinge, shown) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    shown = await pose();
  }
  const fault = phonePoseFault(hinge, shown);
  if (fault) throw new Error(`duo: the hinge was moved to ${hinge} once, and ${settle / 1000} seconds later ${fault}`);
  return shown;
}
