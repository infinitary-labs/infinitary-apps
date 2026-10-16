import type { PanelSummaryLine } from "@shared/personal/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FeedLine } from "../design";
import { useOverflowTitle } from "../design/core/overflowTitle";
import { motionEase, motionToken } from "../design/motion";

/** Each line holds the header at least this long while newer lines wait. */
export const SAID_LINE_DWELL_MS = 700;
/** A burst skips to its newest lines: the reader only ever needs these many. */
export const SAID_LINE_QUEUE_KEEP = 2;

/** A line's identity: a new one is what the panel says, not its age ticking on. */
function lineKey(line: PanelSummaryLine): string {
  return `${line.tone ?? ""}|${line.lead ?? ""}|${line.line}`;
}

type Shown = { line: PanelSummaryLine; gen: number };

/**
 * The line a collapsed panel said it holds (`PanelSummaryLine`), in its
 * title's place: the row the removed whisper above the message box drew
 * (a dot in its tone, the lead in mono, the words cut with an ellipsis),
 * as a button that opens the panel. Resting the pointer reads it whole.
 *
 * The line it shows on mounting is already there, so it rests; a newer one
 * rises in over `--dur-med` while the one it replaces lifts out over
 * `--dur-fast`. Each holds the header `SAID_LINE_DWELL_MS`, and a burst
 * keeps only its newest `SAID_LINE_QUEUE_KEEP`. Under reduced motion the
 * shared rule zeroes both durations, so every move is a cut.
 */
export function SaidLine({
  line,
  panelTitle,
  onOpen,
}: {
  line: PanelSummaryLine;
  panelTitle: string;
  onOpen: () => void;
}) {
  const [shown, setShown] = useState<Shown>({ line, gen: 0 });
  const [outgoing, setOutgoing] = useState<Shown | null>(null);
  const queue = useRef<PanelSummaryLine[]>([]);
  const shownRef = useRef(shown);
  const lastShownAt = useRef(0);
  const pump = useRef<number | undefined>(undefined);
  // `line` changes identity on every summary, its age ticking on beside
  // it; only its words make it a new line.
  const latest = useRef(line);
  latest.current = line;
  const said = lineKey(line);

  useEffect(() => {
    const last = queue.current.at(-1) ?? shownRef.current.line;
    if (lineKey(last) === said) return;
    queue.current = [...queue.current, latest.current].slice(-SAID_LINE_QUEUE_KEEP);
    const next = () => {
      pump.current = undefined;
      const upcoming = queue.current.shift();
      if (!upcoming) return;
      const replaced = shownRef.current;
      const entering = { line: upcoming, gen: replaced.gen + 1 };
      shownRef.current = entering;
      lastShownAt.current = Date.now();
      setOutgoing(replaced);
      setShown(entering);
      if (queue.current.length > 0) pump.current = window.setTimeout(next, SAID_LINE_DWELL_MS);
    };
    if (pump.current === undefined) {
      const wait = Math.max(0, lastShownAt.current + SAID_LINE_DWELL_MS - Date.now());
      pump.current = window.setTimeout(next, wait);
    }
  }, [said]);
  useEffect(() => () => window.clearTimeout(pump.current), []);

  return (
    <span style={{ position: "relative", display: "block", flex: 1, minWidth: 0 }}>
      {outgoing && (
        <Row
          // Its own key: the row that showed it unmounts, and this one mounts to leave.
          key={`out-${outgoing.gen}`}
          line={outgoing.line}
          leaving
          onLeft={() => setOutgoing((now) => (now?.gen === outgoing.gen ? null : now))}
        />
      )}
      <Row
        key={`in-${shown.gen}`}
        line={shown.line}
        entering={shown.gen > 0}
        panelTitle={panelTitle}
        onOpen={onOpen}
      />
    </span>
  );
}

function Row({
  line,
  entering = false,
  leaving = false,
  panelTitle,
  onOpen,
  onLeft,
}: {
  line: PanelSummaryLine;
  entering?: boolean;
  leaving?: boolean;
  panelTitle?: string;
  onOpen?: () => void;
  onLeft?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  // One move per row, as it mounts: it enters or leaves once.
  const move = useRef(leaving ? "leave" : entering ? "enter" : null);
  const left = useRef(onLeft);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || move.current === null) return;
    const leave = move.current === "leave";
    const duration = motionToken(el, leave ? "--dur-fast" : "--dur-med");
    if (duration <= 0) {
      if (leave) left.current?.();
      return;
    }
    // It rises in by the stack's distance, and lifts out by half of it.
    const rise = motionToken(el, "--move-stack");
    const motion = el.animate(
      leave
        ? [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: `translateY(${-rise / 2}px)` },
          ]
        : [
            { opacity: 0, transform: `translateY(${rise}px)` },
            { opacity: 1, transform: "none" },
          ],
      { duration, easing: motionEase(el), fill: "both" },
    );
    if (leave)
      motion.finished.then(
        () => left.current?.(),
        () => {},
      );
    return () => motion.cancel();
  }, []);
  const words = line.lead ? `${line.lead} ${line.line}` : line.line;
  const lineFit = useOverflowTitle(leaving ? undefined : words);
  return (
    <button
      ref={ref}
      type="button"
      // Named for what it does, so it never collides with a control that
      // shares a word with the line; the line itself is its description.
      aria-label={leaving ? undefined : `Open ${panelTitle}`}
      aria-description={leaving ? undefined : words}
      aria-hidden={leaving || undefined}
      tabIndex={leaving ? -1 : undefined}
      data-panel-summary-line={leaving ? undefined : ""}
      data-panel-summary-line-leaving={leaving ? "" : undefined}
      title={lineFit.title}
      onClick={onOpen}
      style={{
        appearance: "none",
        background: "none",
        border: 0,
        padding: 0,
        font: "inherit",
        color: "inherit",
        textAlign: "left",
        cursor: "pointer",
        display: "block",
        width: "100%",
        borderRadius: "var(--radius-s)",
        ...(leaving ? { position: "absolute", inset: 0, pointerEvents: "none" } : {}),
      }}
    >
      <FeedLine
        tone={line.tone ?? "neutral"}
        kind={line.tone}
        taskKey={line.lead}
        style={{ gridTemplateColumns: "auto minmax(0, 1fr)" }}
      >
        <span data-panel-summary-words="" ref={lineFit.ref}>
          {line.line}
        </span>
      </FeedLine>
    </button>
  );
}
