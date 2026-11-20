import * as m from "@shared/i18n/messages.generated";
import { useCommandKeys } from "../app/keyHints";
import { IconButton } from "../design/core/IconButton";
import { useRestLabelWith } from "../design/core/restLabel";

/** The arrows' stroke, as the card pager draws its own (design skill CardStack). */
const ARROW = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** A press on the stepper takes no focus: the main message keeps its caret. */
const keepFocus = (event: React.MouseEvent) => event.preventDefault();

/**
 * The footer's count of a card's picks as a stepper through its questions
 * (docs/keyboard.md, "Moving between a card's questions"; design skill
 * ResponseCard footer rule): the count in its own words is a quiet button
 * that goes to the next question with no answer, and from two questions on
 * an arrow before it goes to the previous question and one after it to the
 * next. The pointer's steps go round past either end and only bring the
 * question into view; the keys move focus there.
 */
export function QuestionStepper({
  words,
  questions,
  onStep,
}: {
  /** The count, as `answersLine` words it. */
  words: string;
  /** How many questions the body asks. */
  questions: number;
  onStep: (step: 1 | -1, unpicked: boolean) => void;
}) {
  const previousKeys = useCommandKeys("cards.previous-question");
  const nextKeys = useCommandKeys("cards.next-question");
  const unansweredKeys = useCommandKeys("cards.unanswered-question");
  const unanswered = m.commandCardsUnansweredQuestion();
  const rest = useRestLabelWith<HTMLButtonElement>(unanswered, { keys: unansweredKeys.keys }, {});
  const arrows = questions > 1;
  return (
    <span data-card-questions="" style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
      {arrows && (
        <IconButton
          label={m.uiCardPreviousQuestion()}
          size={24}
          data-card-question-step="previous"
          onMouseDown={keepFocus}
          onClick={() => onStep(-1, false)}
          {...previousKeys}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" {...ARROW} aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </IconButton>
      )}
      <span aria-live="polite" style={{ display: "inline-flex" }}>
        <button
          {...rest}
          type="button"
          data-card-answers=""
          aria-description={unanswered}
          aria-keyshortcuts={unansweredKeys["aria-keyshortcuts"]}
          data-key-command={unansweredKeys["data-key-command"]}
          onMouseDown={keepFocus}
          onClick={() => onStep(1, true)}
          style={{
            border: "none",
            background: "transparent",
            borderRadius: "var(--radius-sm)",
            padding: "2px 4px",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-xs)",
            color: "var(--fg-3)",
            whiteSpace: "nowrap",
          }}
        >
          {words}
        </button>
      </span>
      {arrows && (
        <IconButton
          label={m.uiCardNextQuestion()}
          size={24}
          data-card-question-step="next"
          onMouseDown={keepFocus}
          onClick={() => onStep(1, false)}
          {...nextKeys}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" {...ARROW} aria-hidden="true">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </IconButton>
      )}
    </span>
  );
}
