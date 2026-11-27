import type { Card } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import { confirmFieldOf, type IntegrationAsk } from "@shared/writeAsk";
import { escapeCardText } from "./cardText";
import { HOST_CARD_PRIORITY } from "./hostCards";
import { APPROVAL_CARD_META } from "./integrationApprovalCard";
import { writeAskStrip } from "./requestStrips";

/**
 * A place's question, which Google writes in Markdown: its bold and code
 * spans show as such, and every other mark as the text it is. The words are
 * escaped before any tag is added, so nothing the place writes becomes markup.
 */
function placeMarkdown(message: string): string {
  return escapeCardText(message)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
}

/**
 * The card for a place's own question about one call (docs/integrations.md,
 * "Google"): Google stopped a call Infinitary let run, to ask the captain
 * first. It shows Google's words and Google's exact choices, none picked,
 * and the call they answer. Send to {place} carries the pick once, as the
 * card's field `confirm-<ask>`; Not now sends nothing. It offers no lasting
 * allowance, since the pick answers this one call, and no other ask joins
 * it. Its words are worded in the captain's language each time it is drawn.
 */
export function integrationConfirmCard(
  ask: IntegrationAsk & { confirm: NonNullable<IntegrationAsk["confirm"]> },
  task?: { id: string; title: string },
  options: { id?: string } = {},
): Card {
  const text = escapeCardText;
  const place = ask.place;
  const action = ask.label ?? ask.action;
  const panel = !task && ask.by === "panel" ? ask.panel : undefined;
  const lead = task
    ? m.integrationsConfirmLeadTask({ task: task.title, place })
    : panel
      ? m.integrationsConfirmLeadPanel({ panel: panel.title, place })
      : m.integrationsConfirmLeadFirstmate({ place });
  const field = text(confirmFieldOf(ask.id));
  const choices = ask.confirm.options.map(
    (option, index) =>
      `<label><input type="radio" name="${field}" value="${text(option.value)}"${index === 0 ? " required" : ""}> ${text(option.label)}</label>`,
  );
  return {
    id: options.id ?? `integration-ask-${ask.id}`,
    ...(task ? { taskId: task.id } : {}),
    author: "host",
    priority: HOST_CARD_PRIORITY,
    title: m.integrationsConfirmTitle({ place, action }),
    meta: task ? task.title : APPROVAL_CARD_META,
    ...(task
      ? { answeredBy: "crewmate" as const }
      : panel
        ? {}
        : { answeredBy: "firstmate" as const }),
    body: [
      `<p>${text(lead)}</p>`,
      `<h3>${text(m.integrationsConfirmWords({ place }))}</h3>`,
      `<blockquote style="white-space:pre-wrap">${placeMarkdown(ask.confirm.message)}</blockquote>`,
      `<fieldset data-inf-options-only><legend>${text(m.integrationsConfirmChoice({ place }))}</legend>${choices.join("")}</fieldset>`,
      `<p>${text(m.integrationsConfirmWays({ place }))}</p>`,
      writeAskStrip(ask),
    ].join(""),
    actions: [
      {
        id: "deny",
        label: m.integrationsConfirmNotNow(),
        variant: "secondary",
        default: false,
        effect: { kind: "request_write", ask: ask.id, integration: "deny" },
      },
      {
        id: "once",
        label: m.integrationsConfirmSend({ place }),
        variant: "primary",
        default: true,
        effect: { kind: "request_write", ask: ask.id, integration: "once" },
      },
    ],
    status: "ready",
    createdAt: ask.at,
  };
}
