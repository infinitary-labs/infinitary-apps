import * as m from "@shared/i18n/messages.generated";
import { KEYBOARD_COMMANDS } from "@shared/keyboard";
import type { LastRound, LastTurn as Turn } from "@shared/lastTurn";
import { CAPTAIN_COMMAND } from "@shared/through";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { prefersReducedMotion } from "../character/reducedMotion";
import { useRestLabel } from "../design";
import { useOverflowTitle } from "../design/core/overflowTitle";
import { useWholeWords } from "../design/core/wholeWords";
import { useCommandKeys } from "./keyHints";
import {
  fadeKey,
  getFade,
  markReplyAnnounced,
  replyAnnounced,
  replyAnnouncementKey,
  subscribeFade,
  syncFade,
} from "./lastTurnFade";
import { stackOf } from "./stack";
import { useShellStore } from "./store";
import "./lastTurn.css";

/**
 * The last turn above the input (FI3-1089's plan, redrawn as INF-1770's
 * Chat layout, the captain's Approve and build; behavior documented in
 * docs/composer.md "The last turn"): the captain's last two messages, each
 * with the Firstmate's reply line kept beside it. A round is the captain's
 * words in a soft grey bubble on the right and, under them, the reply as
 * plain type beside the first mate's mark on the left. The older round sits
 * above at half strength; while a card is up only the newest shows.
 *
 * While the Firstmate works, the newest round's mark turns ember and spins
 * (INF-2483's plan, the captain's Approve and build: "turn the mark to
 * orange and spin it"); a message with no reply yet shows the spinning mark
 * and "Working…" in its reply's place. Working never hides a reply. Becoming the older round starts 15
 * seconds of visible reading time (./lastTurnFade), after which only that
 * round dissolves, even during work; the newest stays until the next message. Each
 * reply line is a button that opens that reply whole as a note
 * (./ReplyNote, docs/composer.md "The reply note"); the captain's words
 * are plain text. A line too long for its row ends on its last whole word
 * and an ellipsis, never part way through a word (../design/core/wholeWords);
 * resting on a cut line shows its whole text and pauses the count.
 *
 * Its words and busy signal are shell state (./store `lastTurn`,
 * `firstmateBusy`); this component owns only the moves a class change
 * cannot sequence: the rounds gliding up as a new one enters, the oldest
 * leaving, and the working words leaving before the reply rises in.
 */

/**
 * The working words beside the spinning mark: the captain's own word. This
 * and `PICTURE_ONLY_WORDS` are worded as the module loads (English, before
 * any language is set) for a spec; the rounds word them when shown.
 */
export const WORKING_WORDS = m.shellLastTurnWorking();
export const PICTURE_ONLY_WORDS = m.shellLastTurnPictureOnly();
/** The lane whose width bounds each line, which the lines' own words never size. */
const LANE = "[data-last-turn]";
/** A leaving round or set of words is gone after --dur-fast. */
const LEAVE_MS = 160;
/** One whole turn of the working mark: INF-2483's chosen steady turn at 2.0 s. */
export const MARK_TURN_MS = 2000;
/** The hexagon looks the same every sixth of a turn, so it comes to rest on one. */
const MARK_REST_DEG = 60;

type Mate = { kind: "working" } | { kind: "reply"; text: string; problem: boolean };

function mateOf(busy: boolean, round: LastRound): Mate | null {
  if (round.reply)
    return { kind: "reply", text: round.reply.text, problem: round.reply.problem === true };
  return busy ? { kind: "working" } : null;
}

function mateKey(mate: Mate | null): string {
  if (mate === null) return "";
  return mate.kind === "working" ? "working" : `reply:${mate.problem}:${mate.text}`;
}

/**
 * The first mate's mark, the app's hexagon, beside each reply line. While
 * the Firstmate works it turns ember (lastTurn.css) and spins one steady
 * turn every MARK_TURN_MS; when work ends it eases on to the next resting
 * sixth of a turn over --dur-med as it fades back to cyan. Under reduced
 * motion it turns ember and stands still.
 */
