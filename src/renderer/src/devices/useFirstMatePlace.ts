import { hereAs } from "@shared/deviceNames";
import { useShellStore } from "../app/store";
import { firstMatePlace, isView } from "./viewWords";

/**
 * Where the first mate lives, as a sentence in its Settings names it
 * (`firstMatePlace`): this computer, or that computer by its name from one
 * that controls all of it.
 */
export function useFirstMatePlace(): { this: string; This: string } {
  return firstMatePlace(useShellStore((s) => s.thisMac));
}

/**
 * Says a sentence the first mate's computer wrote of itself as this
 * computer where this app shows it: as written there, and naming that
 * computer on one that controls it (`hereAs`).
 */
export function useHereAs(): (text: string) => string {
  const name = useShellStore((s) => (isView(s.thisMac) ? s.thisMac.name : null));
  return (text) => hereAs(text, name);
}
