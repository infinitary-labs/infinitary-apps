import { type Card, cardPresentation } from "@shared/cards";
import type {
  ConversationPage,
  ConversationRound,
  ConversationCard as RoundCard,
} from "@shared/conversation";
import { newerRound } from "@shared/conversation";
import { formatDate, formatTime } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import type { LastTurn } from "@shared/lastTurn";
import { CAPTAIN_COMMAND } from "@shared/through";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ResponseCard } from "../design/cards/ResponseCard";
import { Badge, type BadgeTone } from "../design/core/Badge";
import { GroupedPills } from "../design/core/GroupedPills";
import { MateMark } from "./LastTurn";
import { conversationHeading } from "./lastTurnWords";
import { CONVERSATION_ENTRY_ID, type ConversationEntry, type ConversationView } from "./stack";
import { useShellStore } from "./store";
import "./conversation.css";

/**
 * The conversation (INF-6337's plan, the captain's Approve and build;
 * docs/composer.md "The conversation"): everything the captain did directly
 * - their messages and the first mate's replies, their presses of a card's
 * buttons and the lines they typed under cards - oldest at the top, the
 * newest at the foot, read a page at a time from the core
 * (`inf:conversation:thread`). Its Cards view lists the cards waiting on
 * them, then the cards they answered. Reading it tells the first mate
 * nothing.
 */

/** How close to the oldest end a scroll comes before the next page is read. */
const EDGE_PX = 80;

type Loaded = {
  rounds: ConversationRound[];
  more: boolean;
  /** The core could not be read: the two rounds the strip holds stand in. */
  fallback: boolean;
};

/** Newer rounds in `page` replace the same ids; rounds read earlier stay. */
function merged(kept: readonly ConversationRound[], page: readonly ConversationRound[]) {
  const byId = new Map(kept.map((round) => [round.id, round]));
  for (const round of page) byId.set(round.id, round);
  return [...byId.values()].sort(newerRound);
}

/** The strip's two rounds, for a home that cannot answer the read. */
function fallbackRounds(turn: LastTurn | null): ConversationRound[] {
  if (!turn) return [];
  const round = (id: string, r: Pick<LastTurn, "you" | "reply" | "through">) => ({
    id,
    at: 0,
    kind: "message" as const,
    you: r.you,
    reply: r.reply ?? null,
    ...(r.through ? { through: r.through } : {}),
  });
  return [round("last:1", turn), ...(turn.previous ? [round("last:0", turn.previous)] : [])];
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

function dayWords(at: number, now: number): string {
  if (sameDay(at, now)) return m.shellConversationToday();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(at, yesterday.getTime())) return m.shellConversationYesterday();
  return formatDate(at, { weekday: "long", month: "long", day: "numeric" });
}

const timeWords = (at: number) => formatTime(at, { hour: "numeric", minute: "2-digit" });

const CHIP: Record<RoundCard["presentation"], { tone: BadgeTone; label: () => string }> = {
  note: { tone: "neutral", label: () => m.uiCardKindNote() },
  decision: { tone: "accent", label: () => m.uiCardKindDecision() },
  attention: { tone: "danger", label: () => m.uiCardKindAttention() },
};

/** Opens a card from the conversation: a live one comes forward, a closed one opens as a past card. */
function useOpenCard(): (cardId: string) => void {
  return useCallback((cardId: string) => {
    const s = useShellStore.getState();
    if (s.cards.some((card) => card.id === cardId) && s.focusCard(cardId)) return;
    s.openPastCard(cardId, { cardId: CONVERSATION_ENTRY_ID });
  }, []);
}

/** A card the captain acted on, drawn small: its kind's chip, its title and its task's key. */
function CardTile({
  card,
  onOpen,
}: {
  card: Pick<RoundCard, "id" | "title" | "presentation" | "taskKey">;
  onOpen: (cardId: string) => void;
}) {
  const chip = CHIP[card.presentation];
  return (
    <button
      type="button"
      className="conversation-tile"
      data-conversation-card={card.id}
      onClick={() => onOpen(card.id)}
    >
      <Badge tone={chip.tone} dot style={{ flexShrink: 0 }}>
        {chip.label()}
      </Badge>
      <span className="conversation-tile-title">{card.title}</span>
      {card.taskKey && <span className="conversation-tile-key">{card.taskKey}</span>}
    </button>
  );
}

