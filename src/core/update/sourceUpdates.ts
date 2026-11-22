import * as m from "@shared/i18n/messages.generated";
import type { UpdateChannel, UpdateInstallResult, UpdateStatus } from "@shared/update";
import { UPDATE_LATER, UPDATE_PROBLEMS } from "@shared/updateWords";
import { REMOTE_TIMEOUT_MS, git as runGit } from "../workspace/git";
import { requestSourceUpdate, type StarterSession } from "./devStarter";
import type { UpdateChecker } from "./updateChecker";
import { type UpdateSaving, withUpdateWork } from "./updateWork";

/**
 * The third update mode, beside an installer and a package manager
 * (docs/alpha.md, "Updates from source"): a copy of the project run by
 * `pnpm dev`'s starter. It reads the branch the copy is on and the branch
 * where the project lives that it follows, main for a daily copy. When that
 * branch has newer commits and the copy can move forward to them - no
 * tracked file edited, no commit of its own - it offers Update and restart;
 * otherwise it says why. Update and restart saves the crew's work as an
 * installed update does, leaves the starter its request and ends the app;
 * the starter moves the copy, installs packages when they changed and
 * starts it again, or goes back to this commit when the new one fails.
 */

// A check at most every 4 hours, as an installed copy's.
const DEFAULT_INTERVAL_MS = 4 * 60 * 60 * 1000;

export type SourceGit = (args: string[], options?: { remote?: boolean }) => Promise<string>;

export type SourceUpdateOptions = {
  /** The starter's folder (`INFINITARY_DEV_STARTER`). */
  starterDir: string;
  /** What the starter wrote before this start. */
  session: StarterSession;
  /** Required by the status's shape; a copy run from source follows no release channel. */
  channel: () => UpdateChannel;
  /** Saves the crew's work before the copy changes (`createUpdateSaving`). */
  saving: UpdateSaving;
  /** Ends the app for the starter; absent, nothing is offered to install. */
  end?: () => void;
  openExternal: (url: string) => void | Promise<void>;
  /** Git in the copy; the work substrate's runner by default. */
  git?: SourceGit;
  intervalMs?: number;
  now?: () => number;
};

/** What the copy and the branch it follows say now. */
type SourceRead =
  | { kind: "detached"; head: string }
  | { kind: "no-upstream"; head: string; branch: string }
  | {
      kind: "following";
      head: string;
      /** The branch it follows, by its name where the project lives: `main`. */
      upstream: string;
      target: string;
      behind: number;
      ahead: number;
      edited: boolean;
      compareUrl: string | null;
    };

const short = (commit: string) => commit.slice(0, 7);

/** A GitHub project's page comparing two commits, from the remote's address; null elsewhere. */
export function compareUrlOf(remoteUrl: string, from: string, to: string): string | null {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      remoteUrl.trim(),
    );
  return match ? `https://github.com/${match[1]}/${match[2]}/compare/${from}...${to}` : null;
}

function defaultGit(root: string): SourceGit {
  return (args, options) =>
    runGit(root, args, {
      // A fetch never asks for a password in a terminal nobody watches.
      env: { GIT_TERMINAL_PROMPT: "0" },
      ...(options?.remote ? { timeoutMs: REMOTE_TIMEOUT_MS } : {}),
    });
}

/** The words for how the starter's last update ended, when it did not move the copy forward. */
export function wentBackWords(last: StarterSession["last"]): string | undefined {
  if (last?.outcome !== "went-back") return undefined;
  const words = { from: short(last.from), to: short(last.to) };
  if (last.step === "move") return m.updateSourceNotMoved(words);
  if (last.step === "install") return m.updateSourceInstallFailed(words);
  return m.updateSourceBuildFailed(words);
}

