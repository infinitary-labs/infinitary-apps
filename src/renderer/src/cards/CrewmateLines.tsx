import {
  type CrewLine,
  type CrewPicture,
  type CrewPictureRef,
  type CrewResultText,
  diffWords,
  CREWMATE_WORDS as WORDS,
} from "@shared/crewTranscript";
import { type TaskFacts, taskChangeOf } from "@shared/taskFacts";
import type { TaskDetail } from "@shared/tasks";
import type React from "react";
import { useEffect, useState } from "react";
import { Button } from "../design";
import { FactDot, PlanMark } from "../design/core/TaskFacts";
import { cardOfBlock } from "./crewmateState";

/**
 * The Crewmate tab's lines (docs/task-card-tabs.md, "The Crewmate tab"), in
 * Claude Code's shape, the captain's choice on FI3-1419: a dot before each
 * thing the crewmate said or did, an elbow before what a call answered,
 * folded to its first line and a count a press opens, and a `>` before a
 * line it was sent. The app's own tools read as blocks. The marks are drawn,
 * never typed glyphs.
 */

const Dot = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
    <circle cx="4" cy="4" r="3" fill="currentColor" />
  </svg>
);
const Elbow = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M3.5 0.5V7.5H11" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);
const Prompt = () => <span aria-hidden="true">&gt;</span>;

function Line({
  line,
  mark,
  tone,
  children,
  ...hooks
}: {
  line: { kind: string; id: string };
  mark: React.ReactNode;
  tone?: "hot" | "captain" | "danger";
  children: React.ReactNode;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div className="fm-crew-line" data-crew-line={line.kind} data-crew-id={line.id} {...hooks}>
      <span className="fm-crew-mark" data-tone={tone}>
        {mark}
      </span>
      <div className="fm-crew-body">{children}</div>
    </div>
  );
}

/** A result's whole text, read once when its fold first opens. */
const resultTexts = new Map<string, Promise<CrewResultText | null>>();
const pictures = new Map<string, Promise<CrewPicture | null>>();

function useResultText(taskId: string, ref: string, open: boolean): CrewResultText | null {
  const [text, setText] = useState<CrewResultText | null>(null);
  useEffect(() => {
    if (!open) return;
    const key = `${taskId}\n${ref}`;
    let read = resultTexts.get(key);
    if (!read) {
      read = window.infinitary.tasks.crewmateResult(taskId, ref).catch(() => null);
      resultTexts.set(key, read);
    }
    let live = true;
    void read.then((value) => {
      if (live) setText(value);
    });
    return () => {
      live = false;
    };
  }, [taskId, ref, open]);
  return open ? text : null;
}

/** A picture a call's result holds, read when its line first draws; small, larger on a press. */
function ResultPicture({ taskId, picture }: { taskId: string; picture: CrewPictureRef }) {
  const [source, setSource] = useState<string | null>(null);
  const [large, setLarge] = useState(false);
  useEffect(() => {
    const key = `${taskId}\n${picture.ref}`;
    let read = pictures.get(key);
    if (!read) {
      read = window.infinitary.tasks.crewmatePicture(taskId, picture.ref).catch(() => null);
      pictures.set(key, read);
    }
    let live = true;
    void read.then((value) => {
      if (live && value) setSource(`data:${value.mimeType};base64,${value.data}`);
    });
    return () => {
      live = false;
    };
  }, [taskId, picture.ref]);
  if (!source) return null;
  return (
    <button
      type="button"
      className="fm-crew-picture"
      data-crew-picture={picture.ref}
      data-large={large ? "" : undefined}
      aria-label={large ? WORDS.pictureSmaller : WORDS.pictureLarger}
      onClick={() => setLarge((now) => !now)}
    >
      <img src={source} alt={WORDS.picture} />
    </button>
  );
}

function Fold({ open, label, onToggle }: { open: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="fm-crew-fold"
      data-crew-fold=""
      aria-expanded={open}
      onClick={onToggle}
    >
      {open ? WORDS.fold : label}
    </button>
  );
}