export function MateMark({ working }: { working: boolean }) {
  const ref = useRef<SVGSVGElement>(null);
  const spin = useRef<Animation | null>(null);
  useEffect(() => {
    const mark = ref.current;
    if (!mark || typeof mark.animate !== "function") return;
    if (working) {
      spin.current?.cancel();
      if (prefersReducedMotion()) return;
      spin.current = mark.animate([{ rotate: "0deg" }, { rotate: "360deg" }], {
        duration: MARK_TURN_MS,
        iterations: Number.POSITIVE_INFINITY,
      });
      return;
    }
    const turning = spin.current;
    spin.current = null;
    if (!turning) return;
    const at = (((Number(turning.currentTime) || 0) % MARK_TURN_MS) / MARK_TURN_MS) * 360;
    turning.cancel();
    if (prefersReducedMotion()) return;
    const style = getComputedStyle(mark);
    mark.animate(
      [{ rotate: `${at}deg` }, { rotate: `${Math.ceil(at / MARK_REST_DEG) * MARK_REST_DEG}deg` }],
      {
        duration: Number.parseFloat(style.getPropertyValue("--dur-med")) || 0,
        easing: style.getPropertyValue("--ease-out").trim() || "ease-out",
      },
    );
  }, [working]);
  useEffect(() => () => spin.current?.cancel(), []);
  return (
    <svg
      ref={ref}
      className="mark"
      viewBox="0 0 16 16"
      fill="none"
      strokeWidth="1.2"
      aria-hidden="true"
      data-last-turn-mark=""
      data-working={working ? "" : undefined}
    >
      <polygon className="o" points="8,1.2 13.9,4.6 13.9,11.4 8,14.8 2.1,11.4 2.1,4.6" />
      <polygon className="i" points="12,8 10,11.46 6,11.46 4,8 6,4.54 10,4.54" />
      <circle className="d" cx="8" cy="8" r="1.3" stroke="none" />
    </svg>
  );
}

/**
 * One ref for a line's words: the rest label's measure of whether they are
 * cut, and the cut that ends them on a whole word.
 */
function useCuttingRef(
  title: (node: HTMLElement | null) => void,
  cut: (node: HTMLElement | null) => void,
): (node: HTMLElement | null) => void {
  return useCallback(
    (node: HTMLElement | null) => {
      title(node);
      cut(node);
    },
    [title, cut],
  );
}

const REPLY_COMMAND_WORDS = KEYBOARD_COMMANDS["firstmate.reply"].label;

/** The Firstmate's line, swapping its words with a leave and a rise. */
function MateLine({
  target,
  busy,
  announce,
  older,
}: {
  target: Mate | null;
  /** The Firstmate works: the mark spins beside the working words or the reply. */
  busy: boolean;
  announce: boolean;
  older: boolean;
}) {
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
  const mateWords = reply ? reply.text : m.shellLastTurnWorking();
  const mateFit = useOverflowTitle(shown ? mateWords : undefined);
  const mateCut = useWholeWords(shown ? mateWords : undefined, LANE);
  const mateRef = useCuttingRef(mateFit.ref, mateCut);
  const openReplyNote = useShellStore((s) => s.openReplyNote);
  // A reply is a button that opens it whole; the working words are not.
  const Bubble = reply ? "button" : "span";
  // The newest reply's button names the key of Open the first mate's reply
  // in the app's label on rest, after its words when they are cut short, else
  // after the command's own words (docs/keyboard.md, "Key hints").
  const replyKeys = useCommandKeys(reply && !older ? "firstmate.reply" : null);
  const replyRest = useRestLabel(
    reply ? (mateFit.title ?? (replyKeys.keys ? REPLY_COMMAND_WORDS : undefined)) : undefined,
    { keys: replyKeys.keys },
  );
  return (
    <>
      <div className="row mate">
        {shown && (
          <>
            <MateMark working={busy} />
            <span className="line">
              <Bubble
                {...(reply
                  ? {
                      ...replyRest,
                      type: "button" as const,
                      "aria-keyshortcuts": replyKeys["aria-keyshortcuts"],
                      "data-key-command": replyKeys["data-key-command"],
                      onClick: () => openReplyNote(older ? "older" : undefined),
                    }
                  : { title: mateFit.title })}
                data-last-turn-bubble="firstmate"
                data-state={
                  shown.kind === "working" ? "working" : reply?.problem ? "problem" : "reply"
                }
                data-working={busy && reply ? "" : undefined}
              >
                <span
                  // Newer words enter as new text, so the rise replays for each.
                  key={reply ? `reply:${reply.text}` : "working"}
                  className="said"
                  data-leaving={leaving ? "" : undefined}
                >
                  <span className="words" data-last-turn-words="" ref={mateRef}>
                    {mateWords}
                  </span>
                </span>
              </Bubble>
            </span>
          </>
        )}
      </div>
      {/* The newest reply is read out once as it arrives, never the working words. */}
      {!older && (
        <div className="status" role="status" aria-live="polite" aria-atomic="true">
          {announce && reply && !leaving ? reply.text : ""}
        </div>
      )}
    </>
  );
}

