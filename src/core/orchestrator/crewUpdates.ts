import { LOCAL_MACHINE_ID } from "../session/session";
import { QUIT_SETTLE_MS, type TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import type { RestartWatch } from "./restartWatch";

/** How a save for this computer's own update ended (`saveForUpdate`). */
export type UpdateSaveOutcome = "saved" | "withdrawn";

/** One turn this computer's own update stops (`stopForUpdate`). */
type UpdateTurn = {
  task: TaskRuntime;
  /** The lane row that carries it on. */
  row: number;
  /** Withdraws the stop while it still waits. */
  withdraw: AbortController;
  /** How many calls it runs that the stop waits for. */
  running: number;
  /** Resolves once the turn has ended here, or the stop was withdrawn. */
  ended: Promise<void>;
};

/** This computer's own update while it saves the crew's work (`saveForUpdate`). */
type LocalUpdate = {
  turns: Map<string, UpdateTurn>;
  /** Tells the update which tasks' running work it waits for now. */
  report: () => void;
  /** Every turn here has stopped: the copy may be replaced. */
  saved: boolean;
  /** The save under way, which a second ask joins. */
  saving: Promise<UpdateSaveOutcome>;
};

/** A paused task's timeline line while this computer is updated. */
const UPDATE_PAUSE_NOTE = "paused while Infinitary is updated";

/** What the crew's updates reach of the supervisor beyond its options. */
export type CrewUpdatesHost = {
  now(): number;
  /** The crew a restart or an update cut, watched until each carries on. */
  readonly restarts: RestartWatch;
  /** The app is quitting: nothing is paused, saved or carried on now. */
  disposed(): boolean;
  /** Every crewmate open here now. */
  runtimes(): Iterable<TaskRuntime>;
  /** Where a task's crewmate runs: the computer that runs work its record names, or this Mac. */
  machineOf(taskId: string): string;
  /** Resolves once the task's running turn here has ended, at once when none runs. */
  untilTurnOver(task: TaskRuntime): Promise<void>;
  /** Deliver what is due on a task's lane now. */
  sweepTaskLane(taskId: string, now: number): Promise<void>;
  /** Run the ready sweep now. */
  sweepGates(now: number): Promise<void>;
  /** Tell the window the crew's counts changed. */
  broadcastCrewCounts(): void;
};

/**
 * The crew's side of an update (docs/helper.md, "Updated by its home";
 * docs/alpha.md, "Saving work before an update"): a computer that runs
 * work pauses its crewmates while its home updates it, and this computer
 * saves its own crew's work before its copy is replaced, then carries on.
 */
export class CrewUpdates {
  /**
   * The computers being updated now, each by its device id with its name:
   * their crewmates wait as for a computer out of reach (`outOfReach`)
   * until the update is over and the computer is back and caught up.
   */
  private readonly updating = new Map<string, string>();
  /**
   * This computer's own update while it saves its crew's work and until
   * the copy is replaced or the update is let go (`saveForUpdate`): no
   * turn here starts, and each one running stops where nothing is lost.
   */
  private localUpdate: LocalUpdate | undefined;

  constructor(
    private readonly options: Pick<CrewSupervisorOptions, "inbox" | "machines" | "tasks">,
    private readonly host: CrewUpdatesHost,
  ) {}

  /** A computer that runs work is being updated now (`pauseForUpdate`). */
  isUpdating(deviceId: string): boolean {
    return this.updating.has(deviceId);
  }

  /** This computer's own update is saving its crew's work, or saved it and has not replaced the copy. */
  updatingHere(): boolean {
    return this.localUpdate !== undefined;
  }

  /** Every turn this computer's own update stopped has ended: the copy may be replaced. */
  savedHere(): boolean {
    return this.localUpdate?.saved === true;
  }

  /**
   * This computer is being updated and the task's turns run here
   * (`saveForUpdate`): nothing starts a turn for it until the update is
   * over, and what it is sent waits on its lane in order.
   */
  heldForUpdate(taskId: string): boolean {
    return this.localUpdate !== undefined && this.host.machineOf(taskId) === LOCAL_MACHINE_ID;
  }

  /** A turn began while its computer is being updated: it stops too. */
  turnBegan(task: TaskRuntime): void {
    const computer = this.updating.get(this.host.machineOf(task.id));
    if (computer !== undefined) void this.pauseTurn(task, computer);
    if (this.localUpdate && this.heldForUpdate(task.id)) this.stopForUpdate(task, this.localUpdate);
  }

  /**
   * The computer is about to be updated (docs/helper.md, "Updated by its
   * home"): each crewmate turn running there stops, as a pause and never a
   * failure, and nothing is handed to its crew until the update is over
   * and the computer is back and caught up (`outOfReach`). The update
   * waits, at most `QUIT_SETTLE_MS`, for the stopped turns to end there,
   * so each conversation is written down before its computer stops.
   */
  async pauseForUpdate(deviceId: string): Promise<void> {
    if (this.host.disposed() || this.updating.has(deviceId)) return;
    const computer = this.options.machines?.nameOf(deviceId) ?? deviceId;
    this.updating.set(deviceId, computer);
    const stopping = [...this.host.runtimes()]
      .filter((task) => task.state === "streaming" && this.host.machineOf(task.id) === deviceId)
      .map((task) => this.pauseTurn(task, computer));
    if (stopping.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, QUIT_SETTLE_MS);
    });
    await Promise.race([Promise.all(stopping), bound]).finally(() => clearTimeout(timer));
  }

  /**
   * The update is over, whatever came of it: the computer's crew carries
   * on, each paused crewmate with the lane row its pause left - once the
   * computer is back and caught up (`placedCaughtUp`), or now when it
   * never stopped.
   */
  resumeAfterUpdate(deviceId: string): void {
    if (!this.updating.delete(deviceId) || this.host.disposed()) return;
    const now = this.host.now();
    for (const taskId of this.options.inbox.recipientsWithRows())
      if (this.host.machineOf(taskId) === deviceId) void this.host.sweepTaskLane(taskId, now);
    void this.host.sweepGates(now);
    this.host.broadcastCrewCounts();
  }

  /**
   * One crewmate's turn stops for its computer's update: a lane row says
   * why, for the turn that carries it on, and the turn's end there is a
   * pause (`turnComplete`). No interrupt is recorded, so a kept merge
   * approval stands.
   */
  private async pauseTurn(task: TaskRuntime, computer: string): Promise<void> {
    if (task.paused || task.cancelled || !task.session) return;
    const row = this.options.inbox.enqueue(task.id, {
      facts: { kind: "turn-resumed", stopped: "update", computer },
    });
    task.paused = { computer, row };
    this.host.restarts.observe(task.id);
    this.host.restarts.recordRestartOutcome(
      task.id,
      "waiting",
      `Infinitary on ${computer} is being updated`,
    );
    this.options.tasks.note(task.id, `paused while Infinitary on ${computer} is updated`, {
      news: true,
    });
    try {
      await task.session.abort();
    } catch (caught) {
      // Its end comes with the update instead, and is read as the pause.
      console.warn("[crew] a paused turn could not be stopped:", caught);
    }
  }

  /**
   * This computer's own copy is about to be replaced (docs/alpha.md,
   * "Saving work before an update"). No new turn starts here and what the
   * crew is sent waits on its lanes in order (`heldForUpdate`); each turn
   * running here stops where nothing is lost - the calls it runs finish and
   * keep their results, the ones it would start are refused and say so,
   * and then the turn is cut, with a lane row that carries it on after the
   * restart. Resolves `saved` once every turn here has stopped, with no
   * bound, telling `waiting` meanwhile which tasks' running work it waits
   * for. Aborting `signal` lets the update go (`releaseUpdate`) and
   * resolves `withdrawn`. A second ask joins the first. Turns on other
   * computers go on there, and an idle or paused task is left as it is.
   */
  saveForUpdate(
    options: { signal?: AbortSignal; waiting?: (tasks: string[]) => void } = {},
  ): Promise<UpdateSaveOutcome> {
    if (this.localUpdate) return this.localUpdate.saving;
    if (this.host.disposed()) return Promise.resolve("saved");
    const turns = new Map<string, UpdateTurn>();
    const report = () =>
      options.waiting?.(
        [...turns.values()].filter((turn) => turn.running > 0).map((turn) => turn.task.title),
      );
    const update: LocalUpdate = { turns, report, saved: false, saving: Promise.resolve("saved") };
    this.localUpdate = update;
    for (const task of [...this.host.runtimes()])
      if (task.state === "streaming" && this.heldForUpdate(task.id))
        this.stopForUpdate(task, update);
    update.saving = this.saveTurns(update, options.signal);
    return update.saving;
  }

  /** Waits for every turn the update stops, including one that began meanwhile. */
  private async saveTurns(update: LocalUpdate, signal?: AbortSignal): Promise<UpdateSaveOutcome> {
    let letGo = () => {};
    const withdrawn = new Promise<"withdrawn">((resolve) => {
      letGo = () => resolve("withdrawn");
    });
    if (signal?.aborted) letGo();
    else signal?.addEventListener("abort", letGo, { once: true });
    try {
      for (let asked = -1; asked !== update.turns.size; ) {
        asked = update.turns.size;
        const ended = Promise.all([...update.turns.values()].map((turn) => turn.ended));
        const outcome = await Promise.race([ended.then(() => "saved" as const), withdrawn]);
        if (this.localUpdate !== update) return "withdrawn";
        if (outcome === "withdrawn") {
          this.releaseUpdate();
          return "withdrawn";
        }
      }
      update.saved = true;
      update.report();
      return "saved";
    } finally {
      signal?.removeEventListener("abort", letGo);
    }
  }

  /**
   * One crewmate's turn here stops for this computer's update: a lane row
   * says why for the turn that carries it on, and its end is a pause
   * (`turnComplete`). A session that cannot hold its calls is cut.
   */
  private stopForUpdate(task: TaskRuntime, update: LocalUpdate): void {
    const session = task.session;
    if (update.turns.has(task.id) || task.cancelled || !session) return;
    const row = this.options.inbox.enqueue(task.id, {
      facts: { kind: "turn-resumed", stopped: "update" },
    });
    task.paused = { row };
    this.host.restarts.observe(task.id);
    this.host.restarts.recordRestartOutcome(task.id, "waiting", "Infinitary is being updated");
    this.options.tasks.note(task.id, UPDATE_PAUSE_NOTE, { news: true });
    const withdraw = new AbortController();
    const turn: UpdateTurn = { task, row, withdraw, running: 0, ended: Promise.resolve() };
    const stopped = session.stopSafely
      ? session.stopSafely({
          signal: withdraw.signal,
          waiting: (calls) => {
            turn.running = calls.length;
            update.report();
          },
        })
      : session.abort().then(() => "stopped" as const);
    turn.ended = stopped
      .catch((caught: unknown) => {
        // Its end comes with the update instead, and is read as the pause.
        console.warn("[crew] a paused turn could not be stopped:", caught);
        return "stopped" as const;
      })
      .then((outcome) => {
        turn.running = 0;
        if (outcome === "stopped") return this.host.untilTurnOver(task);
        // Let go before it was cut: the turn goes on as if never asked.
        if (task.paused?.row === row) {
          task.paused = undefined;
          this.options.inbox.withdraw([row]);
          this.host.restarts.forget(task.id);
        }
      });
    update.turns.set(task.id, turn);
    update.report();
  }

  /**
   * This computer's update was let go, or did not replace the copy
   * (docs/alpha.md, "Saving work before an update"): a turn still stopping
   * goes on as if never asked, one that stopped carries on from its lane
   * row, and what waited on the lanes goes now, in order.
   */
  releaseUpdate(): void {
    const update = this.localUpdate;
    if (!update) return;
    this.localUpdate = undefined;
    for (const turn of update.turns.values()) turn.withdraw.abort();
    if (this.host.disposed()) return;
    const now = this.host.now();
    for (const taskId of this.options.inbox.recipientsWithRows())
      if (this.host.machineOf(taskId) === LOCAL_MACHINE_ID)
        void this.host.sweepTaskLane(taskId, now);
    void this.host.sweepGates(now);
    this.host.broadcastCrewCounts();
  }

  /**
   * The tasks whose turn this computer's own update stopped and which have
   * not started again, by title: the update's Resuming work.
   */
  resumingAfterUpdate(): string[] {
    const titles: string[] = [];
    for (const taskId of this.options.inbox.recipientsWithRows()) {
      const waits = this.options.inbox
        .allFor(taskId)
        .some(
          (row) =>
            row.deliveredAt === null &&
            row.facts?.kind === "turn-resumed" &&
            row.facts.stopped === "update" &&
            row.facts.computer === undefined,
        );
      const title = waits ? this.options.tasks.get(taskId)?.title : undefined;
      if (title) titles.push(title);
    }
    return titles;
  }
}
