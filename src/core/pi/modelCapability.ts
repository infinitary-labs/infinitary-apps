import type { ModelCapability } from "../routing/capability";
import type { ModelRuntime } from "./types";

/**
 * Reads a routed model's def out of the Pi runtimes, so routing can check a
 * candidate BEFORE it is chosen (routing redesign stage 1). It lives here
 * because the def is a Pi type and every `@earendil-works/*` touchpoint
 * stays behind src/main/pi/ (lint-enforced).
 *
 * The defs come from the same `getModel` every session resolves through,
 * which `createModelRuntime` has already wrapped in `withHonestReasoning` -
 * so what routing reads is the CORRECTED def, not the catalog's claim. That
 * ordering is the point: a model whose def claims a reasoning parameter it
 * rejects reads as non-reasoning here, and the high-tier check sees it.
 *
 * Runtimes are consulted in order and the first one holding the model wins.
 * A model no runtime knows returns undefined - Claude models served by
 * their own client, and custom models.json entries, are unknown
 * rather than incapable.
 */
export function createModelCapabilityLookup(
  runtimes: () => ModelRuntime[],
): (ref: { provider: string; id: string }) => ModelCapability | undefined {
  return (ref) => {
    for (const runtime of runtimes()) {
      let def: ReturnType<ModelRuntime["getModel"]>;
      try {
        def = runtime.getModel(ref.provider, ref.id);
      } catch {
        continue;
      }
      if (!def) continue;
      return {
        reasoning: def.reasoning,
        input: def.input,
        contextWindow: def.contextWindow,
      };
    }
    return undefined;
  };
}
