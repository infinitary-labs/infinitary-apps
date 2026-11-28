import { randomBytes } from "node:crypto";
import type { startCore } from "@core/index";
import { seedTask } from "@core/tasks/seedTask";

type Core = Awaited<ReturnType<typeof startCore>>;

/** The three states of a background-work wait that the phone's record words differently. */
export const BACKGROUND_WAIT_STATES = ["started", "check-back", "unknown"] as const;
export type BackgroundWaitState = (typeof BACKGROUND_WAIT_STATES)[number];

/**
 * Seeds a task whose wait is background work in one state: `started` (a known start, no check-back),
 * `check-back` (a crewmate's check-back owns the wait and the job began an hour earlier) or `unknown`
 * (running with no known start). A real job or client report needs a running crewmate, so the wait
 * facts and the job posture of a seeded task are fixture inputs read from here; the real wait
 * projection and board read build the wait from them. The answer names the task, the job's start
 * (absent when unknown) and the wait as the board read gives it.
 */
export function phoneBackgroundWaits(core: Core) {
  const seeded = new Map<string, { jobSince?: number; timerOwned: boolean }>();
  const postures = core.services.supervisor.postures;
  const realFacts = postures.workWaitFacts.bind(postures);
  const realPosture = postures.workPosture.bind(postures);
  postures.workWaitFacts = (record) => {
    const own = seeded.get(record.id);
    if (!own) return realFacts(record);
    const { jobSince, timerOwned } = own;
    return { job: true, timerOwned, ...(jobSince !== undefined ? { jobSince } : {}) };
  };
  postures.workPosture = (record) =>
    seeded.has(record.id) ? { state: "active", reason: "job" } : realPosture(record);
  return {
    async seed(state: unknown) {
      if (!BACKGROUND_WAIT_STATES.includes(state as BackgroundWaitState))
        throw new Error(`background-wait-fixture takes ${BACKGROUND_WAIT_STATES.join(", ")}`);
      const id = `native-background-${state}-${randomBytes(6).toString("hex")}`;
      const owned = state === "check-back";
      const jobSince = state === "unknown" ? undefined : Date.now() - (owned ? 82 : 22) * 60_000;
      seeded.set(id, { timerOwned: owned, ...(jobSince !== undefined ? { jobSince } : {}) });
      const work = seedTask(core.services.tasks, {
        id,
        title: `Background work ${state}`,
        status: "running",
      });
      if (owned)
        core.services.tasks.turns.recordReport(id, {
          text: "Waiting for the website build.",
          declared: { checkBack: { minutes: 30, waitingFor: "Website build" } },
        });
      const board = await core.dispatch("inf:tasks:board", []);
      const wait = board.tasks.find((row) => row.id === id)?.waits?.find((w) => w.kind === "job");
      return {
        taskId: id,
        key: work.key,
        title: work.title,
        state,
        ...(jobSince !== undefined ? { jobSince } : {}),
        wait,
      };
    },
  };
}
