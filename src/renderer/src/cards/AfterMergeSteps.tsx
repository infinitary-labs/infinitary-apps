import {
  AFTER_MERGE_DOER_WORDS,
  AFTER_MERGE_LEAD,
  type AfterMergeShown,
  afterMergeWaitWords,
} from "@shared/afterMerge";
import type { CSSProperties } from "react";
import { CARD_MAX_HEIGHT } from "../design/cards/ResponseCard";
import "./requiredActions.css";

/**
 * The work the crew starts once the merge goes through (INF-2796), outside
 * the body's scroller beside the host's merge buttons, as the captain's own
 * required actions are. Each new step is filed as the task it names when the
 * merge goes through, and an existing task it names starts then; a step that
 * waits for other work says which. Each step names who does it: a crewmate, or
 * the first mate for a change in the app itself, which files no task (INF-3060's
 * finding 4). A card whose story declared none draws nothing.
 */
export function AfterMergeSteps({ steps }: { steps: readonly AfterMergeShown[] }) {
  if (!steps.length) return null;
  return (
    <section
      className="required-actions"
      aria-label={AFTER_MERGE_LEAD}
      data-after-merge=""
      style={{ "--required-action-room": CARD_MAX_HEIGHT } as CSSProperties}
    >
      <p>{AFTER_MERGE_LEAD}</p>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: This scrollable list needs keyboard focus outside the card body. */}
      <ul tabIndex={0} aria-label={AFTER_MERGE_LEAD}>
        {steps.map((step, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: The declared order is the steps' only identity.
          <li key={index}>
            <span>
              {step.key && <span className="inf-mono">{step.key} </span>}
              {step.title}
            </span>
            {step.goal && <p>{step.goal}</p>}
            {step.waitsFor?.length ? <p>{afterMergeWaitWords(step.waitsFor)}</p> : null}
            <p data-after-merge-doer={step.doer ?? "crewmate"}>
              {AFTER_MERGE_DOER_WORDS[step.doer ?? "crewmate"]}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
