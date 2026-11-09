import { fileSizeWords } from "@shared/attachments";
import {
  CARD_CHAT_LABEL,
  CARD_REPLY_HINT,
  CARD_REPLY_MAX_CHARS,
  type Card,
  type CardAnswer,
  type CardMessage,
  type CardMessageWho,
} from "@shared/cards";
import {
  COMPOSER_NOTICE_WORDS,
  composeTurnText,
  limitBand,
  type PastedText,
} from "@shared/composer";
import { ENDED_CLOSE_CARD_LABEL } from "@shared/endedCard";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ComposerNoticeView } from "../app/ComposerNotice";
import { useCommandKeys } from "../app/keyHints";
import { useShellStore } from "../app/store";
import { replyDestination } from "../attachments/destinations";
import { useFileIntake } from "../attachments/useFileIntake";
import { Button, IconButton, type ImageAttachment, MicroLabel } from "../design";
import { ComposerCount, ComposerCountAnnouncer, ComposerField } from "../design/core/ComposerField";
import {
  AddFilesButton,
  FilesStatus,
  PendingFileChips,
  useFileDrop,
} from "../design/core/FileControls";
import { PastedTextChip } from "../design/voice/VoiceInput";
import type { CollectAnswers } from "./PrototypeBody";
import { RevisionLinks } from "./RevisionNavigation";
import { useMessageEntrance, useWorkingEntrance } from "./SurfaceReveal";
import { KeyedText } from "./TaskKey";
import {
  contributorWords,
  messageCountWords,
  settingsCountWords,
  THREAD_CARD,
  THREAD_WHO_LABELS,
  THREAD_WORKING,
  threadCountWords,
  threadCueLabel,
} from "./threadWords";
import { useReplyDoing } from "./useReplyDoing";
import { type ThreadWaitLine, useThreadWait } from "./useThreadWait";
import "./cardThread.css";

/** Shared empty list so the reply-image selector is referentially stable. */
const NO_REPLY_PASTES: PastedText[] = [];
const NO_REPLY_IMAGES: ImageAttachment[] = [];

/**
 * A card's thread: the host chrome between the captain and the card's
 * author (cards-as-threads phase 1; the design skill's
 * `components/cards/CardThread.prompt.md` owns every rule here). The card's
 * body frame is untouched - a thread is never the author's HTML.
 *
 * Two shapes, and the same one field in both: above the card's choices,
 * with Chat at the right edge of their row, while the card has no thread
 * open (INF-924), and at the foot of the column beside the card once the
 * first message is sent, with its own Chat. A thread the captain collapses
 * goes back into the card: the field returns above the choices with the
 * thread's latest line above it (FI3-1130).
 */

/** Who wrote it, in the words the thread shows and the color it uses. */
const WHO: Record<CardMessageWho, { label: string; color: string }> = {
  captain: { label: THREAD_WHO_LABELS.captain, color: "var(--captain)" },
  crewmate: { label: THREAD_WHO_LABELS.crewmate, color: "var(--accent)" },
  firstmate: { label: THREAD_WHO_LABELS.firstmate, color: "var(--accent)" },
  // The host is not a party to the conversation: no accent, the whole row quiet.
  host: { label: THREAD_WHO_LABELS.host, color: "var(--fg-3)" },
};

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Chat's speech bubble (Lucide's message-square). */
const chatIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flexShrink: 0 }}
  >
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

/** The key Chat shows: Enter in the field sends the same reply. */
const CHAT_KEY = "⏎";

/**
 * The card's field had the focus when it left one place for the other (the
 * card's foot, or the thread column beside it): the field that takes its
 * place takes the focus too, as one field that never moved would keep it.
 */
const focusCarried = new Set<string>();

/** The card's one field, found from anywhere inside the card or its thread. */
const fieldIn = (from: Element, cardId: string) =>
  from
    .closest("[data-card-surface], section")
    ?.querySelector<HTMLTextAreaElement>(`[data-card-reply="${CSS.escape(cardId)}"] textarea`) ??
  null;

