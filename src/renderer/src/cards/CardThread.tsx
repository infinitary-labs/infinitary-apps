import { fileSizeWords } from "@shared/attachments";
import { markNumbers, placeKey, queuedNotesWords, sendNotesLabel } from "@shared/cardNotes";
import {
  CARD_CHAT_LABEL,
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
import { formatTime } from "@shared/i18n/format";
import * as m from "@shared/i18n/messages.generated";
import { hasNotTypingKeys } from "@shared/keyboard";
import { CAPTAIN_COMMAND } from "@shared/through";
import {
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ComposerNoticeView } from "../app/ComposerNotice";
import { useDictationField } from "../app/dictationField";
import { useCommandKeys } from "../app/keyHints";
import { pressInputOf } from "../app/pressInput";
import { useShellStore } from "../app/store";
import { VoiceNotice } from "../app/VoiceNotice";
import { replyDestination } from "../attachments/destinations";
import { useFileIntake } from "../attachments/useFileIntake";
import { prefersReducedMotion } from "../character/reducedMotion";
import { Button, focusWithRing, IconButton, type ImageAttachment, MicroLabel } from "../design";
import { ComposerCount, ComposerCountAnnouncer, ComposerField } from "../design/core/ComposerField";
import { isComposing } from "../design/core/composing";
import {
  AddFilesButton,
  FilesStatus,
  PendingFileChips,
  useFileDrop,
} from "../design/core/FileControls";
import { installedBindings } from "../design/core/installedKeys";
import { DictationMark, PastedTextChip } from "../design/voice/VoiceInput";
import { AnnotationControls, NO_NOTES, NoteAnchor, QueuedNotes } from "./AnnotationControls";
import { FOLLOW_SLACK_PX } from "./CrewmateView";
import type { CollectAnswers } from "./PrototypeBody";
import { RevisionLinks } from "./RevisionNavigation";
import { useMessageEntrance, useWorkingEntrance } from "./SurfaceReveal";
import { KeyedText } from "./TaskKey";
import {
  contributorWords,
  messageCountWords,
  settingsCountWords,
  THREAD_WHO_LABELS,
  threadCountWords,
  threadCueLabel,
  threadJumpLabel,
  threadJumpWords,
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

const WHO: Record<CardMessageWho, { label: string; color: string }> = {
  captain: {
    get label() {
      return THREAD_WHO_LABELS.captain;
    },
    color: "var(--captain)",
  },
  crewmate: {
    get label() {
      return THREAD_WHO_LABELS.crewmate;
    },
    color: "var(--accent)",
  },
  firstmate: {
    get label() {
      return THREAD_WHO_LABELS.firstmate;
    },
    color: "var(--accent)",
  },
  // The host is not a party to the conversation: no accent, the whole row quiet.
  host: {
    get label() {
      return THREAD_WHO_LABELS.host;
    },
    color: "var(--fg-3)",
  },
};

function timeOf(at: number): string {
  return formatTime(at, { hour: "2-digit", minute: "2-digit" });
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
 * to send. With nothing to send it puts the caret in the field. While notes
 * wait it reads Send 2 notes as the primary button (INF-3786), so the send is
 * named; the notes and the field's words still leave as one reply.
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
  const notes = useShellStore((s) => s.replyNotes[cardId] ?? NO_NOTES);
  const something = length > 0 || images.length > 0 || pastes.length > 0 || notes.length > 0;
  const lit = something && !over;
  const naming = notes.length > 0;
  return (
    <Button
      variant={naming ? "primary" : "ghost"}
      size={naming ? "sm" : "md"}
      data-card-chat={cardId}
      data-lit={lit ? "" : undefined}
      // Named, it needs no icon or key: the thread's column keeps room for the field,
      // whose Enter still sends.
      icon={naming ? undefined : chatIcon}
      keys={naming ? undefined : CHAT_KEY}
      disabled={sending}
      // Past a reply's limit nothing leaves: Chat is off, as Enter is.
      off={over}
      style={lit && !naming ? { background: "var(--accent-dim)", color: "var(--fg-1)" } : undefined}
      onClick={(event) => {
        // The caret goes to the field either way, as a send by Enter leaves it.
        if (focusField) focusField();
        else fieldIn(event.currentTarget, cardId)?.focus();
        if (lit) void sendReply(cardId, collect);
      }}
    >
      {naming ? sendNotesLabel(notes.length) : CARD_CHAT_LABEL}
    </Button>
  );
}

/**
 * The thread's collapse: a panel whose chevron points left, into the card,
 * because the arrow says where the thread goes (Lucide's panel-right-open
 * glyph, whose name is the reverse of its meaning here).
 */
export const collapseIcon = (
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
export const openIcon = (
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
  placeholder = m.cardReplyHint(),
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
  // The dictation key writes here while the field has focus (docs/composer.md, "Voice").
  const dictation = useDictationField(
    field,
    () => useShellStore.getState().replyDrafts[cardId] ?? "",
    (text) => useShellStore.getState().setReplyDraft(cardId, text),
  );
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
  const notes = useShellStore((s) => s.replyNotes[cardId] ?? NO_NOTES);
  const canSend =
    !sending &&
    !over &&
    !preparing &&
    (length > 0 || images.length > 0 || pastes.length > 0 || notes.length > 0);
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
      {!inThread && <QueuedNotes cardId={cardId} />}
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
                label={
                  image.name
                    ? m.cardThreadRemoveNamed({ name: image.name })
                    : m.cardThreadRemovePicture()
                }
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
      <div
        style={
          {
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "flex-end",
            // The field's last line, where the controls at both ends centre:
            // `--reply-height` plus the field's own 2px above and below it.
            "--reply-line": "calc(var(--reply-height) + 4px)",
          } as CSSProperties
        }
      >
        <AnnotationControls cardId={cardId} collect={collect} />
        <div
          className="inf-reply-pill"
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
                insetInlineEnd: "var(--space-3)",
                fontFamily: "var(--font-ui)",
                fontSize: "var(--text-sm)",
                lineHeight: "var(--leading-body)",
                color: "var(--fg-3)",
                pointerEvents: "none",
              }}
            >
              <span
                style={{ fontFamily: "var(--font-mono)", direction: "ltr", unicodeBidi: "isolate" }}
              >
                {replyKeys.keys}
              </span>
            </span>
          )}
          <ComposerField
            fieldRef={field}
            aria-label={m.cardThreadReplyField()}
            aria-keyshortcuts={replyKeys["aria-keyshortcuts"]}
            messageField="reply"
            placeholder={placeholder}
            value={draft}
            // Held, not disabled, while the reply sends: a disabled field
            // drops the focus to the page.
            readOnly={sending}
            recording={dictation.recording}
            lineCap={REPLY_LINE_CAP}
            canSend={canSend}
            onSend={send}
            onChange={(event) => setReplyDraft(cardId, event.target.value)}
            onPasteText={(text) => attachPaste(cardId, text)}
            onAttach={(items) => attachReplyImages(cardId, items)}
            onPictureTooBig={() => showReplyNotice(cardId, "picture-too-big")}
            onKeyDown={(event) => {
              // The dictation key goes on to record here, and Escape while
              // this field records abandons it (docs/composer.md, "Voice").
              if (dictation.keyDown(event)) return;
              // Only the opted-in layer lends an unused Escape to the window's
              // existing chain. Every other key stays the field's own.
              if (
                event.key === "Escape" &&
                !event.defaultPrevented &&
                !isComposing(event) &&
                hasNotTypingKeys(installedBindings())
              )
                return;
              event.stopPropagation();
            }}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            style={{
              width: "100%",
              fontSize: "var(--text-sm)",
              lineHeight: "var(--leading-body)",
              // Its draft stays on screen while it records, dimmed as the main input's is.
              opacity: dictation.recording ? 0.55 : 1,
              transition: "opacity var(--dur-med) var(--ease-out)",
            }}
          />
        </div>
        {/* Centred on the field's last line, at every height. */}
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
            height: "var(--reply-line)",
          }}
        >
          {files && <AddFilesButton intake={files} size={28} label={m.cardThreadAddFiles()} />}
          {inThread && (
            <ChatButton
              cardId={cardId}
              collect={collect}
              focusField={() => field.current?.focus()}
            />
          )}
        </span>
      </div>
      <DictationMark
        recording={dictation.recording}
        transcribing={dictation.transcribing}
        onAbandon={() => {
          useShellStore.getState().abandonRecording();
          field.current?.focus();
        }}
        onAccept={() => useShellStore.getState().acceptRecording()}
      />
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
      <VoiceNotice width="100%" field={dictation.field} />
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
        borderInlineStart: "1px solid var(--line-2)",
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
        <MicroLabel>{m.cardThreadLabel()}</MicroLabel>
        {onCollapse && (
          <IconButton
            label={m.cardThreadCollapse()}
            {...keys}
            size={28}
            data-thread-collapse=""
            onClick={(event) => onCollapse(byKey(event))}
            style={{ marginInlineStart: "auto" }}
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
  const notes = useShellStore((s) => s.replyNotes[cardId] ?? NO_NOTES);
  const waiting = useThreadWait(card);
  const doing = useReplyDoing(card, messages, working === true);
  const keys = useCommandKeys("cards.thread");
  if (!messages.length && notes.length)
    return (
      <Button
        variant="ghost"
        keys={keys.keys}
        data-key-command={keys["data-key-command"]}
        onClick={(event) => onOpen(byKey(event))}
      >
        {queuedNotesWords(notes.length)}
      </Button>
    );
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
      <span data-thread-cue-state="">{working ? m.cardThreadWorking() : count}</span>
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
  const notes = useShellStore((s) => (card.id ? (s.replyNotes[card.id] ?? NO_NOTES) : NO_NOTES));
  const doing = useReplyDoing(card, messages, working === true);
  return (
    <MessageList
      messages={messages}
      pending={card.id ? <QueuedNotes cardId={card.id} /> : undefined}
      pendingCount={notes.length}
      working={working}
      doing={doing}
      waiting={waiting}
      ended={card.ended && card.id ? <EndedLine card={{ ...card, id: card.id }} /> : undefined}
      endedAt={card.ended?.at}
    />
  );
}

/** What a thread reads of its card; an ended card's line needs its id and offer too. */
type ThreadCard = Pick<Card, "author" | "awaiting" | "taskId" | "sentBackAt"> &
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
              marginInlineStart: 6,
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
          onClick={(event) =>
            void pressNote(card.id, card, pressInputOf(event.nativeEvent, event.currentTarget))
          }
        >
          {ENDED_CLOSE_CARD_LABEL}
        </Button>
      </div>
    </div>
  );
}

