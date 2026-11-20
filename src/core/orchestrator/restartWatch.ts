import type { CrewStatusEntry } from "../pi/crewTools";
import { RESTART_RESUMED_WORDS } from "../tasks/recordActivity";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";

/** What the restart watch reaches of the supervisor beyond its options. */
export type RestartWatchHost = {
  now(): number;
};

/**
 * The crew a restart or an update cut, watched until each carries on or
 * stops (INF-1272): when it was cut, and the last outcome its timeline
 * says. Observing boot recovery never sends guidance or wakes an agent;
 * writing or reading these facts only records what was seen.
 */
export class RestartWatch {
  /** Each watched task, by id: when it was cut, and the last outcome its timeline said. */
  private readonly restartObservations = new Map<string, { at: number; last?: string }>();

  constructor(
    private readonly options: Pick<CrewSupervisorOptions, "tasks">,
    private readonly host: RestartWatchHost,
  ) {}

  /** Watch a task cut now, starting over when it was already watched. */
  observe(taskId: string): void {
    this.restartObservations.set(taskId, { at: this.host.now() });
  }

  /** Whether a task cut by a restart or an update is still watched. */
  observing(taskId: string): boolean {
    return this.restartObservations.has(taskId);
  }

  /** Stop watching a task, with nothing recorded. */
  forget(taskId: string): void {
    this.restartObservations.delete(taskId);
  }

  /** Every task still watched. */
  observed(): IterableIterator<string> {
    return this.restartObservations.keys();
  }

  /** The latest durable observation, not an inference from the running flag. */
  restartFact(taskId: string): CrewStatusEntry["restart"] {
    const event = this.options.tasks.restartObservation(taskId);
    if (!event) return undefined;
    return { at: new Date(event.at).toISOString(), text: event.text };
  }

  recordRestartOutcome(
    taskId: string,
    outcome: "pending" | "waiting" | "resumed" | "stopped",
    reason?: string,
  ): void {
    const observation = this.restartObservations.get(taskId);
    if (!observation) return;
    const text =
      outcome === "resumed"
        ? RESTART_RESUMED_WORDS
        : outcome === "waiting" || outcome === "pending"
          ? `Has not carried on after the app reopened: ${reason}.`
          : `Stopped after the app reopened: ${reason}.`;
    if (observation.last === text) return;
    observation.last = text;
    this.options.tasks.note(taskId, text, {
      news: outcome !== "pending",
      feed: outcome !== "pending",
      data: {
        journal: true,
        restartOutcome: { reopenedAt: observation.at, outcome, ...(reason ? { reason } : {}) },
      },
    });
    if (outcome === "resumed") this.restartObservations.delete(taskId);
  }
}
