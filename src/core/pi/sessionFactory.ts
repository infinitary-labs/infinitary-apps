import type { SessionFactory } from "../session/session";
import { PI_CONTROL_PROFILE } from "./controlProfile";
import type { PiSessionDeps } from "./session";

/**
 * The host can hold Pi's factory without loading a backend it may never use
 * (Claude seats and injected test sessions included). Only construction is
 * deferred: every open still reaches the real factory with the original spec,
 * its admission checks, its own session and its normal cleanup.
 */
export function createPiSessionFactory(deps: PiSessionDeps): SessionFactory {
  let implementation: Promise<SessionFactory> | undefined;
  return {
    backend: "pi",
    controlProfile: PI_CONTROL_PROFILE,
    open: async (spec) => {
      implementation ??= import("./session").then((module) => module.createPiSessionFactory(deps));
      return (await implementation).open(spec);
    },
  };
}