/**
 * Chat (INF-924): the quiet button that sends the card's field as a reply,
 * at the right edge of the card's choices, or beside the field at the
 * thread's foot. It never closes the card and takes no number key; it shows
 * ⏎, which does the same from the field, and lights once there is something
 * to send. With nothing to send it puts the caret in the field.
 */
export function ChatButton({
  cardId,
  collect,
  focusField,
}: {
  cardId: string;
  collect?: CollectAnswers | undefined;
  /** The field to put the caret in; found inside the card when not given. */
  focusField?: () => void;
}) {
  const draft = useShellStore((s) => s.replyDrafts[cardId] ?? "");
  const images = useShellStore((s) => s.replyImages[cardId] ?? NO_REPLY_IMAGES);
  const pastes = useShellStore((s) => s.replyPastes[cardId] ?? NO_REPLY_PASTES);
  const sending = useShellStore((s) => s.sendingReplies[cardId] === true);
  const sendReply = useShellStore((s) => s.sendReply);
  const length = composeTurnText(draft, []).length;
  const over = limitBand(length, CARD_REPLY_MAX_CHARS) === "over";
  const something = length > 0 || images.length > 0 || pastes.length > 0;
  const lit = something && !over;
  return (
    <Button
      variant="ghost"
      data-card-chat={cardId}
      data-lit={lit ? "" : undefined}
      icon={chatIcon}
      keys={CHAT_KEY}
      disabled={sending}
      // Past a reply's limit nothing leaves: Chat is off, as Enter is.
      off={over}
      style={lit ? { background: "var(--accent-dim)", color: "var(--fg-1)" } : undefined}
      onClick={(event) => {
        // The caret goes to the field either way, as a send by Enter leaves it.
        if (focusField) focusField();
        else fieldIn(event.currentTarget, cardId)?.focus();
        if (lit) void sendReply(cardId, collect);
      }}
    >
      {CARD_CHAT_LABEL}
    </Button>
  );
}

/**
 * The thread's collapse: a panel whose chevron points left, into the card,
 * because the arrow says where the thread goes (Lucide's panel-right-open
 * glyph, whose name is the reverse of its meaning here).
 */
const collapseIcon = (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18" />
    <path d="m11 15-3-3 3-3" />
  </svg>
);

/** The cue's end: the chevron points right, toward where the thread opens (panel-right-close). */
const openIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M15 3v18" />
    <path d="m8 9 3 3-3 3" />
  </svg>
);

/** A press made by a key: a button's click from Enter or Space counts no clicks. */
const byKey = (event: MouseEvent) => event.detail === 0;

/** The reply field stops growing here inside the card, then scrolls. */
const REPLY_LINE_CAP = 5;

/**
 * The captain's own input under a card, its one field (INF-924): the
 * composer's field (`ComposerField`) at `--text-sm`, with its keys and its
 * count against a reply's limit. Enter, or Chat, sends the words as a reply
 * to the card's author and never resolves anything; a click on any of the
 * card's choices carries them with it instead (`withAnythingElse`). The
 * field keeps the focus through a send, by Enter or by Chat.
 */
