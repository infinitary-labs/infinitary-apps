import type { Card } from "@shared/cards";
import {
  INTEGRATION_APPROVAL_WORDS,
  integrationApprovalTitle,
  integrationTaskAllowLine,
} from "@shared/integrations";
import type { IntegrationAsk } from "@shared/writeAsk";
import { escapeCardText } from "./cardText";
import { HOST_CARD_PRIORITY } from "./hostCards";
import { writeAskStrip } from "./requestStrips";

/**
 * INF-950: only typed held-call facts, with the agent's reason explicitly
 * attributed. A crewmate's card sits on its task; the first mate's has no
 * task, so the row the host files for it holds the call (INF-1108).
 */
export function integrationApprovalCard(
  ask: IntegrationAsk,
  task?: { id: string; title: string },
): Card {
  const text = escapeCardText;
  const preferred = ask.effect === "reads" ? "always" : "once";
  const effect =
    ask.effect === "reads"
      ? "It reads and changes nothing."
      : ask.effect === "sends"
        ? "It sends something to other people."
        : "It changes something outside your project.";
  const panel = !task && ask.by === "panel" ? ask.panel : undefined;
  const asker = task
    ? `The crewmate on “${text(task.title)}”`
    : panel
      ? `Your panel “${text(panel.title)}”`
      : "Your first mate";
  // Only a crewmate's ask that names its scope offers the rest of its task
  // (INF-2993). The footer draws the default last, so listing it after
  // Always allow draws it between Only this time and Always allow.
  const scope = task && ask.by === undefined ? ask.scope : undefined;
  const choices = scope
    ? (["deny", "once", "always", "task"] as const)
    : (["deny", "once", "always"] as const);
  const words = task
    ? "the crewmate's words"
    : panel
      ? "the panel's manifest"
      : "your first mate's words";
  return {
    id: `integration-ask-${ask.id}`,
    ...(task ? { taskId: task.id } : {}),
    author: "host",
    priority: HOST_CARD_PRIORITY,
    title: integrationApprovalTitle(ask.label ?? ask.action, ask.place),
    meta: "Integration approval",
    body: [
      `<p>${asker} wants to use this action. ${effect}</p>`,
      `<p>${text(ask.description ?? "")}</p>`,
      `<h3>Why, in ${words}</h3><blockquote>${text(ask.reason ?? "")}</blockquote>`,
      ...(scope ? [`<p>${integrationTaskAllowLine(text(scope.words))}</p>`] : []),
      `<p>Always allow lasts until you change it in Settings, replace the connection, or the action changes.</p>`,
      writeAskStrip(ask),
    ].join(""),
    actions: choices.map((choice) => ({
      id: choice,
      label: INTEGRATION_APPROVAL_WORDS[choice],
      variant: choice === preferred ? "primary" : "secondary",
      default: choice === preferred,
      effect: { kind: "request_write", ask: ask.id, integration: choice },
    })),
    status: "ready",
    createdAt: ask.at,
  };
}
