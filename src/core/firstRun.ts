import type { CrewWord, FirstRunRecord, FirstRunView, FreshCheck } from "@shared/firstRun";
import type { CardStore } from "./storage/cardStore";
import type { TaskService } from "./tasks/taskService";
import type { RepoRegistry } from "./workspace/repoRegistry";

export type FirstRunOptions = {
  settings: {
    getFirstRun(): FirstRunRecord;
    setFirstRun(record: FirstRunRecord): void;
  };
  /** The existing derived setup gate, including its pause exception. */
  gateOpen: () => boolean;
  /**
   * The custom connection the Firstmate was chosen on, while its saved
   * checks no longer count; read only while the gate is open.
   */
  freshCheck?: () => FreshCheck | undefined;
  /** The actual selected/automatic model can serve without a known pause. */
  usable: () => boolean;
  /** Prior use (`hasPriorActivity`): asks, tasks, cards (including resolved), or user projects. */
  hasActivity: () => boolean;
  /** The profile has had a crewmate (a task on the board), so its colors need no teaching. */
  hasCrewHistory: () => boolean;
  /** A task of the captain's has closed done (`hasFinishedTask`). */
  hasFinishedTask: () => boolean;
  /** How many of the captain's crewmates have finished their tasks (`finishedCrewmates`). */
  finishedCrewmates: () => number;
  /** Commit the note, completed answer and consume callback in one transaction, then publish. */
  createWelcome: (consume: (cardId: string) => void) => void;
  onStep?: (step: FirstRunStep) => void;
  now?: () => number;
};

export type FirstRunStep = "gate_shown" | "signed_in" | "first_turn";

/**
 * Prior use a new profile has not had (docs/first-launch.md): a task, an ask,
 * any stored card, or a project the captain registered. An `operation` row is
 * bookkeeping, not use: the settled trail of an app change - during setup,
 * the captain's own Settings changes, which are how a new profile gets
 * ready - or a host card's gate row, whose card already counts.
 */
export function hasPriorActivity(sources: {
  tasks: Pick<TaskService, "list" | "listAsks">;
  cards: Pick<CardStore, "hasHistory">;
  repos: Pick<RepoRegistry, "list">;
}): boolean {
  return (
    sources.tasks.list().some((task) => task.kind !== "operation") ||
    sources.tasks.listAsks().length > 0 ||
    sources.cards.hasHistory() ||
    sources.repos.list().some((repo) => repo.kind !== "personal")
  );
}

/**
 * Whether a task of the captain's has closed done (`firstTaskDoneAt`, kept
 * for a view on an older version): work, a decision, or a question that
 * answered one of the captain's messages. A host note - the welcome, a
 * release's note - answers no message, and an `operation` row is the trail
 * of an app change, so neither is a task the captain finished.
 */
export function hasFinishedTask(tasks: Pick<TaskService, "list" | "listAsks">): boolean {
  const answered = new Set(tasks.listAsks().flatMap((ask) => (ask.taskId ? [ask.taskId] : [])));
  return tasks
    .list()
    .some(
      (task) =>
        task.status === "done" &&
        task.kind !== "operation" &&
        (task.kind !== "question" || answered.has(task.id)),
    );
}

/**
 * How many of the captain's crewmates have finished their tasks
 * (docs/first-launch.md "The create-your-own-panel slot"): work a crewmate
 * started that closed done. A question or decision the Firstmate answered
 * itself had no crewmate, work closed done before one started was nobody's,
 * and dropped work did not finish, so none of them counts.
 */
export function finishedCrewmates(tasks: Pick<TaskService, "list">): number {
  return tasks
    .list()
    .filter((task) => task.kind === "work" && task.status === "done" && task.startedAt !== null)
    .length;
}

/** Durable once-only delivery, independent of the derived setup gate. */
export class FirstRunService {
  private lastOpen: boolean | undefined;

  constructor(private readonly options: FirstRunOptions) {}

  /** A readiness read cannot bypass delivery reconciliation. */
  view(): FirstRunView {
    return this.reconcile();
  }

  reconcile(): FirstRunView {
    const open = this.options.gateOpen();
    const was = this.lastOpen;
    this.lastOpen = open;
    if (open && was !== true) this.options.onStep?.("gate_shown");
    if (was === true && !open && this.options.settings.getFirstRun().welcomedAt === null) {
      this.options.onStep?.("signed_in");
    }
    try {
      let record = this.options.settings.getFirstRun();
      if (record.workingWordAt === undefined || record.idleWordAt === undefined) {
        // Decided once, before a first crewmate can exist on a new profile.
        const taught = this.options.hasCrewHistory() ? this.now() : null;
        record = {
          ...record,
          workingWordAt: record.workingWordAt ?? taught,
          idleWordAt: record.idleWordAt ?? taught,
        };
        this.options.settings.setFirstRun(record);
      }
      if (record.firstTaskDoneAt === undefined && this.options.hasFinishedTask()) {
        // At boot for a profile that already has finished work, and at the
        // first read after a task closes (the window reads it again then).
        record = { ...record, firstTaskDoneAt: this.now() };
        this.options.settings.setFirstRun(record);
      }
      if (record.thirdCrewmateDoneAt === undefined && this.options.finishedCrewmates() >= 3) {
        // The same two moments, for the third crewmate's finished task.
        record = { ...record, thirdCrewmateDoneAt: this.now() };
        this.options.settings.setFirstRun(record);
      }
      if (record.welcomeState === undefined || record.welcomeState === "uninitialized") {
        record = {
          ...record,
          welcomeState:
            record.welcomeState === "uninitialized" &&
            open &&
            record.welcomedAt === null &&
            record.firstTurnAt === null &&
            !this.options.hasActivity()
              ? "pending"
              : "skipped",
        };
        this.options.settings.setFirstRun(record);
      }
      if (record.welcomeState === "pending") {
        if (record.firstTurnAt !== null || this.options.hasActivity()) {
          this.options.settings.setFirstRun({ ...record, welcomeState: "skipped" });
        } else if (this.options.usable()) {
          this.options.createWelcome((cardId) => {
            this.options.settings.setFirstRun({
              ...record,
              welcomedAt: this.now(),
              welcomeCardId: cardId,
              welcomeState: "consumed",
            });
          });
        }
      }
    } catch (error) {
      // A failed introduction write is not a setup failure. Pending can
      // retry at the next serving/read reconciliation or boot, without
      // holding otherwise usable input or recording consumption alone.
      console.warn("[first-run] introduction could not be committed:", error);
    }
    const freshCheck = open ? this.options.freshCheck?.() : undefined;
    return {
      ...this.options.settings.getFirstRun(),
      gateOpen: open,
      ...(freshCheck ? { freshCheck } : {}),
    };
  }

  /** Called synchronously at durable captain-turn acceptance, before any await. */
  noteCaptainTurn(): void {
    const record = this.options.settings.getFirstRun();
    if (record.firstTurnAt !== null) return;
    this.options.settings.setFirstRun({
      ...record,
      firstTurnAt: this.now(),
      ...(record.welcomeState === "pending" || record.welcomeState === "uninitialized"
        ? { welcomeState: "skipped" as const }
        : {}),
    });
    this.options.onStep?.("first_turn");
  }

  /** A state word was shown in full: recorded once, never overwritten. */
  noteCrewWord(word: CrewWord): FirstRunView {
    const key = word === "working" ? "workingWordAt" : "idleWordAt";
    const record = this.options.settings.getFirstRun();
    if (record[key] == null) this.options.settings.setFirstRun({ ...record, [key]: this.now() });
    return this.view();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}
