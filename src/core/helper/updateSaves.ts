import { UPDATE_RETURN_MS } from "@shared/workUpdate";
import type { ModelSession } from "../session/session";
import type { PlacedTaskState } from "./placedTasks";

/**
 * Its home's update of this computer, saving the crew's work here first
 * (docs/helper.md, "Saving its work before an update"). `SessionHost` holds
 * the conversations and answers the home's orders; this keeps the save
 * while it holds and what it did to each task's turn.
 */

/** What the save reads and writes of a conversation `SessionHost` holds here. */
export type SavedConversation = {
  readonly task: string;
  state: PlacedTaskState;
  session: ModelSession | null;
  /** The newest event number the home said it has. */
  through: number;
  /** Settles once the prompt's turn running here has ended and its end is written. */
  turnOver: Promise<void> | undefined;
  /** Its folder was removed: nothing of it is written again. */
  removed: boolean;
};

/** What the save asks of `SessionHost`, which holds the conversations. */
export type UpdateSavesHost<H extends SavedConversation> = {
  readonly held: ReadonlyMap<string, H>;
  stopped(): boolean;
  /** Whether the conversation is working (`SessionHost.busy`). */
  busy(held: H): boolean;
  /** Writes its events and state to disk now. */
  writeOut(held: H): void;
  /** Resolves once the home has every event written before now, or refused them. */
  flushed(held: H): Promise<void>;
  log(line: string): void;
  /** `SessionHostOptions.updateReturnMs`: a test's shorter wait than `UPDATE_RETURN_MS`. */
  updateReturnMs: number | undefined;
};

/**
 * Its home's update of this computer while it saves the crew's work, until
 * the update ends this run or the save is let go (`saveForUpdate`).
 */
type UpdateSave = {
  /** Withdraws each stop still waiting (`releaseUpdate`). */
  readonly withdraw: AbortController;
  /** Each task's latest stop, settled once its turn ended here or it was withdrawn. */
  readonly stops: Map<string, Promise<void>>;
  /** Each task whose stop is under way now. */
  readonly stopping: Set<string>;
  /** How many stops it asked for, a later turn's of the same task included. */
  asked: number;
  /** Resolves once every turn here stopped and the home has every end. */
  saving: Promise<void>;
  /** Lets the save go here when the home says nothing for `UPDATE_RETURN_MS` after it saved. */
  timer: NodeJS.Timeout | undefined;
};

/**
 * What the save answers: each task whose turn an update's save stopped here
 * and still marks stopped (`updateStop`): no turn has started there since,
 * nor a later save once the home had that turn's end.
 */
type UpdateSaveAnswer = { stopped: string[] };
/** What the let-go answers besides: each task whose stop it withdrew. */
type UpdateReleaseAnswer = UpdateSaveAnswer & { withdrawn: string[] };

export class UpdateSaves<H extends SavedConversation> {
  /** Its home's update while it saves the crew's work here (`saveForUpdate`). */
  private updateSave: UpdateSave | undefined;

  constructor(private readonly host: UpdateSavesHost<H>) {}

  /** No turn starts here while a save holds. */
  get holding(): boolean {
    return this.updateSave !== undefined;
  }

  /** A turn its crewmate began carrying on by itself stops too, while a save holds. */
  carriedOn(held: H): void {
    if (this.updateSave) this.stopForUpdate(held, this.updateSave);
  }

  /** This computer stops: a save is never let go by itself after. */
  close(): void {
    clearTimeout(this.updateSave?.timer);
  }

  /**
   * Its home is about to update this computer (docs/helper.md, "Saving its
   * work before an update"): no turn starts here until the update ends this
   * run or the save is let go, and each conversation working here stops
   * where nothing is lost - its running calls finish and keep their
   * results, the ones it would start are refused and say so, and then its
   * turn is cut; so does a turn its crewmate carries on by itself
   * meanwhile. Answers once every stopped turn's end is written here and
   * the home has every event, so what the crew did is kept on both sides
   * before anything here stops. A second ask joins the first. This
   * computer decides when it is saved, and lets the save go by itself when
   * the home asks nothing for `UPDATE_RETURN_MS` after that (`homeAsked`).
   */
  async saveForUpdate(): Promise<UpdateSaveAnswer> {
    let save = this.updateSave;
    if (!save) {
      const own: UpdateSave = {
        withdraw: new AbortController(),
        stops: new Map(),
        stopping: new Set(),
        asked: 0,
        saving: Promise.resolve(),
        timer: undefined,
      };
      this.updateSave = own;
      for (const held of this.host.held.values()) {
        // An earlier save's stop whose end the home already took is over
        // there: this save names its own, and one whose end the home lacks.
        if (held.state.updateStop && held.through >= held.state.seq) {
          held.state = { ...held.state, updateStop: undefined };
          this.host.writeOut(held);
        }
        this.stopForUpdate(held, own);
      }
      own.saving = this.saveTurns(own);
      save = own;
    }
    // Asked again: the home is still there, so the wait starts over.
    clearTimeout(save.timer);
    save.timer = undefined;
    await save.saving;
    if (this.updateSave === save && !this.host.stopped()) {
      const own = save;
      own.timer = setTimeout(() => {
        if (this.updateSave !== own) return;
        // i18n-exempt: this computer's own log.
        this.host.log("its home did not update it after saving its work, so it carries on");
        void this.releaseUpdate();
      }, this.host.updateReturnMs ?? UPDATE_RETURN_MS);
      own.timer.unref?.();
    }
    return { stopped: this.updateStops("stopped") };
  }

