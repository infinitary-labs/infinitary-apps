import { formatDate, formatDateTime, formatNumber } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { useMinute } from "./useMinute";

export { useMinute } from "./useMinute";

import { checksFinishedAgo, checksRestWords, checksSpanWords } from "@shared/checksSpan";
import { FACT_DOT, type FactDotState } from "@shared/factDot";
import { feedRelativeAge } from "@shared/feed";
import { bandWords, MODEL_WHY_WORDS } from "@shared/modelChoice";
import { reasoningWord } from "@shared/reasoning";
import type { TaskChecks, TaskFacts, TaskModelWhy } from "@shared/taskFacts";
import {
  clipPlanLine,
  foldPlan,
  PLAN_FOLD_PAST,
  type PlanItemState,
  planCounts,
  type TaskPlan,
  type TaskPlanItem,
} from "@shared/taskPlan";
import { checksWait, taskWaitText } from "@shared/taskWaits";
import { PULL_REQUEST_WORDS } from "@shared/vocabulary";
import { type ReactNode, useState } from "react";
import { SlotBadge } from "../quota/SlotBadge";
import { useOverflowTitle } from "./overflowTitle";
import { useRestLabel } from "./restLabel";
import "./taskFacts.css";

/**
 * A short age beside a fact (`2m`): its exact time shows on rest, the
 * pointer's or - where the surface takes the keyboard, the record - the
 * keyboard's focus, which makes the age a Tab stop of its own; its
 * accessible name carries both (docs/keyboard.md, "Facts shown on rest").
 */
