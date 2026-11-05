import { CARD_REPLY_MAX_CHARS, onStage as cardOnStage } from "@shared/cards";
import {
  type CrewLive,
  type CrewTranscript,
  elapsedWords,
  CREWMATE_WORDS as WORDS,
} from "@shared/crewTranscript";
import { isSafeCardHref } from "@shared/linkify";
import { browserDriverOf } from "@shared/taskBrowser";
import { taskFactsOf } from "@shared/taskFacts";
import type { TaskDetail } from "@shared/tasks";
import type React from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShellStore } from "../app/store";
import { useModelNames } from "../app/useModelNames";
import { KeyCap, StatusDot } from "../design";
import { CARD_MAX_HEIGHT, cardFloor } from "../design/cards/ResponseCard";
import { ComposerField } from "../design/core/ComposerField";
import { thisDesktop } from "../design/core/desktop";
import { appReadExecutor } from "../plugins/reads/appExecutor";
import "./crewmate.css";
import { CrewmateLines } from "./CrewmateLines";
import {
  type CrewState,
  crewDraftOf,
  crewStateOf,
  keepCrewDraft,
  liveWords,
  runningCalls,
} from "./crewmateState";
import { RecordPaneChrome } from "./RecordPaneChrome";
import { recordPillToneOf } from "./recordFooter";
import { TaskTabStrip } from "./TaskTabStrip";
import { taskTabFactsOf } from "./taskTabs";

/**
 * A task's Crewmate tab on the stage (docs/task-card-tabs.md, "The Crewmate
 * tab"; the design skill's components/cards/TaskCrewmate): the crewmate's
 * own session read as a CLI agent's transcript in Claude Code's shape, a
 * status line, and a boxed prompt whose line is the captain's steer on the
 * crewmate's lane. A shell-held stack entry like the record and the browser
 * view, which it replaces in place; it takes the stage's full width.
 *
 * It reads three things and stores none: the task's record, its crewmate's
 * transcript (`tasks.crewmate`) and what the crewmate is writing now
 * (`tasks.crewmate.live`). A closed task reads as it ran, with no prompt.
 */

const SURFACE: React.CSSProperties = {
  width: "100%",
  maxHeight: CARD_MAX_HEIGHT,
  minHeight: cardFloor(420),
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  overflowX: "hidden",
  overflowY: "auto",
  background: "var(--acrylic-bg)",
  backdropFilter: "var(--acrylic-blur)",
  WebkitBackdropFilter: "var(--acrylic-blur)",
  border: "1px solid var(--acrylic-border)",
  borderRadius: "var(--radius-l)",
  boxShadow: "var(--acrylic-shadow)",
};

/** How close to its end the transcript must be read for it to keep following new lines. */
const FOLLOW_SLACK_PX = 24;
/** The prompt grows to this many lines, then scrolls inside. */
const PROMPT_LINE_CAP = 6;

/** One task's read, kept current by the app's read executor; null until it answers. */
function useTaskRead<T>(
  name: "tasks.detail" | "tasks.crewmate" | "tasks.crewmate.live",
  taskId: string,
): { value: T | null; failed: boolean } {
  const [read, setRead] = useState<{ taskId: string; value: T | null; failed: boolean }>({
    taskId,
    value: null,
    failed: false,
  });
  useEffect(() => {
    setRead({ taskId, value: null, failed: false });
    return appReadExecutor().subscribe(
      name,
      { id: taskId },
      {
        onValue: (value) => setRead({ taskId, value: value as T, failed: false }),
        onError: () => setRead((now) => ({ ...now, failed: true })),
      },
    );
  }, [name, taskId]);
  return read.taskId === taskId ? read : { value: null, failed: false };
}

/**
 * How tall the foot under the transcript may grow, in px: the card's cap
 * less the pinned top row. The middle can scroll its title, tabs and even
 * the transcript's one-line floor out of sight. The prompt grows into that room and then
 * scrolls inside, so the card never cuts it off. Read again whenever the
 * card or its transcript changes size: the window, the cap or the chrome.
 */
