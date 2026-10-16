import type { DropTaskReview, TaskLifecycleOp } from "@shared/cards";
import { RECORD_NEXT_LABELS, type RecordBar } from "@shared/recordBar";
import {
  DROP_CANCEL_LABEL,
  DROP_REVIEW_STALE,
  DROP_TASK_LABEL,
  dropConfirmLead,
  dropPartsRefusal,
  dropUnderwayLine,
  dropWaitingLine,
  HIDE_RECORD_LABEL,
} from "@shared/recordDrop";
import type { TaskStatusReading } from "@shared/taskPresentation";
import type { DropEffects } from "@shared/tasks";
import type React from "react";
import { useEffect, useState } from "react";
import { Badge, Button, IconButton } from "../design";
import { CardCorner } from "../design/cards/CardSize";
import { useCutWords } from "../design/core/overflowTitle";
import { TaskStatusMark } from "../design/core/TaskStatusMark";
import type { RecordPillTone } from "./recordFooter";
import { KeyedText } from "./TaskKey";

const closeIcon = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const keyText: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  fontWeight: 400,
  letterSpacing: "normal",
  color: "var(--fg-3)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  minWidth: 0,
};

/**
 * Host chrome for the task record card. The status pill, its reason and the
 * task key share the top row: the pill's mark is the Tasks rail's own
 * lifecycle mark for the task, and the key gives way when the row is tight.
 * The title sits alone beneath, at the decision card's title size. Both
 * start on the card's one left edge, 20px in, where its facts, sections and
 * buttons start and where a decision card starts its own (FI3-1159). The
 * model is not here: it is in the fact strip just above the action bar
 * (FI3-565 piece 2), read the way the crew summary reads it.
 */
export function RecordPaneChrome({
  pillTone,
  reading,
  taskKey,
  title,
  tabs,
  onClose,
  middle,
}: {
  pillTone: RecordPillTone;
  reading: TaskStatusReading | null;
  taskKey: string | null;
  title: string;
  /** The card's tab strip, under the title, when the task has more than Info. */
  tabs?: React.ReactNode;
  onClose: () => void;
  /** Title, tabs and body give way together while the top row stays pinned. */
  middle?: React.ReactNode;
}) {
  const keyCut = useCutWords(taskKey ?? undefined);
  const heading = (
    <>
      <div
        data-record-title=""
        data-task-fact="task"
        style={{
          padding: "8px 20px 0",
          fontSize: "var(--text-lg)",
          fontWeight: 500,
          letterSpacing: "var(--tracking-display)",
          color: "var(--fg-1)",
          lineHeight: "var(--leading-tight)",
        }}
      >
        {title}
      </div>
      {tabs && <div style={{ marginTop: "var(--space-2)", flexShrink: 0 }}>{tabs}</div>}
    </>
  );
  return (
    <>
      <div
        data-record-chrome=""
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          // The card's one left edge, the decision card's own (FI3-1159).
          padding: "12px 10px 0 20px",
          flexShrink: 0,
          minWidth: 0,
        }}
      >
        <span
          data-record-status={pillTone}
          data-task-fact="status"
          style={{ display: "inline-flex", flexShrink: 0 }}
        >
          <Badge tone={pillTone} dot={false}>
            {reading && <TaskStatusMark reading={reading} nativeTitle={false} />}
            {reading?.word ?? "Loading"}
          </Badge>
        </span>
        {reading?.reason && (
          <span
            data-record-status-reason=""
            style={{
              color: reading.reason.startsWith("Could not start")
                ? "var(--warn)"
                : reading.reason === "Checking whether it started" ||
                    reading.reason === "Still starting. You can keep working."
                  ? "var(--fg-2)"
                  : "var(--fg-3)",
              fontSize: "var(--text-sm)",
              minWidth: 0,
              whiteSpace: "normal",
              overflowWrap: "anywhere",
            }}
          >
            {reading.reason}
          </span>
        )}
        {taskKey && (
          <span data-record-key="" {...keyCut} style={{ ...keyText, flex: 1 }}>
            {taskKey}
          </span>
        )}
        <CardCorner style={{ marginLeft: "auto" }}>
          <IconButton label={HIDE_RECORD_LABEL} onClick={onClose}>
            {closeIcon}
          </IconButton>
        </CardCorner>
      </div>
      {middle !== undefined ? (
        <div
          data-record-middle=""
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "flex",
            flexDirection: "column-reverse",
            overflowY: "auto",
            overflowAnchor: "none",
            scrollbarWidth: "none",
          }}
        >
          {/* The trailing space, not the selected underline, meets the top row
              when only a sliver of the heading fits above the session floor. */}
          <div
            style={{
              order: 2,
              flexShrink: 0,
              overflow: "hidden",
              paddingBottom: "var(--space-2)",
            }}
          >
            {heading}
          </div>
          {middle}
        </div>
      ) : (
        heading
      )}
    </>
  );
}

/**
 * The record's action bar (FI3-565 direction A, piece 4; FI3-948 layout B):
 * the host's own row of buttons, read only from the task's typed state
 * (`recordBarOf`) - the end slot (Drop task) at its left edge and the next
 * slot (Start, Continue, Show the card, or nothing) at its right, so neither
 * moves between states. It says nothing of its own: the status reason and
 * the body's attention box say what happens next. Closed records, and open
 * rows with no button, have none.
 *
 * Drop task asks once, inline: Cancel takes the end slot and focus, the
 * confirm sentence sits between the slots and says whether unfinished work
 * is kept, and the danger Drop task takes the next slot. Cancel restores the
 * bar and writes nothing. A click is pending until the record changes;
 * competing buttons disable immediately. A refusal is an inline error and
 * writes nothing. Enter does not approve a drop: Cancel takes focus, and
 * both buttons are type="button". Show the card only points at the waiting
 * decision. Tab reaches the buttons in the order shown.
 */