export function LastTurnRound({
  round,
  busy,
  older = false,
  leaving = false,
  fading = false,
  announce = true,
}: {
  round: LastRound;
  /** The Firstmate works on the newest round. */
  busy: boolean;
  /** The round before the newest: drawn at half strength, never read out. */
  older?: boolean;
  /** The round a newer message pushes out: visible as it leaves, out of the a11y tree. */
  leaving?: boolean;
  /** The reading time has ended: the older round dissolves in place. */
  fading?: boolean;
  /** A remount of a reply already read out says nothing. */
  announce?: boolean;
}) {
  const said = round.you.trim();
  const you = said || m.shellLastTurnPictureOnly();
  const youFit = useOverflowTitle(leaving ? undefined : you);
  const youCut = useWholeWords(you, LANE);
  const youRef = useCuttingRef(youFit.ref, youCut);
  return (
    <div
      data-last-turn-pair=""
      data-older={older ? "" : undefined}
      data-leaving={leaving ? "" : undefined}
      data-fading={fading ? "" : undefined}
      inert={leaving || fading}
      aria-hidden={leaving || undefined}
    >
      <div className="row you">
        {round.through ? (
          <span className="through" data-last-turn-through="">
            {m.shellLastTurnFromCommand({ command: CAPTAIN_COMMAND })}
          </span>
        ) : null}
        <span data-last-turn-bubble="you" title={youFit.title}>
          <span className="words" data-last-turn-words="" ref={youRef}>
            {you}
          </span>
        </span>
      </div>
      <MateLine
        target={mateOf(busy && !older, round)}
        busy={busy && !older}
        announce={announce && !older}
        older={older}
      />
    </div>
  );
}

