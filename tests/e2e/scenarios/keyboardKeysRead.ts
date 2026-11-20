import type { Scenario } from "../mockProvider";
import { sinceLastUser } from "../providerRequest";

export const KEYBOARD_KEYS_ASK = "Which keys do my commands have now?";

/**
 * The first mate reads its `keyboard.keys` read when asked, and hands the
 * test the tool's own answer, not the scripted model's paraphrase.
 */
export function keyboardKeysRead(observe: (result: string) => void): Scenario {
  return () =>
    ({ body, isFirstmate, wantsStream, latestUserTail }) => {
      if (!isFirstmate || !wantsStream || !latestUserTail.includes(KEYBOARD_KEYS_ASK))
        return undefined;
      const { results } = sinceLastUser(body);
      if (!results.length)
        return { calls: [{ name: "app_state", args: { read: "keyboard.keys" } }] };
      observe(results[0] ?? "");
      return { text: "I read the keys each command has now." };
    };
}