function ToolLine({
  taskId,
  line,
  running,
  open,
  onToggle,
}: {
  taskId: string;
  line: Extract<CrewLine, { kind: "tool" }>;
  running: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const { result, diff } = line;
  const whole = useResultText(taskId, result?.ref ?? "", open && !diff && result !== null);
  const more = result ? Math.max(0, result.lines - 1) : 0;
  const foldable = diff
    ? diff.lines.length > 0
    : more > 0 || (result?.preview.endsWith("…") ?? false);
  const summary = diff
    ? diffWords(diff)
    : !result
      ? running
        ? WORDS.running
        : WORDS.noResult
      : result.lines === 0
        ? result.pictures.length > 0
          ? ""
          : WORDS.noOutput
        : result.preview;
  return (
    <>
      <Line
        line={line}
        mark={<Dot />}
        tone={running ? "hot" : undefined}
        data-crew-tool={line.name}
      >
        <span className="fm-crew-call">
          <span className="name">{line.name}</span>
          {line.target && <span className="target">({line.target})</span>}
          {line.reading && <span className="reading">{line.reading}</span>}
        </span>
      </Line>
      <div
        className="fm-crew-line"
        data-crew-line="result"
        data-crew-result={result ? (result.error ? "error" : "ok") : running ? "running" : "none"}
      >
        <span className="fm-crew-mark">
          <Elbow />
        </span>
        <div className="fm-crew-body">
          <span className="fm-crew-result" data-error={result?.error ? "" : undefined}>
            {summary}
            {foldable && (
              <>
                {summary ? " · " : ""}
                <Fold
                  open={open}
                  label={diff ? WORDS.open : more > 0 ? WORDS.moreLines(more) : WORDS.open}
                  onToggle={onToggle}
                />
              </>
            )}
          </span>
          {open && diff && (
            <div className="fm-crew-diff" data-crew-diff="">
              {diff.lines.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a diff's rows are its order.
                <div key={index} data-diff={row.kind}>
                  {row.kind === "added" ? "+ " : row.kind === "removed" ? "- " : "  "}
                  {row.text}
                </div>
              ))}
              {diff.more > 0 && <div data-diff="more">{WORDS.moreLines(diff.more)}</div>}
            </div>
          )}
          {open && !diff && whole && (
            <div className="fm-crew-out" data-crew-output="">
              {whole.text}
              {whole.cut > 0 && `\n${WORDS.cut(whole.cut)}`}
            </div>
          )}
          {result && result.pictures.length > 0 && (
            <div className="fm-crew-pictures">
              {result.pictures.map((picture) => (
                <ResultPicture key={picture.ref} taskId={taskId} picture={picture} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function SentLine({
  line,
  open,
  onToggle,
}: {
  line: Extract<CrewLine, { kind: "sent" }>;
  open: boolean;
  onToggle: () => void;
}) {
  const captain = line.from === "captain";
  const end = line.text.indexOf("\n");
  const first = end < 0 ? line.text : line.text.slice(0, end);
  const folds = !captain && end >= 0;
  return (
    <Line
      line={line}
      mark={<Prompt />}
      tone={captain ? "captain" : undefined}
      data-crew-from={line.from}
      data-crew-queued={line.queued ? "" : undefined}
    >
      <span className="fm-crew-sent" data-crew-from={line.from}>
        {!captain && (
          <span className="fm-crew-who">
            {line.from === "firstmate" ? WORDS.firstmate : WORDS.app}
          </span>
        )}
        <span data-crew-words="">{captain || open ? line.text : first}</span>
        {folds && (
          <>
            {" · "}
            <Fold open={open} label={WORDS.open} onToggle={onToggle} />
          </>
        )}
        {line.queued && (
          <span className="fm-crew-queued" data-crew-queued-word="">
            {WORDS.queued}
          </span>
        )}
      </span>
    </Line>
  );
}

/**
 * Every line of the transcript, the running turn's words last. `opened`
 * holds the folds the captain opened; `facts` reads the pull request's
 * label, page and checks off the record, as the fact strip does.
 */
export function CrewmateLines({
  taskId,
  detail,
  facts,
  lines,
  earlier,
  running,
  live,
  opened,
  onStage,
  onToggle,
  onShowCard,
  onOpenChange,
}: {
  taskId: string;
  detail: TaskDetail;
  facts: TaskFacts | null;
  lines: readonly CrewLine[];
  earlier: number;
  running: ReadonlySet<string>;
  live: string;
  opened: ReadonlySet<string>;
  /** The cards the stage holds now: an open card shows only where it is. */
  onStage: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onShowCard: (cardId: string, open: boolean) => void;
  onOpenChange: (url: string) => void;
}) {
  const toggle = (id: string) => () => onToggle(id);
  return (
    <>
      {earlier > 0 && <div className="fm-crew-earlier">{WORDS.earlier(earlier)}</div>}
      {lines.map((line) => {
        const open = opened.has(line.id);
        switch (line.kind) {
          case "brief":
            return (
              <Line key={line.id} line={line} mark={<Prompt />}>
                <span className="fm-crew-note">{WORDS.brief}</span>
                {" · "}
                <Fold open={open} label={WORDS.open} onToggle={toggle(line.id)} />
                {open && <div className="fm-crew-out">{line.text}</div>}
              </Line>
            );
          case "said":
            return (
              <Line key={line.id} line={line} mark={<Dot />}>
                <div className="fm-crew-said">{line.text}</div>
              </Line>
            );
          case "tool":
            return (
              <ToolLine
                key={line.id}
                taskId={taskId}
                line={line}
                running={running.has(line.id)}
                open={open}
                onToggle={toggle(line.id)}
              />
            );
          case "sent":
            return <SentLine key={line.id} line={line} open={open} onToggle={toggle(line.id)} />;
          case "plan": {
            // As the record counts a plan: a skipped item is not one to do.
            const done = line.items.filter((item) => item.state === "done").length;
            const total = line.items.filter((item) => item.state !== "skipped").length;
            return (
              <Line key={line.id} line={line} mark={<Dot />}>
                <div className="fm-crew-block" data-crew-block="plan">
                  <div className="k">
                    {total > 0 ? `${WORDS.plan} · ${done} of ${total}` : WORDS.progress}
                  </div>
                  {line.text && <div className="ti">{line.text}</div>}
                  {line.items.length > 0 && (
                    <div className="items">
                      {line.items.map((item) => (
                        <div key={item.label} className="item" data-plan-item={item.state}>
                          <PlanMark state={item.state} />
                          {item.label}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Line>
            );
          }
          case "report":
            return (
              <Line key={line.id} line={line} mark={<Dot />}>
                <div className="fm-crew-block" data-crew-block="report">
                  <div className="k">
                    {WORDS.report}
                    {line.text !== line.summary && (
                      <>
                        {" · "}
                        <Fold open={open} label={WORDS.open} onToggle={toggle(line.id)} />
                      </>
                    )}
                  </div>
                  <div className="ti">{line.summary}</div>
                  {open && <div className="text">{line.text}</div>}
                </div>
              </Line>
            );
          case "card": {
            const card = cardOfBlock(detail, line);
            // An open card shows where the stage holds it; a closed one as the past card.
            const showable = card && (card.state === "closed" || onStage.has(card.id));
            return (
              <Line key={line.id} line={line} mark={<Dot />}>
                <div className="fm-crew-block" data-crew-block="card">
                  <div className="k">
                    {WORDS.card}
                    {card?.ending && ` · ${card.ending}`}
                  </div>
                  <div className="ti">{line.title}</div>
                  {card && showable && (
                    <div className="act">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => onShowCard(card.id, card.state === "open")}
                      >
                        {WORDS.showCard}
                      </Button>
                    </div>
                  )}
                </div>
              </Line>
            );
          }
          case "change": {
            // The change by the record, live or closed; its checks while the work is live.
            const change = detail.delivery ? taskChangeOf(detail.delivery) : null;
            const checks = facts?.delivery?.checks;
            const label = change ? (change.label ?? change.noun) : "";
            return (
              <Line key={line.id} line={line} mark={<Dot />}>
                <div className="fm-crew-block" data-crew-block="change">
                  <div className="k">{change?.noun ?? WORDS.change}</div>
                  <div className="ti">
                    {change?.url ? (
                      <a
                        href={change.url}
                        onClick={(event) => {
                          event.preventDefault();
                          onOpenChange(change.url as string);
                        }}
                      >
                        {label}
                      </a>
                    ) : (
                      label
                    )}
                    {label ? " " : ""}
                    {line.title}
                  </div>
                  {checks && (
                    <div className="item" data-crew-checks={checks.dot}>
                      <FactDot state={checks.dot} />
                      {checks.words}
                    </div>
                  )}
                </div>
              </Line>
            );
          }
          case "stopped":
            return (
              <Line key={line.id} line={line} mark={<Dot />} tone="danger">
                <span className="fm-crew-note">{WORDS.stopped[line.by]}</span>
              </Line>
            );
          case "compacted":
            return (
              <Line key={line.id} line={line} mark={<Dot />}>
                <span className="fm-crew-note">{WORDS.compacted}</span>
              </Line>
            );
          case "failed":
            return (
              <Line key={line.id} line={line} mark={<Dot />} tone="danger">
                <span className="fm-crew-note">
                  {WORDS.failed} {line.text}
                </span>
              </Line>
            );
          default:
            return null;
        }
      })}
      {live && (
        <Line line={{ kind: "live", id: "live" }} mark={<Dot />} tone="hot">
          <div className="fm-crew-said fm-crew-live" data-crew-live="">
            {live}
          </div>
        </Line>
      )}
    </>
  );
}