function windowAwake(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

function messageCovered(): boolean {
  return document.documentElement.hasAttribute("data-card-maximized");
}

/** Whether a card or another stack entry is up: then only the newest round shows. */
export function useCardUp(): boolean {
  return useShellStore((s) => stackOf(s).length > 0);
}

type Shown = { round: LastRound; key: number; older: boolean };
/** A round leaving, drawn where it stood. */
type Outgoing = Shown & { top: number };

/**
 * The rounds to draw, oldest first, keyed by the message's place in this
 * window's sequence so the newest keeps its node as it becomes the older.
 */
function roundsOf(turn: Turn, seq: number, withOlder: boolean): Shown[] {
  const newest: Shown = { round: turn, key: seq, older: false };
  return withOlder && turn.previous
    ? [{ round: turn.previous, key: seq - 1, older: true }, newest]
    : [newest];
}

export function LastTurn() {
  const turn = useShellStore((s) => s.lastTurn);
  const seq = useShellStore((s) => s.lastTurnSeq);
  const replySeq = useShellStore((s) => s.lastTurnReplySeq);
  const busy = useShellStore((s) => s.firstmateBusy);
  const view = useShellStore((s) => s.view);
  const cardUp = useCardUp();
  const fade = useSyncExternalStore(subscribeFade, getFade, getFade);
  const [outgoing, setOutgoing] = useState<Outgoing | null>(null);
  const [hovering, setHovering] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [focused, setFocused] = useState(false);
  const [awake, setAwake] = useState(windowAwake);
  const [covered, setCovered] = useState(messageCovered);
  const shownRef = useRef<{ rounds: Shown[]; seq: number } | null>(null);
  /** Where each round stood after the last render, and the render before it. */
  const tops = useRef(new Map<number, number>());
  const earlierTops = useRef(new Map<number, number>());
  const rootRef = useRef<HTMLDivElement>(null);
  /** The reply this mount read out, so a later render does not clear the live region. */
  const spoken = useRef<string | null>(null);
  const key = fadeKey(turn, seq);
  const announcement = replyAnnouncementKey(turn, replySeq);
  const readable =
    view === "home" && !cardUp && !hovering && !selecting && !focused && awake && !covered;

  // The clock lives outside this component, so Settings unmounting it only pauses.
  useEffect(() => {
    syncFade(key, readable);
    return () => syncFade(key, false);
  }, [key, readable]);

  if (announcement && spoken.current !== announcement && !replyAnnounced(announcement))
    spoken.current = announcement;

  useEffect(() => {
    if (fade.phase === "hidden") {
      setHovering(false);
      setSelecting(false);
    }
  }, [fade.phase]);

  useEffect(() => {
    if (!announcement) return;
    // After this mount sticks. A strict-mode remount cancels the mark, so the
    // reply is still read out; a later return from Settings is not.
    const id = window.setTimeout(() => markReplyAnnounced(announcement), 0);
    return () => window.clearTimeout(id);
  }, [announcement]);

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

  const hidden = key !== null && fade.key === key && fade.phase === "hidden";
  const fading = key !== null && fade.key === key && fade.phase === "fading";
  const rounds = turn ? roundsOf(turn, seq, !cardUp) : [];

  // A new message pushes the oldest round out: it leaves over --dur-fast
  // from where it stood while the rest glide up.
  useEffect(() => {
    const now = turn ? roundsOf(turn, seq, !cardUp) : [];
    const before = shownRef.current;
    shownRef.current = { rounds: now, seq };
    if (!before || before.seq === seq || prefersReducedMotion()) return;
    const gone = before.rounds.find((round) => !now.some((kept) => kept.key === round.key));
    if (!gone) return;
    setOutgoing({ ...gone, top: earlierTops.current.get(gone.key) ?? 0 });
    const id = window.setTimeout(() => setOutgoing(null), LEAVE_MS + 60);
    return () => window.clearTimeout(id);
  }, [turn, seq, cardUp]);

  // The glide: a round that stays starts from where it stood and eases to
  // its new place over --dur-med. Reduced motion lands it at once.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const nodes = root.querySelectorAll<HTMLElement>(":scope > [data-round]:not([data-outgoing])");
    const next = new Map<number, number>();
    for (const node of nodes) {
      const at = Number(node.dataset.round);
      const top = node.offsetTop;
      next.set(at, top);
      const was = tops.current.get(at);
      if (was === undefined || was === top || prefersReducedMotion()) continue;
      const style = getComputedStyle(node);
      node.animate([{ translate: `0 ${was - top}px` }, { translate: "0 0" }], {
        duration: Number.parseFloat(style.getPropertyValue("--dur-med")) || 0,
        easing: style.getPropertyValue("--ease-out").trim() || "ease-out",
      });
    }
    earlierTops.current = tops.current;
    tops.current = next;
  });

  if (!turn) return null;
  return (
    <div
      data-last-turn=""
      data-last-turn-rounds={rounds.length}
      data-last-turn-fade={hidden ? "hidden" : fading ? "fading" : "shown"}
      ref={rootRef}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => setFocused(event.currentTarget.contains(event.relatedTarget))}
    >
      {outgoing && !rounds.some((round) => round.key === outgoing.key) && (
        <div data-round={outgoing.key} data-outgoing="" style={{ top: outgoing.top }}>
          <LastTurnRound round={outgoing.round} busy={false} older leaving announce={false} />
        </div>
      )}
      {rounds.map((shown) =>
        shown.older && hidden ? null : (
          <div key={shown.key} data-round={shown.key} className="slot">
            <LastTurnRound
              round={shown.round}
              busy={busy}
              older={shown.older}
              fading={shown.older && fading}
              announce={!shown.older && spoken.current === announcement}
            />
          </div>
        ),
      )}
    </div>
  );
}
