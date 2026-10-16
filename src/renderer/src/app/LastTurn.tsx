import type { LastTurn as Turn } from "@shared/lastTurn";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { prefersReducedMotion } from "../character/reducedMotion";
import { useOverflowTitle } from "../design/core/overflowTitle";
import {
  fadeKey,
  getFade,
  markReplyAnnounced,
  replyAnnounced,
  subscribeFade,
  syncFade,
} from "./lastTurnFade";
import { useShellStore } from "./store";
import "./lastTurn.css";

/**
 * The last turn above the input (FI3-1089's plan, the captain's Approve and
 * build, drawn as FI3-1225's borderless Subtitles and quoted as FI3-1387's
 * Quotes; behavior documented in docs/composer.md "The last turn"): the
 * captain's last message and, under it, the Firstmate's, one centered line
 * each inside quotation marks, with no shape around either. While the
 * Firstmate works its line shows three dots and "Working…"; when the turn
 * ends it becomes the reply line the core chose (`firstmate_reply`). The
 * pair stays until the next message. A completed reply then fades after
 * 15 seconds of visible reading time (./lastTurnFade). Both lines are plain
 * text, never a control: resting on a cut line shows its whole text and
 * pauses that count.
 *
 * Its words and busy signal are shell state (./store `lastTurn`,
 * `firstmateBusy`); this component owns only the two moves a class change
 * cannot sequence: the old pair leaving as a new one enters, and the
 * working words leaving before the reply rises in.
 */

/** The working words beside the dots: the captain's own word. */
export const WORKING_WORDS = "Working…";
/** A message that was only pictures. */
export const PICTURE_ONLY_WORDS = "A picture";
/** The marks around words someone said, drawn in --fg-3. */
const OPEN_QUOTE = "\u201c";
const CLOSE_QUOTE = "\u201d";
/** A leaving pair or set of words is gone after --dur-fast. */
const LEAVE_MS = 160;

type Mate = { kind: "working" } | { kind: "reply"; text: string; problem: boolean };

function mateOf(busy: boolean, turn: Turn): Mate | null {
  if (busy) return { kind: "working" };
  if (!turn.reply) return null;
  return { kind: "reply", text: turn.reply.text, problem: turn.reply.problem === true };
}

/** What the Firstmate's line says, as one comparable value. */
function mateKey(mate: Mate | null): string {
  if (mate === null) return "";
  return mate.kind === "working" ? "working" : `reply:${mate.problem}:${mate.text}`;
}