export function Age({
  at,
  now,
  focusable,
  ago = false,
}: {
  at: number;
  now: number;
  focusable: boolean;
  /** Say it as a time past, `5m ago`, after the checks' duration. */
  ago?: boolean;
}) {
  const exact = formatDateTime(at);
  const short = ago ? checksFinishedAgo(at, now) : feedRelativeAge(at, Math.max(now, at));
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
 * The checks' state word with how long they have run or took, by the
 * host's own times (INF-587): `running for 15m`, `passed in 14m`. When the
 * first check started and when the app last read them show on rest, as an
 * age's exact time does.
 */
function ChecksWords({
  checks,
  now,
  focusable,
}: {
  checks: TaskChecks;
  now: number;
  focusable: boolean;
}) {
  const words = checks.span ? checksSpanWords(checks.words, checks.span, now) : checks.words;
  const exact = checksRestWords(checks.span, checks.at);
  const rest = useRestLabel(exact, { fact: true });
  if (!exact) return <span data-task-fact-checks="">{words}</span>;
  return (
    <span
      className="checks"
      data-task-fact-checks=""
      role="img"
      aria-label={`${words} · ${exact}`}
      tabIndex={focusable ? 0 : undefined}
      {...rest}
    >
      {words}
    </span>
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

/** One fact cell; ordinary values stay one line, while a check-read refusal wraps within it. */
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

/**
 * The word the plan is labelled with on every surface (the captain's pick,
 * FI3-734), in English for the tests; the surfaces call the message when
 * they draw.
 */
export const PLAN_LABEL = m.uiTaskFactsProgress();

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
        {m.uiTaskFactsPlanCount({ done: formatNumber(done), total: formatNumber(total) })}
      </span>
      {skipped > 0 && <span className="count">{m.uiTaskFactsPlanSkipped({ count: skipped })}</span>}
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
          short: m.uiTaskFactsFoldedDone({ count: fold.folded.length }),
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
          short: m.uiTaskFactsFoldedMore({ count: clip.later.length }),
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
      aria-label={m.uiTaskFactsPlanDotsName({
        done: formatNumber(done),
        total: formatNumber(total),
      })}
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
            {m.uiTaskFactsShowEarlier({ count: formatNumber(fold.folded.length) })}
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
            {item.state === "skipped" && <span className="skipped"> {m.uiTaskFactsSkipped()}</span>}
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
  return facts.model !== null || facts.delivery !== null || Boolean(facts.waits?.some(checksWait));
}

/**
 * The task record's row of facts (INF-2261, the captain's pick: "At the end
 * of the Info body, under a hairline, scrolling with it"): one cell per fact,
 * each an uppercase micro label over a one-line value (a check-read refusal
 * wraps within its cell), the cells wrapping whole. The hover preview's row
 * comes first with the same labels, dot and state words - the model with
 * its intelligence badge, then the pull request with its checks as one cell:
 * the link, the dot, the checks' words with their counts and their time -
 * then Reasoning, a review's verdict and the cells the record adds after
 * them (`more`: Delivery, Runs on, Use), then the footnote saying why that
 * model. A surface with nothing in the row draws nothing.
 */
export function TaskFactStrip({
  facts,
  onOpenChange,
  focusable = false,
  why = false,
  more,
}: {
  facts: TaskFacts;
  /**
   * Show Why this model under the cells (INF-1714): the full task record
   * only, never a summary someone points at.
   */
  why?: boolean;
  /** Where a click on the change goes; without it the change is plain text. */
  onOpenChange?: (url: string) => void;
  /**
   * The surface takes the keyboard (the record): an age is a Tab stop that
   * shows its exact time. The summary, which takes neither, leaves it out.
   */
  focusable?: boolean;
  /** The record's own cells after the shared ones: Delivery, Runs on and Use. */
  more?: ReactNode;
}) {
  const now = useMinute();
  if (!hasFactStrip(facts) && !more) return null;
  const { change, checks, review } = facts.delivery ?? {};
  const changeWords = change ? (change.label ?? change.noun) : "";
  const watching = facts.waits?.some(checksWait) ?? false;
  return (
    <div className="strip">
      <div className="cells" data-task-fact-strip="">
        {facts.model && (
          <div className="cell model">
            <div className="label" data-task-fact-label="">
              {m.uiTaskFactsModel()}
            </div>
            <div className="value">
              <span data-task-fact="model" title={facts.model}>
                {facts.model}
              </span>
            </div>
          </div>
        )}
        {facts.tier && (
          <Cell label={m.uiTaskFactsDifficulty()} fact="intelligence" data-slot={facts.tier}>
            <SlotBadge slot={facts.tier} />
          </Cell>
        )}
        {facts.reasoning && (
          <Cell
            label={m.uiTaskFactsReasoning()}
            fact="reasoning"
            data-level={facts.reasoning.level}
          >
            {reasoningWord(facts.reasoning)}
          </Cell>
        )}
        {(change || checks || watching) && (
          <div className="cell" data-task-fact-change-cell="">
            <div className="label" data-task-fact-label="">
              {change ? change.noun : m.uiTaskFactsChecks()}
            </div>
            <div className="value" {...(checks?.problem ? { "data-check-read-problem": "" } : {})}>
              {change && (
                <span data-task-fact="change" title={changeWords}>
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
                </span>
              )}
              {(checks || watching) && (
                <span
                  className="state"
                  data-task-fact="checks"
                  data-dot={checks?.dot ?? "idle"}
                  {...(watching ? { "data-task-watch-schedules": "" } : {})}
                  {...(checks?.problem ? { "data-check-read-problem": "" } : {})}
                >
                  {checks && (
                    <>
                      <FactDot state={checks.dot} />
                      <ChecksWords checks={checks} now={now} focusable={focusable} />
                      {checks.span?.finishedAt != null && (
                        <Age at={checks.span.finishedAt} now={now} focusable={focusable} ago />
                      )}
                    </>
                  )}
                  {facts.waits?.filter(checksWait).map((wait) => (
                    <span key={wait.id} className="wait-schedule" data-task-watch={wait.id}>
                      {taskWaitText(wait, now)}
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>
        )}
        {review && (
          <Cell label={m.uiTaskFactsReview()} fact="review" data-dot={review.dot}>
            <FactDot state={review.dot} />
            {review.words}
          </Cell>
        )}
        {more}
      </div>
      {facts.reason && (
        <div className="reason" data-task-fact="reason">
          {facts.reason}
        </div>
      )}
      {why && facts.why && <ModelWhy why={facts.why} />}
    </div>
  );
}

/** One of the record's own cells (`TaskFactStrip`'s `more`): a micro label over its value. */
export function RecordCell({
  label,
  dim = false,
  children,
  ...data
}: {
  label: string;
  /** Dim mono, as Use reads (INF-2261, the captain's pick: "A Use cell beside Runs on, dim mono"). */
  dim?: boolean;
  children: ReactNode;
} & Record<`data-${string}`, string>) {
  return (
    <div className={dim ? "cell dim" : "cell"}>
      <div className="label" data-task-fact-label="">
        {label}
      </div>
      <div className="value" {...data}>
        {children}
      </div>
    </div>
  );
}

/**
 * The hover preview's footer (INF-2528, the captain's direction B): one row
 * that never wraps - the model, then its Difficulty badge, then the change
 * with its checks as one state and its time (`#813 running for 11m`); a
 * long model name gives way first, down to its label's width, then a long
 * branch name, each ending in an ellipsis. A review's verdict takes a
 * second row. Reasoning, the footnote, the check counts, a
 * refusal's reason and each watched run's next read are the task card's.
 */
function SummaryStrip({ facts }: { facts: TaskFacts }) {
  const now = useMinute();
  const { change, checks, review } = facts.delivery ?? {};
  if (!facts.model && !change && !checks && !review) return null;
  const changeWords = change ? (change.label ?? change.noun) : "";
  return (
    <div className="strip">
      {(facts.model || change || checks) && (
        <div className="cells summary" data-task-fact-strip="summary">
          {facts.model && (
            <div className="cell model">
              <div className="label" data-task-fact-label="">
                {m.uiTaskFactsModel()}
              </div>
              <div className="value">
                <span data-task-fact="model" title={facts.model}>
                  {facts.model}
                </span>
              </div>
            </div>
          )}
          {facts.tier && (
            <Cell label={m.uiTaskFactsDifficulty()} fact="intelligence" data-slot={facts.tier}>
              <SlotBadge slot={facts.tier} />
            </Cell>
          )}
          {(change || checks) && (
            <div className="cell change">
              <div className="label" data-task-fact-label="">
                {change ? change.noun : m.uiTaskFactsChecks()}
              </div>
              <div className="value">
                {change && (
                  <span data-task-fact="change" title={changeWords}>
                    {changeWords}
                  </span>
                )}
                {checks && (
                  <span className="state" data-task-fact="checks" data-dot={checks.dot}>
                    <FactDot state={checks.dot} />
                    <span data-task-fact-checks="">
                      {checks.span ? checksSpanWords(checks.state, checks.span, now) : checks.state}
                    </span>
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {review && (
        <div className="cells">
          <Cell label={m.uiTaskFactsReview()} fact="review" data-dot={review.dot}>
            <FactDot state={review.dot} />
            {review.words}
          </Cell>
        </div>
      )}
    </div>
  );
}

/** 24-hour clock time, the day too when it is not today, for a reset. */
function whenOf(at: number, now: number): string {
  const day = new Date(at);
  const clock = `${String(day.getHours()).padStart(2, "0")}:${String(day.getMinutes()).padStart(2, "0")}`;
  return day.toDateString() === new Date(now).toDateString()
    ? clock
    : `${formatDate(day, { month: "short", day: "numeric" })}, ${clock}`;
}

/** How long before the choice its reading was taken. */
function readBefore(measuredAt: number, at: number): string {
  const minutes = Math.max(0, Math.floor((at - measuredAt) / 60_000));
  if (minutes < 1) return m.uiTaskFactsReadJustBefore();
  if (minutes < 60) return m.uiTaskFactsReadMinutesBefore({ minutes: formatNumber(minutes) });
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? m.uiTaskFactsReadHoursBefore({ hours: formatNumber(hours) })
    : m.uiTaskFactsReadDaysBefore({ days: formatNumber(Math.floor(hours / 24)) });
}

/**
 * Why this model (INF-1714, the captain's option A): a native disclosure
 * under the fact strip holding what chose the model, how the allowance
 * compared, and each model weighed with the reading it was ranked on.
 */
function ModelWhy({ why }: { why: TaskModelWhy }) {
  const comparison = why.comparison;
  // A reading's age is told against the newest reading weighed: the choice followed it.
  const at = Math.max(
    0,
    ...(comparison?.candidates.map((candidate) => candidate.measuredAt ?? 0) ?? []),
  );
  return (
    <details className="why" data-task-fact="why">
      <summary>{MODEL_WHY_WORDS.summary}</summary>
      {(why.line || why.choice) && (
        <p className="why-line" data-task-why-line="">
          {[why.line ? `${why.line}.` : null, why.choice].filter(Boolean).join(" ")}
        </p>
      )}
      {comparison ? (
        <ol className="why-list">
          {comparison.candidates.map((candidate) => {
            const facts = [
              candidate.band
                ? bandWords(candidate.band, comparison.floorPercent, candidate.onCredits)
                : undefined,
              candidate.percentRemaining !== undefined
                ? m.uiPercentLeft({ percent: formatNumber(Math.round(candidate.percentRemaining)) })
                : undefined,
              candidate.measuredAt !== undefined ? readBefore(candidate.measuredAt, at) : undefined,
              candidate.resetsAtMs !== undefined
                ? m.uiTaskFactsResets({ when: whenOf(candidate.resetsAtMs, Date.now()) })
                : undefined,
            ].filter((fact): fact is string => fact !== undefined);
            return (
              <li
                key={candidate.model}
                className="why-candidate"
                data-picked={candidate.picked ? "" : undefined}
              >
                <span className="why-name" data-task-why-name="">
                  {candidate.name}
                  {candidate.picked ? ` · ${MODEL_WHY_WORDS.chosen}` : ""}
                </span>
                {facts.length > 0 && <span>{facts.join(" · ")}</span>}
                {candidate.placedWorkPoints !== undefined && (
                  <span data-task-why-placed="">
                    {MODEL_WHY_WORDS.placedWork(candidate.placedWorkPoints)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        why.unrecorded && <p data-task-why-unrecorded="">{MODEL_WHY_WORDS.notRecorded}</p>
      )}
    </details>
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
 * leads with its relations and its goal (`lead`), names its project, and
 * draws its row of facts itself after the Use cell joins it (`omitStrip`).
 * The task row is the summary's; the record has its title in its chrome. Each value carries
 * its identity in `data-task-fact`.
 */
export function TaskFactRows({
  facts,
  lead,
  withTask = false,
  project,
  planView,
  omitStrip = false,
  strip = "full",
  pullRequests = false,
  onOpenChange,
  onOpenBrowser,
  nowWords,
  focusable = false,
}: {
  facts: TaskFacts;
  /**
   * Rows the record draws first (INF-2261): the task's relations as keys,
   * then its goal with the captain's words folded under it.
   */
  lead?: ReactNode;
  withTask?: boolean;
  /**
   * The Tasks row's project name, with where another computer runs the task
   * ("website · on Mac mini"), on the summary under Task; on the record the
   * project's name, under the goal (INF-2261).
   */
  project?: string;
  /**
   * How the plan is drawn (FI3-734): `dots` on the summary, `list` on the
   * record; absent, the plan is not drawn.
   */
  planView?: "dots" | "list";
  /** The record draws its row of facts itself, with its own cells after the shared ones. */
  omitStrip?: boolean;
  /**
   * How much of the strip to draw: every cell (`full`), or the hover
   * preview's one footer row (`summary`, INF-2528).
   */
  strip?: "full" | "summary";
  /**
   * The record lists every pull request of a task with more than one
   * (INF-2490); the summary, like the task row, names only the current one.
   */
  pullRequests?: boolean;
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
      {lead}
      {withTask && (
        <div className="row">
          <div className="label" data-task-fact-label="">
            {m.uiTaskFactsTask()}
          </div>
          <div className="title" data-task-fact="task">
            {facts.title}
          </div>
        </div>
      )}
      {project ? (
        <div className="row">
          <div className="label" data-task-fact-label="">
            {m.uiTaskFactsProject()}
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
            {m.uiTaskFactsNow()}
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
            {m.uiTaskFactsProgress()}
          </div>
          {/* The same words on both surfaces: the count and the current item. */}
          <div className="plan" data-task-fact="plan" data-task-plan-items={plan.items.length}>
            <PlanCount plan={plan} />
            <PlanCurrent
              words={
                current
                  ? current.label
                  : planCounts(plan.items).done === planCounts(plan.items).total
                    ? m.uiTaskFactsAllDone()
                    : m.uiTaskFactsBetweenItems()
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
            {m.uiTaskFactsBrowser()}
          </div>
          <div
            className="browser-line"
            data-task-fact="browser"
            data-browser-driver={facts.browser.driver ?? "stopped"}
          >
            <span className="site">{facts.browser.site}</span>
            <span>{facts.browser.words}</span>
            <button type="button" className="link" data-browser-open="" onClick={onOpenBrowser}>
              {m.uiTaskFactsOpen()}
            </button>
          </div>
        </div>
      )}
      {pullRequests && facts.pullRequests && (
        <div className="row pull-requests">
          <div className="label" data-task-fact-label="">
            {PULL_REQUEST_WORDS.label}
          </div>
          <ul className="pull-request-list" data-task-fact="pull-requests">
            {facts.pullRequests.map((pull) => (
              <li
                key={pull.number}
                className="pull-request-line"
                data-task-pull-request={pull.number}
                data-pull-request-closes={pull.closes ? "" : undefined}
              >
                {pull.url && onOpenChange ? (
                  <a
                    className="change-link number"
                    href={pull.url}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpenChange(pull.url as string);
                    }}
                  >
                    #{pull.number}
                  </a>
                ) : (
                  <span className="number">#{pull.number}</span>
                )}
                <span>{pull.words}</span>
                {pull.closes && <span>{PULL_REQUEST_WORDS.closes}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!omitStrip && strip === "summary" && <SummaryStrip facts={facts} />}
      {!omitStrip && strip === "full" && (
        <TaskFactStrip facts={facts} onOpenChange={onOpenChange} focusable={focusable} />
      )}
    </div>
  );
}
