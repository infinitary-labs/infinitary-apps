import { FACT_DOT, type FactDotState } from "@shared/factDot";
import { feedRelativeAge } from "@shared/feed";
import { reasoningWord } from "@shared/reasoning";
import type { TaskFacts } from "@shared/taskFacts";
import {
  clipPlanLine,
  foldPlan,
  PLAN_FOLD_PAST,
  type PlanItemState,
  planCounts,
  type TaskPlan,
  type TaskPlanItem,
} from "@shared/taskPlan";
import { type ReactNode, useEffect, useState } from "react";
import { SlotBadge } from "../quota/SlotBadge";
import { useOverflowTitle } from "./overflowTitle";
import { useRestLabel } from "./restLabel";
import "./taskFacts.css";

/** Repaints short ages each minute; only their text changes. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * A short age beside a fact (`2m`): its exact time shows on rest, the
 * pointer's or - where the surface takes the keyboard, the record - the
 * keyboard's focus, which makes the age a Tab stop of its own; its
 * accessible name carries both (docs/keyboard.md, "Facts shown on rest").
 */
function Age({ at, now, focusable }: { at: number; now: number; focusable: boolean }) {
  const exact = new Date(at).toLocaleString();
  const short = feedRelativeAge(at, Math.max(now, at));
  const rest = useRestLabel(exact, { fact: true });
  return (
    <time
      className="age"
      data-task-fact-age=""
      dateTime={new Date(at).toISOString()}
      role="img"
      aria-label={`${short} · ${exact}`}
      tabIndex={focusable ? 0 : undefined}
      {...rest}
    >
      {short}
    </time>
  );
}

/**
 * The fact strip's state dot (`@shared/factDot`), the merge card's own
 * drawing: a tick, a cross, a bang or a ring, its color the state's.
 */
