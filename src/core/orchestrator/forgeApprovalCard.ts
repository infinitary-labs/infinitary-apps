import type { Card } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import {
  ASK_ROW_WORDS,
  allowFieldOf,
  INTEGRATION_APPROVAL_WORDS,
  integrationApprovalsButtonLines,
} from "@shared/integrations";
import type { ForgeWriteAsk } from "@shared/writeAsk";
import { escapeCardText } from "./cardText";
import { HOST_CARD_PRIORITY } from "./hostCards";
import { APPROVAL_CARD_META, inputLines } from "./integrationApprovalCard";

/**
 * The host's approval card for an unsafe data reader's writes where its project
 * lives (docs/agents-reach.md, "An unsafe data reader"), drawn as the
 * integration approval card draws several asks: one ticked row per write,
 * its exact call and the request it sends, and the same tally and legend.
 * It offers only Only this time and Not now: a reader's write is never
 * allowed beyond the one click. The click answers every row it showed
 * (`CardActions.answerIntegrationCard`).
 */
export function forgeApprovalCard(
  listed: readonly ForgeWriteAsk[],
  task: { id: string; title: string },
  options: { id?: string; joined?: ReadonlySet<string> } = {},
): Card {
  const first = listed[0];
  if (!first) throw new Error("An approval card lists at least one ask.");
  const text = escapeCardText;
  const choices = ["deny", "once"] as const;
  const rows = listed.map((ask, index) =>
    [
      `<li class="inf-ask" data-inf-ask-row="${text(ask.id)}">`,
      '<div class="inf-ask-head">',
      `<span class="inf-ask-n">${index + 1}</span>`,
      `<span class="inf-ask-name inf-ask-call inf-mono">${text(`${ask.method} ${ask.path}`)}</span>`,
      options.joined?.has(ask.id)
        ? `<span class="inf-ask-joined">${ASK_ROW_WORDS.joined}</span>`
        : "",
      `<label class="inf-ask-out"><input type="checkbox" name="${text(allowFieldOf(ask.id))}" value="allow" checked> ${ASK_ROW_WORDS.allow}</label>`,
      "</div>",
      ask.body !== undefined ? inputLines(ask.body) : "",
      "</li>",
    ].join(""),
  );
  const legend = integrationApprovalsButtonLines(undefined).filter(({ choice }) =>
    (choices as readonly string[]).includes(choice),
  );
  return {
    id: options.id ?? `write-ask-${first.id}`,
    taskId: task.id,
    author: "host",
    priority: HOST_CARD_PRIORITY,
    title: m.cardReaderWritesTitle({ place: first.place }),
    meta: APPROVAL_CARD_META,
    body: [
      `<p>${text(m.cardReaderWritesLead({ task: task.title, place: first.place }))}</p>`,
      `<p>${text(m.cardReaderWritesHow({ place: first.place }))}</p>`,
      `<ol class="inf-asks">${rows.join("")}<li class="inf-asks-tally" data-of="${ASK_ROW_WORDS.of}" data-ticked="${ASK_ROW_WORDS.ticked}"></li></ol>`,
      '<dl class="inf-asks-buttons">',
      ...legend.map(
        ({ choice, words }) => `<dt>${INTEGRATION_APPROVAL_WORDS[choice]}</dt><dd>${words}</dd>`,
      ),
      "</dl>",
    ].join(""),
    actions: choices.map((choice) => ({
      id: choice,
      label: INTEGRATION_APPROVAL_WORDS[choice],
      variant: choice === "once" ? "primary" : "secondary",
      default: choice === "once",
      effect: { kind: "request_write", ask: first.id, integration: choice },
    })),
    status: "ready",
    createdAt: first.at,
  };
}
