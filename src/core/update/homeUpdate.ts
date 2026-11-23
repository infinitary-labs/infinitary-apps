import { type HomeUpdate, type HomeUpdateStops, homeUpdateOf } from "@shared/homeUpdate";
import * as m from "@shared/i18n/messages.generated";
import type { UpdateStatus } from "@shared/update";
import type { UpdateChecker } from "./updateChecker";

/**
 * An update a paired view started, run by the program that installs this
 * computer's copy: the first mate's own, or the window opened beside a first
 * mate a command started (docs/view.md, "Updating the first mate's
 * computer"). It runs the updater's own install unchanged, so the crew's work
 * is saved first and Update later lets it go, and keeps how it ended for the
 * next reading, since nobody waits on the install's own answer.
 */
export class AskedInstall {
  private problem: string | null = null;
  private from: string | undefined;
  private running = false;

  constructor(private readonly updates: UpdateChecker) {}

  /** Starts the offered update for `from`; one already under way goes on. */
  start(from?: string): void {
    if (this.running) return;
    this.running = true;
    this.problem = null;
    this.from = from;
    void this.updates
      .install()
      .then(
        (result) => {
          // Update later is no failure: the update waits, and the work carries on.
          if (!result.ok && !result.later) this.problem = result.problem;
        },
        (error: unknown) => {
          this.problem = error instanceof Error ? error.message : String(error);
        },
      )
      .finally(() => {
        this.running = false;
        this.from = undefined;
      });
  }

  /** Whether an update this started is still under way. */
  underWay(): boolean {
    return this.running;
  }

  /** Update later, as the update notice's own button. */
  later(): Promise<UpdateStatus> {
    return this.updates.later?.() ?? this.updates.getStatus();
  }

  /** The updater's status, with who started the update under way and how a failed one ended. */
  async status(): Promise<UpdateStatus> {
    const status = await this.updates.getStatus();
    // An update that moved on since, such as one started at this computer, ends the failed one's story.
    if (!this.running && movedOn(status)) this.problem = null;
    return {
      ...status,
      ...(this.running && this.from ? { askedFrom: this.from } : {}),
      ...(this.problem && !this.running && status.phase !== "error"
        ? { phase: "error" as const, problem: this.problem }
        : {}),
    };
  }
}

/**
 * The updater is downloading, installing or saving work: an update under way since.
 * A check, a staged copy and an error are where a failed update rests, so they keep its story.
 */
function movedOn(status: UpdateStatus): boolean {
  return (
    status.phase === "downloading" || status.phase === "installing" || status.work !== undefined
  );
}

/** The window opened beside a first mate a command started, which installs this Mac's copy. */
export type UpdatingWindow = {
  open: () => boolean;
  /** Asks the window one step of its own update; rejects when it is gone. */
  ask: (step: "status" | "install" | "later", from?: string) => Promise<UpdateStatus>;
  /** Opens the window beside the first mate, where this computer can. */
  start?: () => void;
};

export type HomeUpdatesOptions = {
  updates: UpdateChecker;
  /**
   * Present where the window installs the update (a Mac whose first mate a
   * command started): every step is asked of it, and it is opened first
   * when it is closed.
   */
  window?: UpdatingWindow;
  /** What an update would stop here now. */
  stops: () => HomeUpdateStops;
  /** Tells this computer's own window that a view started the update (`inf:update:asked`). */
  asked?: (from: string) => void;
  /** How long a window that was opened has to say it is here. */
  windowWaitMs?: number;
  /** How often the opened window is looked for meanwhile. */
  windowEveryMs?: number;
};

/** How long an opened window has to say it is here before the update says it did not start. */
const WINDOW_WAIT_MS = 60_000;
const WINDOW_EVERY_MS = 500;

/**
 * This computer's own update, as any paired view reads, starts and lets it
 * go (`inf:home-update:*`). It offers only what the Version row here offers:
 * a copy that updates through Homebrew, an unconfirmed one, or one whose
 * installer asks for a password says why and offers nothing from afar.
 */
export function createHomeUpdates(options: HomeUpdatesOptions): {
  status: () => Promise<HomeUpdate>;
  install: (from?: string) => Promise<HomeUpdate>;
  later: () => Promise<HomeUpdate>;
  /** This first mate's own update status, naming the view that started one under way. */
  own: () => Promise<UpdateStatus>;
} {
  const asked = new AskedInstall(options.updates);
  const window = options.window;
  /** The window is being opened to install the update for this view. */
  let starting: string | null = null;
  let problem: string | null = null;

  const read = async (): Promise<UpdateStatus> => {
    if (!window) return asked.status();
    // A closed window cannot say how its update stands: this first mate reads the same
    // installation and channel, and nothing is under way without the window.
    if (!window.open()) return options.updates.getStatus();
    try {
      return await window.ask("status");
    } catch {
      return options.updates.getStatus();
    }
  };

  const said = (status: UpdateStatus): HomeUpdate => {
    const install = status.install;
    const fromAfar = install !== undefined && !install.asksPassword;
    return homeUpdateOf(status, options.stops(), {
      fromAfar,
      why:
        install?.asksPassword === true
          ? m.viewHomeUpdateAsksPassword()
          : (status.problem ?? m.viewHomeUpdateAtComputer()),
      starting: starting !== null || asked.underWay(),
      problem,
    });
  };

  const status = async () => said(await read());

  /** Opens the window and waits for it to say it is here; false when it did not come. */
  const windowHere = async (target: UpdatingWindow): Promise<boolean> => {
    if (target.open()) return true;
    if (!target.start) return false;
    target.start();
    const until = Date.now() + (options.windowWaitMs ?? WINDOW_WAIT_MS);
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, options.windowEveryMs ?? WINDOW_EVERY_MS));
      if (target.open()) return true;
    }
    return false;
  };

  const install = async (from?: string): Promise<HomeUpdate> => {
    const before = said(await read());
    // Only what the Version row here offers, and nothing twice.
    if (before.step !== "offered" && before.step !== "failed") return before;
    if (before.offered === null) return before;
    problem = null;
    if (!window) {
      asked.start(from);
      if (from) options.asked?.(from);
      return status();
    }
    if (window.open()) {
      await window.ask("install", from).catch(() => {});
      return status();
    }
    if (starting !== null) return before;
    starting = from ?? "";
    void windowHere(window)
      .then(async (here) => {
        if (!here) {
          problem = m.viewHomeUpdateNoWindow();
          return;
        }
        await window.ask("install", from);
      })
      .catch((error: unknown) => {
        problem = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        starting = null;
      });
    return status();
  };

  const later = async (): Promise<HomeUpdate> => {
    if (!window) return said(await asked.later());
    if (window.open()) return said(await window.ask("later").catch(() => read()));
    return status();
  };

  return { status, install, later, own: () => asked.status() };
}
