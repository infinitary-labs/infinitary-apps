import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./moduleRunner.ts";

// INF-4241 piece 8 (the captain's "Keep a small helper of our own in the project that opens the hinge through the
// undocumented interface; it can break when Xcode changes"): the phone check opens and closes a simulated iPhone Duo's
// hinge through scripts/phone-hinge.m, a helper it builds for the iOS simulator and runs inside the Duo, then reads
// the pose back and fails the part, by name and with no second try, when the Duo did not reach it. INF-4539: the same
// helper turns the open Duo, which ignores XCUIDevice's turns, and the gate reads the turn back the same way.
// INF-5183: it presses a key on the open Duo too, where XCTest's own key reaches no app, and the gate reads where the
// simulator sent it.

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

type Display = { name?: string; active?: boolean; primary?: boolean; currentOrientation?: string; bounds?: number[][] };

/** The one lit screen in `devicectl device info displays`'s JSON; exactly one of the Duo's two screens is active. */
function litScreen(reading: string): Display {
  const displays = (JSON.parse(reading) as { result?: { displays?: Display[] } })
    .result?.displays?.filter((display) => display.name?.startsWith("LCD")) ?? [];
  const lit = displays.filter((display) => display.active);
  if (lit.length !== 1) throw new Error(`The Duo lit ${lit.length} of its ${displays.length} screens, so its pose cannot be read`);
  return lit[0]!;
}

/** Whether the inner screen is the lit one, from `devicectl device info displays`'s JSON: the Duo's outer screen is
 * its primary display. */
export function innerScreenLit(reading: string): boolean {
  return !litScreen(reading).primary;
}

/** Whether the lit screen shows the app wider than tall: its panel's own size, a quarter turn swapping the two. */
export function litScreenWide(reading: string): boolean {
  const screen = litScreen(reading);
  const [width, height] = screen.bounds?.[1] ?? [];
  if (!width || !height || !screen.currentOrientation) throw new Error("The Duo's lit screen reports no size or turn");
  const quarter = screen.currentOrientation === "rot90" || screen.currentOrientation === "rot270";
  return quarter ? height > width : width > height;
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
 * INF-4539's turn check: the two ways the open Duo is held, like a book with the fold upright, and on its side with
 * the fold across, one page above the other. A side names which way it turns, so the check reaches both.
 */
export type PhoneTurn = "book" | "side-left" | "side-right";
/** The orientation Device Hub's picker posts for each: the Duo's device orientation reads from its outer screen, a
 * quarter turn from the inner one, so the upright device holds the inner screen like a book. */
const ORIENTATIONS: Record<PhoneTurn, string> = { book: "portrait", "side-left": "landscape-left", "side-right": "landscape-right" };

/** CoreMotion's reading of the Duo `simulator`'s hinge angle, in degrees, through the helper. */
async function hingeAngle(run: Run, simulator: string, helper: string): Promise<number> {
  const said = (await run("xcrun", ["simctl", "spawn", simulator, helper, "angle"])).trim().split("\n").at(-1) ?? "";
  const degrees = Number(said);
  if (!said || !Number.isFinite(degrees)) throw new Error(`The Duo's hinge angle could not be read: ${said}`);
  return degrees;
}

/**
 * Turns the open Duo `simulator` to `to` once, through the helper `buildPhoneHinge` built, then reads its inner screen
 * back until it shows the turn or `settle` milliseconds pass: wide like a book, tall on its side. A Duo that never
 * shows it fails, naming the turn asked for and what it showed; nothing turns it a second time.
 *
 * INF-5183: before the turn, the hinge's angle is read and stated once more, which moves nothing. After a hinge move
 * the simulated Duo's SpringBoard can leave its screen transition unfinished until the next pose event it hears, and
 * a turn that is that event finishes the transition and can lose its own turn: the Duo takes the event and keeps its
 * inner screen as it was. The restated angle is that event instead, so the turn reaches a Duo with nothing pending.
 */
export async function turnPhone({ run, simulator, helper, to, reading, settle = PHONE_HINGE_SETTLE_MS }: {
  run: Run; simulator: string; helper: string; to: PhoneTurn; reading: string; settle?: number;
}): Promise<void> {
  const wide = async () => {
    await run("xcrun", ["devicectl", "device", "info", "displays", "-d", simulator, "--json-output", reading]);
    const shown = readFileSync(reading, "utf8");
    if (!innerScreenLit(shown)) throw new Error(`duo: it was asked to turn ${to} closed; only the open Duo turns`);
    return litScreenWide(shown);
  };
  const angle = String(await hingeAngle(run, simulator, helper));
  await run("xcrun", ["simctl", "spawn", simulator, helper, "sweep", angle, angle, "0"]);
  await run("xcrun", ["simctl", "spawn", simulator, helper, "turn", ORIENTATIONS[to]]);
  const until = Date.now() + settle;
  let shown = await wide();
  while (shown !== (to === "book") && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    shown = await wide();
  }
  if (shown !== (to === "book")) {
    throw new Error(`duo: it was turned ${to} once, and ${settle / 1000} seconds later its inner screen shows ${shown ? "wide" : "tall"}`);
  }
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
  const angle = () => hingeAngle(run, simulator, helper);
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

/**
 * INF-5183: the keys the fold part presses on the open Duo, by the helper's names for them. XCTest's typeKey gives its
 * key a keyboard bound to one display, and while the Duo is open the simulator's event router finds that key no
 * destination. The helper's key names no display, as an attached keyboard's does, so it goes to the app in front.
 */
export type PhoneKey = "tab" | "return" | "escape";

/**
 * Presses `key` once on the Duo `simulator`, through the helper `buildPhoneHinge` built, then reads what the simulator
 * did with it. `outcome` answers for the press's own span and is asked again until it holds proof or `settle`
 * milliseconds pass, since the simulator's kept log can trail the press; each ask names when that window ends, so no
 * read of the log outlasts it. Nothing presses the key a second time.
 */
export async function pressPhoneKey<Outcome extends { proof: readonly string[] }>({ run, simulator, helper, key, outcome, settle = PHONE_HINGE_SETTLE_MS }: {
  run: Run; simulator: string; helper: string; key: PhoneKey;
  /** What the simulator's event router did with the one key pressed between `since` and `until`, answered by `deadline`. */
  outcome: (since: number, until: number, deadline: number) => Promise<Outcome>;
  settle?: number;
}): Promise<Outcome> {
  const since = Date.now();
  await run("xcrun", ["simctl", "spawn", simulator, helper, "key", key]);
  const until = Date.now();
  const deadline = until + settle;
  let read = await outcome(since, until, deadline);
  while (!read.proof.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    read = await outcome(since, until, deadline);
  }
  return read;
}
