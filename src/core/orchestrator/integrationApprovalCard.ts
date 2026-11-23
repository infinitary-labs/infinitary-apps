import type { Card } from "@shared/cards";
import {
  ASK_ROW_WORDS,
  allowFieldOf,
  INTEGRATION_APPROVAL_WORDS,
  integrationApprovalsButtonLines,
  integrationApprovalsTitle,
  integrationApprovalTitle,
  integrationTaskAllowLine,
} from "@shared/integrations";
import type { IntegrationAsk } from "@shared/writeAsk";
import { escapeCardText } from "./cardText";
import { HOST_CARD_PRIORITY } from "./hostCards";
import { writeAskStrip } from "./requestStrips";

/** The label every host approval card for a held call carries. */
export const APPROVAL_CARD_META = "Integration approval";

/**
 * INF-950: only typed held-call facts, with the agent's reason explicitly
 * attributed. A crewmate's card sits on its task; the first mate's has no
 * task, so the row the host files for it holds the call (INF-1108).
 */
export function integrationApprovalCard(
  asked: IntegrationAsk | readonly IntegrationAsk[],
  task?: { id: string; title: string },
  options: { id?: string; joined?: ReadonlySet<string> } = {},
): Card {
  const listed: readonly IntegrationAsk[] = Array.isArray(asked)
    ? asked
    : [asked as IntegrationAsk];
  const ask = listed[0];
  if (!ask) throw new Error("An approval card lists at least one ask.");
  if (task && listed.length > 1) return integrationApprovalsCard(listed, task, options);
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
    id: options.id ?? `integration-ask-${ask.id}`,
    ...(task ? { taskId: task.id } : {}),
    author: "host",
    priority: HOST_CARD_PRIORITY,
    title: integrationApprovalTitle(ask.label ?? ask.action, ask.place),
    // Whoever asked answers a reply under the card, and a crewmate's heads
    // with its task; a panel cannot answer one.
    meta: task ? task.title : APPROVAL_CARD_META,
    ...(task
      ? { answeredBy: "crewmate" as const }
      : panel
        ? {}
        : { answeredBy: "firstmate" as const }),
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

/**
 * One card for a crewmate's asks to one connection (INF-2993 piece 2): each
 * ask that arrived while the card waited joined it as a row. A row leads
 * with its action and the exact input it runs, then the crewmate's reason;
 * its Allow box comes ticked, an unticked row is struck through, and the tally
 * under the rows counts both as the captain ticks (`.inf-asks` in the frame
 * stylesheet). A legend says what each button does to the rows.
 */
function integrationApprovalsCard(
  listed: readonly IntegrationAsk[],
  task: { id: string; title: string },
  options: { id?: string; joined?: ReadonlySet<string> },
): Card {
  const text = escapeCardText;
  const first = listed[0] as IntegrationAsk;
  const reads = listed.every((ask) => ask.effect === "reads");
  const preferred = reads ? "always" : "once";
  const effect = reads
    ? "They read and change nothing."
    : listed.some((ask) => ask.effect === "sends")
      ? "Some send something to other people."
      : "They change something outside your project.";
  // Every row must name its scope for the rest of the task to be offered.
  const scoped = listed.every((ask) => ask.by === undefined && ask.scope !== undefined);
  const covers = [
    ...new Map(
      listed.map((ask) => [
        `${ask.action}\n${ask.scope?.key ?? ""}`,
        `${ask.label ?? ask.action} for ${ask.scope?.words ?? ""}`,
      ]),
    ).values(),
  ];
  const choices = scoped
    ? (["deny", "once", "always", "task"] as const)
    : (["deny", "once", "always"] as const);
  const rows = listed.map((ask, index) =>
    [
      `<li class="inf-ask" data-inf-ask-row="${text(ask.id)}">`,
      '<div class="inf-ask-head">',
      `<span class="inf-ask-n">${index + 1}</span>`,
      `<span class="inf-ask-name">${text(ask.label ?? ask.action)}</span>`,
      options.joined?.has(ask.id)
        ? `<span class="inf-ask-joined">${ASK_ROW_WORDS.joined}</span>`
        : "",
      `<label class="inf-ask-out"><input type="checkbox" name="${text(allowFieldOf(ask.id))}" value="allow" checked> ${ASK_ROW_WORDS.allow}</label>`,
      "</div>",
      inputLines(ask.input),
      ask.reason ? `<p class="inf-ask-why">${text(ask.reason)}</p>` : "",
      "</li>",
    ].join(""),
  );
  const descriptions = [...new Set(listed.map((ask) => ask.description ?? ""))].filter(Boolean);
  const place = text(first.place);
  const legend = integrationApprovalsButtonLines(
    scoped ? text(covers.join("; ")) : undefined,
  ).filter(({ choice }) => (choices as readonly string[]).includes(choice));
  return {
    id: options.id ?? `integration-ask-${first.id}`,
    taskId: task.id,
    author: "host",
    priority: HOST_CARD_PRIORITY,
    title: integrationApprovalsTitle(listed.length, first.place),
    meta: task.title,
    answeredBy: "crewmate",
    body: [
      `<p>The crewmate on “${text(task.title)}” asks to run these on ${place}. ${effect} ${descriptions.map((description) => text(description)).join(" ")}</p>`,
      `<p>Each row is one call: the input it runs, then the crewmate's reason. Every row comes ticked; untick ${ASK_ROW_WORDS.allow} on any you do not want to run.</p>`,
      `<ol class="inf-asks">${rows.join("")}<li class="inf-asks-tally" data-of="${ASK_ROW_WORDS.of}" data-ticked="${ASK_ROW_WORDS.ticked}"></li></ol>`,
      '<dl class="inf-asks-buttons">',
      ...legend.map(
        ({ choice, words }) => `<dt>${INTEGRATION_APPROVAL_WORDS[choice]}</dt><dd>${words}</dd>`,
      ),
      "</dl>",
      `<p class="inf-muted">Calls run oldest first, each once, with your ${place} sign-in.</p>`,
    ].join(""),
    actions: choices.map((choice) => ({
      id: choice,
      label: INTEGRATION_APPROVAL_WORDS[choice],
      variant: choice === preferred ? "primary" : "secondary",
      default: choice === preferred,
      effect: { kind: "request_write", ask: first.id, integration: choice },
    })),
    status: "ready",
    createdAt: first.at,
  };
}

/**
 * An ask's checked input as the row shows it: a flat object one field per
 * line, its name muted and its value as given; anything else on one line,
 * as kept when it does not parse.
 */
export function inputLines(input: string): string {
  const text = escapeCardText;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return `<pre class="inf-ask-input" data-inf-call-body>${text(input)}</pre>`;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const fields = Object.entries(parsed as Record<string, unknown>);
    if (fields.length > 0)
      return `<dl class="inf-ask-input" data-inf-call-body>${fields
        .map(
          ([name, value]) =>
            `<dt>${text(name)}</dt><dd>${text(typeof value === "string" ? value : JSON.stringify(value))}</dd>`,
        )
        .join("")}</dl>`;
  }
  return `<pre class="inf-ask-input" data-inf-call-body>${text(JSON.stringify(parsed))}</pre>`;
}
