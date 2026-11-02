import type { UpdateStatus, UpdateWork } from "@shared/update";

/**
 * What an update of this computer's own copy asks of the crew's work here
 * (docs/alpha.md, "Saving work before an update"); the core's crew answers
 * it (`CrewSupervisor.saveForUpdate`). An app with no crew of its own, such
 * as one controlling another computer, has none and saves nothing.
 */
export type CrewWorkForUpdate = {
  /**
   * Stops every turn running here where nothing is lost, telling `waiting`
   * which tasks' running work it waits for; `withdrawn` once `signal`
   * aborts first.
   */
  save: (options: {
    signal: AbortSignal;
    waiting: (tasks: string[]) => void;
  }) => Promise<"saved" | "withdrawn">;
  /** The copy was not replaced: the work it stopped carries on. */
  release: () => void;
  /** The tasks whose turn an update stopped that have not started again, by title. */
  resuming: () => string[];
};

/** One installation's save of the crew's work before its copy is replaced, with Update later. */
export type UpdateSaving = {
  /** The status's `work` now. */
  status: () => UpdateWork | undefined;
  /** Saves the crew's work; false when Update later let the update go first. */
  save: () => Promise<boolean>;
  /** Update later: lets the update go while work is being saved; false when none is. */
  later: () => boolean;
  /** The update did not replace the copy after its work was saved: the work carries on. */
  release: () => void;
};

export function createUpdateSaving(work: CrewWorkForUpdate | undefined): UpdateSaving {
  let saving: { controller: AbortController; tasks: string[] } | undefined;
  // Saved and not let go: the copy is being replaced, and nothing resumes yet.
  let saved = false;
  return {
    status: () => {
      if (saving) return { state: "saving", tasks: saving.tasks };
      if (saved || !work) return undefined;
      const tasks = work.resuming();
      return tasks.length > 0 ? { state: "resuming", tasks } : undefined;
    },
    save: async () => {
      if (!work) return true;
      if (saving) return false;
      const own = { controller: new AbortController(), tasks: [] as string[] };
      saving = own;
      try {
        const outcome = await work.save({
          signal: own.controller.signal,
          waiting: (tasks) => {
            own.tasks = tasks;
          },
        });
        saved = outcome === "saved";
        return saved;
      } finally {
        if (saving === own) saving = undefined;
      }
    },
    later: () => {
      if (!saving) return false;
      saving.controller.abort();
      // Let go now: the status that answers Update later no longer saves.
      saving = undefined;
      return true;
    },
    release: () => {
      saved = false;
      work?.release();
    },
  };
}

/** A status with the crew's work around the update, when there is any. */
export function withUpdateWork(status: UpdateStatus, saving: UpdateSaving): UpdateStatus {
  const work = saving.status();
  return work ? { ...status, work } : status;
}
