import type { LaunchRecord } from "../storage/settingsStore";

/**
 * Safe-mode boot (talk-to-personalize Step 5, plan section 5.5).
 *
 * A personal panel runs in the renderer as a React module and, when it
 * ships a `server.ts`, in the core with the core's privilege. An error
 * boundary catches a throw; it does not catch a render loop that wedges
 * the window, and it does not catch a server module that takes the process
 * down. The honest recovery for both is the same: notice that the app is
 * not surviving its own launch, and come up with the captain's own panels
 * off, where the switch in Settings puts them back.
 *
 * The signal is a marker, not a stack trace, because the app cannot write
 * a report from inside a crash: every launch writes `pending` before
 * anything risky runs and clears it once the app has been up for
 * `EARLY_LAUNCH_MS` - long enough that an ordinary session always settles,
 * short enough that a panel wedging the first paint never does. A clean
 * quit clears it too. So a launch that STARTS and finds the marker still
 * set knows the previous one ended before it settled, whether that was a
 * crash, a force quit of a frozen window, or a kill: all three are the
 * same fact - the app did not survive its own launch.
 *
 * Two of those in a row is the threshold (`SAFE_MODE_AFTER_CRASHES`), so
 * one bad shutdown is never enough. A safe-mode boot starts the count
 * again: the panels are off now, so whatever happens next is about
 * something else.
 *
 * It owns no policy beyond that. What the app DOES with `safeMode` - write
 * the switch off with reason `safe-mode`, say so in the feed and in the
 * Firstmate's context - is `createServices`'s, so this stays one testable
 * decision over one row.
 */

/** How long a launch must survive before it counts as a good one. */
export const EARLY_LAUNCH_MS = 10_000;

/** Consecutive launches that ended early before the next one comes up safe. */
export const SAFE_MODE_AFTER_CRASHES = 2;

export type LaunchWatchOptions = {
  read: () => LaunchRecord;
  write: (record: LaunchRecord) => void;
  /** Records a marker failure without taking down the host process. */
  log?: (message: string) => void;
  /** How long a launch must survive; dev/e2e only, `EARLY_LAUNCH_MS` otherwise. */
  earlyLaunchMs?: number;
  /** Injected in tests; the real one is an unref'd host timer. */
  schedule?: (run: () => void, ms: number) => () => void;
};

export type LaunchVerdict = {
  /** Consecutive launches that ended before settling, this one excluded. */
  earlyCrashes: number;
  /** Whether this launch comes up with the captain's own panels off. */
  safeMode: boolean;
};

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

export class LaunchWatch {
  private cancel: (() => void) | null = null;
  private settled = false;

  constructor(private readonly options: LaunchWatchOptions) {}

  /**
   * Reads the previous launch's marker, decides this one, and arms the
   * settle timer. Call it before anything a personal panel could reach.
   */
  begin(): LaunchVerdict {
    const previous = this.options.read();
    const earlyCrashes = previous.pending ? previous.earlyCrashes + 1 : 0;
    const safeMode = earlyCrashes >= SAFE_MODE_AFTER_CRASHES;
    this.write({ pending: true, earlyCrashes: safeMode ? 0 : earlyCrashes });
    const schedule = this.options.schedule ?? defaultSchedule;
    this.cancel = schedule(() => this.settle(), this.options.earlyLaunchMs ?? EARLY_LAUNCH_MS);
    return { earlyCrashes, safeMode };
  }

  /** The launch is good: clear the marker and the count. */
  settle(): void {
    if (this.settled) return;
    if (!this.write({ pending: false, earlyCrashes: 0 })) return;
    this.settled = true;
    this.cancel?.();
    this.cancel = null;
  }

  /**
   * A clean quit, however early: the app was asked to go, which is not a
   * crash, so the marker and the count both clear.
   */
  dispose(): void {
    this.settle();
  }

  private write(record: LaunchRecord): boolean {
    try {
      this.options.write(record);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `launch record write failed: ${detail}`;
      if (this.options.log) this.options.log(message);
      else console.error(`[infinitary] ${message}`);
      return false;
    }
  }
}