function useFootRoom(
  surface: React.RefObject<HTMLElement | null>,
  log: React.RefObject<HTMLElement | null>,
): number | undefined {
  const [room, setRoom] = useState<number>();
  useLayoutEffect(() => {
    const card = surface.current;
    const transcript = log.current;
    if (!card || !transcript) return;
    const read = () => {
      const cap = Number.parseFloat(getComputedStyle(card).maxHeight);
      const style = getComputedStyle(transcript);
      const floor =
        Number.parseFloat(style.minHeight) +
        Number.parseFloat(style.paddingTop) +
        Number.parseFloat(style.paddingBottom);
      const borders = card.offsetHeight - card.clientHeight;
      const pinned = card.querySelector("[data-record-middle]") ?? transcript;
      const chrome =
        pinned.getBoundingClientRect().top -
        card.getBoundingClientRect().top -
        card.clientTop +
        card.scrollTop;
      // The middle may scroll even its one-line floor out of sight.
      const next = Math.floor(cap - borders - chrome - (pinned === transcript ? floor : 0));
      setRoom(Number.isFinite(next) ? next : undefined);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(card);
    observer.observe(transcript);
    return () => observer.disconnect();
  }, [surface, log]);
  return room;
}

/** The running turn's age, ticking each second while it runs. */
function useElapsed(since: number | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since == null ? null : elapsedWords(now - since);
}

function StatusLine({
  state,
  since,
  stopping,
  onStop,
}: {
  state: CrewState;
  since: number | null | undefined;
  stopping: boolean;
  onStop: () => void;
}) {
  const elapsed = useElapsed(state === "working" ? since : null);
  const words =
    state === "working"
      ? WORDS.working
      : state === "paused"
        ? WORDS.paused
        : state === "waiting"
          ? WORDS.waiting
          : state === "idle"
            ? WORDS.idle
            : null;
  if (!words) return null;
  const tone =
    state === "working"
      ? "busy"
      : state === "paused"
        ? "captain"
        : state === "waiting"
          ? "warn"
          : "idle";
  return (
    <div className="fm-crew-status" data-crew-status={state} aria-live="polite">
      <span className="state">
        <StatusDot tone={tone} label={words} />
        {words}
      </span>
      {state === "working" && (
        <>
          {elapsed && <span data-crew-elapsed="">{elapsed}</span>}
          <span>
            <KeyCap>{thisDesktop().mac ? "⌃C" : "Ctrl+C"}</KeyCap> {WORDS.interruptHint}
          </span>
          <button
            type="button"
            className="stop"
            data-crew-stop=""
            disabled={stopping}
            onClick={onStop}
          >
            {stopping ? WORDS.stopping : WORDS.stop}
          </button>
        </>
      )}
    </div>
  );
}

function Composer({
  taskId,
  working,
  foot,
  footRoom,
  onInterrupt,
}: {
  taskId: string;
  working: boolean;
  /** The foot it sits in, with the status line, and the most that foot may take (`useFootRoom`). */
  foot: React.RefObject<HTMLDivElement | null>;
  footRoom: number | undefined;
  onInterrupt: () => void;
}) {
  const [draft, setDraft] = useState(() => crewDraftOf(taskId));
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const text = draft.trim();
  const canSend = !sending && text.length > 0 && text.length <= CARD_REPLY_MAX_CHARS;
  const change = (value: string) => {
    setDraft(value);
    keepCrewDraft(taskId, value);
    setRefusal(null);
  };
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setRefusal(null);
    try {
      const result = await window.infinitary.task.steer(taskId, text);
      if (result.ok) change("");
      else setRefusal(result.text);
    } catch {
      setRefusal("This line could not be sent right now.");
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <div className="fm-crew-compose" data-crew-composer="" data-focus={focus ? "" : undefined}>
        <span className="prompt" aria-hidden="true">
          &gt;
        </span>
        <ComposerField
          fieldRef={field}
          aria-label={WORDS.field}
          messageField="reply"
          placeholder={working ? WORDS.placeholderWorking : WORDS.placeholderIdle}
          value={draft}
          // Held, not disabled, while the line sends: a disabled field drops the focus.
          readOnly={sending}
          lineCap={PROMPT_LINE_CAP}
          frame={foot}
          frameMaxHeight={footRoom}
          canSend={canSend}
          onSend={() => void send()}
          onChange={(event) => change(event.target.value)}
          onKeyDown={(event) => {
            // ⌃C stops the running turn, as it does in a CLI agent. Where
            // Ctrl+C also copies (Linux), it copies words picked in the field.
            const field = event.currentTarget;
            if (
              event.key.toLowerCase() === "c" &&
              event.ctrlKey &&
              !event.metaKey &&
              !event.altKey &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing &&
              (thisDesktop().mac || field.selectionStart === field.selectionEnd)
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (working) onInterrupt();
              return;
            }
            // Escape still hides the card; every other key is the field's own,
            // so none reaches the window's hold-to-talk listeners.
            if (event.key !== "Escape") event.stopPropagation();
          }}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "var(--text-sm)",
            lineHeight: "var(--leading-body)",
          }}
        />
        <span className="to">
          {WORDS.sendsTo} · <KeyCap>{thisDesktop().mac ? "↩" : "Enter"}</KeyCap>
        </span>
      </div>
      {refusal && (
        <p role="alert" className="fm-crew-refusal" data-crew-refusal="">
          {refusal}
        </p>
      )}
    </>
  );
}