  /**
   * Waits for every stop, including one a turn begun meanwhile needed, then
   * for the home to have every event written by then.
   */
  private async saveTurns(save: UpdateSave): Promise<void> {
    for (let asked = -1; asked !== save.asked; ) {
      asked = save.asked;
      await Promise.all(save.stops.values());
      if (this.updateSave !== save) return;
      const kept = [...this.host.held.values()].filter((held) => !held.removed);
      await Promise.all(kept.map((held) => this.host.flushed(held)));
    }
  }

  /**
   * Its home asked something: a saved update's wait for it starts over, so
   * a long download or build there for the update never lets the save go.
   */
  homeAsked(): void {
    this.updateSave?.timer?.refresh();
  }

  /**
   * One conversation working here stops for the update: safely when its
   * session can hold its calls, cut when it cannot. A turn the stop cut is
   * the save's, so its home carries it on after the update. A later turn
   * of a task whose earlier one the save already stopped stops too. What
   * each stop came to is kept in the task's state (`markStop`).
   */
  private stopForUpdate(held: H, save: UpdateSave): void {
    const session = held.session;
    if (!session || held.state.closed || save.stopping.has(held.task) || !this.host.busy(held))
      return;
    const stopping = session.stopSafely
      ? session.stopSafely({ signal: save.withdraw.signal })
      : session.abort().then(() => "stopped" as const);
    save.stopping.add(held.task);
    save.asked += 1;
    this.markStop(held, "stopping");
    save.stops.set(
      held.task,
      stopping
        .catch((caught: unknown) => {
          // i18n-exempt: this computer's own log.
          this.host.log(`could not stop ${held.task} safely: ${messageOf(caught)}`);
          return "stopped" as const;
        })
        .then(async (outcome) => {
          if (outcome !== "stopped") {
            this.markStop(held, "withdrawn");
            return;
          }
          this.markStop(held, "stopped");
          await held.turnOver;
        })
        .finally(() => save.stopping.delete(held.task)),
    );
  }

  /**
   * The update did not replace this copy, or was let go: a stop still
   * waiting is withdrawn and its turn goes on as if never asked, and turns
   * start here again. Answers once each stop settled, naming every task
   * whose turn the save stopped, which its home carries on, and every one
   * whose stop it withdrew, whose turn its home lets go on - the same after
   * a restart here or once it let the save go by itself (`markStop`).
   */
  async releaseUpdate(): Promise<UpdateReleaseAnswer> {
    const save = this.updateSave;
    if (save) {
      this.updateSave = undefined;
      clearTimeout(save.timer);
      save.withdraw.abort();
      await Promise.all(save.stops.values());
    }
    return { stopped: this.updateStops("stopped"), withdrawn: this.updateStops("withdrawn") };
  }

  /**
   * Keeps what an update's save did to this task's turn here, through a
   * restart and after the save is let go, until a turn starts here while
   * no save holds (`record`): a let-go asked again, by a home that came back after
   * either, names it as the first would have. A stop the save made stays
   * one when a later turn's stop in the same save is withdrawn; a new save
   * forgets it once the home has that turn's end. A stop that settles after
   * this computer stopped writes nothing: its next start reads the stop it
   * was making as the save's.
   */
  private markStop(held: H, mark: NonNullable<PlacedTaskState["updateStop"]>): void {
    if (this.host.stopped() || (held.state.updateStop === "stopped" && mark !== "stopped")) return;
    held.state = { ...held.state, updateStop: mark };
    this.host.writeOut(held);
  }

  /** Each task whose turn an update's save stopped here, or whose stop it withdrew. */
  private updateStops(mark: "stopped" | "withdrawn"): string[] {
    return [...this.host.held.values()]
      .filter((held) => held.state.updateStop === mark)
      .map((held) => held.task);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
