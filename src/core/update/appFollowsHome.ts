import type { AppFollowReport } from "@shared/appFollow";
import { isNewerVersion } from "@shared/semver";
import type { UpdateChecker } from "./updateChecker";

/**
 * An app open on another computer follows the version of the computer it
 * controls, its home (docs/view.md, "Following the home's version"; INF-5372's
 * plan, piece 2, the captain's "by itself, while nobody is using it" and
 * "the home's version"). At each connection it reads the version the home
 * runs; while that is newer than its own, it gets that exact version through
 * its own updater, in the background, and starts again on it once nobody
 * here uses it: none of its windows is in front and none holds words not
 * yet sent. Update on the home's Devices row (the captain's "i think we
 * should still provide a manual update flow in the devices view") has it
 * start again as soon as it has the version, whoever uses it. It tells the
 * home each step, and what it cannot do by itself, so the home's row and
 * card say it.
 */
export type AppFollowsHomeOptions = {
  /** This app's own installed copy's updater. */
  updates: UpdateChecker;
  /** The version the home runs, read at each connection; null when it does not say. */
  homeVersion: () => Promise<string | null>;
  /** Tells the home a step; a home that does not listen hears nothing. */
  tell: (report: AppFollowReport) => void;
  /** Whether nobody uses this app now: no window in front, no words left unsent. */
  nobodyHere: () => boolean;
  /** Runs `run` again and again while a download moves; answers its stop. */
  every?: (ms: number, run: () => void) => () => void;
};

/** How often a download's progress is told to the home: the cadence a computer's own download is read at. */
const PROGRESS_EVERY_MS = 1_000;

export class AppFollowsHome {
  /** The catching up under way, one at a time. */
  private running: Promise<void> | null = null;
  /**
   * The row's Update was pressed: start again as soon as the version is here.
   * It holds for the catching up under way, or the next one, and ends with it.
   */
  private now = false;
  /** The home's version, ready to install, while it waits for nobody to use this app. */
  private waiting: string | null = null;
  /** The last step told, so a moving download tells only what changed. */
  private told: string | null = null;
  private disposed = false;

  constructor(private readonly options: AppFollowsHomeOptions) {}

  /**
   * A connection to the home was caught up: read its version again and
   * catch up with it if it is newer. A version already got ready is ready
   * again with no download, and one the home no longer runs is let go.
   */
  connected(): void {
    this.told = null;
    this.waiting = null;
    this.start();
  }

  /** The row's Update on the home: catch up and start again as soon as the version is here. */
  askedNow(): void {
    this.now = true;
    if (this.waiting) {
      void this.install(this.waiting);
      return;
    }
    this.start();
  }

  /**
   * Something about who uses this app changed - a window left the front, or
   * its words were sent: a version waiting for nobody to use it installs now.
   */
  noticed(): void {
    if (this.waiting && this.options.nobodyHere()) void this.install(this.waiting);
  }

  /** This app no longer controls that home: its own channel's newest is its offer again. */
  dispose(): void {
    this.disposed = true;
    this.waiting = null;
    this.options.updates.unfollow?.();
  }

  /** The catching up, once at a time; one asked meanwhile joins it. */
  private start(): void {
    if (this.running || this.disposed) return;
    const run = this.catchUp().finally(() => {
      if (this.running === run) this.running = null;
      // A press holds only for this catching up: one that ended short of installing lets it go.
      if (!this.waiting) this.now = false;
    });
    this.running = run;
  }

  private async catchUp(): Promise<void> {
    const { updates } = this.options;
    const home = await this.options.homeVersion().catch(() => null);
    if (!home || this.disposed) return;
    const own = (await updates.getStatus()).currentVersion;
    if (!isNewerVersion(home, own)) {
      // The home runs this version or an older one again: nothing to follow.
      updates.unfollow?.();
      return;
    }
    if (!updates.follow || !updates.installFollowed) {
      this.tell({ version: home, step: "cannot", reason: "installation" });
      return;
    }
    this.tell({ version: home, step: "getting", percent: 0 });
    const stop = (this.options.every ?? every)(PROGRESS_EVERY_MS, () => {
      void updates.getStatus().then((status) => {
        if (status.phase === "downloading" && status.percent !== undefined)
          this.tell({ version: home, step: "getting", percent: Math.floor(status.percent) });
      });
    });
    const ready = await updates.follow(home).finally(stop);
    if (this.disposed) return;
    if (!ready.ok) {
      this.tell(
        "reason" in ready
          ? {
              version: home,
              step: "cannot",
              reason: ready.reason,
              ...(ready.problem ? { problem: ready.problem.slice(0, 400) } : {}),
            }
          : { version: home, step: "failed", problem: ready.failed.slice(0, 400) },
      );
      return;
    }
    this.waiting = home;
    if (this.now || this.options.nobodyHere()) {
      await this.install(home);
      return;
    }
    this.tell({ version: home, step: "waiting" });
  }

  /**
   * Starts again on the version it has, and only that version: the home
   * hears it restarting, or why it did not. Unless the row's Update asked,
   * whether nobody uses the app is asked again before it quits.
   */
  private async install(version: string): Promise<void> {
    const { installFollowed } = this.options.updates;
    if (this.waiting !== version || this.disposed || !installFollowed) return;
    const asked = this.now;
    this.waiting = null;
    this.now = false;
    this.tell({ version, step: "restarting" });
    const result = await installFollowed(version, () => asked || this.options.nobodyHere());
    // A release quits to start again and never answers; an answer means it did not.
    if (result.ok || this.disposed) return;
    if (result.later) {
      this.waiting = version;
      this.tell({ version, step: "waiting" });
      return;
    }
    this.tell({
      version,
      step: "failed",
      ...(result.problem ? { problem: result.problem.slice(0, 400) } : {}),
    });
  }

  private tell(report: AppFollowReport): void {
    const said = JSON.stringify(report);
    if (said === this.told) return;
    this.told = said;
    this.options.tell(report);
  }
}

function every(ms: number, run: () => void): () => void {
  const timer = setInterval(run, ms);
  return () => clearInterval(timer);
}
