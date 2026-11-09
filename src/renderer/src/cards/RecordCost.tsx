import { type TaskCostView, taskCostWords } from "@shared/costLimit";
import { useRestLabel } from "../design/core/restLabel";
import { RecordCell } from "../design/core/TaskFacts";

/**
 * Spend shares the record's existing fact strip, never its prefix: another
 * row there clipped long plans and prevented the next framed card drawing.
 * The amount stays visible; the same explanation is available by pointer,
 * keyboard and accessible name through the shared facts-on-rest owner.
 */
export function RecordCost({ cost }: { cost: TaskCostView }) {
  const words = taskCostWords(cost);
  const rest = useRestLabel(words.detail, { fact: true });
  return (
    <RecordCell label="Spend">
      <span
        data-record-cost=""
        role="img"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The complete read-only fact must be reachable by keyboard, like the record's ages.
        tabIndex={0}
        aria-label={`${words.amount} · ${words.detail}`}
        {...rest}
        style={{ fontFamily: "var(--font-mono)", borderRadius: "var(--radius-s)" }}
      >
        {words.amount}
      </span>
    </RecordCell>
  );
}
