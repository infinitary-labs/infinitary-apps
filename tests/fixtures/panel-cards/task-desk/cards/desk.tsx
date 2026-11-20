import type { PanelProps, PanelTaskBoard } from "@firstmate/contracts";
import { Empty, Input } from "@firstmate/ui";
import { useEffect, useState } from "react";
import styles from "../desk.css";
import { liveWork } from "../rows";

/**
 * The desk's card: a find field whose words the card keeps while the
 * captain pages away, and a row per task that aims his next message at it -
 * the shown entry's task, as the app tells it, is the one aimed at.
 */
export default function Desk({ card, reads, point, view }: PanelProps) {
  const kept = (card?.kept as { query?: string } | null)?.query ?? "";
  const [query, setQuery] = useState(kept);
  const [board, setBoard] = useState<PanelTaskBoard | null>(null);
  useEffect(() => reads.subscribe("tasks.board", setBoard), [reads]);
  const rows = board
    ? liveWork(board).filter((task) =>
        `${task.key} ${task.title}`.toLowerCase().includes(query.toLowerCase()),
      )
    : [];
  return (
    <div data-fixture-desk-card="">
      <style>{styles}</style>
      <Input
        aria-label="Find on the desk"
        data-desk-find=""
        value={query}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setQuery(next);
          void card?.keep({ query: next });
        }}
      />
      {rows.length === 0 && <Empty>Nothing matches</Empty>}
      {rows.map((task) => (
        <button
          key={task.id}
          type="button"
          className="desk-open"
          data-desk-aim={task.key}
          aria-pressed={view.shownTaskId === task.id ? "true" : "false"}
          onClick={() => void point.aim(task.id)}
        >
          {`${task.key} ${task.title}`}
        </button>
      ))}
    </div>
  );
}
