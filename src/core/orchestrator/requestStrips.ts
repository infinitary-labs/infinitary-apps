import type { MergeReview } from "@shared/mergeReview";
import type { WriteAsk } from "@shared/writeAsk";
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
  let body = ask.body;
  if (body !== undefined) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // Kept as the crewmate gave it; the gateway only keeps JSON text.
    }
  }
  const through = ask.via === "account" ? "It goes through your github.com sign-in." : "";
  return [
    '<div class="inf-call" data-inf-call="write">',
    `<div class="inf-call-k">Your click sends this to ${escapeCardText(ask.place)}, once</div>`,
    `<div class="inf-call-line" data-inf-call-line>${escapeCardText(ask.method)} ${escapeCardText(ask.path)}</div>`,
    body !== undefined ? `<pre data-inf-call-body>${escapeCardText(body)}</pre>` : "",
    `<p class="inf-muted">Nothing is sent before your click.${through ? ` ${through}` : ""}</p>`,
    "</div>",
  ].join("");
}
