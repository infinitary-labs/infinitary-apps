import { DELIVERY_BASIS_WORDS, DELIVERY_FACTS_LABEL } from "@shared/deliveryFacts";
import { formatList, formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { partWordOf, recordAttentionOf, recordClosedLineOf } from "@shared/recordAttention";
import { type TaskStatus, taskStatusOf } from "@shared/taskPresentation";
import type { TaskDetail, TaskView } from "@shared/tasks";
import { type ReactNode, useRef, useState } from "react";
import { Age, useMinute } from "../design/core/TaskFacts";
import { TaskStatusMark } from "../design/core/TaskStatusMark";
import { openTaskFromKey } from "../plugins/point/openTask";
import { KeyedText, useKeyRest } from "./TaskKey";
import "./recordHead.css";

/**
 * The top of the task record's Info tab (INF-2261), drawn by the window
 * above the shared task facts: a charted filing's Why, the attention
 * sentence when something is wrong or the task waits, and how a closed task
 * closed. A failure or a wait leads, above the Why.
 */
export function RecordAttention({
  detail,
  onOpenChange,
}: {
  detail: TaskDetail;
  onOpenChange: (url: string) => void;
}) {
  const now = useMinute();
  const attention = recordAttentionOf(detail, now);
  const closed = attention ? null : recordClosedLineOf(detail);
  const filing = detail.filing;
  const charted = Boolean(filing) && detail.status === "open";
  if (!attention && !closed && !charted) return null;
  const box = attention && (
    <section
      className="attention"
      data-record-attention=""
      data-urgent={attention.urgent ? "" : undefined}
      data-danger={attention.danger ? "" : undefined}
    >
      <p data-record-attention-title="">
        <KeyedText text={attention.title} own={detail.id} />
      </p>
      {attention.guidance && (
        <p className="guidance" data-record-attention-guidance="">
          <KeyedText text={attention.guidance} own={detail.id} />
        </p>
      )}
    </section>
  );
  return (
    <div className="fm-record-head" data-record-overview="">
      {attention?.urgent && box}
      {charted && filing && (
        <section className="why" data-record-section="filing">
          <h3 className="label">{m.cardRecordWhy()}</h3>
          <p className="goal" data-record-why="">
            {filing.why || m.cardRecordNoReason()}
          </p>
          <p className="verdict" data-record-verdict="">
            {filing.verdict
              ? m.cardRecordVerdict({ verdict: filing.verdict })
              : m.cardRecordNoVerdict()}
          </p>
        </section>
      )}
      {!attention?.urgent && box}
      {closed && (
        <p className="context" data-record-context="">
          {closed.lead}
          {closed.at !== null && <Age at={closed.at} now={now} focusable ago />}
          {closed.change && (
            <>
              {" as "}
              {closed.change.url ? (
                <a
                  href={closed.change.url}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenChange(closed.change?.url as string);
                  }}
                >
                  {`${closed.change.noun} ${closed.change.label}`}
                </a>
              ) : (
                `${closed.change.noun} ${closed.change.label}`
              )}
            </>
          )}
          {closed.tail}
        </p>
      )}
    </div>
  );
}

