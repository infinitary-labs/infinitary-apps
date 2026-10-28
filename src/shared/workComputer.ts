import type { DeviceView } from "./devices";
import { AUTOMATIC_COMPUTER } from "./placement";
import { RUNS_ON_THIS_MAC } from "./repos";

/** Resolve a placement selector once; records keep IDs, never mutable names. */
export function resolveWorkComputer(
  asked: string,
  computers: readonly Pick<DeviceView, "id" | "name">[],
): string {
  const selector = asked.trim();
  if (
    selector === AUTOMATIC_COMPUTER ||
    selector === RUNS_ON_THIS_MAC ||
    computers.some((computer) => computer.id === selector)
  )
    return selector;
  const matches = computers.filter(
    (computer) => computer.name.toLowerCase() === selector.toLowerCase(),
  );
  const [match] = matches;
  if (matches.length === 1 && match) return match.id;
  if (matches.length > 1)
    throw new Error(
      `More than one computer that runs work is named "${selector}". Use its deviceId: ${matches.map((computer) => `${computer.name} (${computer.id})`).join(", ")}.`,
    );
  throw new Error("No computer that runs work has that deviceId. Look with app_state.");
}
