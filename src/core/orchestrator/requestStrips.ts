import type { ChangeRequestKind } from "@shared/forgeKinds";
import * as m from "@shared/i18n/messages.generated";
import type { MergeReview } from "@shared/mergeReview";
import type { FeedbackAskFacts, ForgeWriteAsk, IntegrationAsk, WriteAsk } from "@shared/writeAsk";
import { gitlabReleaseFileCalls } from "../forge";
import { escapeCardText } from "./cardText";

/**
 * What the host writes at the end of a card whose button sends something
 * where the project lives (FI3-1571; design skill `ResponseCard`, "What the
 * click sends"): the author words the why, the host draws exactly what the
 * click does from its own record, so no prompt asks an agent to copy it and
 * a body cannot get it wrong. Each strip carries `data-inf-call` naming its
 * kind, its call line `data-inf-call-line` and a write's body
 * `data-inf-call-body`; the frame stylesheet gives `.inf-call` its look.
 */

/**
 * A kind whose release file goes up in more than one call names each one
 * (GitLab: the package upload, then its link on the release); any other
 * kind's is the single call that was kept.
 */
const RELEASE_FILE_CALLS: Record<
  ChangeRequestKind,
  ((path: string, file: string) => { put: string; link: string } | undefined) | undefined
> = {
  github: undefined,
  gitlab: gitlabReleaseFileCalls,
  bitbucket: undefined,
};

/** A merge past the branch rules: the version, the method, every rule it may skip and every failed check. */
export function skipRulesStrip(review: MergeReview, place: string): string {
  const skips = review.skips ?? { rules: [], failedChecks: [] };
  const rows = [
    ...skips.rules.map(
      (rule) =>
        `<li data-inf-skip="rule">${escapeCardText(rule.rule)} <span class="inf-muted">· rule set ${escapeCardText(rule.ruleset)}</span></li>`,
    ),
    ...skips.failedChecks.map(
      (name) =>
        `<li data-inf-skip="check">failed check <span class="inf-mono">${escapeCardText(name)}</span></li>`,
    ),
  ];
  return [
    '<div class="inf-call" data-inf-call="merge">',
    `<div class="inf-call-k">Your click merges this on ${escapeCardText(place)}, once</div>`,
    `<div class="inf-call-line" data-inf-call-line>#${review.number} at ${escapeCardText(review.headSha.slice(0, 7))} · squash · skipping</div>`,
    rows.length ? `<ul>${rows.join("")}</ul>` : "",
    `<p class="inf-muted">${escapeCardText(place)} says your sign-in may skip each rule. Nothing merges before your click, and a changed pull request merges nothing.</p>`,
    "</div>",
  ].join("");
}

/**
 * A write a crewmate asked to send: where it goes, the exact method and
 * path, and its JSON body as it was kept, shown whole and scrolled inside.
 */
export function writeAskStrip(ask: WriteAsk): string {
  if (ask.kind === "integration") return integrationAskStrip(ask);
  if (ask.kind === "web")
    return [
      '<div class="inf-call" data-inf-call="write">',
      `<div class="inf-call-k">Your click opens this page on ${escapeCardText(ask.place)} once, signed out</div>`,
      `<div class="inf-call-line" data-inf-call-line>${escapeCardText(`GET ${ask.url}`)}</div>`,
      "</div>",
    ].join("");
  if (ask.feedback) return feedbackAskStrip(ask, ask.feedback);
  let body = ask.body;
  if (body !== undefined) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // Kept as the crewmate gave it; the gateway only keeps JSON text.
    }
  }
  const through = ask.via === "account" ? "It goes through your github.com sign-in." : "";
  const file =
    ask.file !== undefined
      ? `<p>A file from this task's working copy. It is read only when you click.</p><pre data-inf-call-body>${escapeCardText(ask.file)}</pre>`
      : "";
  const fileCalls = RELEASE_FILE_CALLS[ask.kind];
  const calls = fileCalls && ask.file !== undefined ? fileCalls(ask.path, ask.file) : undefined;
  const steps = calls ? [`PUT ${calls.put}`, `POST ${calls.link}`] : undefined;
  const callLine = (steps ?? [`${ask.method} ${ask.path}`])
    .map((step) => `<div class="inf-call-line" data-inf-call-line>${escapeCardText(step)}</div>`)
    .join("");
  return [
    '<div class="inf-call" data-inf-call="write">',
    `<div class="inf-call-k">Your click sends this to ${escapeCardText(ask.place)}, once</div>`,
    callLine,
    body !== undefined ? `<pre data-inf-call-body>${escapeCardText(body)}</pre>` : file,
    `<p class="inf-muted">Nothing is sent before your click.${through ? ` ${through}` : ""}</p>`,
    "</div>",
  ].join("");
}

/**
 * A /feedback report's issue or comment (docs/feedback.md, "The review
 * card"): the exact title and body as readable text, where it is published
 * and under which account, and the call line beneath them.
 */
function feedbackAskStrip(ask: ForgeWriteAsk, feedback: FeedbackAskFacts): string {
  let text = ask.body ?? "";
  try {
    const parsed = JSON.parse(text) as { body?: unknown };
    if (typeof parsed.body === "string") text = parsed.body;
  } catch {
    // Kept as the draft built it; shown as it is.
  }
  const where =
    feedback.commentOn !== undefined
      ? m.feedbackStripComment({ number: String(feedback.commentOn) })
      : feedback.kind === "bug"
        ? m.feedbackStripBug()
        : m.feedbackStripIdea();
  const account = feedback.login
    ? m.feedbackStripAccount({ login: feedback.login })
    : m.feedbackStripNoAccount();
  return [
    '<div class="inf-call" data-inf-call="write" data-inf-call-feedback>',
    `<div class="inf-call-k">${escapeCardText(m.feedbackStripHeading({ place: ask.place }))}</div>`,
    `<p>${escapeCardText(where)}</p>`,
    feedback.commentOn === undefined
      ? `<p data-inf-call-title><strong>${escapeCardText(feedback.title)}</strong></p>`
      : "",
    `<pre data-inf-call-body>${escapeCardText(text)}</pre>`,
    `<div class="inf-call-line" data-inf-call-line>${escapeCardText(`${ask.method} ${ask.path}`)}</div>`,
    `<p class="inf-muted">${escapeCardText(account)}</p>`,
    "</div>",
  ].join("");
}

/**
 * An integration's action a crewmate asked to run (docs/integrations.md,
 * "The rules"): which integration, the action, and its input as it was
 * kept, shown whole.
 */
function integrationAskStrip(ask: IntegrationAsk): string {
  let input = ask.input;
  try {
    input = JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    // Kept as checked; the service only keeps JSON text.
  }
  return [
    '<div class="inf-call" data-inf-call="write">',
    `<div class="inf-call-k">Your click runs this on ${escapeCardText(ask.place)}, once</div>`,
    `<div class="inf-call-line" data-inf-call-line>${escapeCardText(ask.action)}</div>`,
    `<pre data-inf-call-body>${escapeCardText(input)}</pre>`,
    `<p class="inf-muted">Nothing runs before your click. It runs with your ${escapeCardText(ask.place)} sign-in.</p>`,
    "</div>",
  ].join("");
}
