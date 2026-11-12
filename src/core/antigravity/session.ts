import {
  LOCAL_MACHINE_ID,
  type ModelSession,
  type SessionFactory,
  type SessionSpec,
} from "../session/session";
import {
  ANTIGRAVITY_CONTROL_PROFILE,
  ANTIGRAVITY_WORDS,
  AntigravitySession,
  type AntigravitySessionDeps,
} from "./antigravitySession";

export {
  ANTIGRAVITY_CONTROL_PROFILE,
  ANTIGRAVITY_MODEL_PROVIDER,
  ANTIGRAVITY_WORDS,
} from "./antigravitySession";

/**
 * The Antigravity backend's `SessionFactory` (INF-3776): crewmates only, on
 * this computer's own installed program, on the sign-in the program holds.
 * The first mate's seat and the one-shot roles are refused, so a role that
 * needs them stays on the backends that serve them.
 */
export function createAntigravitySessionFactory(deps: AntigravitySessionDeps): SessionFactory {
  return {
    backend: "antigravity",
    controlProfile: ANTIGRAVITY_CONTROL_PROFILE,
    async open(spec: SessionSpec): Promise<ModelSession> {
      if (spec.binding.backend !== "antigravity") {
        throw new Error(`The Antigravity backend cannot open a ${spec.binding.backend} session.`);
      }
      if (spec.machine !== LOCAL_MACHINE_ID) {
        throw new Error(`An Antigravity session cannot run on machine ${spec.machine}.`);
      }
      if (spec.shape.turns !== "rolling" || spec.builtins !== "coding") {
        throw new Error(ANTIGRAVITY_WORDS.onlyCrew);
      }
      return AntigravitySession.open(spec, deps);
    },
  };
}
