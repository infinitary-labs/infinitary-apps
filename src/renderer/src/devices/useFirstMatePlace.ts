import { useShellStore } from "../app/store";
import { firstMatePlace } from "./viewWords";

/**
 * Where the first mate lives, as a sentence in its Settings names it
 * (`firstMatePlace`): this computer, or that computer by its name from one
 * that controls all of it.
 */
export function useFirstMatePlace(): { this: string; This: string } {
  return firstMatePlace(useShellStore((s) => s.thisMac));
}