/** The Firstmate's line, swapping its words with a leave and a rise. */
function MateLine({ target, announce }: { target: Mate | null; announce: boolean }) {
  const [shown, setShown] = useState<Mate | null>(target);
  const [leaving, setLeaving] = useState(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const targetRef = useRef(target);
  targetRef.current = target;
  const key = mateKey(target);

  useEffect(() => {
    const next = targetRef.current;
    if (mateKey(shownRef.current) === key) {
      setLeaving(false);
      return;
    }
    if (shownRef.current === null || prefersReducedMotion()) {
      setShown(next);
      setLeaving(false);
      return;
    }
    setLeaving(true);
    const id = window.setTimeout(() => {
      setShown(next);
      setLeaving(false);
    }, LEAVE_MS);
    return () => window.clearTimeout(id);
  }, [key]);

  const reply = shown?.kind === "reply" ? shown : null;
  const mateWords = reply ? reply.text : WORKING_WORDS;
  const mateFit = useOverflowTitle(shown ? mateWords : undefined);
  return (
    <>
      <div className="row mate">
        {shown && (
          <span
            data-last-turn-bubble="firstmate"
            data-state={shown.kind === "working" ? "working" : reply?.problem ? "problem" : "reply"}
            title={mateFit.title}
          >
            {shown.kind === "working" && (
              <span data-last-turn-dots="" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
            <span
              // Newer words enter as new text, so the rise replays for each.
              key={reply ? `reply:${reply.text}` : "working"}
              className="said"
              data-leaving={leaving ? "" : undefined}
            >
              {reply && <Quote mark={OPEN_QUOTE} />}
              <span className="words" data-last-turn-words="" ref={mateFit.ref}>
                {mateWords}
              </span>
              {reply && <Quote mark={CLOSE_QUOTE} />}
            </span>
          </span>
        )}
      </div>
      {/* The reply is read out once as it arrives, never the working words. */}
      <div className="status" role="status" aria-live="polite" aria-atomic="true">
        {announce && reply && !leaving ? reply.text : ""}
      </div>
    </>
  );
}

/** One quotation mark: seen, never read out. */
function Quote({ mark }: { mark: string }) {
  return (
    <span className="quote" aria-hidden="true">
      {mark}
    </span>
  );
}

/** One message and its reply, as the turn and the busy signal say. */
export function LastTurnPair({
  turn,
  busy,
  leaving = false,
  fading = false,
  announce = true,
}: {
  turn: Turn;
  busy: boolean;
  /** The pair a newer message replaces: visible as it leaves, out of the a11y tree. */
  leaving?: boolean;
  /** The reading time has ended: both lines dissolve in place. */
  fading?: boolean;
  /** A remount of a reply already read out says nothing. */
  announce?: boolean;
}) {
  // A message of pictures alone said no words, so its name is not quoted.
  const said = turn.you.trim();
  const you = said || PICTURE_ONLY_WORDS;
  const youFit = useOverflowTitle(leaving ? undefined : you);
  return (
    <div
      data-last-turn-pair=""
      data-leaving={leaving ? "" : undefined}
      data-fading={fading ? "" : undefined}
      inert={leaving}
      aria-hidden={leaving || undefined}
    >
      <div className="row you">
        <span data-last-turn-bubble="you" title={youFit.title}>
          <span className="said">
            {said && <Quote mark={OPEN_QUOTE} />}
            <span className="words" data-last-turn-words="" ref={youFit.ref}>
              {you}
            </span>
            {said && <Quote mark={CLOSE_QUOTE} />}
          </span>
        </span>
      </div>
      <MateLine target={mateOf(busy, turn)} announce={announce} />
    </div>
  );
}

function windowAwake(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function messageCovered(): boolean {
  return document.documentElement.hasAttribute("data-card-maximized");
}

/** Working… in its own row, after a faded pair, so the old words stay gone. */
function WorkingAlone() {
  return (
    <div data-last-turn-pair="" data-last-turn-working="">
      <div className="row you" />
      <div className="row mate">
        <span data-last-turn-bubble="firstmate" data-state="working">
          <span data-last-turn-dots="" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="said">
            <span className="words" data-last-turn-words="">
              {WORKING_WORDS}
            </span>
          </span>
        </span>
      </div>
    </div>
  );
}

export function LastTurn() {
  const turn = useShellStore((s) => s.lastTurn);
  const seq = useShellStore((s) => s.lastTurnSeq);
  const replySeq = useShellStore((s) => s.lastTurnReplySeq);
  const busy = useShellStore((s) => s.firstmateBusy);
  const view = useShellStore((s) => s.view);
  const fade = useSyncExternalStore(subscribeFade, getFade, getFade);
  const [outgoing, setOutgoing] = useState<{ turn: Turn; seq: number } | null>(null);
  const [hovering, setHovering] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [awake, setAwake] = useState(windowAwake);
  const [covered, setCovered] = useState(messageCovered);
  const shown = useRef<{ turn: Turn; seq: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  /** The reply this mount read out, so a later render does not clear the live region. */
  const spoken = useRef<string | null>(null);
  const key = fadeKey(turn, replySeq);
  const readable = view === "home" && !busy && !hovering && !selecting && awake && !covered;

  // The clock lives outside this component, so Settings unmounting it only pauses.
  useEffect(() => {
    syncFade(key, readable);
    return () => syncFade(key, false);
  }, [key, readable]);

  if (key && spoken.current !== key && !replyAnnounced(key)) spoken.current = key;

  useEffect(() => {
    if (fade.phase === "hidden") {
      setHovering(false);
      setSelecting(false);
    }
  }, [fade.phase]);

  useEffect(() => {
    if (!key) return;
    // After this mount sticks. A strict-mode remount cancels the mark, so the
    // reply is still read out; a later return from Settings is not.
    const id = window.setTimeout(() => markReplyAnnounced(key), 0);
    return () => window.clearTimeout(id);
  }, [key]);

  useEffect(() => {
    const refreshAwake = () => setAwake(windowAwake());
    const refreshCovered = () => setCovered(messageCovered());
    refreshAwake();
    refreshCovered();
    const onSelection = () => {
      const root = rootRef.current;
      const sel = document.getSelection();
      const node = sel?.anchorNode ?? null;
      setSelecting(Boolean(root && node && !sel?.isCollapsed && root.contains(node)));
    };
    document.addEventListener("visibilitychange", refreshAwake);
    window.addEventListener("focus", refreshAwake);
    window.addEventListener("blur", refreshAwake);
    document.addEventListener("selectionchange", onSelection);
    const observer = new MutationObserver(refreshCovered);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-card-maximized"],
    });
    return () => {
      document.removeEventListener("visibilitychange", refreshAwake);
      window.removeEventListener("focus", refreshAwake);
      window.removeEventListener("blur", refreshAwake);
      document.removeEventListener("selectionchange", onSelection);
      observer.disconnect();
    };
  }, []);

  // A new message replaces the pair: the old one leaves over --dur-fast
  // while the new one enters. A fade already running is cancelled by the new key.
  useEffect(() => {
    const before = shown.current;
    shown.current = turn ? { turn, seq } : null;
    if (!before || before.seq === seq || prefersReducedMotion()) return;
    setOutgoing(before);
    const id = window.setTimeout(() => setOutgoing(null), LEAVE_MS + 60);
    return () => window.clearTimeout(id);
  }, [turn, seq]);

  if (!turn) return null;
  const hidden = key !== null && fade.key === key && fade.phase === "hidden";
  const fading = key !== null && fade.key === key && fade.phase === "fading";
  return (
    <div
      data-last-turn=""
      data-last-turn-fade={hidden ? "hidden" : fading ? "fading" : "shown"}
      ref={rootRef}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
    >
      {hidden && busy ? (
        <WorkingAlone />
      ) : (
        !hidden && (
          <>
            {outgoing && outgoing.seq !== seq && (
              <LastTurnPair
                key={outgoing.seq}
                turn={outgoing.turn}
                busy={false}
                leaving
                announce={false}
              />
            )}
            <LastTurnPair
              key={seq}
              turn={turn}
              busy={busy}
              fading={fading}
              announce={spoken.current === key}
            />
          </>
        )
      )}
    </div>
  );
}
