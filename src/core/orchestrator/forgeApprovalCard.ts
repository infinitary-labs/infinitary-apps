import type { Card } from "@shared/cards";
import * as m from "@shared/i18n/messages.generated";
import {
  ASK_ROW_WORDS,
  allowFieldOf,
  INTEGRATION_APPROVAL_WORDS,
  integrationApprovalsButtonLines,
} from "@shared/integrations";
import {
  BUILD_ROW_CHOICES,
  type BuildRowAsk,
  type BuildRowChoice,
  buildRowFieldOf,
  type ForgeWriteAsk,
  type IntegrationAsk,
  type WebReadAsk,
  type WriteAsk,
} from "@shared/writeAsk";
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
 *
 * A Build row (docs/agents-reach.md, "A reader's Build rows") shows the task
 * the reader proposes from an open issue: its title, the issue as a link,
 * how it starts, its goal and why whole, and one choice that arrives on Keep
 * for later. It has no tick, so it is drawn outside the tally's rows.
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
  const writes = listed.filter(
    (ask): ask is Exclude<WriteAsk, BuildRowAsk> => ask.kind !== "build",
  );
  const builds = listed.filter((ask): ask is BuildRowAsk => ask.kind === "build");
  const rows = writes.map((ask, index) =>
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
  const buildRows = builds.map((ask, index) =>
    buildRowLines(ask, writes.length + index + 1, options.joined?.has(ask.id) === true),
  );
  // Only this time's line speaks of ticked rows; a card of Build rows alone
  // has none, and its own lines already say what each row's choice files.
  const legend = integrationApprovalsButtonLines(undefined).filter(
    ({ choice }) =>
      (choices as readonly string[]).includes(choice) && (choice !== "once" || writes.length > 0),
  );
  // Writes on one place keep the words that name it; integration calls, or
  // writes on several places, are spoken of as calls; waiting web pages add
  // their own lead.
  const calls = writes.filter((ask): ask is ForgeWriteAsk | IntegrationAsk => ask.kind !== "web");
  const pages = calls.length < writes.length;
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
    title:
      words?.title ?? (pages ? m.cardReaderPagesTitle() : m.cardBuildRowsTitle({ place: first.place })),
    meta: APPROVAL_CARD_META,
    body: [
      ...(words ? [`<p>${text(words.lead)}</p>`, `<p>${text(words.how)}</p>`] : []),
      ...(pages
        ? [
            `<p>${text(m.cardReaderPagesLead({ task: task.title }))}</p>`,
            `<p>${text(m.cardReaderPagesHow())}</p>`,
          ]
        : []),
      ...(writes.length > 0
        ? [
            `<ol class="inf-asks">${rows.join("")}<li class="inf-asks-tally" data-of="${ASK_ROW_WORDS.of}" data-ticked="${ASK_ROW_WORDS.ticked}"></li></ol>`,
          ]
        : []),
      ...(builds.length > 0
        ? [
            `<p>${text(m.cardBuildRowsLead({ task: task.title }))}</p>`,
            `<p>${text(m.cardBuildRowsHow())}</p>`,
            `<ol class="inf-asks inf-builds" start="${writes.length + 1}">${buildRows.join("")}</ol>`,
          ]
        : []),
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

const BUILD_ROW_CHOICE_WORDS: Record<BuildRowChoice, () => string> = {
  start: m.cardBuildRowStart,
  later: m.cardBuildRowLater,
  skip: m.cardBuildRowSkip,
};

/** One Build row: what its task would be told, and its one choice, Keep for later picked. */
function buildRowLines(ask: BuildRowAsk, n: number, joined: boolean): string {
  const text = escapeCardText;
  const field = text(buildRowFieldOf(ask.id));
  return [
    `<li class="inf-build" data-inf-build-row="${text(ask.id)}">`,
    '<div class="inf-ask-head">',
    `<span class="inf-ask-n">${n}</span>`,
    `<span class="inf-ask-name inf-ask-call">${text(ask.title)}</span>`,
    joined ? `<span class="inf-ask-joined">${ASK_ROW_WORDS.joined}</span>` : "",
    "</div>",
    '<p class="inf-build-facts">',
    `<a class="inf-mono" href="${text(ask.issueUrl)}">${text(m.cardBuildRowIssue({ number: String(ask.issue) }))}</a>`,
    ` · ${text(ask.start === "reproduce" ? m.cardBuildRowReproduce() : m.cardBuildRowPlan())}`,
    "</p>",
    '<dl class="inf-ask-input">',
    `<dt>${text(m.cardBuildRowGoal())}</dt><dd>${text(ask.goal)}</dd>`,
    `<dt>${text(m.cardBuildRowWhy())}</dt><dd>${text(ask.why)}</dd>`,
    "</dl>",
    `<fieldset class="inf-build-choice" data-inf-options-only><legend>${text(m.cardBuildRowChoice())}</legend>`,
    ...BUILD_ROW_CHOICES.map(
      (choice) =>
        `<label><input type="radio" name="${field}" value="${choice}"${choice === "later" ? " checked" : ""}> ${text(BUILD_ROW_CHOICE_WORDS[choice]())}</label>`,
    ),
    "</fieldset>",
    "</li>",
  ].join("");
}