export function RecordPaneFooter({
  bar,
  effects,
  taskId,
  taskKey,
  revision,
  onRun,
  onShowCard,
}: {
  bar: RecordBar | null;
  effects: DropEffects | null;
  /** Its task: the one key a refusal names that stays text (FI3-1271). */
  taskId: string;
  taskKey: string;
  /** Changes whenever the record does: a pending click clears on it. */
  revision: unknown;
  onRun: (op: TaskLifecycleOp, review?: DropTaskReview) => Promise<unknown>;
  onShowCard: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<TaskLifecycleOp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reviewKey = effects ? JSON.stringify(effects) : "";

  // A new reading of the record settles whatever was in flight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the trigger.
  useEffect(() => {
    setPending(null);
  }, [revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the slots, task and reviewed effects are the triggers.
  useEffect(() => {
    setConfirming(false);
    setError(null);
  }, [bar?.end, bar?.next, taskKey, reviewKey]);

  if (!bar || (!bar.end && !bar.next)) return null;
  const end = bar.end;

  const run = (op: TaskLifecycleOp, review?: DropTaskReview) => {
    setPending(op);
    setError(null);
    onRun(op, review).catch((caught: unknown) => {
      setPending(null);
      setConfirming(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };
  const busy = pending !== null;
  const beginDrop = () => {
    if (end === "drop-task") {
      if (!effects) {
        setError(DROP_REVIEW_STALE);
        return;
      }
      if (effects.parts.length > 0) {
        setError(dropPartsRefusal(taskKey, effects.parts));
        return;
      }
    }
    setError(null);
    setConfirming(true);
  };
  const confirm = () => {
    if (end === "stop-task") run("stop-task");
    else if (end === "drop-task" && effects)
      run("drop-task", {
        parts: effects.parts.map((part) => part.key),
        waiting: effects.waiting.map((task) => task.key),
        underway: effects.underway.map((task) => task.key),
      });
  };

  const asking = confirming && end !== null;
  let confirmLine = "";
  if (asking) {
    const unstarted = end === "drop-task" && effects;
    const waiting = unstarted ? dropWaitingLine(effects.waiting) : null;
    const underway = unstarted ? dropUnderwayLine(effects.underway) : null;
    confirmLine = [dropConfirmLead(taskKey, end === "stop-task"), waiting, underway]
      .filter(Boolean)
      .join(" ");
  }

  let endButton: React.ReactNode = null;
  let nextButton: React.ReactNode = null;
  if (asking) {
    endButton = (
      <Button variant="secondary" autoFocus disabled={busy} onClick={() => setConfirming(false)}>
        {DROP_CANCEL_LABEL}
      </Button>
    );
    nextButton = (
      <Button variant="danger" pending={pending === end} disabled={busy} onClick={confirm}>
        {DROP_TASK_LABEL}
      </Button>
    );
  } else {
    if (end) {
      endButton = (
        <Button variant="secondary" disabled={busy} onClick={beginDrop}>
          {DROP_TASK_LABEL}
        </Button>
      );
    }
    if (bar.next === "show-card") {
      nextButton = (
        <Button variant="primary" onClick={onShowCard}>
          {RECORD_NEXT_LABELS["show-card"]}
        </Button>
      );
    } else if (bar.next === "starting") {
      nextButton = (
        <Button variant="primary" disabled>
          {RECORD_NEXT_LABELS.starting}
        </Button>
      );
    } else if (bar.next) {
      const op: TaskLifecycleOp =
        bar.next === "start" || bar.next === "try-again"
          ? "start-task"
          : bar.next === "start-again"
            ? "start-again"
            : "continue-task";
      nextButton = (
        <Button
          variant="primary"
          pending={pending === op}
          disabled={bar.blocked || busy}
          onClick={() => run(op)}
        >
          {RECORD_NEXT_LABELS[bar.next]}
        </Button>
      );
    }
  }

  return (
    <div
      data-record-footer={asking ? "confirm" : "bar"}
      data-record-end={end ?? "none"}
      data-record-next={bar.next ?? "none"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        // The footer wrapper insets 16px; the extra 4px lines the buttons up
        // with the model readout's labels and the body's rows.
        padding: "var(--space-3) var(--space-1) 0",
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
        <div data-record-slot="end" style={{ display: "flex", flexShrink: 0 }}>
          {endButton}
        </div>
        {/* Between the slots: empty at rest, the confirm sentence while Drop task asks. */}
        <div
          {...(asking ? { "data-record-confirm": end } : {})}
          style={{
            flex: "1 1 0",
            minWidth: 0,
            fontSize: "var(--text-sm)",
            color: "var(--fg-2)",
            whiteSpace: "normal",
          }}
        >
          {confirmLine}
        </div>
        <div data-record-slot="next" style={{ display: "flex", flexShrink: 0 }}>
          {nextButton}
        </div>
      </div>
      {error && (
        <p role="alert" style={{ margin: 0, color: "var(--danger)", fontSize: "var(--text-sm)" }}>
          <KeyedText text={error} own={taskId} />
        </p>
      )}
    </div>
  );
}
