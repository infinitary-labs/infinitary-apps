import type { ResetScope } from "@shared/reset";

/**
 * What the first mate's own side undoes before a reset wipes its folder
 * (docs/reset.md, "Before it quits"): everything the folder's deletion alone
 * would leave answering, running or listed somewhere else. Each step is
 * capped, so nothing remote holds the reset up, and none stops the next: the
 * folder goes at the next start whatever these left.
 */
export type ResetPrepareDeps = {
  /** Paired phones and computers, by id. */
  devices: () => readonly { id: string }[];
  /** Takes one off the list; a connected one hears it was removed. */
  removeDevice: (id: string) => unknown;
  /** Signed-in accounts, by id. */
  accounts: () => readonly { id: string }[];
  /** Signs one out with its provider, as Settings' Remove does. */
  signOut: (id: string) => Promise<unknown>;
  /** Integrations, by id. */
  integrations: () => readonly { id: string }[];
  /** Removes one, revoking its sign-in where its service offers that. */
  removeIntegration: (id: string) => Promise<unknown>;
  /** Open and started tasks, by id. */
  openTasks: () => readonly { id: string }[];
  /** Closes one as discarded, so its registered stops and keeps run. */
  discardTask: (id: string) => Promise<unknown>;
  /** Waits until a closed task's stops and keeps have run. */
  leftoversSettled: (id: string) => Promise<unknown>;
  /** Jobs kept running past their task, by id. */
  keptJobs: () => readonly { id: string }[];
  /** Runs one's own remove command. */
  removeKeptJob: (id: string) => Promise<{ removed: boolean }>;
  /** Projects that live outside the data folder, by their folder. */
  projects: () => readonly string[];
  /** Undoes the settings Infinitary wrote into one (`undoProjectSettings`). */
  undoProject: (folder: string) => Promise<unknown>;
  /** Waits up to `ms` for `work`, then goes on; a step never holds the reset longer. */
  within?: <T>(work: Promise<T>, ms: number) => Promise<T | "timed-out">;
};

/** How long one remote step may take: a sign-out, an integration's revoke. */
export const RESET_STEP_MS = 5_000;
/** How long a closed task's stops and keeps, and a kept job's remove, may take together. */
export const RESET_PROGRAMS_MS = 60_000;

export function resetScope(deps: ResetPrepareDeps): ResetScope {
  return { tasks: deps.openTasks().length };
}

/** Undoes each kind in turn; a step that fails or times out never stops the next. */
export async function prepareReset(deps: ResetPrepareDeps): Promise<{ ok: true }> {
  const within = deps.within ?? withinMs;
  const attempt = async (work: () => unknown, ms: number): Promise<boolean> => {
    try {
      const outcome = await within(Promise.resolve().then(work), ms);
      return outcome !== "timed-out";
    } catch {
      return false;
    }
  };

  // Devices first, while the connection still runs: a phone or computer
  // that hears it was removed stops dialing a first mate that is going.
  for (const device of deps.devices())
    await attempt(() => deps.removeDevice(device.id), RESET_STEP_MS);

  // Tasks close as discarded, so each one's stops end what it started and
  // each keep's remove runs, before the folder holding their records goes.
  const tasks = deps.openTasks().map((task) => task.id);
  await Promise.all(tasks.map((id) => attempt(() => deps.discardTask(id), RESET_PROGRAMS_MS)));
  await attempt(() => Promise.all(tasks.map((id) => deps.leftoversSettled(id))), RESET_PROGRAMS_MS);

  for (const job of deps.keptJobs()) {
    await attempt(() => deps.removeKeptJob(job.id), RESET_PROGRAMS_MS);
  }

  for (const folder of deps.projects())
    await attempt(() => deps.undoProject(folder), RESET_STEP_MS);

  for (const account of deps.accounts())
    await attempt(() => deps.signOut(account.id), RESET_STEP_MS);
  for (const integration of deps.integrations())
    await attempt(() => deps.removeIntegration(integration.id), RESET_STEP_MS);

  return { ok: true };
}

/** Waits up to `ms` for `work`, then answers "timed-out" and goes on. */
export function withinMs<T>(work: Promise<T>, ms: number): Promise<T | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed-out">((done) => {
    timer = setTimeout(() => done("timed-out"), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
