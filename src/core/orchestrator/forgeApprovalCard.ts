import type { Card } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import {
  ASK_ROW_WORDS,
  allowFieldOf,
  INTEGRATION_APPROVAL_WORDS,
  integrationApprovalsButtonLines,
} from "@shared/integrations";
import type { ForgeWriteAsk, IntegrationAsk, WebReadAsk, WriteAsk } from "@shared/writeAsk";
import { escapeCardText } from "./cardText";
import { HOST_CARD_PRIORITY } from "./hostCards";
import { APPROVAL_CARD_META, inputLines } from "./integrationApprovalCard";

/**
 * The host's one approval card for an unsafe data reader's held calls
 * (docs/agents-reach.md, "An unsafe data reader"), drawn as the integration
 * approval card draws several asks: one ticked row per call, its exact call
 * and what it sends, and the same tally and legend. A row is a write where
 * its project lives, an integration call the reader's rules keep, or a web
 * page it waits to open, shown by its whole address. It
 * offers only Only this time and Not now: a reader's call is never allowed
 * beyond the one click. The click answers every row it showed
 * (`CardActions.answerIntegrationCard`).
 */
export function readerApprovalCard(
  listed: readonly WriteAsk[],
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
      ask.kind !== "integration"
        ? `<span class="inf-ask-name inf-ask-call inf-mono">${text(readerAskCall(ask))}</span>`
        : `<span class="inf-ask-name">${text(`${ask.place}: ${ask.label ?? ask.action}`)}</span>`,
      options.joined?.has(ask.id)
        ? `<span class="inf-ask-joined">${ASK_ROW_WORDS.joined}</span>`
        : "",
      `<label class="inf-ask-out"><input type="checkbox" name="${text(allowFieldOf(ask.id))}" value="allow" checked> ${ASK_ROW_WORDS.allow}</label>`,
      "</div>",
      ask.kind === "integration" ? `<p class="inf-ask-why">${text(callEffect(ask))}</p>` : "",
      ask.kind === "integration"
        ? inputLines(ask.input)
        : ask.kind !== "web" && ask.body !== undefined
          ? inputLines(ask.body)
          : "",
      // The reason comes from a model reading strangers' words, so it is named as the crewmate's.
      ask.kind === "integration" && ask.reason
        ? `<p class="inf-ask-why">${m.cardReaderCallWhy()} ${text(ask.reason)}</p>`
        : "",
      "</li>",
    ].join(""),
  );
  const legend = integrationApprovalsButtonLines(undefined).filter(({ choice }) =>
    (choices as readonly string[]).includes(choice),
  );
  // Writes on one place keep the words that name it; integration calls, or
  // writes on several places, are spoken of as calls; waiting web pages add
  // their own lead.
  const calls = listed.filter((ask): ask is ForgeWriteAsk | IntegrationAsk => ask.kind !== "web");
  const pages = calls.length < listed.length;
  const place = calls[0]?.kind === "integration" ? undefined : calls[0]?.place;
  const onePlace =
    place !== undefined && calls.every((ask) => ask.kind !== "integration" && ask.place === place);
  const words =
    calls.length === 0
      ? undefined
      : onePlace
        ? {
            title: pages ? m.cardReaderAsksTitle({ place }) : m.cardReaderWritesTitle({ place }),
            lead: m.cardReaderWritesLead({ task: task.title, place }),
            how: m.cardReaderWritesHow({ place }),
          }
        : {
            title: pages ? m.cardReaderCallsPagesTitle() : m.cardReaderCallsTitle(),
            lead: m.cardReaderCallsLead({ task: task.title }),
            how: m.cardReaderCallsHow(),
          };
  return {
    id: options.id ?? `write-ask-${first.id}`,
    taskId: task.id,
    author: "host",
    priority: HOST_CARD_PRIORITY,
    title: words?.title ?? m.cardReaderPagesTitle(),
    meta: APPROVAL_CARD_META,
    body: [
      ...(words ? [`<p>${text(words.lead)}</p>`, `<p>${text(words.how)}</p>`] : []),
      ...(pages
        ? [
            `<p>${text(m.cardReaderPagesLead({ task: task.title }))}</p>`,
            `<p>${text(m.cardReaderPagesHow())}</p>`,
          ]
        : []),
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

/** What an integration row does, as the ordinary integration card says it, then its action's own description. */
function callEffect(ask: IntegrationAsk): string {
  const effect =
    ask.effect === "reads"
      ? m.cardReaderCallReads()
      : ask.effect === "sends"
        ? m.cardReaderCallSends()
        : m.cardReaderCallChanges();
  return ask.description ? `${effect} ${ask.description}` : effect;
}

/** One reader ask as its row and its kept call show it: the write's request, or a page's whole address. */
export function readerAskCall(ask: ForgeWriteAsk | WebReadAsk): string {
  return ask.kind === "web" ? `GET ${ask.url}` : `${ask.method} ${ask.path}`;
}