/** The list's own top padding, which a message brought to the top keeps above it. */
const LIST_PAD_TOP = 4;

/** The messages that came while the reader read above: the first one's id, and how many. */
type Unread = { from: number; count: number };

/**
 * The messages, oldest at the top (docs/card-threads.md, "Keeping your
 * place"). The list follows the thread only while the reader is at its
 * foot: a new message, the working row and the waiting line keep the foot
 * in view, except that new messages taller than the list open at their
 * first line. Once the reader scrolls up, nothing but the reader moves it,
 * and the jump down floats over its foot, counting what arrived below.
 * The captain's own reply always takes the list to its foot.
 */
export function MessageList({
  messages,
  pending,
  pendingCount = 0,
  working = false,
  doing,
  waiting,
  ended,
  endedAt,
}: {
  messages: readonly CardMessage[];
  pending?: ReactNode;
  pendingCount?: number;
  working?: boolean;
  /** What the crewmate is doing on the reply, beside `working` (`useReplyDoing`). */
  doing?: string | undefined;
  /** The waiting line; `working` wins while a turn runs. */
  waiting?: ThreadWaitLine;
  /** An ended card's app line, in place of any wait (INF-3071). */
  ended?: ReactNode;
  /**
   * When the card ended: its line sits among the messages in time, so a
   * line written after it, such as the one naming the work the captain's
   * reply started, reads below it.
   */
  endedAt?: number | undefined;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const count = messages.length;
  const workingEntrance = useWorkingEntrance();
  const waitingText = working ? undefined : waiting?.text;
  const tail = working ? `working ${doing ?? ""}` : ended ? "ended" : waitingText; // i18n-exempt: not shown (a scroll trigger key)
  const split =
    ended && endedAt !== undefined ? messages.findIndex((message) => message.at > endedAt) : -1;
  const earlier = split < 0 ? messages : messages.slice(0, split);
  const later = split < 0 ? [] : messages.slice(split);
  // Whether the reader is at the foot, as the list last measured it: a
  // message or a tail that grows the list leaves it true until the list
  // follows, so only the reader's own scroll ends following.
  const atFoot = useRef(true);
  // Where the list stood when it last measured: a scroll that moved it up
  // from there is the reader's own (`scrolled`).
  const measuredTop = useRef(0);
  const [above, setAbove] = useState(false);
  const [unread, setUnread] = useState<Unread | null>(null);
  // How many messages the list has placed; it opens at its foot.
  const placed = useRef(count);
  const measure = useCallback(() => {
    const node = listRef.current;
    if (!node) return;
    const foot = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
    atFoot.current = foot;
    measuredTop.current = node.scrollTop;
    setAbove(!foot);
    if (foot) setUnread(null);
  }, []);
  // A scroll that did not move the list up never ends following. The list's
  // own follow fires one, which can arrive after the column settled around
  // the list - the card's choices moving under the reply field as a first
  // reply opens the thread - and before the resize observer follows again:
  // read as it stands, it would put a reader who never scrolled above the
  // foot. A following list goes back to its foot instead; a pixel of
  // rounding is not a scroll.
  const scrolled = useCallback(() => {
    const node = listRef.current;
    if (!node) return;
    if (atFoot.current && node.scrollTop >= measuredTop.current - 1)
      node.scrollTop = node.scrollHeight;
    measure();
  }, [measure]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a message or the tail is the trigger; `messages` is read as it stands then.
  useLayoutEffect(() => {
    const node = listRef.current;
    const from = placed.current;
    placed.current = count;
    if (!node || (count === 0 && tail === undefined && pendingCount === 0)) return;
    const arrived = messages.slice(from);
    if (arrived.some((message) => message.who === "captain")) {
      // The captain's own reply: the foot, to watch the author take it up.
      node.scrollTop = node.scrollHeight;
    } else if (!atFoot.current) {
      // Reading above: the list stays, and the jump down counts the arrivals.
      const [first] = arrived;
      if (first) {
        setUnread((was) => ({
          from: was?.from ?? first.id,
          count: (was?.count ?? 0) + arrived.length,
        }));
      }
      return;
    } else {
      // At the foot it follows, but new messages taller than the list open
      // at their first line, so they read down from their start.
      const start = arrived[0] ? topOf(node, arrived[0].id) : undefined;
      node.scrollTop =
        start !== undefined && node.scrollHeight - start > node.clientHeight
          ? start
          : node.scrollHeight;
    }
    measure();
  }, [count, tail, pendingCount, measure]);
  // The list changing size, as the card or the reply field grows, keeps a
  // following foot in view and measures again, so a jump down leaves once
  // the whole thread fits.
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (atFoot.current) node.scrollTop = node.scrollHeight;
      measure();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);
  // The jump down: to the first message that came while the reader read
  // above, or to the foot.
  const jump = (event: MouseEvent<HTMLButtonElement>) => {
    const node = listRef.current;
    if (!node) return;
    const top = (unread && topOf(node, unread.from)) ?? node.scrollHeight;
    setUnread(null);
    node.scrollTo({ top, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    // A key that pressed it leaves the keyboard in the list it moved, where
    // the reading keys scroll on, never on a control about to leave; a
    // pointer press draws no ring.
    if (byKey(event) && document.activeElement === event.currentTarget)
      focusWithRing(node, { preventScroll: true });
  };
  const jumpKeys = useCommandKeys("cards.thread-new");
  return (
    <div
      style={{
        position: "relative",
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        ref={listRef}
        data-thread-messages=""
        tabIndex={-1}
        onScroll={scrolled}
        style={{
          // The messages' offsets are measured from the list (`topOf`).
          position: "relative",
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: `${LIST_PAD_TOP}px 16px 10px`,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          outline: "none",
        }}
      >
        {earlier.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {ended}
        {later.map((message) => (
          <Message key={message.id} message={message} />
        ))}
        {pending}
        {working ? (
          <WorkingRow entrance={workingEntrance} doing={doing} />
        ) : (
          !ended &&
          waiting && <WaitingRow key={waiting.text} waiting={waiting} entrance={workingEntrance} />
        )}
      </div>
      {above && (
        <button
          type="button"
          data-thread-jump={unread ? "unread" : "foot"}
          aria-label={threadJumpLabel(unread?.count ?? 0)}
          aria-keyshortcuts={jumpKeys["aria-keyshortcuts"]}
          data-key-command={jumpKeys["data-key-command"]}
          onClick={jump}
        >
          {threadJumpWords(unread?.count ?? 0)}
          {jumpKeys.keys && <span data-thread-jump-key="">{jumpKeys.keys}</span>}
        </button>
      )}
    </div>
  );
}

/**
 * Where a message's top sits in the list's scroll, its padding kept above
 * it; none for one not drawn. Its layout offset, never its drawn box, which
 * the entrance animation still moves and scales as it arrives.
 */
function topOf(list: HTMLElement, id: number): number | undefined {
  const line = list.querySelector<HTMLElement>(`[data-thread-message-id="${id}"]`);
  if (!line) return undefined;
  return Math.max(0, line.offsetTop - LIST_PAD_TOP);
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
      <span style={{ fontFamily: "var(--font-mono)", flex: "none" }}>{m.cardThreadWorking()}</span>
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
 * One line of the thread, from any author: its words, with every recorded
 * task's key in them a link to that task, the card's own task's included
 * (FI3-1271).
 */
function Message({ message }: { message: CardMessage }) {
  const reveal = useMessageEntrance(message.id, message.at);
  const who = WHO[message.who];
  const host = message.who === "host";
  return (
    <div
      data-thread-message={message.who}
      data-thread-message-id={message.id}
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
          <KeyedText text={message.text} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              marginInlineStart: 6,
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
        {message.who === "captain" && message.through ? (
          <span data-thread-through="" style={{ fontSize: "var(--text-xs)", color: "var(--fg-3)" }}>
            {m.cardThreadFromCommand({ command: CAPTAIN_COMMAND })}
          </span>
        ) : null}
        {message.notes?.map((note, at) => (
          <div
            key={JSON.stringify([note.key, note.start, note.span, placeKey(note.place)])}
            className="inf-sent-note"
          >
            <NoteAnchor
              cardId={message.cardId}
              note={note}
              mark={markNumbers(message.notes ?? [])[at]}
            />
            <span>{note.comment || m.cardThreadNoComment()}</span>
          </div>
        ))}
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
        value: picked.length === 0 ? m.cardThreadNoAnswer() : picked.join(", "),
        state: answer.changed ? "changed" : "as proposed", // i18n-exempt: not shown (a state, worded by SETTING_STATE_WORDS)
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
          aria-label={m.cardThreadSettingsSent({ time: timeOf(at) })}
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
          <div data-thread-settings-note="">{m.cardThreadSettingsNote()}</div>
        </section>
      )}
    </>
  );
}

/** A settings row's state, worded when shown. */
const SETTING_STATE_WORDS: Record<NonNullable<SettingsRow["state"]>, () => string> = {
  changed: m.cardThreadSettingChanged,
  "as proposed": m.cardThreadSettingAsProposed,
};

function SettingsRowView({ row }: { row: SettingsRow }) {
  return (
    <>
      <dt>{row.key}</dt>
      <dd>
        {row.value}
        {row.state && (
          <span data-thread-settings-state=""> · {SETTING_STATE_WORDS[row.state]()}</span>
        )}
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
    { key: "card", label: m.cardThreadCard() },
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
