import { answerDoneRest, DECLINE_LABEL } from "@shared/cardLeave";
import type { DropTaskReview, TaskLifecycleOp } from "@shared/cards";
import {
  computerMoveLine,
  MOVE_LABELS,
  RECORD_NEXT_LABELS,
  type RecordBar,
} from "@shared/recordBar";
import { CLOSE_DONE_LABEL, closeDoneConfirm } from "@shared/recordCloseDone";
import {
  DROP_CANCEL_LABEL,
  DROP_REVIEW_STALE,
  DROP_TASK_LABEL,
  dropConfirmLead,
  dropPartsLine,
  dropUnderwayLine,
  dropWaitingLine,
} from "@shared/recordDrop";
import type { TaskStatusReading } from "@shared/taskPresentation";
import type { ComputerMoveView, DropEffects, MoveDestination, MoveOptions } from "@shared/tasks";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useCommandKeys } from "../app/keyHints";
import { Badge, Button } from "../design";
import { CardCorner } from "../design/cards/CardSize";
import { useCutWords } from "../design/core/overflowTitle";
import { TaskStatusMark } from "../design/core/TaskStatusMark";
import type { RecordPillTone } from "./recordFooter";
import { KeyedText } from "./TaskKey";

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
  middle,
}: {
  pillTone: RecordPillTone;
  reading: TaskStatusReading | null;
  taskKey: string | null;
  title: string;
  /** The card's tab strip, under the title, when the task has more than Info. */
  tabs?: React.ReactNode;
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
        <CardCorner style={{ marginLeft: "auto" }} />
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
 * The record's Close as done (INF-3169's plan, piece 3): whether it is
 * offered, and the close itself, whose answer is the close's own words or
 * a refusal.
 */
export type RecordCloseDone = {
  offered: boolean;
  close: () => Promise<{ ok: boolean; text: string }>;
};

/**
 * A started task's Move to a computer on its record (docs/helper.md,
 * "Moving a started task"): whether it may move now, the move that stands,
 * where it could go and the ask itself, which `null` cancels.
 */
