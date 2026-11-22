/**
 * `pnpm dev`'s starter (docs/alpha.md, "Updates from source"): it runs the
 * app from this copy and stays as its parent, so the app can ask it to
 * update and start again. `scripts/dev.ts` gives it the real git, pnpm and
 * electron-vite; tests give it stand-ins for the programs it starts.
 *
 * Each start: read the copy (commit, edited, lockfile digest), write the
 * session, start the app and wait for it to end. An app that asked for an
 * update leaves its request; the starter then moves the copy forward to the
 * asked commit, installs packages when they changed, prepares the build's
 * generated files, and starts again. A new commit that does not install,
 * prepare or reach the app's main process goes back to the commit before
 * it, which starts again and says why.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type SourceUpdateRequest,
  type StarterOutcome,
  takeSourceUpdate,
  takeStarted,
  writeStarterSession,
} from "../src/core/update/devStarter.ts";

/** What changes which packages `pnpm install` puts in place. */
export const PACKAGE_FILES = ["pnpm-lock.yaml", "package.json", "pnpm-workspace.yaml", "patches"];

export type DevStarterDeps = {
  /** The copy of the project. */
  root: string;
  /** The starter's private folder, named to the app. */
  session: string;
  /** Runs git in the copy and answers its output, throwing when it fails. */
  git: (args: string[]) => Promise<string>;
  /** `pnpm install --frozen-lockfile` in the copy; its exit code. */
  install: () => Promise<number>;
  /** The generated files a start needs (`predev`); its exit code. */
  prepare: () => Promise<number>;
  /** Runs the app until it ends; its exit code. */
  start: () => Promise<number>;
  /** A line for the person at the terminal. */
  say: (line: string) => void;
  /** True once the person stopped the starter, so nothing starts again. */
  stopping: () => boolean;
};

const short = (commit: string) => commit.slice(0, 7);

async function lockDigest(root: string): Promise<string> {
  try {
    return createHash("sha256")
      .update(await readFile(join(root, "pnpm-lock.yaml")))
      .digest("hex");
  } catch {
    return "";
  }
}

/** Tracked files that differ from the commit; untracked files never block a forward move. */
async function edited(deps: DevStarterDeps): Promise<boolean> {
  return (await deps.git(["status", "--porcelain", "--untracked-files=no"])).trim() !== "";
}

async function packagesChanged(deps: DevStarterDeps, from: string, to: string): Promise<boolean> {
  const names = await deps.git(["diff", "--name-only", from, to, "--", ...PACKAGE_FILES]);
  return names.trim() !== "";
}

/** Moves the copy back to `from` after an update moved it; false when it could not. */
async function goBack(deps: DevStarterDeps, from: string, reinstall: boolean): Promise<boolean> {
  try {
    await deps.git(["reset", "--keep", from]);
  } catch (error) {
    deps.say(`Infinitary could not move this copy back to ${short(from)}: ${String(error)}`);
    return false;
  }
  if (reinstall && (await deps.install()) !== 0) {
    deps.say(`Installing packages for ${short(from)} failed. Run pnpm install, then pnpm dev.`);
    return false;
  }
  if ((await deps.prepare()) !== 0) {
    deps.say(`Preparing ${short(from)} failed. Run pnpm dev again.`);
    return false;
  }
  return true;
}

type Moved =
  | { ok: true; outcome: StarterOutcome; reinstall: boolean }
  | { ok: false; outcome: StarterOutcome | null };

/** Moves the copy forward to the asked commit, or back where it was when a step fails. */
async function update(deps: DevStarterDeps, request: SourceUpdateRequest): Promise<Moved> {
  const { from, to } = request;
  const notMoved: StarterOutcome = { outcome: "went-back", from, to, step: "move" };
  const head = (await deps.git(["rev-parse", "HEAD"])).trim();
  if (head !== from || (await edited(deps))) {
    deps.say("This copy changed after the update was offered, so nothing was moved.");
    return { ok: true, outcome: notMoved, reinstall: false };
  }
  deps.say(`Updating this copy from ${short(from)} to ${short(to)}.`);
  try {
    await deps.git(["merge", "--ff-only", "--quiet", to]);
  } catch (error) {
    deps.say(`This copy could not move forward to ${short(to)}: ${String(error)}`);
    return { ok: true, outcome: notMoved, reinstall: false };
  }
  const reinstall = await packagesChanged(deps, from, to);
  if (reinstall) {
    deps.say("The packages changed, so pnpm install runs.");
    if ((await deps.install()) !== 0) {
      deps.say(`Installing packages for ${short(to)} failed, so this copy goes back to ${short(from)}.`);
      const back = await goBack(deps, from, true);
      return back
        ? { ok: true, outcome: { outcome: "went-back", from, to, step: "install" }, reinstall: false }
        : { ok: false, outcome: null };
    }
  }
  if ((await deps.prepare()) !== 0) {
    deps.say(`Preparing ${short(to)} failed, so this copy goes back to ${short(from)}.`);
    const back = await goBack(deps, from, reinstall);
    return back
      ? { ok: true, outcome: { outcome: "went-back", from, to, step: "build" }, reinstall: false }
      : { ok: false, outcome: null };
  }
  return { ok: true, outcome: { outcome: "updated", from, to, installed: reinstall }, reinstall };
}

/** Runs the app from the copy until it ends without asking for an update; the exit code. */
export async function runDevStarter(deps: DevStarterDeps): Promise<number> {
  let last: StarterOutcome | undefined;
  // An update that moved the copy, until its first start reaches the app's main process.
  let unproven: { from: string; to: string; reinstall: boolean } | undefined;
  for (;;) {
    const commit = (await deps.git(["rev-parse", "HEAD"])).trim();
    writeStarterSession(deps.session, {
      root: deps.root,
      commit,
      edited: await edited(deps),
      lockDigest: await lockDigest(deps.root),
      ...(last ? { last } : {}),
    });
    // Nothing left from an earlier start counts for this one.
    takeStarted(deps.session);
    takeSourceUpdate(deps.session);
    const code = await deps.start();
    const started = takeStarted(deps.session);
    const request = takeSourceUpdate(deps.session);
    if (deps.stopping()) return code;
    if (unproven && !started) {
      const { from, to, reinstall } = unproven;
      unproven = undefined;
      deps.say(`${short(to)} did not start, so this copy goes back to ${short(from)}.`);
      if (!(await goBack(deps, from, reinstall))) return 1;
      last = { outcome: "went-back", from, to, step: "build" };
      continue;
    }
    unproven = undefined;
    if (!request) return code;
    const moved = await update(deps, request);
    if (!moved.ok) return 1;
    last = moved.outcome;
    if (moved.outcome.outcome === "updated")
      unproven = { from: request.from, to: request.to, reinstall: moved.reinstall };
    deps.say("Starting Infinitary again.");
  }
}
