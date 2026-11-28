import type { Card, CardAction } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import type { IntegrationAsk } from "@shared/writeAsk";
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
 * Google's choice values with a fixed meaning (Google's approval guide,
 * "ApprovalChoice"): Allow once runs this call only, Don't allow ends it,
 * and every other value is an Always choice Google keeps for later calls.
 */
const ALLOW_ONCE = "ALLOW_ONCE";
const DENY_ONCE = "DENY_ONCE";

/**
 * The card for a place's own question about one call (docs/integrations.md,
 * "Google"): Google stopped a call Infinitary let run, to ask the captain
 * first. Its title names the service that asks (Gmail, Google Calendar,
 * Google Drive) and the action; its body shows Google's words and question line as sent.
 * Each of Google's choices is a footer button with Google's own label, and
 * a click sends that one value once; nothing is picked before it. Don't
 * allow is the declining choice and Allow once the default, with the Always
 * choices quiet beside them; Not now, which sends nothing, is offered
 * only when Google gives no such choice. It offers no lasting allowance of
 * Infinitary's own, and no other ask joins it. Its words are worded in the
 * captain's language each time it is drawn.
 */
export function integrationConfirmCard(
  ask: IntegrationAsk & { confirm: NonNullable<IntegrationAsk["confirm"]> },
  task?: { id: string; title: string },
  options: { id?: string } = {},
): Card {
  const text = escapeCardText;
  // A question kept before the card named its asker names the place.
  const asker = ask.confirm.asker ?? ask.place;
  const action = ask.label ?? ask.action;
  const panel = !task && ask.by === "panel" ? ask.panel : undefined;
  const choices = ask.confirm.options;
  const declines = choices.some((choice) => choice.value === DENY_ONCE);
  const recommended = choices.some((choice) => choice.value === ALLOW_ONCE)
    ? ALLOW_ONCE
    : choices.find((choice) => choice.value !== DENY_ONCE)?.value;
  const always = choices.some(
    (choice) => choice.value !== ALLOW_ONCE && choice.value !== DENY_ONCE,
  );
  const button = (choice: { value: string; label: string }, index: number): CardAction => ({
    id: `choice-${index}`,
    label: choice.label,
    // Google's Always choices are quiet, so they keep their own row when
    // Google's long labels leave no room for one: Don't allow and Allow
    // once stay together at the right, as Google draws them.
    variant:
      choice.value === recommended ? "primary" : choice.value === DENY_ONCE ? "secondary" : "ghost",
    default: choice.value === recommended,
    ...(choice.value === DENY_ONCE ? { declines: true as const } : {}),
    effect: { kind: "request_write", ask: ask.id, integration: "once", pick: choice.value },
  });
  const buttons = choices.map(button);
  const actions: CardAction[] = declines
    ? buttons
    : [
        {
          id: "deny",
          label: m.integrationsConfirmNotNow(),
          variant: "secondary",
          default: false,
          declines: true,
          effect: { kind: "request_write", ask: ask.id, integration: "deny" },
        },
        ...buttons,
      ];
  return {
    id: options.id ?? `integration-ask-${ask.id}`,
    ...(task ? { taskId: task.id } : {}),
    author: "host",
    priority: HOST_CARD_PRIORITY,
    title: m.integrationsConfirmTitle({ asker, action }),
    // Google's words name no asker of ours, so a panel's card names the panel.
    meta: task ? task.title : panel ? panel.title : APPROVAL_CARD_META,
    ...(task
      ? { answeredBy: "crewmate" as const }
      : panel
        ? {}
        : { answeredBy: "firstmate" as const }),
    body: [
      `<p style="white-space:pre-wrap">${placeMarkdown(ask.confirm.message)}</p>`,
      ask.confirm.question ? `<p><strong>${text(ask.confirm.question)}</strong></p>` : "",
      always ? `<p class="inf-muted">${text(m.integrationsConfirmKeeps({ asker }))}</p>` : "",
      writeAskStrip(ask),
    ].join(""),
    actions,
    status: "ready",
    createdAt: ask.at,
  };
}
