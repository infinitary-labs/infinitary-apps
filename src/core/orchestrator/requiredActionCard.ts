import type { Card } from "@shared/cards";
import type { CaptainAction } from "@shared/requiredActions";
import { escapeCardText } from "./cardText";

/** Instructions remain inert text. The host buttons carry only typed lifecycle operations. */
export function requiredActionCard(taskId: string, action: CaptainAction, now: number): Card {
  const requirements = action.requirements;
  const first = requirements[0];
  if (!first) throw new Error("A required action has no requirements.");
  const e = escapeCardText;
  const manual = requirements.every((entry) => entry.action.completion.kind === "manual");
  return {
    id: action.cardId,
    taskId,
    author: "firstmate",
    priority: 40,
    title: first.action.title,
    meta: "Waiting on you",
    status: "ready",
    createdAt: now,
    body:
      requirements
        .map(
          ({ action: entry }) =>
            `<section><p>${e(entry.consequence)}</p><p>On ${e(entry.target)}</p><ol>${entry.instructions.map((instruction) => `<li>${e(instruction)}</li>`).join("")}</ol><p>Complete when: ${e(entry.criterion)}</p></section>`,
        )
        .join("") +
      (manual
        ? "<p>Your confirmation runs nothing.</p>"
        : "<p>Your first mate will check a fresh connection from this computer. Opening Settings does not complete this action.</p>"),
    actions: [
      {
        id: "defer",
        label: "Not now",
        variant: "secondary",
        effect: { kind: "host", op: "defer-required-action", arg: taskId },
      },
      ...(manual
        ? [
            {
              id: "confirm",
              label:
                first.action.completion.kind === "manual"
                  ? first.action.completion.label
                  : "I completed it",
              default: true,
              variant: "primary" as const,
              effect: {
                kind: "host" as const,
                op: "confirm-required-action" as const,
                arg: `${taskId}:${action.generation}`,
              },
            },
          ]
        : [
            {
              id: "devices",
              label: "Open Devices",
              default: true,
              variant: "primary" as const,
              effect: { kind: "open" as const, target: "devices" as const },
            },
          ]),
    ],
  };
}