export function ReplyRow({
  cardId,
  placeholder = CARD_REPLY_HINT,
  inThread,
  lead,
  collect,
}: {
  cardId: string;
  placeholder?: string;
  /**
   * Inside the thread column, with its own Chat beside the field; above the
   * card's choices, Chat sits at the right edge of their row instead.
   */
  inThread?: boolean;
  /** What sits between the hairline and the field: a collapsed thread's latest line. */
  lead?: ReactNode;
  collect?: CollectAnswers;
}) {
  const pastes = useShellStore((s) => s.replyPastes[cardId] ?? NO_REPLY_PASTES);
  const attachPaste = useShellStore((s) => s.attachReplyPaste);
  const removePaste = useShellStore((s) => s.removeReplyPaste);
  const draft = useShellStore((s) => s.replyDrafts[cardId] ?? "");
  const images = useShellStore((s) => s.replyImages[cardId] ?? NO_REPLY_IMAGES);
  const sending = useShellStore((s) => s.sendingReplies[cardId] === true);
  const error = useShellStore((s) => s.replyErrors[cardId]);
  const notice = useShellStore((s) => s.replyNotices[cardId]);
  const setReplyDraft = useShellStore((s) => s.setReplyDraft);
  const attachReplyImages = useShellStore((s) => s.attachReplyImages);
  const showReplyNotice = useShellStore((s) => s.showReplyNotice);
  const dismissReplyNotice = useShellStore((s) => s.dismissReplyNotice);
  const removeReplyImage = useShellStore((s) => s.removeReplyImage);
  const sendReply = useShellStore((s) => s.sendReply);
  const [focus, setFocus] = useState(false);
  const replyKeys = useCommandKeys("focus.card-reply");
  const field = useRef<HTMLTextAreaElement | null>(null);
  const destination = useMemo(() => replyDestination(cardId, () => field.current), [cardId]);
  const files = useFileIntake(destination);
  const drop = useFileDrop(files);
  const preparing = (files?.pending.length ?? 0) > 0;
  const send = () => {
    field.current?.focus();
    void sendReply(cardId, collect);
  };
  useLayoutEffect(() => {
    if (focusCarried.delete(cardId)) field.current?.focus();
    const own = field.current;
    return () => {
      // Read before the field leaves the page: the one that replies it in
      // the same commit takes the focus; one that never comes forgets it.
      if (!own || document.activeElement !== own) return;
      focusCarried.add(cardId);
      queueMicrotask(() => focusCarried.delete(cardId));
    };
  }, [cardId]);
  // What would leave on send, as the task prompt counts it: whitespace
  // alone is nothing, and past the limit nothing leaves.
  const length = composeTurnText(draft, []).length;
  const over = limitBand(length, CARD_REPLY_MAX_CHARS) === "over";
  const canSend =
    !sending && !over && !preparing && (length > 0 || images.length > 0 || pastes.length > 0);
  return (
    <div
      data-card-reply={cardId}
      data-file-drop={drop.over ? "over" : undefined}
      {...drop.handlers}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        ...(drop.over ? { boxShadow: "inset 0 0 0 1px var(--accent)" } : {}),
        ...(inThread ? { padding: "10px 12px 14px" } : {}),
      }}
    >
      {lead}
      {(pastes.length > 0 || preparing) && (
        <div style={{ display: "flex", gap: "var(--space-2)", overflowX: "auto" }}>
          {pastes.map((paste) => (
            <PastedTextChip
              key={paste.id}
              paste={paste}
              onRemove={() => removePaste(cardId, paste.id)}
            />
          ))}
          {files && <PendingFileChips intake={files} />}
        </div>
      )}
      {images.length > 0 && (
        <div style={{ display: "flex", gap: "var(--space-2)", overflowX: "auto" }}>
          {images.map((image) => (
            <div
              key={image.id}
              data-card-reply-picture=""
              style={{
                display: "flex",
                flex: "0 0 auto",
                alignItems: "center",
                gap: "var(--space-1)",
                padding: "var(--space-1)",
                borderRadius: "var(--radius-s)",
                background: "var(--bg-2)",
                border: "1px solid var(--line-1)",
              }}
            >
              <img
                src={image.preview}
                alt=""
                style={{
                  width: "var(--space-6)",
                  height: "var(--space-6)",
                  objectFit: "cover",
                  borderRadius: "var(--radius-xs)",
                }}
              />
              {image.name && (
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span
                    style={{
                      maxWidth: "calc(2 * var(--space-9))",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--fg-1)",
                    }}
                  >
                    {image.name}
                  </span>
                  <span style={{ color: "var(--fg-3)", whiteSpace: "nowrap" }}>
                    {fileSizeWords(Math.floor((image.data.length * 3) / 4))}
                  </span>
                </span>
              )}
              <IconButton
                label={image.name ? `Remove ${image.name}` : "Remove picture"}
                size={20}
                disabled={sending}
                onClick={() => removeReplyImage(cardId, image.id)}
              >
                ×
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end" }}>
        <div
          style={{
            position: "relative",
            flex: 1,
            minWidth: 0,
            boxSizing: "border-box",
            minHeight: "var(--reply-height)",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--surface-input)",
            border: `1px solid ${focus ? "var(--line-2)" : "var(--line-1)"}`,
            borderRadius: "var(--reply-radius)",
            boxShadow: focus ? "var(--focus-ring)" : "none",
            transition:
              "border-color var(--dur-fast) var(--ease-out),box-shadow var(--dur-fast) var(--ease-out)",
          }}
        >
          {replyKeys.keys && draft === "" && !focus && (
            // The key that brings focus here, at the empty field's far end
            // as a placeholder is; gone once the field has focus or words.
            <span
              data-reply-key=""
              aria-hidden="true"
              style={{
                position: "absolute",
                // The field's first line, in the field's own font and line height
                // so the key shares the placeholder's baseline: the pill's padding,
                // then the field's own 2px.
                top: "calc(var(--space-2) + 2px)",
                right: "var(--space-3)",
                fontFamily: "var(--font-ui)",
                fontSize: "var(--text-sm)",
                lineHeight: "var(--leading-body)",
                color: "var(--fg-3)",
                pointerEvents: "none",
              }}
            >
              <span style={{ fontFamily: "var(--font-mono)" }}>{replyKeys.keys}</span>
            </span>
          )}
          <ComposerField
            fieldRef={field}
            aria-label="Reply to this card"
            aria-keyshortcuts={replyKeys["aria-keyshortcuts"]}
            messageField="reply"
            placeholder={placeholder}
            value={draft}
            // Held, not disabled, while the reply sends: a disabled field
            // drops the focus to the page.
            readOnly={sending}
            lineCap={REPLY_LINE_CAP}
            canSend={canSend}
            onSend={send}
            onChange={(event) => setReplyDraft(cardId, event.target.value)}
            onPasteText={(text) => attachPaste(cardId, text)}
            onAttach={(items) => attachReplyImages(cardId, items)}
            onPictureTooBig={() => showReplyNotice(cardId, "picture-too-big")}
            onKeyDown={(event) => {
              // The card's own input, not the shell's: every key stops here
              // so neither Escape nor Enter reaches the window's
              // hold-to-talk listeners, and right Option records nothing.
              event.stopPropagation();
            }}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            style={{ width: "100%", fontSize: "var(--text-sm)", lineHeight: "var(--leading-body)" }}
          />
        </div>
        {/* Centred on the field's last line, at every height. */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
            height: "var(--reply-height)",
          }}
        >
          {files && <AddFilesButton intake={files} size={28} label="Add files to this reply" />}
          {inThread && (
            <ChatButton
              cardId={cardId}
              collect={collect}
              focusField={() => field.current?.focus()}
            />
          )}
        </span>
      </div>
      {limitBand(length, CARD_REPLY_MAX_CHARS) !== "none" && (
        <div
          data-card-reply-limit=""
          style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
        >
          <span style={{ flex: 1, minWidth: 0, fontSize: "var(--text-xs)", color: "var(--fg-2)" }}>
            {over ? COMPOSER_NOTICE_WORDS["too-long"] : null}
          </span>
          <ComposerCount length={length} max={CARD_REPLY_MAX_CHARS} />
        </div>
      )}
      <ComposerCountAnnouncer length={length} max={CARD_REPLY_MAX_CHARS} />
      <FilesStatus intake={files} />
      {notice && (
        <ComposerNoticeView
          width="100%"
          notice={notice}
          onDismiss={() => dismissReplyNotice(cardId)}
        />
      )}
      {error && (
        <p role="alert" style={{ margin: 0, color: "var(--danger)", fontSize: "var(--text-xs)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The thread column beside the card, inside the pair's single container:
 * its own micro-label head and the message list. The reply row at its foot
 * is the card's one reply field, which the stage keeps mounted whether the
 * thread is open or not (`app/stage/EntrySurface.tsx`), so opening the thread never
 * rebuilds the field or the body beside it. The divider is the column's
 * left border - one hairline, no gap and no second surface, so the pair
 * reads as one object. The head names only the thread: the card beside it
 * already carries the author, the model and the close. Its one control
 * collapses the thread back into the card (FI3-1130), never an ×.
 */
export function CardThread({
  cardId,
  card,
  working,
  onCollapse,
  style,
}: {
  cardId: string;
  /** The card's author and hold, which the waiting line reads (`useThreadWait`). */
  card: ThreadCard;
  working?: boolean;
  /** The head's Collapse thread; `byKey` when a key pressed it. */
  onCollapse?: (byKey: boolean) => void;
  /** Where the column sits in the pair's grid. */
  style?: CSSProperties;
}) {
  const messages = useShellStore((s) => s.threads[cardId]) ?? [];
  const keys = useCommandKeys("cards.thread");
  return (
    <div
      data-card-thread={cardId}
      style={{
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        borderLeft: "1px solid var(--line-2)",
        ...style,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          // The collapse control's height, so the label stays level with
          // the card's head beside it.
          minHeight: 28,
          padding: "14px 8px 8px 16px",
        }}
      >
        <MicroLabel>Thread</MicroLabel>
        {onCollapse && (
          <IconButton
            label="Collapse thread"
            {...keys}
            size={28}
            data-thread-collapse=""
            onClick={(event) => onCollapse(byKey(event))}
            style={{ marginLeft: "auto" }}
          >
            {collapseIcon}
          </IconButton>
        )}
      </div>
      <LiveMessageList card={card} messages={messages} working={working} />
    </div>
  );
}

/**
 * A collapsed thread's latest line, read live: the thread from the store,
 * the waiting line off the board and the command's keys (`LatestLine`).
 */
export function ThreadCue({
  cardId,
  card,
  working,
  onOpen,
}: {
  cardId: string;
  card: Pick<Card, "author" | "awaiting" | "taskId">;
  working?: boolean;
  /** Opens the thread; `byKey` when a key pressed the row. */
  onOpen: (byKey: boolean) => void;
}) {
  const messages = useShellStore((s) => s.threads[cardId]) ?? [];
  const waiting = useThreadWait(card);
  const doing = useReplyDoing(card, messages, working === true);
  const keys = useCommandKeys("cards.thread");
  return (
    <LatestLine
      cardId={cardId}
      messages={messages}
      working={working}
      doing={doing}
      waiting={waiting}
      keyShortcuts={keys["aria-keyshortcuts"]}
      onOpen={onOpen}
    />
  );
}

/**
 * A collapsed thread's latest line (FI3-1130, the captain's cue B): one row
 * at the card's foot, between the hairline and the reply field, that opens
 * the thread beside the card again. It says who wrote last and the newest
 * message on one line, or the waiting line's sentence with no who, and how
 * many messages there are, or `working` while the author's turn runs - the
 * same tail the message list ends with, so what the crewmate is doing on
 * the reply stands in for the newest message while it works.
 */
export function LatestLine({
  cardId,
  messages,
  working = false,
  doing,
  waiting,
  keyShortcuts,
  onOpen,
}: {
  cardId: string;
  messages: readonly CardMessage[];
  working?: boolean;
  /** What the crewmate is doing on the reply while it works (`useReplyDoing`). */
  doing?: string | undefined;
  /** The waiting line; `working` wins while a turn runs. */
  waiting?: ThreadWaitLine;
  /** Every key of the command that does the same, for assistive technology. */
  keyShortcuts?: string | undefined;
  onOpen: (byKey: boolean) => void;
}) {
  const last = messages.at(-1);
  if (!last) return null;
  const waitingText = working ? doing : waiting?.text;
  const who = WHO[last.who];
  const count = messageCountWords(messages.length);
  return (
    <button
      type="button"
      data-thread-cue={cardId}
      aria-label={threadCueLabel(count, working)}
      aria-keyshortcuts={keyShortcuts}
      onClick={(event) => onOpen(byKey(event))}
    >
      <span data-thread-cue-who="" style={{ color: who.color }}>
        {waitingText === undefined ? who.label : ""}
      </span>
      <span
        data-thread-cue-said=""
        data-quiet={waitingText !== undefined || last.who === "host" ? "" : undefined}
      >
        {waitingText ?? last.text}
      </span>
      <span data-thread-cue-state="">{working ? THREAD_WORKING : count}</span>
      {openIcon}
    </button>
  );
}

/**
 * The messages with their live tail: `working` while the author's turn
 * runs, else the waiting line read off the board (`useThreadWait`).
 */
export function LiveMessageList({
  card,
  messages,
  working,
}: {
  card: ThreadCard;
  messages: readonly CardMessage[];
  working?: boolean;
}) {
  const waiting = useThreadWait(card);
  const doing = useReplyDoing(card, messages, working === true);
  return (
    <MessageList
      messages={messages}
      working={working}
      doing={doing}
      waiting={waiting}
      own={card.taskId}
      ended={card.ended && card.id ? <EndedLine card={{ ...card, id: card.id }} /> : undefined}
    />
  );
}

/** What a thread reads of its card; an ended card's line needs its id and offer too. */
type ThreadCard = Pick<Card, "author" | "awaiting" | "taskId"> &
  Partial<Pick<Card, "id" | "ended" | "lifecycleId" | "offerId">>;

/**
 * An ended card's app line (INF-3071): who ended it, its reason and that
 * nothing on it waits, with Close card under it - the same close as the
 * card's own Close. The core wrote the words; the thread keeps no row.
 */
function EndedLine({ card }: { card: Pick<Card, "id" | "ended" | "lifecycleId" | "offerId"> }) {
  const pressNote = useShellStore((s) => s.pressNote);
  const pending = useShellStore((s) => s.pendingCardActions[card.id] !== undefined);
  if (!card.ended) return null;
  return (
    <div
      data-thread-message="host"
      data-thread-ended=""
      style={{
        display: "grid",
        gridTemplateColumns: "34px minmax(0,1fr)",
        gap: 8,
        fontSize: "var(--text-xs)",
        lineHeight: "var(--leading-body)",
        color: "var(--fg-3)",
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", paddingTop: 1 }}>
        {WHO.host.label}
      </span>
      <div
        style={{
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 6,
        }}
      >
        <span style={{ alignSelf: "stretch", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
          {card.ended.line}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              marginLeft: 6,
              whiteSpace: "nowrap",
            }}
          >
            {timeOf(card.ended.at)}
          </span>
        </span>
        <Button
          size="sm"
          variant="secondary"
          data-thread-ended-close=""
          disabled={pending}
          onClick={() => void pressNote(card.id, card)}
        >
          {ENDED_CLOSE_CARD_LABEL}
        </Button>
      </div>
    </div>
  );
}

/**
 * The messages, oldest at the top. The list holds its scroll at the bottom
 * as they arrive, because the newest is always the one being answered.
 */
export function MessageList({
  messages,
  working = false,
  doing,
  waiting,
  own,
  ended,
}: {
  messages: readonly CardMessage[];
  working?: boolean;
  /** What the crewmate is doing on the reply, beside `working` (`useReplyDoing`). */
  doing?: string | undefined;
  /** The waiting line; `working` wins while a turn runs. */
  waiting?: ThreadWaitLine;
  /** The id of the card's own task, whose key stays text in its lines (FI3-1271). */
  own?: string | undefined;
  /** An ended card's app line, after every message and in place of any wait (INF-3071). */
  ended?: ReactNode;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  const workingEntrance = useWorkingEntrance();
  const waitingText = working ? undefined : waiting?.text;
  // The list's live tail: the working row with what it names, or the
  // waiting line.
  const tail = working ? `working ${doing ?? ""}` : ended ? "ended" : waitingText;
  useEffect(() => {
    // Hold at the bottom as messages arrive, as the working row comes (the
    // first mate's busy flag can land a render after the captain's reply,
    // INF-1231), and as the waiting line comes or changes; the newest is
    // always the one being answered. Nothing to hold to while the thread is
    // empty.
    if (count === 0 && tail === undefined) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count, tail]);
  return (
    <div
      data-thread-messages=""
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "4px 16px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {messages.map((message) => (
        <Message key={message.id} message={message} own={own} />
      ))}
      {working ? (
        <WorkingRow entrance={workingEntrance} doing={doing} />
      ) : (
        !ended &&
        waiting && <WaitingRow key={waiting.text} waiting={waiting} entrance={workingEntrance} />
      )}
      {ended}
      <div ref={endRef} />
    </div>
  );
}

/**
 * The waiting line (docs/card-threads.md, "The waiting line"): one quiet
 * sentence in the app's own voice, the host line's tone with no who, saying
 * the reply is saved, what holds it and who goes next. It is derived, not a
 * message: it changes with the task's state and leaves when the author
 * writes.
 */
function WaitingRow({ waiting, entrance }: { waiting: ThreadWaitLine; entrance: boolean }) {
  const [reveal] = useState(entrance);
  return (
    <div
      data-thread-waiting={waiting.on}
      {...(waiting.hold ? { "data-thread-hold": waiting.hold } : {})}
      role="status"
      data-stage-reveal={reveal ? "entrance" : "static"}
      style={{
        fontSize: "var(--text-xs)",
        lineHeight: "var(--leading-body)",
        color: "var(--fg-3)",
      }}
    >
      {waiting.text}
    </div>
  );
}

/**
 * `working` while the author's turn runs, and beside it, on a crewmate's
 * card the captain replied under, what the crewmate did last since the
 * captain's line - the description of the command it runs - so a long piece of work
 * shows itself as it goes (INF-990 friction 3).
 */
function WorkingRow({ entrance, doing }: { entrance: boolean; doing?: string | undefined }) {
  const [reveal] = useState(entrance);
  return (
    <div
      data-thread-working=""
      aria-busy="true"
      data-stage-reveal={reveal ? "entrance" : "static"}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 8,
        minWidth: 0,
        fontSize: "var(--text-xs)",
        color: "var(--fg-3)",
      }}
    >
      <span style={{ fontFamily: "var(--font-mono)", flex: "none" }}>{THREAD_WORKING}</span>
      {doing && (
        <span
          data-thread-doing=""
          title={doing}
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            lineHeight: "var(--leading-body)",
          }}
        >
          {doing}
        </span>
      )}
    </div>
  );
}

/**
 * One line of the thread, from any author: its words, with every other
 * task's key in them a link to that task (FI3-1271).
 */
function Message({ message, own }: { message: CardMessage; own: string | undefined }) {
  const reveal = useMessageEntrance(message.id, message.at);
  const who = WHO[message.who];
  const host = message.who === "host";
  return (
    <div
      data-thread-message={message.who}
      data-stage-reveal={reveal ? "entrance" : "static"}
      style={{
        display: "grid",
        gridTemplateColumns: "34px minmax(0,1fr)",
        gap: 8,
        fontSize: host ? "var(--text-xs)" : "var(--text-sm)",
        lineHeight: "var(--leading-body)",
        color: host ? "var(--fg-3)" : "var(--fg-1)",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: host ? "var(--fg-3)" : who.color,
          paddingTop: 1,
        }}
      >
        {who.label}
      </span>
      <div
        style={{
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          gap: 3,
        }}
      >
        {/* Line breaks kept: a multi-line reply reads the way it was typed. */}
        <span style={{ alignSelf: "stretch", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
          <KeyedText text={message.text} own={own} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              marginLeft: 6,
              whiteSpace: "nowrap",
            }}
          >
            {timeOf(message.at)}
          </span>
        </span>
        {message.contributor || message.clarification ? (
          <span
            data-thread-contributor=""
            style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}
          >
            {contributorWords({
              host,
              ...(message.contributor ? { label: message.contributor.label } : {}),
              ...(message.clarification ? { clarification: true } : {}),
            })}
          </span>
        ) : null}
        {message.who === "host" && <RevisionLinks message={message} />}
        {message.who === "captain" && message.answers?.length ? (
          <ReplySettings answers={message.answers} at={message.at} />
        ) : null}
      </div>
    </div>
  );
}

/** One readable line of a reply's settings: a key, its value, and for a question whether he changed it. */
type SettingsRow = { key: string; value: string; state?: "changed" | "as proposed" };

/**
 * A reply's settings as readable rows: a staged JSON snapshot opens into
 * one row per leaf, keyed by its dotted path (and its name, beside other
 * answers); a question reads as the label he picked, or its value, then
 * the words written under its Something else row, in quotes.
 */
export function settingsRows(answers: readonly CardAnswer[]): SettingsRow[] {
  const rows: SettingsRow[] = [];
  for (const answer of answers) {
    if (!answer.json) {
      const picked = answer.values.map((value, index) => answer.labels?.[index] || value);
      if (answer.written !== undefined) picked.push(`“${answer.written}”`);
      rows.push({
        key: answer.name,
        value: picked.length === 0 ? "no answer" : picked.join(", "),
        state: answer.changed ? "changed" : "as proposed",
      });
      continue;
    }
    const raw = answer.values[0] ?? "";
    let snapshot: unknown = raw;
    try {
      snapshot = JSON.parse(raw);
    } catch {
      // Not JSON after all: its text is the value.
    }
    const before = rows.length;
    leafRows(snapshot, answers.length > 1 ? answer.name : "", rows);
    if (rows.length === before) {
      rows.push({ key: answer.name, value: typeof snapshot === "string" ? snapshot : raw });
    }
  }
  return rows;
}

function leafRows(value: unknown, path: string, rows: SettingsRow[]): void {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, inner] of Object.entries(value)) {
      leafRows(inner, path ? `${path}.${key}` : key, rows);
    }
    return;
  }
  if (!path) return;
  rows.push({ key: path, value: typeof value === "string" ? value : JSON.stringify(value) });
}