function You({ words, through }: { words: string; through?: boolean }) {
  return (
    <div className="conversation-you">
      {through && (
        <span className="conversation-through">
          {m.shellLastTurnFromCommand({ command: CAPTAIN_COMMAND })}
        </span>
      )}
      <div className="conversation-bubble" data-conversation-you="">
        {words.trim() || m.shellLastTurnPictureOnly()}
      </div>
    </div>
  );
}

function Mate({
  words,
  problem = false,
  working = false,
  who = "firstmate",
}: {
  words: string | null;
  problem?: boolean;
  working?: boolean;
  who?: "firstmate" | "crewmate";
}) {
  return (
    <div className="conversation-mate" data-conversation-mate={who}>
      {who === "firstmate" ? (
        <MateMark working={working} />
      ) : (
        <span className="conversation-crew">{m.shellConversationCrewmate()}</span>
      )}
      <div
        className="conversation-words"
        data-conversation-words=""
        data-state={words === null ? "working" : problem ? "problem" : "reply"}
      >
        {words ?? m.shellLastTurnWorking()}
      </div>
    </div>
  );
}

function RoundView({
  round,
  working,
  onOpen,
}: {
  round: ConversationRound;
  /** The first mate works on this message: its mark spins, and the working words stand in for a reply. */
  working: boolean;
  onOpen: (cardId: string) => void;
}) {
  if (round.kind === "message") {
    const reply = round.reply;
    return (
      <>
        <You words={round.you} through={round.through !== undefined} />
        {reply ? (
          <Mate
            words={reply.words ?? reply.text}
            problem={reply.problem === true}
            working={working}
          />
        ) : working ? (
          <Mate words={null} working />
        ) : null}
      </>
    );
  }
  if (round.kind === "choice") {
    return (
      <>
        <CardTile card={round.card} onOpen={onOpen} />
        <You words={m.shellConversationChose({ label: round.label })} />
      </>
    );
  }
  const answer = round.answer;
  const reply = round.reply;
  return (
    <>
      <CardTile card={round.card} onOpen={onOpen} />
      <You words={round.you} />
      {answer ? (
        <Mate words={answer.text} who={answer.who} />
      ) : reply ? (
        <Mate words={reply.words ?? reply.text} problem={reply.problem === true} />
      ) : null}
    </>
  );
}

function Everything({
  rounds,
  busy,
  onOpen,
}: {
  rounds: readonly ConversationRound[];
  busy: boolean;
  onOpen: (cardId: string) => void;
}) {
  const now = Date.now();
  // Oldest at the top: the newest round sits at the foot, nearest the message box.
  const shown = [...rounds].reverse();
  const newestMessage = rounds.find((round) => round.kind === "message")?.id;
  return (
    <ol className="conversation-rounds" data-conversation-rounds="">
      {shown.map((round, index) => {
        const before = shown[index - 1];
        const newDay = round.at > 0 && (!before || !sameDay(before.at, round.at));
        // A time is drawn where the minute changes, not on every round in it.
        const newTime =
          round.at > 0 && (newDay || timeWords(before?.at ?? 0) !== timeWords(round.at));
        return (
          <li
            key={round.id}
            className="conversation-round"
            data-conversation-round={round.id}
            data-kind={round.kind}
          >
            {newDay && (
              <div className="conversation-day">
                <span>{dayWords(round.at, now)}</span>
              </div>
            )}
            {newTime && <div className="conversation-time">{timeWords(round.at)}</div>}
            <RoundView round={round} working={busy && round.id === newestMessage} onOpen={onOpen} />
          </li>
        );
      })}
    </ol>
  );
}

type Answered = { card: RoundCard; at: number; words: string };

/** The cards the captain answered, newest first, each once with its newest act. */
function answeredCards(rounds: readonly ConversationRound[], waiting: ReadonlySet<string>) {
  const seen = new Set<string>();
  const answered: Answered[] = [];
  for (const round of rounds) {
    if (round.kind === "message" || seen.has(round.card.id) || waiting.has(round.card.id)) continue;
    seen.add(round.card.id);
    answered.push({
      card: round.card,
      at: round.at,
      words:
        round.kind === "choice"
          ? m.shellConversationYouChose({ label: round.label })
          : m.shellConversationYouReplied({ words: round.you }),
    });
  }
  return answered;
}

