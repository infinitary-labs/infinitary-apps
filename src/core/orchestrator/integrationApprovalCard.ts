import type { Card } from "@shared/cards";
import { INTEGRATION_APPROVAL_WORDS, integrationApprovalTitle } from "@shared/integrations";
import type { IntegrationAsk } from "@shared/writeAsk";
import { HOST_CARD_PRIORITY } from "./cardService";
import { escapeCardText } from "./cardText";
import { writeAskStrip } from "./requestStrips";

/** INF-950: only typed held-call facts, with the agent's reason explicitly attributed. */
export function integrationApprovalCard(taskId: string, title: string, ask: IntegrationAsk): Card {
  const text = escapeCardText;
  const preferred = ask.effect === "reads" ? "always" : "once";
  const effect =
    ask.effect === "reads"
      ? "It reads and changes nothing."
      : ask.effect === "sends"
        ? "It sends something to other people."
        : "It changes something outside your project.";
  return {
    id: `integration-ask-${ask.id}`,
    taskId,
    author: "host",
    priority: HOST_CARD_PRIORITY,
    title: integrationApprovalTitle(ask.label ?? ask.action, ask.place),
    meta: "Integration approval",
    body: [
      `<p>The crewmate on “${text(title)}” wants to use this action. ${effect}</p>`,
      `<p>${text(ask.description ?? "")}</p>`,
      `<h3>Why, in the crewmate's words</h3><blockquote>${text(ask.reason ?? "")}</blockquote>`,
      `<p>Always allow lasts until you change it in Settings, replace the connection, or the action changes.</p>`,
      writeAskStrip(ask),
    ].join(""),
    actions: (["deny", "once", "always"] as const).map((choice) => ({
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