/**
 * The settings a captain's reply carried, kept apart from his words
 * (FI3-617, treatment A): one quiet mono line under them, collapsed by
 * default, that opens a boxed panel of readable rows. The author still
 * reads words and settings together; this only stops the thread showing
 * them as if he typed them.
 */
function ReplySettings({ answers, at }: { answers: readonly CardAnswer[]; at: number }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const rows = useMemo(() => settingsRows(answers), [answers]);
  useEffect(() => {
    // Opened at the foot of the list, the panel scrolls into view as far as
    // it can without scrolling its own line away.
    const toggle = toggleRef.current;
    const panel = panelRef.current;
    const list = toggle?.closest("[data-thread-messages]");
    if (!open || !toggle || !panel || !list) return;
    const box = list.getBoundingClientRect();
    const over = panel.getBoundingClientRect().bottom - box.bottom;
    const room = toggle.getBoundingClientRect().top - box.top - 8;
    if (over > 0) list.scrollTop += Math.min(over, Math.max(0, room));
  }, [open]);
  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        data-thread-settings-toggle=""
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((was) => !was)}
      >
        <span data-thread-settings-caret="" aria-hidden="true" />
        {settingsCountWords(rows.length)}
      </button>
      {open && (
        <section
          ref={panelRef}
          id={panelId}
          aria-label={`Settings sent with your reply at ${timeOf(at)}`}
          data-thread-settings=""
        >
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region is reached by keyboard. */}
          <div data-thread-settings-scroll="" tabIndex={0}>
            <dl data-thread-settings-rows="">
              {rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are fixed for the message.
                <SettingsRowView key={index} row={row} />
              ))}
            </dl>
          </div>
          <div data-thread-settings-note="">
            Sent to the author as context. A reply never approves building.
          </div>
        </section>
      )}
    </>
  );
}

