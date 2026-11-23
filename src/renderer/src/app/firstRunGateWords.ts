/**
 * The first-launch gate's words (docs/first-launch.md), in a plain module a
 * spec can load, so it reads them from here rather than typing them. Each
 * is worded from the catalog when it is shown.
 */
import * as m from "@shared/i18n/messages.generated";

export const GATE_TITLE = (): string => m.shellGateTitle();

/**
 * The home computer's first screen (captain, INF-417): the exact heading,
 * including the capital C. A connected subscription that still cannot answer
 * keeps the older heading, and a computer that controls another's first mate
 * keeps `GATE_TITLE`. Worded as the module loads, in English before any
 * language is set, for a spec to read; the gate reads `gateHomeTitle`.
 */
export const GATE_HOME_TITLE = m.shellGateHomeTitle();

export function gateHomeTitle(): string {
  return m.shellGateHomeTitle();
}

/** The heading when a subscription is connected and still cannot answer. */
export function gateRecoveryTitle(): string {
  return m.shellGateRecoveryTitle();
}

/**
 * The line under the first-screen heading, in the first mate's voice
 * (captain, INF-417); the always-on ask moved to the question under it.
 */
export function gateIntro(): string {
  return m.shellGateIntro();
}

/**
 * Where the first mate lives, asked before anything opens (captain's
 * approval of INF-6207: ask first, three equal choices).
 */
export function gateWhere(): string {
  return m.shellGateWhere();
}

/** The three choices, in the order the screen shows them. */
export type GateChoice = "here" | "another" | "running";
export const GATE_CHOICES: readonly GateChoice[] = ["here", "another", "running"];

/** Each choice's name and the line under it saying what happens before it is pressed. */
export function gateChoiceWords(choice: GateChoice): { name: string; line: string } {
  if (choice === "here") return { name: m.shellGateChoiceHere(), line: m.shellGateChoiceHereSub() };
  if (choice === "another")
    return { name: m.shellGateChoiceAnother(), line: m.shellGateChoiceAnotherSub() };
  return { name: m.shellGateChoiceRunning(), line: m.shellGateChoiceRunningSub() };
}

/** Under the choices: the move after setup stays the fallback (docs/devices.md). */
export function gateMoveLater(): string {
  return m.shellGateMoveLater();
}

/** The link back to the three choices from an opened one. */
export function gateBack(): string {
  return m.shellGateBack();
}

/** Where a Mac keeps the command that a Linux package puts on the search path as `infinitary`. */
export const MAC_COMMAND = "/Applications/Infinitary.app/Contents/MacOS/Infinitary";

/**
 * Another computer by commands (docs/run.md): install, start at boot, make a
 * link, and paste it in One already running's paste box.
 */
export const GATE_COMMANDS = {
  // i18n-exempt: a command typed in a terminal, never translated
  start: "infinitary start-at-boot",
  // i18n-exempt: a command typed in a terminal, never translated
  link: "infinitary link",
} as const;

/** The remaining-need line when a connected subscription still cannot answer. */
export const GATE_STILL_NEEDS = (): string => m.shellGateStillNeeds();

/** The always-on line that stays with that remaining-need message. */
export function gateStaysOn(): string {
  return m.shellGateStaysOn();
}

/**
 * While the gate asks for the fresh check of the custom connection the
 * Firstmate was chosen on (`FreshCheck`), it names that connection instead.
 */
export function freshCheckTitle(label: string): string {
  return m.shellGateFreshCheckTitle({ label });
}

/** What the fresh check covers and what it may cost, before anything is sent. */
export function freshCheckLine(check: { label: string; models: readonly string[] }): string {
  return m.shellGateFreshCheckLine({ count: check.models.length, label: check.label });
}

/** The line under the heading on a computer that controls another (docs/view.md). */
export function gateRunLine(mac: string): string {
  return m.shellGateRunLine({ computer: mac });
}

export const FRESH_CHECK_ACTION = (): string => m.shellGateFreshCheckAction();
export const FRESH_CHECK_PENDING = (): string => m.shellGateFreshCheckPending();

/** A model the fresh check stopped at, with the server's reason in safe words. */
export function freshCheckFailure(model: string, reason: string): string {
  return `${model}: ${reason}`;
}
