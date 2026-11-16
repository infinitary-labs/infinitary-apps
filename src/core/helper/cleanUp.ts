import { existsSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MachineLoginOutcome } from "@shared/accounts";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { MADE_LOGIN_FILE } from "../claude/claudeAuth";
import { HOME_ADDRESSES_FILE, JoinedHome } from "../devices/joinedHome";
import { removeAll } from "../removeWhole";
import {
  type BackgroundContext,
  forgetInstalled,
  readInstalled,
  serviceFiles,
  stopInBackground,
} from "./background";
import { HomeRoute, ROUTE_FILE } from "./route";
import { WorkingCopies } from "./workingCopies";

/**
 * What a computer that runs work takes away once its home removed it
 * (docs/helper.md, "Removed"): everything Firstmate set up for that home -
 * its own sign-ins, its clones and working copies, the conversations held
 * here, the copy of Firstmate a command fetched, and the background agent -
 * and nothing the person put here. The agent and the fetched copy are only
 * what `installed.json` names; everything else is the data folder's own.
 *
 * A home brings a computer's unmerged work home before it removes one that
 * is in reach, so nothing is left to lose. A home that removed it while it
 * was out of reach could not: a working copy that still holds edits or
 * commits that never merged stays, with the clone it belongs to, and the
 * answer names where. So does one whose history cannot be read, and the
 * whole working-copies folder when it cannot be listed.
 *
 * Nothing it cannot delete stops the rest: each piece goes on its own, and a
 * folder a build left read-only is made writable to its owner first. What
 * still stays is kept on the left note (`JoinedHome.setUnfinished`), and the
 * agent and the copy it starts stay with it, so the agent's next run finishes
 * the removal (`finishRemoval`, `./run.ts`).
 *
 * The Claude login Firstmate made here from a code the captain pasted is
 * part of what it set up: it is signed out with the vendor's own client, and
 * a login that was here before Firstmate stays. That client keeps the login
 * in this user's login session, so only the work's own run, which the
 * service manager starts there, signs it out (`signOutClaude`). A removal begun outside it -
 * a command over Remote Login, or a join that leaves a home - keeps the
 * record at the folder's root (`LEFT_CLAUDE_LOGIN`) for the run: until then
 * the removal has not finished, and the agent stays to finish it.
 *
 * What stays in the folder while a removal has not finished, or while
 * unmerged work is kept: the note of which home removed it (`left.json`,
 * which `status` says then). Once nothing is kept and the removal has
 * finished, that note goes too, with the route, the logs and what Electron
 * itself wrote here. A file the person put in the folder stays.
 */

/**
 * The record of a Claude login Firstmate made here, kept past its account's
 * folder for the work's run to sign out (`MADE_LOGIN_FILE`).
 */
export const LEFT_CLAUDE_LOGIN = "claude-login.json";

/** Folders that hold sign-ins, conversations, the pieces of work in flight and the tasks' command keys. */
const ALWAYS = [
  "accounts",
  "forges",
  "pi-agent",
  "pi-base",
  "tasks",
  "bundles",
  "artifacts",
  "worktree-pool",
  "worktree-trash",
  "task-channel",
] as const;

/** Folders a kept working copy needs: the clones it is a working copy of. */
const CLONES = ["repos", "default-workspace"] as const;

/**
 * What a finished removal also takes, beside the route the home's SSH
 * connection published: the logs, Electron's own files, and the
 * `launch-fact.json` protocol 9.0 kept, which nothing reads now. None of it
 * is the person's.
 */
const LEFTOVERS = [
  "work.log",
  "service.log",
  "chromium",
  "display.auth",
  "launch-fact.json",
] as const;

export type CleanUpOptions = {
  dataDir: string;
  /** Where the agent was set up; null leaves launchd alone, as a test that set none up does. */
  background: BackgroundContext | null;
  /**
   * Signs out the Claude login Firstmate made here, as the record names it
   * (`ClaudeAuthBackend.signOutMadeLogin`). Only the work's own run passes
   * it; without it the sign-out is left for that run.
   */
  signOutClaude?: (record: string) => Promise<MachineLoginOutcome>;
};

/**
 * What a removal left: `kept` the working copies kept for their unmerged work
 * or unreadable history, `unreadable` the latter, and `unremoved` what it
 * meant to remove and could not yet, which its next try removes. `claude`
 * is what became of this user's Claude login when Firstmate signed in to
 * Claude here, `later` when the work's run signs it out.
 */
export type CleanUpResult = {
  kept: string[];
  unreadable?: string[];
  unremoved?: string[];
  claude?: MachineLoginOutcome | "later";
};

