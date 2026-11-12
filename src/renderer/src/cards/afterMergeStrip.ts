import {
  AFTER_MERGE_DOER_WORDS,
  AFTER_MERGE_LEAD,
  type AfterMergeShown,
  afterMergeWaitWords,
} from "@shared/afterMerge";
import * as m from "@shared/i18n/messages.generated";
import type { RequiredAction } from "@shared/requiredActions";
import { escapeHtml } from "./prototypeSrcdoc";

/**
 * What happens after a merge card's merge (INF-3149, the captain's direction
 * C): one strip the host writes at the start of the card's body, so it
 * scrolls away with the body and never takes the body's room. It is the
 * body document's own first part, not chrome above the frame, because a
 * frame scrolled wholly out of sight never draws (docs/renderer.md).
 * The captain's own required actions come first, under a lead in the
 * warning color - work only the captain can do - then the steps the crew
 * starts on its own (INF-2796), each naming who does it: a crewmate, or the
 * first mate for a change in the app itself, which files no task (INF-3060's
 * finding 4). A card with neither has no strip: the empty string.
 * Its look is `AFTER_MERGE_STYLE` in the card's stylesheet.
 */
export function afterMergeStrip(
  actions: readonly RequiredAction[] = [],
  steps: readonly AfterMergeShown[] = [],
): string {
  if (!actions.length && !steps.length) return "";
  const text = (words: string) => escapeHtml(words);
  const requiredLead = m.cardRequiredActionsLead();
  const lead = (who: "captain" | "crew", words: string) =>
    `<p data-inf-after-merge-lead="${who}">${text(words)}</p>`;
  const yours = actions.length
    ? `<section aria-label="${text(requiredLead)}" data-inf-required-actions="">${lead("captain", requiredLead)}<ul>${actions
        .map(
          (action) =>
            `<li><span>${text(`${action.title} · ${action.target}`)}</span><p>${text(action.consequence)}</p></li>`,
        )
        .join("")}</ul></section>`
    : "";
  const crews = steps.length
    ? `<section aria-label="${text(AFTER_MERGE_LEAD)}" data-inf-after-merge-steps="">${lead("crew", AFTER_MERGE_LEAD)}<ul>${steps
        .map((step) => {
          const doer = step.doer ?? "crewmate";
          const key = step.key ? `<span class="inf-mono">${text(step.key)}</span> ` : "";
          const goal = step.goal ? `<p>${text(step.goal)}</p>` : "";
          const waits = step.waitsFor?.length
            ? `<p>${text(afterMergeWaitWords(step.waitsFor))}</p>`
            : "";
          return `<li><span>${key}${text(step.title)}</span>${goal}${waits}<p data-inf-after-merge-doer="${doer}">${text(AFTER_MERGE_DOER_WORDS[doer])}</p></li>`;
        })
        .join("")}</ul></section>`
    : "";
  return `<div class="inf-panel" data-inf-after-merge="">${yours}${crews}</div>`;
}