export function CrewmateView({ taskId, onDrawn }: { taskId: string; onDrawn: () => void }) {
  const { value: detail, failed: unreadable } = useTaskRead<TaskDetail>("tasks.detail", taskId);
  const { value: transcript, failed: transcriptFailed } = useTaskRead<CrewTranscript>(
    "tasks.crewmate",
    taskId,
  );
  const { value: live } = useTaskRead<CrewLive>("tasks.crewmate.live", taskId);
  const modelName = useModelNames();
  const facts = detail ? taskFactsOf(detail, modelName) : null;
  const state: CrewState = detail ? crewStateOf(detail, live) : "idle";
  const working = state === "working";
  const lines = transcript?.lines ?? [];
  const running = useMemo(() => runningCalls(lines, working), [lines, working]);
  const words = working ? liveWords(transcript, live) : "";
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const stageCards = useShellStore((s) => s.cards);
  const onStage = useMemo(
    () => new Set(stageCards.filter(cardOnStage).map((card) => card.id)),
    [stageCards],
  );
  const [stopping, setStopping] = useState(false);
  const surface = useRef<HTMLElement | null>(null);
  const foot = useRef<HTMLDivElement | null>(null);

  // Drawn when shown, never prepared: the stage may bring it in at once.
  useEffect(() => {
    onDrawn();
  }, [onDrawn]);
  // A new turn, or its end, settles a stop in flight.
  useEffect(() => {
    if (!working) setStopping(false);
  }, [working]);

  // The transcript follows its end while the captain reads at the end.
  const log = useRef<HTMLDivElement | null>(null);
  const footRoom = useFootRoom(surface, log);
  const atEnd = useRef(true);
  const onScroll = useCallback(() => {
    const node = log.current;
    if (!node) return;
    atEnd.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new lines and new words are the triggers.
  useLayoutEffect(() => {
    const node = log.current;
    if (node && atEnd.current) node.scrollTop = node.scrollHeight;
  }, [transcript?.revision, words]);
  // It gives up its room from the top: shortened while the captain reads at
  // the end, as the prompt grows, it keeps its newest line in sight.
  useEffect(() => {
    const node = log.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (atEnd.current) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const interrupt = useCallback(() => {
    setStopping(true);
    void window.infinitary.task
      .interrupt(taskId)
      .then((result) => {
        if (!result.ok) setStopping(false);
      })
      .catch(() => setStopping(false));
  }, [taskId]);
  const showCard = (cardId: string, open: boolean) => {
    if (open) useShellStore.getState().focusCard(cardId);
    else void window.infinitary.cards.showPast(cardId).catch(() => {});
  };
  const openChange = (url: string) => {
    if (isSafeCardHref(url)) void window.infinitary.app.openExternal(url).catch(() => {});
  };
  const toggle = (id: string) =>
    setOpened((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section
      ref={surface}
      data-task-crewmate={taskId}
      data-crew-state={state}
      aria-label="Crewmate"
      style={SURFACE}
    >
      <RecordPaneChrome
        reading={facts?.status ?? null}
        pillTone={detail ? recordPillToneOf(detail) : "neutral"}
        taskKey={detail ? detail.key : unreadable ? "this record could not be read" : null}
        title={facts?.title ?? ""}
        tabs={
          detail && (
            <TaskTabStrip
              taskId={taskId}
              shown="crewmate"
              browser={detail.browser}
              facts={taskTabFactsOf(detail)}
              captain={browserDriverOf(detail, detail.browser) === "captain"}
            />
          )
        }
        middle={
          <div
            ref={log}
            className="fm-crew-log"
            style={{ order: 1 }}
            role="log"
            aria-label="The crewmate's session"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the transcript scrolls by keys.
            tabIndex={0}
            data-crew-log=""
            onScroll={onScroll}
          >
            {detail && transcript && lines.length > 0 ? (
              <CrewmateLines
                taskId={taskId}
                detail={detail}
                facts={facts}
                lines={lines}
                earlier={transcript.earlier}
                running={running}
                live={words}
                opened={opened}
                onStage={onStage}
                onToggle={toggle}
                onShowCard={showCard}
                onOpenChange={openChange}
              />
            ) : (
              (transcript || transcriptFailed) && (
                <div className="fm-crew-empty" data-crew-empty="">
                  {transcriptFailed ? WORDS.unreadable : WORDS.empty}
                </div>
              )
            )}
          </div>
        }
      />
      <div ref={foot} className="fm-crew-foot">
        <StatusLine state={state} since={live?.since} stopping={stopping} onStop={interrupt} />
        {state === "closed" ? (
          <div className="fm-crew-closed" data-crew-closed="">
            {WORDS.closed}
          </div>
        ) : (
          detail && (
            <Composer
              taskId={taskId}
              working={working}
              foot={foot}
              footRoom={footRoom}
              onInterrupt={interrupt}
            />
          )
        )}
      </div>
    </section>
  );
}
