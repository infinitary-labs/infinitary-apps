import type { Card } from "@shared/cards";
import type { CaptainAction } from "@shared/requiredActions";
import type { TaskService } from "../tasks/taskService";
import { escapeCardText } from "./cardText";

/**
 * Where each requirement came from and who corrected its words, as the card
 * says it on every view (docs/required-actions.md, "Correcting the words"):
 * the source task's name for its filing. Absent, the card says neither.
 */
export type RequiredActionProvenance = { filedFrom: (sourceId: string) => string };

export function requiredActionProvenance(
  tasks: Pick<TaskService, "get">,
): RequiredActionProvenance {
  return { filedFrom: (sourceId) => tasks.get(sourceId)?.key || sourceId };
}

/** Instructions stay inert; completion and deferral alone carry host lifecycle effects. */
export function requiredActionCard(
  taskId: string,
  action: CaptainAction,
  now: number,
  provenance?: RequiredActionProvenance,
): Card {
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
          ({ action: entry, source, corrections }) =>
            `<section><p>${e(entry.consequence)}</p><p>On ${e(entry.target)}</p><ol>${entry.instructions.map((instruction) => `<li>${e(instruction)}</li>`).join("")}</ol><p>Complete when: ${e(entry.criterion)}</p>${provenance ? provenanceLines(provenance.filedFrom(source), corrections ?? []) : ""}</section>`,
        )
        .join("") +
      "<p>If this fails, paste the output below and choose It failed.</p>" +
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
      { id: "failed", label: "It failed", variant: "secondary" },
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

function provenanceLines(
  filedFrom: string,
  corrections: NonNullable<CaptainAction["requirements"][number]["corrections"]>,
): string {
  const e = escapeCardText;
  const lines = [
    `Filed from ${e(filedFrom)}`,
    ...corrections.map(
      (correction) => `Corrected by ${e(correction.label)}: ${e(correction.reason)}`,
    ),
  ];
  return `<p class="inf-muted" data-inf-provenance>${lines.join("<br>")}</p>`;
}
