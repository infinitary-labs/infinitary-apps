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
 * start again as soon as it has the version, even with a window in front,
 * but never while words are left unsent there: those wait, and it starts
 * again once they are sent or cleared (the captain's "start the update now;
 * restart after the draft is resolved"). It tells the
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
  /** Whether a window of this app holds words not yet sent, which even the row's Update waits for. */
  wordsLeft: () => boolean;
  /** Runs `run` again and again while a download moves; answers its stop. */
  every?: (ms: number, run: () => void) => () => void;
};

/** How often a download's progress is told to the home: the cadence a computer's own download is read at. */
const PROGRESS_EVERY_MS = 1_000;

export class AppFollowsHome {
  /** The catching up under way, one at a time. */
  private running: Promise<void> | null = null;
  /**
   * The row's Update was pressed: start again as soon as the version is here
   * and no words are left unsent. It holds for the catching up under way, or
   * the next one, and for the version it got while that waits; it ends with
   * them or with the connection.
   */
  private now = false;
  /** The home's version, ready to install, while it waits for nobody to use this app. */
  private waiting: string | null = null;
  /** The last step told, so a moving download tells only what changed. */
  private told: string | null = null;
  private disposed = false;
  /**
   * Which connection an attempt belongs to: a lost or newer connection ends
   * every attempt of the one before, so none installs its version, waits
   * on it or tells the home of it.
   */
  private connection = 0;
  /** A connection came while an attempt ran: read the home's version again once it ends. */
  private again = false;

  constructor(private readonly options: AppFollowsHomeOptions) {}

  /**
   * A connection to the home was caught up: read its version again and
   * catch up with it if it is newer. A version already got ready is ready
   * again with no download, and one the home no longer runs is let go.
   */
  connected(): void {
    this.lost();
    if (this.running) this.again = true;
    else this.start();
  }

  /** The connection to the home went: what it started ends, and the next connection reads again. */
  lost(): void {
    this.connection++;
    this.told = null;
    this.waiting = null;
    this.now = false;
  }

  /** The row's Update on the home: catch up and start again as soon as the version is here and no words wait. */
  askedNow(): void {
    this.now = true;
    this.resume();
  }

  /**
   * Something about who uses this app changed - a window left the front, or
   * its words were sent: a version waiting for nobody to use it, or for the
   * words a pressed Update waits for, installs now.
   */
  noticed(): void {
    if (this.waiting && this.free(this.now)) this.resume();
  }

  /** This app no longer controls that home: its own channel's newest is its offer again. */
  dispose(): void {
    this.disposed = true;
    this.lost();
    this.options.updates.unfollow?.();
  }

  /**
   * Installs the version waiting, or catches up if none waits. Behind work
   * under way it waits its turn: once that ends, the home's version is read
   * again and the press or the moment it came for still holds.
   */
  private resume(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    const version = this.waiting;
    if (version) this.run(() => this.install(version));
    else this.start();
  }

  /** The catching up, once at a time; a connection that came meanwhile reads again after it. */
  private start(): void {
    this.run(() => this.catchUp(this.connection));
  }

  /**
   * Catching up and installing run one at a time, so an install a lost
   * connection let go ends before the next connection's tries its version.
   */
  private run(work: () => Promise<void>): void {
    if (this.running || this.disposed) return;
    const run = work().finally(() => {
      if (this.running === run) this.running = null;
      // A press holds only for this catching up: one that ended short of installing lets it go.
      if (!this.waiting) this.now = false;
      if (this.again) {
        this.again = false;
        this.start();
      }
    });
    this.running = run;
  }

  /**
   * Whether the app may start again now: when the row's Update asked, once
   * no words are left unsent; otherwise once nobody uses it at all.
   */
  private free(asked: boolean): boolean {
    return asked ? !this.options.wordsLeft() : this.options.nobodyHere();
  }

  /** Whether an attempt still belongs to the connection there is now. */
  private current(connection: number): boolean {
    return connection === this.connection && !this.disposed;
  }

  private async catchUp(connection: number): Promise<void> {
    const { updates } = this.options;
    const home = await this.options.homeVersion().catch(() => null);
    if (!home || !this.current(connection)) return;
    const own = (await updates.getStatus()).currentVersion;
    if (!this.current(connection)) return;
    if (!isNewerVersion(home, own)) {
      // The home runs this version or an older one again: nothing to follow.
      updates.unfollow?.();
      return;
    }
    if (!updates.follow) {
      this.tell({ version: home, step: "cannot", reason: "installation" });
      return;
    }
    this.tell({ version: home, step: "getting", percent: 0 });
    const stop = (this.options.every ?? every)(PROGRESS_EVERY_MS, () => {
      void updates.getStatus().then((status) => {
        if (
          status.phase === "downloading" &&
          status.percent !== undefined &&
          this.current(connection)
        )
          this.tell({ version: home, step: "getting", percent: Math.floor(status.percent) });
      });
    });
    const ready = await updates.follow(home).finally(stop);
    if (!this.current(connection)) return;
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
    // Only a copy that installs the followed version alone may start again on it.
    if (!updates.installFollowed) {
      this.tell({ version: home, step: "cannot", reason: "installation" });
      return;
    }
    this.waiting = home;
    if (this.free(this.now)) {
      await this.install(home);
      return;
    }
    this.tell({ version: home, step: "waiting" });
  }

  /**
   * Starts again on the version it has, and only that version: the home
   * hears it restarting, or why it did not. Whether it may start again
   * (`free`) is asked first, then again once the crew's work is saved,
   * before native staging and once staged, before it quits; false keeps it
   * running and waiting, staged or not, with the row's press still held.
   */
  private async install(version: string): Promise<void> {
    const { installFollowed } = this.options.updates;
    if (this.waiting !== version || this.disposed || !installFollowed) return;
    const asked = this.now;
    if (!this.free(asked)) {
      this.tell({ version, step: "waiting" });
      return;
    }
    const connection = this.connection;
    this.waiting = null;
    this.now = false;
    this.tell({ version, step: "restarting" });
    // Asked again before it quits: still this connection's, and still free to start again.
    const result = await installFollowed(
      version,
      () => this.current(connection) && this.free(asked),
    );
    // A release quits to start again and never answers; an answer means it did not.
    if (result.ok || !this.current(connection)) return;
    if (result.later) {
      this.waiting = version;
      this.now = asked;
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
