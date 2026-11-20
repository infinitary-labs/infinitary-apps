import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

export const DEVICE_SETUP_FACTS_ASK = "What is the second computer waiting for?";

/** Let the test read the actual tool result, not the scripted model's paraphrase. */
export function deviceSetupFacts(observe: (result: string) => void): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream, latestUserTail }) => {
      if (!isFirstmate || !wantsStream || !latestUserTail.includes(DEVICE_SETUP_FACTS_ASK))
        return undefined;
      const { results } = sinceLastUser(body);
      if (!results.length)
        return { calls: [{ name: "app_state", args: { area: "intelligence" } }] };
      observe(results[0] ?? "");
      return { text: "I checked what it is waiting for." };
    };
}