/** One row of the record's head, its micro label in the side column (the shared facts' row). */
function Row({ label, hook, children }: { label: string; hook?: string; children: ReactNode }) {
  return (
    <div className="row" data-record-row={hook}>
      <div className="label" data-task-fact-label="">
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * How a close as done delivered the work (INF-3169's plan, piece 3): the
 * first of the record's rows on a closed task, one fact a line, each with
 * how it is known at the line's right edge, where Now keeps its age.
 */
export function RecordDelivered({ detail }: { detail: TaskDetail }) {
  const facts = detail.closing?.facts ?? [];
  if (facts.length === 0) return null;
  return (
    <Row label={DELIVERY_FACTS_LABEL} hook="delivered">
      <ul className="delivered" data-record-delivery-facts="">
        {facts.map((fact) => (
          <li key={`${fact.basis}:${fact.text}`} data-record-delivery-fact={fact.basis}>
            <span className="fact">
              <KeyedText text={fact.text} own={detail.id} />
            </span>
            <span className="basis">{DELIVERY_BASIS_WORDS[fact.basis]}</span>
          </li>
        ))}
      </ul>
    </Row>
  );
}

/**
 * The task's place among other tasks, as rows of keys above the goal
 * (INF-2261): what it is part of, what it waits on, what it holds up, and
 * its parts. Each key links to its task (FI3-1271).
 */
export function RecordRelations({
  detail,
  parentKey,
  onOpenLink,
  partsOpen = true,
  onPartsToggle,
}: {
  detail: TaskDetail;
  parentKey: string | undefined;
  /** Where a click on the outside issue's link goes; without it the issue is plain text. */
  onOpenLink?: (url: string) => void;
  /** Whether the parts list is unfolded; it starts unfolded. */
  partsOpen?: boolean;
  onPartsToggle?: (open: boolean) => void;
}) {
  const issue = detail.issue;
  const keys = (list: readonly string[]) => <KeyedText text={list.join("  ")} own={detail.id} />;
  return (
    <>
      {parentKey && (
        <Row label={m.cardRecordPartOf()}>
          <div className="keys" data-record-fact="parent">
            {keys([parentKey])}
          </div>
        </Row>
      )}
      {detail.blockedBy.length > 0 && (
        <Row label={m.cardRecordWaitsOn()}>
          <div className="keys" data-record-fact="blocked-by">
            {keys(detail.blockedBy)}
          </div>
        </Row>
      )}
      {detail.blocks.length > 0 && (
        <Row label={m.cardRecordHoldsUp()}>
          <div className="keys" data-record-fact="blocks">
            {keys(detail.blocks)}
          </div>
        </Row>
      )}
      {issue && (
        <Row label={m.cardRecordIssue()}>
          <div className="keys" data-record-fact="issue">
            {onOpenLink ? (
              <a
                className="change-link"
                href={issue.url}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenLink(issue.url);
                }}
              >
                #{issue.number}
              </a>
            ) : (
              <span>#{issue.number}</span>
            )}
          </div>
        </Row>
      )}
      {detail.children.total > 0 && (
        <Row label={m.cardRecordParts()} hook="parts">
          <RecordParts detail={detail} open={partsOpen} onToggle={onPartsToggle} />
        </Row>
      )}
    </>
  );
}

/** Past this many parts, the closed ones fold behind one line and the open ones always show. */
const FOLD_CLOSED_OVER = 8;

const isClosed = (part: TaskView) => part.status === "done" || part.status === "dropped";

/** A part's segment on the bar, in the Tasks panel bar's colors. */
function barState(mark: TaskStatus): string {
  if (mark === "done" || mark === "dropped") return "done";
  if (mark === "waiting") return "waiting";
  return mark === "working" || mark === "starting" ? "working" : "rest";
}

/**
 * A parent's parts (INF-6805's plan, item 1; the captain: "the parts list
 * should be foldable"): how many closed with a bar of each part's state,
 * folding a row per part in filing order. A row opens that part's record,
 * where its own Start or card is; it carries no button of its own (the
 * captain's answer row_step: open). An older home sends no parts, and the
 * row keeps its count alone.
 */
function RecordParts({
  detail,
  open,
  onToggle,
}: {
  detail: TaskDetail;
  open: boolean;
  onToggle: ((open: boolean) => void) | undefined;
}) {
  const [closedShown, setClosedShown] = useState(false);
  const count = m.cardRecordChildrenClosed({
    closed: formatNumber(detail.children.closed),
    total: formatNumber(detail.children.total),
  });
  const parts = detail.parts ?? [];
  if (parts.length === 0) return <div data-record-fact="children">{count}</div>;
  const readings = new Map(parts.map((part) => [part.id, taskStatusOf(part)]));
  const closedParts = parts.filter(isClosed);
  const segments = [...closedParts, ...parts.filter((part) => !isClosed(part))];
  const folds = parts.length > FOLD_CLOSED_OVER && closedParts.length > 0;
  const shown = folds && !closedShown ? parts.filter((part) => !isClosed(part)) : parts;
  return (
    <details
      className="fm-record-fold fm-record-parts"
      data-record-parts=""
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next !== open) onToggle?.(next);
      }}
    >
      <summary>
        <span data-record-fact="children">{count}</span>
        <span className="bar" aria-hidden="true">
          {segments.map((part) => (
            <i key={part.id} data-part={barState(readings.get(part.id)?.mark ?? "backlog")} />
          ))}
        </span>
      </summary>
      <div className="parts-body">
        {folds && (
          <button
            type="button"
            className="closed-fold"
            data-record-parts-closed=""
            aria-expanded={closedShown}
            onClick={() => setClosedShown(!closedShown)}
          >
            {m.recordPartsClosedFold({ count: closedParts.length })}
          </button>
        )}
        <ul className="parts">
          {shown.map((part) => (
            <PartRow key={part.id} part={part} />
          ))}
        </ul>
      </div>
    </details>
  );
}

/**
 * One part: its status mark, title, key and word. Resting on it or
 * focusing it opens its summary as a key does; a click or Enter - only the
 * captain's own - opens its record.
 */
