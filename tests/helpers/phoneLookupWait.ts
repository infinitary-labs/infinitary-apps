import type { ChildProcess } from "node:child_process";
import { phoneWebLaunchObservationMs } from "./phoneWebStacks.ts";

// INF-1936: retain the approved bounded proxy-sample duration and cadence.
export const phoneDiagnosticSampleSeconds = 5;
export const phoneDiagnosticSampleIntervalMs = 100;

/** Report silence only for the child we spawned. A setuid ps cannot be sampled
 * unprivileged; its capture belongs to the proposed guest-wide kernel reader.
 */
export function observePhoneLookupWait(
  child: ChildProcess,
  stalled: (pid: number) => Promise<void>,
) {
  let observationResult: Promise<void> | undefined;
  let stopped = false;
  const cancel = () => {
    stopped = true;
    clearTimeout(timer);
  };
  const timer = setTimeout(() => {
    if (stopped || child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
      return;
    stopped = true;
    observationResult = stalled(child.pid);
    // The owner joins this result; do not leave a rejection unobserved while lookup is pending.
    void observationResult.catch(() => {});
  }, phoneWebLaunchObservationMs);
  child.stdout?.once("data", cancel);
  child.stderr?.once("data", cancel);
  child.once("exit", cancel);
  child.once("error", cancel);
  child.once("close", cancel);
  return {
    cancel,
    async close() {
      cancel();
      child.stdout?.removeListener("data", cancel);
      child.stderr?.removeListener("data", cancel);
      child.removeListener("exit", cancel);
      child.removeListener("error", cancel);
      child.removeListener("close", cancel);
      await observationResult;
    },
  };
}
