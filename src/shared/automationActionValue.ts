import type { AutomationList } from "./automation";
import { cutText } from "./textCut";

/**
 * The automation lines' current value in `app_state`: every rule as an edit
 * reads it, with the last run and failing mark Settings shows from the same
 * record, or, `brief`, by id, label and state alone.
 */
export function automationValue(current: unknown, brief = false): Record<string, unknown> {
  const list = current as AutomationList;
  return {
    rules: list.rules.map((rule) =>
      brief
        ? { id: rule.id, label: rule.name ?? cutText(rule.prompt, 80), state: rule.state }
        : {
            id: rule.id,
            name: rule.name,
            state: rule.state,
            spec: rule.spec,
            prompt: rule.prompt,
            projectId: rule.projectId,
            nextFire: rule.nextFire,
            lastFired: rule.lastFired,
            captainRequested: rule.captainRequested,
            ...(rule.stopped ? { stopped: rule.stopped } : {}),
            ...(rule.failing ? { failing: rule.failing } : {}),
          },
    ),
    ...(list.state === "unavailable" ? { unavailable: list.reason } : {}),
  };
}