function PartRow({ part }: { part: TaskView }) {
  const rest = useKeyRest(part.id);
  const rested = useRef(false);
  const restOn = (anchor: HTMLElement | null) => {
    rested.current = anchor !== null;
    rest(anchor);
  };
  const key = part.key || part.id;
  return (
    <li>
      <button
        type="button"
        className="part"
        data-record-part={key}
        data-closed={isClosed(part) ? "" : undefined}
        onPointerEnter={(event) => restOn(event.currentTarget)}
        onPointerLeave={() => restOn(null)}
        onPointerDown={() => restOn(null)}
        onFocus={(event) => {
          const row = event.currentTarget;
          if (!row.matches(":focus-visible")) return;
          // Once the window has brought the row into view, where its summary goes.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (row.ownerDocument.activeElement === row) restOn(row);
            }),
          );
        }}
        onBlur={() => restOn(null)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !rested.current) return;
          event.stopPropagation();
          restOn(null);
        }}
        onClick={(event) => {
          if (!event.nativeEvent.isTrusted) return;
          restOn(null);
          void openTaskFromKey(part).catch(() => {});
        }}
      >
        <TaskStatusMark reading={taskStatusOf(part)} nativeTitle={false} />
        <span className="title">{part.title}</span>
        <span className="key">{key}</span>
        <span className="word">{partWordOf(part)}</span>
      </button>
    </li>
  );
}

export function recordAsksOf(detail: TaskDetail): TaskDetail["asks"] {
  const words = detail.intent?.userWords ?? "";
  return detail.asks.filter((ask) => ask.text !== words);
}

/**
 * The fold's name (INF-2261, the captain's pick: "Folded under the goal,
 * closed, with their count in the fold's name"): what it holds, with how
 * many of the captain's messages are in it.
 */
export function recordWordsFoldName(detail: TaskDetail): string | null {
  const words = detail.intent?.userWords ?? "";
  const count = recordAsksOf(detail).length + (words ? 1 : 0);
  const filed = Boolean(detail.filing) && detail.status !== "open";
  const parts: string[] = [];
  if (filed) parts.push(m.cardRecordFiledWhy());
  if (detail.skippedPlanBecause) parts.push(m.cardRecordFoldNoPlan());
  if (count > 0) parts.push(m.cardRecordFoldMessages({ count }));
  if (parts.length === 0) return null;
  const name = formatList(parts, "and");
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/**
 * The goal, whole, with the captain's words folded under it, closed until
 * opened and remembered per task (INF-2261). The fold holds why a crew
 * filing was filed and the first mate's verdict, why the first mate built
 * without a plan, and the captain's words with their ages.
 */
export function RecordGoal({
  detail,
  open,
  onToggle,
}: {
  detail: TaskDetail;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const now = useMinute();
  const fold = recordWordsFoldName(detail);
  if (!detail.goal && !fold) return null;
  const words = detail.intent?.userWords ?? "";
  const asks = recordAsksOf(detail);
  const filing = detail.filing;
  const filed = Boolean(filing) && detail.status !== "open";
  const closed = detail.status === "done" || detail.status === "dropped";
  return (
    <Row label={m.cardRecordGoal()}>
      <div className="goal-cell">
        {detail.goal && (
          <p className="goal" data-record-goal="">
            <KeyedText text={detail.goal} own={detail.id} />
          </p>
        )}
        {fold && (
          <details
            className="fm-record-fold"
            data-record-section="words"
            open={open}
            onToggle={(event) => {
              const next = event.currentTarget.open;
              if (next !== open) onToggle(next);
            }}
          >
            <summary data-record-words-fold="">{fold}</summary>
            <div className="fold-body">
              {filed && filing && (
                <section className="why" data-record-section="filed">
                  <h3 className="label">{m.cardRecordFiledWhy()}</h3>
                  <p data-record-filed-why="">{filing.why || m.cardRecordNoReason()}</p>
                  {!closed && (
                    <p className="verdict" data-record-filed-verdict="">
                      {filing.verdict
                        ? m.cardRecordVerdict({ verdict: filing.verdict })
                        : m.cardRecordNoVerdict()}
                    </p>
                  )}
                </section>
              )}
              {detail.skippedPlanBecause && (
                <section className="why" data-record-plan-skip-section="">
                  <h3 className="label">{m.cardRecordNoPlanWhy()}</h3>
                  <p data-record-plan-skip="">{detail.skippedPlanBecause}</p>
                </section>
              )}
              {(words || asks.length > 0) && (
                <section className="why">
                  <h3 className="label">{m.cardRecordYouSaid()}</h3>
                  {words && (
                    <blockquote className="words" data-record-words="">
                      <KeyedText text={words} own={detail.id} />
                    </blockquote>
                  )}
                  {asks.length > 0 && (
                    <div className="asks" data-record-asks="">
                      {asks.map((ask) => (
                        <div key={ask.id} className="ask" data-record-ask={ask.id}>
                          <Age at={ask.at} now={now} focusable />
                          <span>
                            <KeyedText text={ask.text} own={detail.id} />
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
            </div>
          </details>
        )}
      </div>
    </Row>
  );
}