export type RecordMove = {
  movable?: true;
  computerMove?: ComputerMoveView;
  options: () => Promise<MoveOptions>;
  move: (to: string | null) => Promise<{ ok: boolean; text: string }>;
};

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
 *
 * Close as done (INF-3169's plan, piece 3) sits in its own slot just left
 * of the next slot on started work, and asks once the same way: Cancel
 * takes the end slot and focus, the confirm sentence says what the close
 * does to the work, and a primary Close as done takes the next slot. The
 * record stays, and reads Done once the close is accepted.
 */
export function RecordPaneFooter({
  bar,
  effects,
  taskId,
  taskKey,
  revision,
  onRun,
  onShowCard,
  move,
  closeDone,
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
  move?: RecordMove;
  closeDone?: RecordCloseDone;
}) {
  /** The one confirm that asks, Drop task's or Close as done's, if any. */
  const [confirming, setConfirming] = useState<"drop" | "close-done" | null>(null);
  /** Close as done's close while it runs. */
  const [closingDone, setClosingDone] = useState(false);
  const [pending, setPending] = useState<TaskLifecycleOp | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Move to a computer's picker, while it is open: every other computer, and the one chosen. */
  const [picking, setPicking] = useState<MoveDestination[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [moving, setMoving] = useState<"open" | "move" | "cancel" | null>(null);
  const moveKeys = useCommandKeys("task.move-computer");
  const doneKeys = useCommandKeys("cards.done");
  const closeDoneKeys = useCommandKeys("task.close-done");
  const reviewKey = effects ? JSON.stringify(effects) : "";

  // A new reading of the record settles whatever was in flight.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the trigger.
  useEffect(() => {
    setPending(null);
    setClosingDone(false);
  }, [revision]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the slots, task and reviewed effects are the triggers.
  useEffect(() => {
    setConfirming((asked) => (asked === "drop" ? null : asked));
    setError(null);
  }, [bar?.end, bar?.next, taskKey, reviewKey]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the offer and the task are the triggers.
  useEffect(() => {
    setConfirming((asked) => (asked === "close-done" ? null : asked));
  }, [closeDone?.offered, taskKey]);
  // A move that started, or a task that may no longer move, closes the picker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the move's state and the task are the triggers.
  useEffect(() => {
    setPicking(null);
    setChosen(null);
    setMoving(null);
  }, [move?.movable, move?.computerMove?.state, taskKey]);

  const offersDone = closeDone?.offered === true;
  if (!bar || (!bar.end && !bar.next && !offersDone)) return null;
  const end = bar.end;

  const run = (op: TaskLifecycleOp, review?: DropTaskReview) => {
    setPending(op);
    setError(null);
    onRun(op, review).catch((caught: unknown) => {
      setPending(null);
      setConfirming(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };
  const busy = pending !== null || closingDone;
  const beginDrop = () => {
    if (end === "drop-task") {
      if (!effects) {
        setError(DROP_REVIEW_STALE);
        return;
      }
    }
    setError(null);
    setConfirming("drop");
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

  const confirmDone = () => {
    if (!closeDone) return;
    setClosingDone(true);
    setError(null);
    closeDone
      .close()
      .then((done) => {
        setConfirming(null);
        if (!done.ok) {
          setClosingDone(false);
          setError(done.text);
        }
      })
      .catch((caught: unknown) => {
        setClosingDone(false);
        setConfirming(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  };

  const openPicker = () => {
    if (!move) return;
    setMoving("open");
    setError(null);
    move
      .options()
      .then((options) => {
        setMoving(null);
        if (!options.ok) setError(options.text);
        else {
          setPicking(options.destinations);
          setChosen(null);
        }
      })
      .catch((caught: unknown) => {
        setMoving(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  };
  const ask = (to: string | null) => {
    if (!move) return;
    setMoving(to === null ? "cancel" : "move");
    setError(null);
    move
      .move(to)
      .then((done) => {
        setMoving(null);
        if (!done.ok) setError(done.text);
        else {
          setPicking(null);
          setChosen(null);
        }
      })
      .catch((caught: unknown) => {
        setMoving(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  };

  const askingDone = confirming === "close-done" && offersDone;
  const asking = confirming === "drop" && end !== null;
  const choosing = !asking && !askingDone && picking !== null;
  let confirmLine = "";
  if (askingDone) confirmLine = closeDoneConfirm(taskKey);
  else if (asking) {
    const unstarted = end === "drop-task" && effects;
    const parts = unstarted ? dropPartsLine(effects.parts) : null;
    const waiting = unstarted ? dropWaitingLine(effects.waiting) : null;
    const underway = unstarted ? dropUnderwayLine(effects.underway) : null;
    confirmLine = [dropConfirmLead(taskKey, end === "stop-task"), parts, waiting, underway]
      .filter(Boolean)
      .join(" ");
  }

  let endButton: React.ReactNode = null;
  let nextButton: React.ReactNode = null;
  let doneButton: React.ReactNode = null;
  let between: React.ReactNode = confirmLine;
  if (askingDone) {
    // Its own key: the end slot's Drop task must not be reused, or autoFocus never runs.
    endButton = (
      <Button
        key="close-done-cancel"
        variant="secondary"
        autoFocus
        disabled={closingDone}
        onClick={() => setConfirming(null)}
      >
        {DROP_CANCEL_LABEL}
      </Button>
    );
    nextButton = (
      <Button
        variant="primary"
        data-record-close-done-confirm=""
        pending={closingDone}
        disabled={closingDone}
        onClick={confirmDone}
      >
        {CLOSE_DONE_LABEL}
      </Button>
    );
  } else if (choosing) {
    endButton = (
      <Button
        variant="secondary"
        disabled={moving !== null}
        onClick={() => {
          setPicking(null);
          setChosen(null);
        }}
      >
        {MOVE_LABELS.cancel}
      </Button>
    );
    between = (
      <MovePicker
        taskKey={taskKey}
        destinations={picking}
        chosen={chosen}
        disabled={moving !== null}
        onChoose={setChosen}
      />
    );
    nextButton = (
      <Button
        variant="primary"
        data-record-move-confirm=""
        pending={moving === "move"}
        disabled={chosen === null || moving !== null}
        onClick={() => chosen && ask(chosen)}
      >
        {MOVE_LABELS.move}
      </Button>
    );
  } else if (end === "dismiss-question") {
    endButton = (
      <Button variant="secondary" pending={pending === end} onClick={() => run(end)}>
        {DECLINE_LABEL}
      </Button>
    );
    nextButton = (
      <Button variant="primary" onClick={onShowCard}>
        {RECORD_NEXT_LABELS["show-card"]}
      </Button>
    );
  } else if (asking) {
    endButton = (
      <Button variant="secondary" autoFocus disabled={busy} onClick={() => setConfirming(null)}>
        {DROP_CANCEL_LABEL}
      </Button>
    );
    nextButton = (
      <Button variant="danger" pending={pending === end} disabled={busy} onClick={confirm}>
        {DROP_TASK_LABEL}
      </Button>
    );
  } else {
    const moveButton =
      move?.computerMove?.state === "waiting" ? (
        <Button
          variant="secondary"
          data-record-move-cancel=""
          pending={moving === "cancel"}
          disabled={busy || moving !== null}
          onClick={() => ask(null)}
        >
          {MOVE_LABELS.cancelMove}
        </Button>
      ) : move?.movable && !move.computerMove ? (
        <Button
          variant="secondary"
          data-record-move-open=""
          {...moveKeys}
          pending={moving === "open"}
          disabled={busy || moving !== null}
          onClick={openPicker}
        >
          {MOVE_LABELS.open}
        </Button>
      ) : null;
    if (end || moveButton) {
      endButton = (
        <>
          {end && (
            <Button variant="secondary" disabled={busy} onClick={beginDrop}>
              {DROP_TASK_LABEL}
            </Button>
          )}
          {moveButton}
        </>
      );
    }
    if (move?.computerMove) between = computerMoveLine(move.computerMove);
    if (offersDone)
      doneButton = (
        <Button
          variant="secondary"
          data-record-close-done=""
          {...closeDoneKeys}
          disabled={busy}
          onClick={() => {
            setError(null);
            setConfirming("close-done");
          }}
        >
          {CLOSE_DONE_LABEL}
        </Button>
      );
    if (bar.next === "show-card") {
      nextButton = (
        <Button variant="primary" onClick={onShowCard}>
          {RECORD_NEXT_LABELS["show-card"]}
        </Button>
      );
    } else if (bar.next === "answer-done") {
      nextButton = (
        <Button
          variant="primary"
          pending={pending === "answer-done"}
          data-answer-done-control=""
          {...doneKeys}
          note={answerDoneRest(taskKey)}
          onClick={() => run("answer-done")}
        >
          {RECORD_NEXT_LABELS["answer-done"]}
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
      data-record-footer={asking || askingDone ? "confirm" : choosing ? "move" : "bar"}
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
        <div
          data-record-slot="end"
          style={{ display: "flex", flexShrink: 0, gap: "var(--space-2)" }}
        >
          {endButton}
        </div>
        {/* Between the slots: empty at rest, the confirm sentence while Drop
            task asks, the computers while Move to a computer picks, and where
            a move stands while one does. */}
        <div
          {...(asking ? { "data-record-confirm": end } : {})}
          {...(askingDone ? { "data-record-confirm": "close-done" } : {})}
          {...(!asking && !askingDone && !choosing && move?.computerMove
            ? { "data-record-move": move.computerMove.state }
            : {})}
          style={{
            flex: "1 1 0",
            minWidth: 0,
            fontSize: "var(--text-sm)",
            color: "var(--fg-2)",
            whiteSpace: "normal",
          }}
        >
          {between}
        </div>
        {doneButton && (
          <div data-record-slot="done" style={{ display: "flex", flexShrink: 0 }}>
            {doneButton}
          </div>
        )}
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

/**
 * Move to a computer's choices: every other computer as one radio button,
 * reached with Tab and moved between with the arrow keys. A computer that
 * cannot take the task now stays in the list, off, and says why on rest or
 * focus. Picking saves nothing: Move does.
 */
function MovePicker({
  taskKey,
  destinations,
  chosen,
  disabled,
  onChoose,
}: {
  taskKey: string;
  destinations: MoveDestination[];
  chosen: string | null;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const takers = destinations.filter((destination) => !destination.unavailable);
  const first = takers[0]?.id ?? destinations[0]?.id;
  // Focus goes to the chosen computer, else the first that can take the task.
  useEffect(() => {
    group.current
      ?.querySelector<HTMLButtonElement>('[role="radio"][tabindex="0"]')
      ?.focus({ preventScroll: true });
  }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (!step || takers.length === 0) return;
    event.preventDefault();
    const at = takers.findIndex((destination) => destination.id === (chosen ?? first));
    const next = takers[(at + step + takers.length) % takers.length];
    if (!next) return;
    onChoose(next.id);
    group.current
      ?.querySelector<HTMLButtonElement>(`[data-record-move-to="${CSS.escape(next.id)}"]`)
      ?.focus({ preventScroll: true });
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={`${MOVE_LABELS.to} ${taskKey}`}
      onKeyDown={onKeyDown}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-2)" }}
    >
      <span>{MOVE_LABELS.to}</span>
      {destinations.map((destination) => {
        const selected = chosen === destination.id;
        const tabbable = destination.id === (chosen ?? first);
        return (
          <Button
            key={destination.id}
            variant="secondary"
            size="sm"
            role="radio"
            aria-checked={selected}
            tabIndex={tabbable ? 0 : -1}
            data-record-move-to={destination.id}
            disabled={disabled}
            off={destination.unavailable !== undefined}
            {...(destination.unavailable ? { note: destination.unavailable } : {})}
            onClick={() => onChoose(destination.id)}
            style={
              selected
                ? { borderColor: "var(--accent)", background: "var(--accent-dim)" }
                : undefined
            }
          >
            {destination.name}
          </Button>
        );
      })}
    </div>
  );
}
