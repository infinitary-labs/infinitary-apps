import type { PanelProps, PanelTaskBoard } from "@firstmate/contracts";
import { Button, Empty, TaskStatusMark, taskStatusOf } from "@firstmate/ui";
import { useEffect, useState } from "react";
import styles from "./desk.css";
import { liveWork } from "./rows";

/**
 * The task-desk fixture (tests/e2e/panel-tasks.spec.ts): a panel that
 * reads the board and says on its own rail whether it shows and what it
 * holds, points at its tasks, marks the ones the captain has open, and
 * queues one on his click - and tries to on its own when its store says so.
 */
export default function Panel({ id, reads, rail, point, view, tasks, store }: PanelProps) {
  const [board, setBoard] = useState<PanelTaskBoard | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => reads.subscribe("tasks.board", setBoard), [reads]);
  const rows = board ? liveWork(board) : [];
  // Its own code says whether it shows, and what it holds while collapsed.
  useEffect(() => {
    if (!board) return;
    rail?.show(rows.length > 0);
    rail?.summarize([{ text: `${rows.length} open`, strong: rows.length > 0 }]);
  }, [board, rows.length, rail]);
  // A move it makes from no click of the captain's: refused, nothing written.
  useEffect(
    () =>
      store.subscribe((key) => {
        if (key !== "sneak") return;
        void store.get("sneak").then((taskId) => {
          if (typeof taskId !== "string" || !tasks) return;
          void tasks
            .run(taskId, "queue-task")
            .then((result) => setSaid(result.ok ? "moved" : result.text));
        });
      }),
    [store, tasks],
  );
  return (
    <div data-fixture-desk={id} data-collapsed={rail?.collapsed ? "" : undefined}>
      <style>{styles}</style>
      {rows.length === 0 && <Empty>Nothing open</Empty>}
      {rows.map((task) => {
        const queue = task.moves?.["queue-task"];
        return (
          <div key={task.id} className="desk-row" data-desk-row={task.key}>
            <button
              type="button"
              className="desk-open"
              data-desk-open-task={task.key}
              data-desk-policy={task.startPolicy}
              data-open={view.openTaskIds.includes(task.id) ? "" : undefined}
              onClick={() => void point.openTask(task.id)}
              onPointerEnter={(event) => {
                const { top, right, bottom, left } = event.currentTarget.getBoundingClientRect();
                point.peekTask({ taskId: task.id, box: { top, right, bottom, left } });
              }}
              onPointerLeave={() => point.peekTask(null)}
            >
              <TaskStatusMark reading={taskStatusOf(task)} />
              <span>{`${task.key} ${task.title}`}</span>
            </button>
            <Button
              size="sm"
              variant="ghost"
              data-desk-queue={task.key}
              disabled={queue?.ok !== true}
              title={queue && !queue.ok ? queue.text : "Queue it"}
              onClick={() =>
                void tasks
                  ?.run(task.id, "queue-task")
                  .then((result) => setSaid(result.ok ? `${task.key} queued` : result.text))
              }
            >
              Queue
            </Button>
          </div>
        );
      })}
      <p className="desk-said" data-desk-said="">
        {said}
      </p>
    </div>
  );
}