export function createSourceUpdateChecker(options: SourceUpdateOptions): UpdateChecker {
  const root = options.session.root;
  const git = options.git ?? defaultGit(root);
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const saving = options.saving;
  // Said until the person starts another update.
  let lastProblem = wentBackWords(options.session.last);
  let fetchedAt: number | undefined;
  let checkedAt: number | undefined;
  let installing = false;
  let reading: { fetch: boolean; read: Promise<SourceRead> } | undefined;

  const quiet = async (args: string[]): Promise<string | null> => {
    try {
      return (await git(args)).trim();
    } catch {
      return null;
    }
  };

  async function readCopy(fetch: boolean): Promise<SourceRead> {
    const head = (await git(["rev-parse", "HEAD"])).trim();
    const branch = await quiet(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (!branch) return { kind: "detached", head };
    const remote = await quiet(["config", `branch.${branch}.remote`]);
    const merge = await quiet(["config", `branch.${branch}.merge`]);
    const tracking = await quiet([
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{upstream}",
    ]);
    if (!remote || !merge || !tracking) return { kind: "no-upstream", head, branch };
    if (fetch) {
      // The one remote read: the followed branch alone, into its tracking ref.
      await git(["fetch", "--quiet", "--no-tags", remote, merge], { remote: true });
      fetchedAt = now();
    }
    const target = (await git(["rev-parse", "@{upstream}"])).trim();
    const [behind, ahead] = (
      await git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"])
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    // Without git's optional index lock, so a commit the person makes meanwhile never fails on it.
    const edited =
      (
        await git(["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"])
      ).trim() !== "";
    const remoteUrl = (await quiet(["remote", "get-url", remote])) ?? "";
    return {
      kind: "following",
      head,
      upstream: merge.replace(/^refs\/heads\//, ""),
      target,
      behind: behind ?? 0,
      ahead: ahead ?? 0,
      edited,
      compareUrl: compareUrlOf(remoteUrl, head, target),
    };
  }

  /**
   * One read at a time: a read joins the one under way when that one fetches
   * or it need not, and a fetch waits for a read that does not fetch, then fetches.
   */
  function read(fetch: boolean): Promise<SourceRead> {
    const under = reading;
    if (under && (under.fetch || !fetch)) return under.read;
    if (under)
      return under.read.then(
        () => read(fetch),
        () => read(fetch),
      );
    const own = {
      fetch,
      read: readCopy(fetch).finally(() => {
        if (reading === own) reading = undefined;
      }),
    };
    reading = own;
    return own.read;
  }

  const offers = (copy: SourceRead): boolean =>
    copy.kind === "following" &&
    copy.behind > 0 &&
    !copy.edited &&
    copy.ahead === 0 &&
    !!options.end;

  function statusOf(copy: SourceRead): UpdateStatus {
    const base: UpdateStatus = {
      currentVersion: short(copy.head),
      channel: options.channel(),
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: null,
      upgradeCommand: "",
      ...(checkedAt !== undefined ? { checkedAt } : {}),
      ...(installing ? { phase: "installing" as const } : {}),
    };
    if (copy.kind === "detached")
      return { ...base, problem: lastProblem ?? m.updateSourceDetached() };
    if (copy.kind === "no-upstream")
      return { ...base, problem: lastProblem ?? m.updateSourceNoUpstream({ branch: copy.branch }) };
    const held: NonNullable<UpdateStatus["source"]>["held"] = copy.edited
      ? "edited"
      : copy.ahead > 0
        ? "ahead"
        : undefined;
    const source: UpdateStatus["source"] = {
      branch: copy.upstream,
      behind: copy.behind,
      ...(copy.behind > 0 && held ? { held } : {}),
    };
    if (copy.behind === 0)
      return {
        ...base,
        source,
        notice: m.updateSourceUpToDate({ branch: copy.upstream }),
        ...(lastProblem ? { problem: lastProblem } : {}),
      };
    return {
      ...base,
      source,
      latestVersion: short(copy.target),
      updateAvailable: true,
      releaseUrl: copy.compareUrl,
      ...(offers(copy) ? { install: { asksPassword: false, restarts: true } } : {}),
      ...(lastProblem ? { problem: lastProblem } : {}),
    };
  }

  /** A read that fetches once the last fetch went stale, and reads the copy alone when it cannot. */
  async function current(fetch: "stale" | "now"): Promise<UpdateStatus> {
    const due = fetch === "now" || fetchedAt === undefined || now() - fetchedAt >= intervalMs;
    if (due) {
      try {
        const copy = await read(true);
        checkedAt = now();
        return statusOf(copy);
      } catch {
        if (fetch === "now") {
          const { notice, ...known } = statusOf(await read(false));
          return { ...known, phase: "error", problem: UPDATE_PROBLEMS.checkFailed };
        }
        // A quiet check that could not fetch tries again at the next ask.
        fetchedAt = undefined;
      }
    }
    return statusOf(await read(false));
  }

  /** The update under way, which Update later waits on to answer once it let go. */
  let inFlight: Promise<UpdateInstallResult> | undefined;

  function install(): Promise<UpdateInstallResult> {
    if (inFlight) return Promise.resolve({ ok: false, problem: m.updateSourceAlreadyUpdating() });
    const run = installOnce().finally(() => {
      inFlight = undefined;
    });
    inFlight = run;
    return run;
  }

  async function installOnce(): Promise<UpdateInstallResult> {
    if (installing) return { ok: false, problem: m.updateSourceAlreadyUpdating() };
    let copy: SourceRead;
    try {
      copy = await read(true);
      checkedAt = now();
    } catch {
      copy = await read(false);
    }
    if (copy.kind !== "following" || !offers(copy))
      return { ok: false, problem: m.updateSourceNothingToTake() };
    lastProblem = undefined;
    installing = true;
    if (!(await saving.save())) {
      installing = false;
      return { ok: false, later: true, problem: UPDATE_LATER };
    }
    try {
      requestSourceUpdate(options.starterDir, { from: copy.head, to: copy.target });
    } catch {
      installing = false;
      // Nothing changed: the work the save stopped carries on.
      saving.release();
      return { ok: false, problem: m.updateSourceNotAsked() };
    }
    options.end?.();
    return { ok: true };
  }

  return {
    getStatus: async () => withUpdateWork(await current("stale"), saving),
    checkNow: async () => withUpdateWork(await current("now"), saving),
    openReleasePage: async () => {
      const copy = await read(false);
      if (copy.kind === "following" && copy.compareUrl) await options.openExternal(copy.compareUrl);
    },
    install,
    later: async () => {
      // A save let go ends its update: answer once it has, not while it still says it updates.
      if (saving.later()) await inFlight;
      return withUpdateWork(await current("stale"), saving);
    },
  };
}
