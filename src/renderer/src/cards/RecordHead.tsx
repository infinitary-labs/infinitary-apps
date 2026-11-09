import { DELIVERY_BASIS_WORDS, DELIVERY_FACTS_LABEL } from "@shared/deliveryFacts";
import { recordAttentionOf, recordClosedLineOf } from "@shared/recordAttention";
import type { TaskDetail } from "@shared/tasks";
import type { ReactNode } from "react";
import { Age, useMinute } from "../design/core/TaskFacts";
import { KeyedText } from "./TaskKey";
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
          <h3 className="label">Why</h3>
          <p className="goal" data-record-why="">
            {filing.why || "No reason was recorded."}
          </p>
          <p className="verdict" data-record-verdict="">
            {filing.verdict ? `First mate: ${filing.verdict}` : "Your first mate has not said yet."}
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
}: {
  detail: TaskDetail;
  parentKey: string | undefined;
}) {
  const keys = (list: readonly string[]) => <KeyedText text={list.join("  ")} own={detail.id} />;
  return (
    <>
      {parentKey && (
        <Row label="Part of">
          <div className="keys" data-record-fact="parent">
            {keys([parentKey])}
          </div>
        </Row>
      )}
      {detail.blockedBy.length > 0 && (
        <Row label="Waits on">
          <div className="keys" data-record-fact="blocked-by">
            {keys(detail.blockedBy)}
          </div>
        </Row>
      )}
      {detail.blocks.length > 0 && (
        <Row label="Holds up">
          <div className="keys" data-record-fact="blocks">
            {keys(detail.blocks)}
          </div>
        </Row>
      )}
      {detail.children.total > 0 && (
        <Row label="Parts">
          <div data-record-fact="children">
            {`${detail.children.closed} of ${detail.children.total} closed`}
          </div>
        </Row>
      )}
    </>
  );
}

/** The captain's own messages on the task: the words that started it, then every ask since. */
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
  if (filed) parts.push("Why it was filed");
  if (detail.skippedPlanBecause) parts.push("why there was no plan");
  if (count > 0) parts.push(`your ${count} ${count === 1 ? "message" : "messages"}`);
  if (parts.length === 0) return null;
  const name = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${name?.charAt(0).toUpperCase()}${name?.slice(1)}`;
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
    <Row label="Goal">
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
                  <h3 className="label">Why it was filed</h3>
                  <p data-record-filed-why="">{filing.why || "No reason was recorded."}</p>
                  {!closed && (
                    <p className="verdict" data-record-filed-verdict="">
                      {filing.verdict
                        ? `First mate: ${filing.verdict}`
                        : "Your first mate has not said yet."}
                    </p>
                  )}
                </section>
              )}
              {detail.skippedPlanBecause && (
                <section className="why" data-record-plan-skip-section="">
                  <h3 className="label">Why your first mate built without a plan</h3>
                  <p data-record-plan-skip="">{detail.skippedPlanBecause}</p>
                </section>
              )}
              {(words || asks.length > 0) && (
                <section className="why">
                  <h3 className="label">You said</h3>
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
