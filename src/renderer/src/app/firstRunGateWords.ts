/**
 * The first-launch gate's words (docs/first-launch.md), in a plain module a
 * spec can load, so it reads them from here rather than typing them.
 */
import { COMPUTER, HERE } from "@shared/deviceNames";

export const GATE_TITLE = "Connect a subscription to begin";

/**
 * The home computer's first screen (captain, INF-417): the exact heading,
 * including the capital C. A connected subscription that still cannot answer
 * keeps the older heading, and a computer that controls another's first mate
 * keeps `GATE_TITLE`.
 */
export const GATE_HOME_TITLE = "Welcome aboard Infinitary, Captain";

/** The heading when a subscription is connected and still cannot answer. */
export function gateRecoveryTitle(): string {
  return `Set up your first mate on ${HERE.this}`;
}

/**
 * The line under the first-screen heading, in the first mate's voice
 * (captain, INF-417: reword the suggested introduction, keep the always-on ask).
 */
export function gateIntro(): string {
  return [
    "I'm your first mate.",
    "I'll help you manage the rest of the crew.",
    `Set me up on a ${COMPUTER.one} that stays on as much as possible.`,
    `Your other devices need me awake.`,
  ].join(" ");
}

/** The remaining-need line when a connected subscription still cannot answer. */
export const GATE_STILL_NEEDS =
  "Your first mate still needs a subscription that answers - Codex, Grok, Claude, Kimi Code, Copilot, or OpenRouter with an API key.";

/** The always-on line that stays with that remaining-need message. */
export function gateStaysOn(): string {
  return `Pick a ${COMPUTER.one} that stays on. Other ${COMPUTER.many} need it awake.`;
}

/**
 * While the gate asks for the fresh check of the custom connection the
 * Firstmate was chosen on (`FreshCheck`), it names that connection instead.
 */
export function freshCheckTitle(label: string): string {
  return `Check ${label} again to begin`;
}

/** What the fresh check covers and what it may cost, before anything is sent. */
export function freshCheckLine(check: { label: string; models: readonly string[] }): string {
  const need =
    check.models.length === 1 ? "its model needs" : `its ${check.models.length} models need`;
  return `Your first mate answers from ${check.label}, and ${need} one fresh check. Checking may use billable tokens and sends only test text, never your work.`;
}

/** On a Mac that controls another's Firstmate, the check happens there. */
export function freshCheckThere(mac: string): string {
  return `Check it on ${mac}, where your first mate lives.`;
}

export const FRESH_CHECK_ACTION = "Check again";
export const FRESH_CHECK_PENDING = "Checking...";

/** A model the fresh check stopped at, with the server's reason in safe words. */
export function freshCheckFailure(model: string, reason: string): string {
  return `${model}: ${reason}`;
}