export function FactDot({ state }: { state: FactDotState }) {
  const shape = FACT_DOT[state];
  return (
    <svg
      className="dot"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      data-fact-dot={state}
    >
      {"ring" in shape ? (
        <circle cx="5" cy="5" r="4" fill="none" stroke={shape.ring} strokeWidth="1.5" />
      ) : (
        <>
          <circle cx="5" cy="5" r="4.5" fill={shape.disc} />
          <path
            d={shape.mark}
            stroke="var(--bg-2)"
            strokeWidth="1.4"
            fill="none"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

/** One cell of the fact strip: its micro label over its value, the value one line. */
function Cell({
  label,
  fact,
  title,
  children,
  ...data
}: {
  label: string;
  fact: string;
  title?: string;
  children: ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <div className="cell">
      <div className="label" data-task-fact-label="">
        {label}
      </div>
      <div className="value" data-task-fact={fact} title={title} {...data}>
        {children}
      </div>
    </div>
  );
}

/** The word the plan is labelled with on every surface (the captain's pick, FI3-734). */
export const PLAN_LABEL = "Progress";

const MARK_COLOR: Record<PlanItemState, string> = {
  done: "var(--fg-2)",
  current: "var(--accent)",
  next: "var(--idle)",
  skipped: "var(--fg-3)",
};

/**
 * One item's mark, in the task marks' own box: on the list a check, a lit
 * ring, a hollow ring or a dash; on the line a dot - filled when done, lit
 * when current, hollow when next, a dash when skipped. Shape carries the
 * state as well as color.
 */
export function PlanMark({ state, dot = false }: { state: PlanItemState; dot?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      aria-hidden="true"
      style={{ color: MARK_COLOR[state], flexShrink: 0, display: "block" }}
    >
      {state === "skipped" ? (
        <path
          d="M4 8h8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      ) : state === "done" ? (
        dot ? (
          <circle cx="8" cy="8" r="4" fill="currentColor" />
        ) : (
          <path
            d="M2 8 6 12 14 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )
      ) : state === "current" ? (
        <circle
          cx="8"
          cy="8"
          r={dot ? 5 : 6}
          fill={dot ? "var(--accent-dim)" : "none"}
          stroke="currentColor"
          strokeWidth={dot ? 1.8 : 1.6}
        />
      ) : (
        <circle cx="8" cy="8" r={dot ? 4 : 6} fill="none" stroke="currentColor" strokeWidth="1.2" />
      )}
    </svg>
  );
}

/** "2 of 4", and "· 1 skipped" when any item was. */
function PlanCount({ plan }: { plan: TaskPlan }) {
  const { done, total, skipped } = planCounts(plan.items);
  return (
    <>
      <span className="count" data-task-fact-count="">
        {done} of {total}
      </span>
      {skipped > 0 && <span className="count">· {skipped} skipped</span>}
    </>
  );
}

type PlanNode = Pick<TaskPlanItem, "label" | "short" | "state"> & {
  group?: number;
  fold?: "done" | "later";
};

/** The short label under a progress dot. A fuller name, or a cut short label, stays on hover. */
function PlanShort({ node }: { node: PlanNode }) {
  const same = node.label === node.short;
  const fit = useOverflowTitle(same ? node.short : undefined);
  return (
    <span className="short" ref={same ? fit.ref : undefined} title={same ? fit.title : node.label}>
      {node.short}
    </span>
  );
}

/**
 * The plan on the line (the crew summary): one dot per item with its short
 * label under it, the line filled in behind the finished dots. Past
 * `PLAN_FOLD_PAST` items the finished ones fold into one counted dot; a line
 * that still holds more than eight staggers its labels above and below, and
 * past the dots it holds the items after the current one fold into one last
 * counted dot (`clipPlanLine`), their names on hover and whole on the record.
 */
function PlanDots({ plan }: { plan: TaskPlan }) {
  const fold = foldPlan(plan.items);
  const unclipped: PlanNode[] = fold
    ? [
        {
          state: "done",
          short: `${fold.folded.length} done`,
          label: fold.folded.map((item) => item.label).join(", "),
          group: fold.folded.length,
          fold: "done",
        },
        ...fold.rest,
      ]
    : plan.items;
  const clip = clipPlanLine(unclipped);
  const nodes: PlanNode[] = clip
    ? [
        ...clip.shown,
        {
          state: clip.later.every((node) => node.state === "done") ? "done" : "next",
          short: `${clip.later.length} more`,
          label: clip.later.map((node) => node.label).join(", "),
          group: clip.later.length,
          fold: "later",
        },
      ]
    : unclipped;
  const { done, total } = planCounts(plan.items);
  return (
    <div
      className="plan-dots"
      data-task-plan-dots={nodes.length}
      data-stagger={nodes.length > PLAN_FOLD_PAST ? "" : undefined}
      role="img"
      aria-label={`${PLAN_LABEL}: ${done} of ${total} done`}
    >
      {nodes.map((node, index) => (
        <div
          key={node.fold ? `folded-${node.fold}` : node.label}
          className="dot"
          data-plan-item={node.state}
          data-plan-prev={index > 0 ? nodes[index - 1]?.state : undefined}
          data-plan-group={node.group}
        >
          <span className="mark">
            <PlanMark state={node.state} dot />
          </span>
          <PlanShort node={node} />
        </div>
      ))}
    </div>
  );
}

/** The current item on the plan's row, cut to its line with the whole label on hover. */
function PlanCurrent({ words }: { words: string }) {
  const fit = useOverflowTitle(words);
  return (
    <span className="current" data-task-plan-current="" ref={fit.ref} title={fit.title}>
      {words}
    </span>
  );
}

/**
 * The plan as the record lists it: every item with its mark, a finished one
 * with the time it finished, a skipped one saying so; past `PLAN_FOLD_PAST`
 * items the finished ones wait behind Show earlier, as Activity's do.
 */
function PlanList({ plan, now, focusable }: { plan: TaskPlan; now: number; focusable: boolean }) {
  const [unfoldedAt, setUnfoldedAt] = useState<number | null>(null);
  const fold = unfoldedAt === plan.at ? null : foldPlan(plan.items);
  const items = fold ? fold.rest : plan.items;
  return (
    <div className="plan-list" data-task-plan-list={plan.items.length}>
      {fold && (
        <div className="item" data-plan-fold="">
          <span className="mark" />
          <button
            type="button"
            className="earlier"
            data-task-plan-earlier=""
            onClick={() => setUnfoldedAt(plan.at)}
          >
            Show earlier · {fold.folded.length}
          </button>
        </div>
      )}
      {items.map((item) => (
        <div key={item.label} className="item" data-plan-item={item.state}>
          <span className="mark">
            <PlanMark state={item.state} />
          </span>
          <span className="label-text" data-plan-label="">
            {item.label}
            {item.state === "skipped" && <span className="skipped"> skipped</span>}
          </span>
          {item.state === "done" ? (
            <Age at={item.since} now={now} focusable={focusable} />
          ) : (
            <span />
          )}
        </div>
      ))}
    </div>
  );
}

/** Whether the task has anything for its fact strip: a model, or its change, checks or review. */
export function hasFactStrip(facts: TaskFacts): boolean {
  return facts.model !== null || facts.delivery !== null;
}

/**
 * The task's fact strip (FI3-1159, the captain's layout B), the merge
 * card's own shape: one cell per fact, each an uppercase micro label over a
 * one-line value, the cells wrapping whole - the model, its intelligence
 * level and its reasoning (FI3-439), then the change (a link where the
 * host has a page and the surface takes clicks), its checks with the
 * reading's age, and a review's verdict - then the footnote saying why
 * that model. The crew summary draws it last, under a hairline; the task
 * record draws it just above its action bar.
 */
export function TaskFactStrip({
  facts,
  onOpenChange,
  focusable = false,
}: {
  facts: TaskFacts;
  /** Where a click on the change goes; without it the change is plain text. */
  onOpenChange?: (url: string) => void;
  /**
   * The surface takes the keyboard (the record): an age is a Tab stop that
   * shows its exact time. The summary, which takes neither, leaves it out.
   */
  focusable?: boolean;
}) {
  const now = useMinute();
  if (!hasFactStrip(facts)) return null;
  const { change, checks, review } = facts.delivery ?? {};
  const changeWords = change ? (change.label ?? change.noun) : "";
  return (
    <div className="strip">
      <div className="cells" data-task-fact-strip="">
        {facts.model && (
          <Cell label="Model" fact="model" title={facts.model}>
            {facts.model}
          </Cell>
        )}
        {facts.tier && (
          <Cell label="Intelligence" fact="intelligence" data-slot={facts.tier}>
            <SlotBadge slot={facts.tier} />
          </Cell>
        )}
        {facts.reasoning && (
          <Cell label="Reasoning" fact="reasoning" data-level={facts.reasoning.level}>
            {reasoningWord(facts.reasoning)}
          </Cell>
        )}
        {change && (
          <Cell label={change.noun} fact="change" title={changeWords}>
            {change.url && onOpenChange ? (
              <a
                href={change.url}
                onClick={(event) => {
                  event.preventDefault();
                  onOpenChange(change.url as string);
                }}
              >
                {changeWords}
              </a>
            ) : (
              changeWords
            )}
          </Cell>
        )}
        {checks && (
          <Cell label="Checks" fact="checks" data-dot={checks.dot}>
            <FactDot state={checks.dot} />
            {checks.words}
            {checks.at != null && <Age at={checks.at} now={now} focusable={focusable} />}
          </Cell>
        )}
        {review && (
          <Cell label="Review" fact="review" data-dot={review.dot}>
            <FactDot state={review.dot} />
            {review.words}
          </Cell>
        )}
      </div>
      {facts.reason && (
        <div className="reason" data-task-fact="reason">
          {facts.reason}
        </div>
      )}
    </div>
  );
}

/**
 * Now's words, the pull request they name a link where the surface takes
 * clicks (the design skill's TaskRecord, "Pull request links"), the rest
 * drawn by `words` - the record links its task keys there.
 */
function NowWords({
  now,
  words,
  onOpen,
}: {
  now: NonNullable<TaskFacts["now"]>;
  words?: (text: string) => ReactNode;
  onOpen?: (url: string) => void;
}) {
  const plain = (text: string) => (words ? words(text) : text);
  const change = now.change;
  if (!change || !onOpen) return <>{plain(now.text)}</>;
  return (
    <>
      {change.from > 0 && plain(now.text.slice(0, change.from))}
      <a
        className="change-link"
        href={change.url}
        onClick={(event) => {
          event.preventDefault();
          onOpen(change.url);
        }}
      >
        {now.text.slice(change.from, change.to)}
      </a>
      {change.to < now.text.length && plain(now.text.slice(change.to))}
    </>
  );
}

/**
 * The shared task facts after the status (the design skill's NowPanel
 * "Shared task facts"): the task, Now, Progress, the task's own browser,
 * then the fact strip - the model, its intelligence and reasoning, the
 * change, its checks and a review, and the footnote - in that order. The
 * crew summary and the task record both draw them from one projection
 * (`taskFactsOf`), so one task reads the same values on both. The record
 * draws the strip itself just above its action bar (`omitStrip`), after
 * Goal and your words, Activity and Details. The task row is the
 * summary's; the record has its title in its chrome. Each value carries
 * its identity in `data-task-fact`.
 */
export function TaskFactRows({
  facts,
  withTask = false,
  project,
  planView,
  omitStrip = false,
  onOpenChange,
  onOpenBrowser,
  nowWords,
  focusable = false,
}: {
  facts: TaskFacts;
  withTask?: boolean;
  /**
   * The Tasks row's project name, with where another computer runs the task
   * ("website · on Mac mini"). The summary shows it under Task; the record does not.
   */
  project?: string;
  /**
   * How the plan is drawn (FI3-734): `dots` on the summary, `list` on the
   * record; absent, the plan is not drawn.
   */
  planView?: "dots" | "list";
  /** The record draws the fact strip itself, just above the action bar. */
  omitStrip?: boolean;
  /**
   * Where a click on the task's pull request goes - in Now's words and on
   * the strip; without it, as on the summary, which never takes the
   * pointer, the pull request is plain text.
   */
  onOpenChange?: (url: string) => void;
  /**
   * The Browser line's Open: the task's browser view at the front. Only the
   * record draws the Browser line, so without it the line is left out.
   */
  onOpenBrowser?: () => void;
  /**
   * How the record draws Now's words, its task keys linked (FI3-1271);
   * without it - the summary, which never takes the pointer - they are text.
   */
  nowWords?: (text: string) => ReactNode;
  /**
   * The surface takes the keyboard (the record): each age is a Tab stop
   * that shows its exact time. The summary, which takes neither, leaves it out.
   */
  focusable?: boolean;
}) {
  const now = useMinute();
  const plan = planView && facts.plan ? facts.plan : null;
  const current = plan ? planCounts(plan.items).current : null;
  return (
    <div className="fm-task-facts" data-task-facts="">
      {withTask && (
        <div className="row">
          <div className="label" data-task-fact-label="">
            Task
          </div>
          <div className="title" data-task-fact="task">
            {facts.title}
          </div>
        </div>
      )}
      {withTask && project ? (
        <div className="row">
          <div className="label" data-task-fact-label="">
            Project
          </div>
          <div className="title" data-task-fact="project">
            {project}
          </div>
        </div>
      ) : null}
      {/* Held open while the record is read, so the panel does not jump. */}
      {facts.now !== null && (
        <div className="row">
          <div className="label" data-task-fact-label="">
            Now
          </div>
          <div className="now">
            <span className="note" data-task-fact="now">
              {facts.now ? (
                <NowWords now={facts.now} words={nowWords} onOpen={onOpenChange} />
              ) : (
                " "
              )}
            </span>
            {facts.now && <Age at={facts.now.at} now={now} focusable={focusable} />}
          </div>
        </div>
      )}
      {plan && (
        <div className="row">
          <div className="label" data-task-fact-label="">
            {PLAN_LABEL}
          </div>
          {/* The same words on both surfaces: the count and the current item. */}
          <div className="plan" data-task-fact="plan" data-task-plan-items={plan.items.length}>
            <PlanCount plan={plan} />
            <PlanCurrent
              words={
                current
                  ? current.label
                  : planCounts(plan.items).done === planCounts(plan.items).total
                    ? "All done"
                    : "Between items"
              }
            />
            <Age at={plan.at} now={now} focusable={focusable} />
          </div>
        </div>
      )}
      {plan && planView === "dots" && <PlanDots plan={plan} />}
      {plan && planView === "list" && <PlanList plan={plan} now={now} focusable={focusable} />}
      {facts.browser && onOpenBrowser && (
        <div className="row browser">
          <div className="label" data-task-fact-label="">
            Browser
          </div>
          <div
            className="browser-line"
            data-task-fact="browser"
            data-browser-driver={facts.browser.driver ?? "stopped"}
          >
            <span className="site">{facts.browser.site}</span>
            <span>{facts.browser.words}</span>
            <button type="button" className="link" data-browser-open="" onClick={onOpenBrowser}>
              Open
            </button>
          </div>
        </div>
      )}
      {!omitStrip && (
        <TaskFactStrip facts={facts} onOpenChange={onOpenChange} focusable={focusable} />
      )}
    </div>
  );
}
