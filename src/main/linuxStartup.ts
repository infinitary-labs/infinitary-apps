import { findOnPath } from "@core/userBin";

/**
 * What an installed Linux app checks before it opens its window
 * (docs/linux-packages.md, "What the app checks at start"). Each Linux
 * package requires the system's git and keeps Chromium's sandbox on; an
 * AppImage can promise neither, so the app asks instead: quit, the default,
 * or open anyway.
 */

export type StartupAsk = {
  readonly id: "git" | "sandbox";
  readonly message: string;
  readonly detail: string;
};

export const STARTUP_ASK_BUTTONS = { quit: "Quit", open: "Open anyway" } as const;

export const GIT_ASK: StartupAsk = {
  id: "git",
  message: "Infinitary needs git. Install it, then open Infinitary again.",
  detail:
    "Infinitary keeps each task's work apart with git, and this computer does not have it. Your system's software app can install git.",
};

export const SANDBOX_ASK: StartupAsk = {
  id: "sandbox",
  message: "Infinitary cannot turn its sandbox on here.",
  detail:
    "The sandbox keeps web pages and cards apart from the rest of your computer. The Infinitary package for your system keeps it on: install that one instead.",
};

export type StartupFacts = {
  readonly platform: string;
  readonly packaged: boolean;
  /** The search path the app's children will run with. */
  readonly searchPath: string;
  readonly sandboxOff: boolean;
};

/** The questions this start must ask, in order; none on a Mac or an unpackaged run. */
export function startupAsks(facts: StartupFacts): StartupAsk[] {
  if (facts.platform !== "linux" || !facts.packaged) return [];
  const asks: StartupAsk[] = [];
  if (!findOnPath("git", { PATH: facts.searchPath })) asks.push(GIT_ASK);
  if (facts.sandboxOff) asks.push(SANDBOX_ASK);
  return asks;
}

/**
 * Asks each question in turn; true when the person chose to open anyway
 * every time (or nothing needed asking), false when they chose to quit.
 */
export async function answerStartupAsks(
  asks: readonly StartupAsk[],
  ask: (question: StartupAsk) => Promise<"quit" | "open">,
): Promise<boolean> {
  for (const question of asks) {
    if ((await ask(question)) === "quit") return false;
  }
  return true;
}
