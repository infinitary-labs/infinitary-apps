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
 * (captain, INF-417: reword the suggested introduction, keep the always-on ask).
 */
export function gateIntro(): string {
  return m.shellGateIntro();
}

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
