import { FIRST_CREWMATE_NOTE } from "@shared/firstCrewmateNote";
import type { CrewWord, FirstRunRecord, FirstRunView, FreshCheck } from "@shared/firstRun";
import type { CardService } from "./orchestrator/cardService";
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
  /** Any saved sign-in or connection, working or not (docs/view.md, "A Mac that runs work"). */
  hasAccounts?: () => boolean;
  /** The profile has had a crewmate (a task on the board), so its colors need no teaching. */
  hasCrewHistory: () => boolean;
  /** A task of the captain's has closed done (`TaskService.hasFinishedTask`). */
  hasFinishedTask: () => boolean;
  /** Three of the captain's crewmates have finished their tasks (`TaskService.finishedCrewmates`). */
  thirdCrewmateDone: () => boolean;
  /** Commit the note, completed answer and consume callback in one transaction, then publish. */
  createWelcome: (consume: (cardId: string) => void) => void;
  /**
   * Commit the first crewmate's note with the record callback in one
   * transaction, then publish; put away the welcome first when it is open.
   */
  createFirstCrewmateNote: (record: (cardId: string) => void, welcomeCardId?: string) => void;
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
  tasks: Pick<TaskService, "list"> & { capture: Pick<TaskService["capture"], "listAsks"> };
  cards: Pick<CardStore, "hasHistory">;
  repos: Pick<RepoRegistry, "list">;
}): boolean {
  return (
    sources.tasks.list().some((task) => task.kind !== "operation") ||
    sources.tasks.capture.listAsks().length > 0 ||
    sources.cards.hasHistory() ||
    sources.repos.list().some((repo) => repo.kind !== "personal")
  );
}

/** The finished crewmates the create-your-own-panel slot waits for (captain, 2026-10-12; docs/first-launch.md). */
const SLOT_CREWMATES = 3;

/**
 * The crew facts the first-run record is decided from, each a seeking read
 * of the task record: the first read of a record that lacks them runs at
 * boot, inside the startup stretch, and composing every task there held
 * the main thread on a long record (INF-2338). Crew history is a `work`
 * task on the board; `firstTaskDoneAt` (kept for a view on an older
 * version) waits on a finished task of the captain's; the slot waits on
 * its third finished crewmate.
 */
export function crewFacts(
  tasks: Pick<TaskService, "hasKind" | "hasFinishedTask" | "finishedCrewmates">,
): Pick<FirstRunOptions, "hasCrewHistory" | "hasFinishedTask" | "thirdCrewmateDone"> {
  return {
    hasCrewHistory: () => tasks.hasKind("work"),
    hasFinishedTask: () => tasks.hasFinishedTask(),
    thirdCrewmateDone: () => tasks.finishedCrewmates(SLOT_CREWMATES) >= SLOT_CREWMATES,
  };
}

/**
 * How the first crewmate's note goes up (docs/first-launch.md "The first
 * crewmate's note"). The welcome steps aside for it (INF-5532, the
 * captain's "replace"): one card at a time, so the crewmate's first card
 * arrives on an open stage rather than behind the welcome. Like the
 * welcome, the note takes no reply and is the regular card its picture was
 * drawn for.
 */
export function presentFirstCrewmateNote(
  cards: Pick<CardService, "addRecordedFirstmateNote" | "has" | "takeDown">,
): FirstRunOptions["createFirstCrewmateNote"] {
  return (record, welcomeCardId) => {
    if (welcomeCardId && cards.has(welcomeCardId)) {
      cards.takeDown(welcomeCardId, "first-crewmate-started");
    }
    cards.addRecordedFirstmateNote(FIRST_CREWMATE_NOTE, record, {
      replies: false,
      width: "regular",
    });
  };
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
      if (
        record.workingWordAt === undefined ||
        record.idleWordAt === undefined ||
        record.firstCrewmateAt === undefined
      ) {
        // Decided once, before a first crewmate can exist on a new profile.
        const taught = this.options.hasCrewHistory() ? this.now() : null;
        record = {
          ...record,
          workingWordAt: record.workingWordAt ?? taught,
          idleWordAt: record.idleWordAt ?? taught,
          firstCrewmateAt: record.firstCrewmateAt ?? taught,
        };
        this.options.settings.setFirstRun(record);
      }
      if (record.firstTaskDoneAt === undefined && this.options.hasFinishedTask()) {
        // At boot for a profile that already has finished work, and at the
        // first read after a task closes (the window reads it again then).
        record = { ...record, firstTaskDoneAt: this.now() };
        this.options.settings.setFirstRun(record);
      }
      if (record.thirdCrewmateDoneAt === undefined && this.options.thirdCrewmateDone()) {
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
    const record = this.options.settings.getFirstRun();
    // Nothing done here yet: no turn, no saved sign-in or connection, and no
    // ask, task, card or project. Only then may a home that added this
    // computer take it over in place (docs/view.md, "A Mac that runs work").
    const untouched =
      open &&
      record.firstTurnAt === null &&
      !freshCheck &&
      !this.options.hasAccounts?.() &&
      !this.options.hasActivity();
    return {
      ...record,
      gateOpen: open,
      ...(freshCheck ? { freshCheck } : {}),
      ...(untouched ? { untouched: true as const } : {}),
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

  /**
   * A crewmate started (docs/first-launch.md "The first crewmate's note"):
   * the profile's first start is recorded once, and on a profile that had
   * the welcome it presents the note in the same commit. A profile whose
   * record was never read, or that is past its first start, gets nothing.
   */
  noteCrewmateStarted(): void {
    const record = this.options.settings.getFirstRun();
    if (record.firstCrewmateAt !== null) return;
    const at = this.now();
    try {
      if (record.welcomeState !== "consumed") {
        this.options.settings.setFirstRun({ ...record, firstCrewmateAt: at });
        return;
      }
      this.options.createFirstCrewmateNote((cardId) => {
        this.options.settings.setFirstRun({
          ...record,
          firstCrewmateAt: at,
          firstCrewmateNoteId: cardId,
        });
      }, record.welcomeCardId);
    } catch (error) {
      // A failed note never holds the crewmate's start; the next start tries again.
      console.warn("[first-run] the first crewmate's note could not be committed:", error);
    }
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
