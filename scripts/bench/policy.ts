/**
 * The attempt driver's policy, apart from the machinery so it reads (and is
 * tested) on its own: which rigor tier each care level asks for, which
 * state directories an attempt may never boot against, and what the
 * scripted captain does with a card.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Card } from "@shared/cards";
import type { Rigor } from "@shared/rigor";
import { userDataFoldersNewestFirst } from "../../src/shared/userDataFolders.ts";

/** The benchmark's care levels, named as the chart names them. */
export const CARE_LEVELS = ["quick", "default", "careful"] as const;
export type Care = (typeof CARE_LEVELS)[number];

/** Each care level is one of the app's own rigor tiers, written to the repository row. */
export const RIGOR_FOR_CARE: Readonly<Record<Care, Rigor>> = {
  quick: "quick",
  default: "standard",
  careful: "reviewed",
};

/** The directories no attempt may ever boot against: the captain's own app data. */
export function protectedStateDirs(home = homedir()): string[] {
  const appData =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : process.platform === "win32"
        ? (process.env.APPDATA ?? join(home, "AppData", "Roaming"))
        : (process.env.XDG_CONFIG_HOME ?? join(home, ".config"));
  // Every name the app's folders had, newest first, the release's before the
  // dev run's: Infinitary's, and Firstmate 3000's, which stays on disk after
  // the one-time move.
  const devs = userDataFoldersNewestFirst("dev");
  return userDataFoldersNewestFirst("release")
    .flatMap((release, at) => [release, devs[at] as string])
    .map((folder) => join(appData, folder));
}

/**
 * The state directory must be new, empty, and nowhere near the captain's
 * app data: an attempt shares nothing - no seat session, no task, no pin -
 * with any other run, and never with the app he uses.
 */
export function assertIsolatedStateDir(stateDir: string, home = homedir()): void {
  const target = resolve(stateDir);
  const within = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  for (const guarded of protectedStateDirs(home)) {
    if (within(guarded, target) || within(target, guarded)) {
      throw new Error(
        `Refusing to boot against ${target}: it overlaps the app's data (${guarded}).`,
      );
    }
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(
      `Refusing to boot against ${target}: an attempt's state directory starts empty.`,
    );
  }
}

export type CaptainMove =
  | { kind: "ready" }
  | { kind: "host" }
  | { kind: "answer"; actionId: string; label: string }
  | { kind: "none" };

/**
 * The scripted captain's policy, from the card's typed actions only - it
 * never reads a card's words. A card offering to settle the work is the
 * finish line (never clicked: grading reads the tree, and a land would
 * only move it); a host attention card (a stall, a sign-in) stops the
 * attempt; any other decision takes the emitter's proposed step - the
 * action it marked default - else the first that is not destructive.
 */
export function captainMove(card: Card): CaptainMove {
  if (card.actions.length === 0 || card.status !== "ready" || card.awaiting)
    return { kind: "none" };
  if (
    card.actions.some((action) => action.effect?.kind === "merge")
  ) {
    return { kind: "ready" };
  }
  if (card.author === "host" || card.actions.some((action) => action.effect?.kind === "host")) {
    return { kind: "host" };
  }
  const answerable = card.actions.filter(
    (action) =>
      !action.danger && action.effect?.kind !== "settle" && action.effect?.kind !== "open",
  );
  const chosen = answerable.find((action) => action.default) ?? answerable[0];
  return chosen ? { kind: "answer", actionId: chosen.id, label: chosen.label } : { kind: "none" };
}
