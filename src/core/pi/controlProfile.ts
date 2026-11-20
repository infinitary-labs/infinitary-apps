import type { ControlProfile } from "../session/session";

/**
 * Pi's in-process SDK delivers the whole contract natively. One constant so
 * the factory's declaration and each session's own cannot drift apart.
 */
export const PI_CONTROL_PROFILE: ControlProfile = {
  steer: "native",
  interruptGranularity: "turn",
  quotaEvents: false,
  // The crewmate's bash is the host's own tool (it shadows Pi's blocking
  // builtin), so every background job is in the job registry: an idle Pi
  // crewmate with an empty registry and an empty lane is provably stopped.
  backgroundWork: "host",
  // Pi reports a failed turn as prose; `isAuthFailureMessage` reads it.
  failureSignals: "text",
};