function waitingTile(card: Card): Pick<RoundCard, "id" | "title" | "presentation"> {
  return { id: card.id, title: card.title, presentation: cardPresentation(card) };
}

function Cards({
  rounds,
  waiting,
  onOpen,
}: {
  rounds: readonly ConversationRound[];
  waiting: readonly Card[];
  onOpen: (cardId: string) => void;
}) {
  const now = Date.now();
  const answered = answeredCards(rounds, new Set(waiting.map((card) => card.id)));
  if (waiting.length === 0 && answered.length === 0)
    return <p className="conversation-empty">{m.shellConversationNoCards()}</p>;
  const when = (at: number) =>
    sameDay(at, now) ? timeWords(at) : `${dayWords(at, now)} ${timeWords(at)}`;
  return (
    <div className="conversation-cards" data-conversation-cards="">
      {waiting.length > 0 && (
        <section data-conversation-section="waiting">
          <h4 className="conversation-section">{m.shellConversationWaitingOnYou()}</h4>
          <ul>
            {waiting.map((card) => (
              <li key={card.id} className="conversation-card-row">
                <CardTile card={waitingTile(card)} onOpen={onOpen} />
                <span className="conversation-card-fact">{when(card.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {answered.length > 0 && (
        <section data-conversation-section="answered">
          <h4 className="conversation-section">{m.shellConversationAnswered()}</h4>
          <ul>
            {answered.map(({ card, at, words }) => (
              <li key={card.id} className="conversation-card-row">
                <CardTile card={card} onOpen={onOpen} />
                <span className="conversation-card-fact">
                  {words} · {when(at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function ConversationCard({
  entry,
  width,
  onDrawn,
}: {
  entry: ConversationEntry;
  width: number | string;
  onDrawn?: () => void;
}) {
  const turn = useShellStore((s) => s.lastTurn);
  const seq = useShellStore((s) => s.lastTurnSeq);
  const replySeq = useShellStore((s) => s.lastTurnReplySeq);
  const busy = useShellStore((s) => s.firstmateBusy);
  const cards = useShellStore((s) => s.cards);
  const [view, setView] = useState<ConversationView>(entry.view ?? "everything");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reading, setReading] = useState(false);
  const body = useRef<HTMLDivElement | null>(null);
  const onOpen = useOpenCard();
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  /** Where the reader stood from the foot before an older page was read in above. */
  const fromFoot = useRef<number | null>(null);
  const drawn = useRef(false);
  /** The round to bring into view once the rounds are drawn: set on each open. */
  const landing = useRef<ConversationEntry["at"] | "newest" | null>(entry.at ?? "newest");
  const opened = useRef(entry);
  if (opened.current !== entry) {
    opened.current = entry;
    landing.current = entry.at ?? "newest";
  }
  /** Whether the reader stands at the foot, where a new round keeps them. */
  const atFoot = useRef(true);

  useEffect(() => {
    if (entry.view) setView(entry.view);
  }, [entry]);

  // The newest page, read again whenever something the captain did or the
  // first mate said may have added a round; rounds read earlier stay.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each is a sign of a new round, read by id
  useEffect(() => {
    let live = true;
    window.infinitary.conversation.thread().then(
      (page: ConversationPage) => {
        if (!live) return;
        const kept = loadedRef.current;
        setLoaded({
          rounds: kept && !kept.fallback ? merged(kept.rounds, page.rounds) : page.rounds,
          more:
            kept && !kept.fallback && kept.rounds.length > page.rounds.length
              ? kept.more
              : page.more,
          fallback: false,
        });
      },
      () => {
        if (!live) return;
        setLoaded({
          rounds: fallbackRounds(useShellStore.getState().lastTurn),
          more: false,
          fallback: true,
        });
      },
    );
    return () => {
      live = false;
    };
  }, [seq, replySeq, busy, cards]);

  // A home that cannot answer the read keeps the strip's rounds current.
  useEffect(() => {
    setLoaded((was) => (was?.fallback ? { ...was, rounds: fallbackRounds(turn) } : was));
  }, [turn]);

  const readEarlier = useCallback(() => {
    const now = loadedRef.current;
    const oldest = now?.rounds.at(-1);
    if (!now?.more || now.fallback || !oldest || reading) return;
    setReading(true);
    const element = body.current;
    window.infinitary.conversation.thread({ before: { at: oldest.at, id: oldest.id } }).then(
      (page) => {
        if (element) fromFoot.current = element.scrollHeight - element.scrollTop;
        setLoaded((was) =>
          was ? { rounds: merged(was.rounds, page.rounds), more: page.more, fallback: false } : was,
        );
        setReading(false);
      },
      () => setReading(false),
    );
  }, [reading]);

  // After an older page is read in above, the reader stays where they were.
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || fromFoot.current === null || view !== "everything") return;
    element.scrollTop = element.scrollHeight - fromFoot.current;
    fromFoot.current = null;
  });

  // Each open lands at the round the strip was pressed on; a new round at
  // the foot keeps a reader who stood at the foot there.
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || !loaded) return;
    if (!drawn.current) {
      drawn.current = true;
      onDrawn?.();
    }
    if (view !== "everything") return;
    const land = landing.current;
    landing.current = null;
    if (land === "older") {
      const older = loaded.rounds.filter((round) => round.kind === "message")[1];
      const node = older
        ? element.querySelector<HTMLElement>(`[data-conversation-round="${CSS.escape(older.id)}"]`)
        : null;
      if (node) node.scrollIntoView({ block: "center" });
      else element.scrollTop = element.scrollHeight;
    } else if (land === "newest" || (atFoot.current && fromFoot.current === null)) {
      element.scrollTop = element.scrollHeight;
    }
    // A page too short to scroll reads the next one now.
    if (element.scrollHeight <= element.clientHeight && loaded.more) readEarlier();
  }, [loaded, view, onDrawn, readEarlier]);

  // A stage that cannot draw an empty card waits on nothing: the card shows
  // as soon as the first read settles.
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (drawn.current) return;
      drawn.current = true;
      onDrawn?.();
    }, 500);
    return () => window.clearTimeout(id);
  }, [onDrawn]);

  // The card's body is the scroller; a scroll event does not bubble to the rounds.
  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const onScroll = () => {
      atFoot.current = element.scrollHeight - element.scrollTop - element.clientHeight < EDGE_PX;
      const atOldest =
        view === "everything"
          ? element.scrollTop < EDGE_PX
          : element.scrollHeight - element.scrollTop - element.clientHeight < EDGE_PX;
      if (atOldest) readEarlier();
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [view, readEarlier]);

  // Cards waiting on the captain: every live card, those put aside included,
  // newest first. A card its author ended waits on nothing.
  const waiting = cards
    .filter((card) => card.ended === undefined)
    .sort((a, b) => b.createdAt - a.createdAt);

  const rounds = loaded?.rounds ?? [];
  return (
    <ResponseCard
      kind="note"
      headExtra={
        <span className="conversation-head">
          <h3 className="conversation-heading">{conversationHeading()}</h3>
          <GroupedPills<ConversationView>
            name={m.shellConversationShow()}
            htmlName="conversation-view"
            value={view}
            options={[
              { value: "everything", label: m.shellConversationEverything() },
              { value: "cards", label: m.shellConversationCards() },
            ]}
            onChange={(next) => {
              setView(next);
              useShellStore.getState().setConversationView(next);
            }}
          />
        </span>
      }
      width={width}
      minHeight={160}
      bodyRef={body}
    >
      <div className="conversation" data-conversation={view}>
        {loaded?.fallback && <p className="conversation-notice">{m.shellConversationPartial()}</p>}
        {reading && view === "everything" && (
          <p className="conversation-notice">{m.shellConversationReadingEarlier()}</p>
        )}
        {view === "everything" ? (
          loaded && rounds.length === 0 ? (
            <p className="conversation-empty">{m.shellConversationEmpty()}</p>
          ) : (
            <Everything rounds={rounds} busy={busy} onOpen={onOpen} />
          )
        ) : (
          <Cards rounds={rounds} waiting={waiting} onOpen={onOpen} />
        )}
        {reading && view === "cards" && (
          <p className="conversation-notice">{m.shellConversationReadingEarlier()}</p>
        )}
      </div>
    </ResponseCard>
  );
}