function SettingsRowView({ row }: { row: SettingsRow }) {
  return (
    <>
      <dt>{row.key}</dt>
      <dd>
        {row.value}
        {row.state && <span data-thread-settings-state=""> · {row.state}</span>}
      </dd>
    </>
  );
}

/**
 * The in-place rung's head control (`card` · `thread · N`). It exists
 * because the ladder must end somewhere: it needs a stage under 720px,
 * which the app's own 960px window minimum puts out of reach.
 */
export function ThreadSegments({
  showing,
  count,
  onShow,
}: {
  showing: "card" | "thread";
  count: number;
  onShow: (which: "card" | "thread") => void;
}) {
  const options: { key: "card" | "thread"; label: string }[] = [
    { key: "card", label: THREAD_CARD },
    { key: "thread", label: threadCountWords(count) },
  ];
  return (
    <div
      data-thread-segments={showing}
      style={{
        display: "inline-flex",
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-s)",
        overflow: "hidden",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        flexShrink: 0,
      }}
    >
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onShow(option.key)}
          style={{
            padding: "4px 10px",
            border: "none",
            cursor: "pointer",
            font: "inherit",
            background: showing === option.key ? "var(--accent-dim)" : "transparent",
            color: showing === option.key ? "var(--fg-1)" : "var(--fg-3)",
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