/** Removes what Firstmate set up here; keeps unmerged work and copies it cannot safely inspect. */
export async function cleanUp(options: CleanUpOptions): Promise<CleanUpResult> {
  const { dataDir } = options;
  const joinedHome = new JoinedHome(dataDir, () => {});
  const copies = new WorkingCopies(dataDir);
  const kept: string[] = [];
  const unreadable: string[] = [];
  const unremoved: string[] = [];
  const remove = (path: string) => {
    if (!removeAll(path)) unremoved.push(path);
  };
  // What an earlier try found it could remove and could not: a copy it began
  // to delete reads as unreadable now, so it is never read again.
  const begun = new Set(joinedHome.unfinished() ?? []);
  let listed: string[] | null = [];
  if (!begun.has(copies.worktreesDir)) {
    try {
      listed = copies.list();
    } catch {
      // Nobody can tell what any copy in it holds: the folder stays whole, with every clone.
      listed = null;
      kept.push(copies.worktreesDir);
      unreadable.push(copies.worktreesDir);
    }
  }
  for (const task of listed ?? []) {
    if (begun.has(copies.dir(task))) continue;
    // One that cannot be read is kept: nobody can tell it holds nothing.
    const status = await copies.status(task).catch(() => null);
    if (!status) unreadable.push(copies.dir(task));
    if (!status || (status.present && (status.dirty || status.unlandedCommits > 0)))
      kept.push(copies.dir(task));
  }
  // Before its account's folder goes with the rest.
  const claude = await claudeLogin(dataDir, options.signOutClaude);
  for (const folder of ALWAYS) remove(join(dataDir, folder));
  if (kept.length === 0) {
    for (const folder of CLONES) remove(join(dataDir, folder));
    remove(copies.worktreesDir);
  } else {
    for (const task of listed ?? []) if (!kept.includes(copies.dir(task))) remove(copies.dir(task));
  }
  // The route, the logs and Electron's files are Firstmate's too. A failure
  // to take one joins the unfinished list, so the next run tries again. The
  // route goes under its write lock (`HomeRoute.remove`): the home's SSH
  // connection may be renewing or withdrawing it from its own process, and
  // a write it began before the delete would bring it back.
  try {
    new HomeRoute(dataDir).remove();
  } catch {
    unremoved.push(join(dataDir, ROUTE_FILE));
  }
  for (const name of LEFTOVERS) remove(join(dataDir, name));
  // The agent, and the copy it starts, go only once the rest is gone: until
  // then its next run is what finishes the removal. Its file goes first, in
  // one step, so one that stays still has the copy it starts.
  const finished = () => unremoved.length === 0 && !claude.left;
  const installed = readInstalled(dataDir);
  if (installed.service && finished())
    for (const file of serviceFiles(installed.service)) remove(file);
  if (installed.app && finished()) {
    remove(installed.app);
    // The folder that held it, once nothing else is in it.
    try {
      if (readdirSync(dirname(installed.app)).length === 0) remove(dirname(installed.app));
    } catch {
      // Gone already.
    }
  }
  joinedHome.setUnfinished(claude.left ? [...unremoved, claude.left] : unremoved);
  // With nothing kept and the removal finished, the note of which home goes
  // too: status then says this user has joined nothing. While work is kept,
  // or the removal has not finished, the note stays.
  if (finished() && kept.length === 0) {
    remove(join(dataDir, "left.json"));
    remove(join(dataDir, "home.json"));
    remove(join(dataDir, HOME_ADDRESSES_FILE));
    if (!finished()) joinedHome.setUnfinished(unremoved);
  }
  const result = {
    kept,
    ...(unreadable.length > 0 ? { unreadable } : {}),
    ...(unremoved.length > 0 ? { unremoved } : {}),
    ...(claude.outcome ? { claude: claude.outcome } : {}),
  };
  if (!finished()) return result;
  forgetInstalled(dataDir);
  // Last: run from the agent itself, taking it away ends this process.
  if (installed.service && options.background)
    await stopInBackground(options.background, installed.service);
  return result;
}

/**
 * The Claude login Firstmate made here, signed out with `signOut`, or with
 * none its record kept at the folder's root (`left`) for the work's run.
 * Nothing when this user never signed in to Claude here; `kept` when the
 * login was here before Firstmate.
 */
async function claudeLogin(
  dataDir: string,
  signOut: CleanUpOptions["signOutClaude"],
): Promise<{ outcome?: CleanUpResult["claude"]; left?: string }> {
  const left = join(dataDir, LEFT_CLAUDE_LOGIN);
  let accounts: string[] = [];
  try {
    accounts = readdirSync(join(dataDir, "accounts", CLAUDE_PROVIDER_ID)).map((account) =>
      join(dataDir, "accounts", CLAUDE_PROVIDER_ID, account, MADE_LOGIN_FILE),
    );
  } catch {
    // No Claude account here.
  }
  const record = [left, ...accounts].find((file) => existsSync(file));
  if (!record) return accounts.length > 0 ? { outcome: "kept" } : {};
  if (!signOut) {
    try {
      if (record !== left) renameSync(record, left);
      return { outcome: "later", left };
    } catch {
      // Not kept: it can only be signed out here.
    }
  }
  const outcome = signOut
    ? await signOut(record).catch((): MachineLoginOutcome => "not-signed-out")
    : "not-signed-out";
  removeAll(left);
  return { outcome };
}
