import { NOTE_DONE_ACTION_ID } from "@shared/cardLeave";
import {
  CARD_FILES_FIRST,
  type Card,
  type CardAction,
  type CardActionSource,
  type CardWidth,
  cardMetaWords,
  cardTakesReplies,
  firstmateOwnCard,
  isPreviewBody,
} from "@shared/cards";
import { CARD_CHOICE_COMMANDS } from "@shared/keyboard";
import type { FrameAnswers } from "@shared/plugins/bridge";
import type { Theme } from "@shared/preferences";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AskedLine } from "../../cards/AskedLine";
import { afterMergeStrip } from "../../cards/afterMergeStrip";
import { answersLine } from "../../cards/answersLine";
import { bridgeActionIds } from "../../cards/bridgeActions";
import { CardAttachment } from "../../cards/CardAttachment";
import { ChatButton, LiveMessageList, ThreadSegments } from "../../cards/CardThread";
import { useCardReadingPlace } from "../../cards/cardReadingPlace";
import { useCardTask } from "../../cards/cardTask";
import { choiceOrder, footerGroups, footerVariant } from "../../cards/footerGroups";
import { CardFactsFrame, type CollectAnswers, HtmlCardBody } from "../../cards/PrototypeBody";
import { revisedLine } from "../../cards/revisedLine";
import { useBodyEntrance } from "../../cards/SurfaceReveal";
import { CardTaskKey, KeyedText } from "../../cards/TaskKey";
import { Button, ResponseCard } from "../../design";
import { RiskChart, riskBodyInset, riskChartBox } from "../../design/cards/RiskChart";
import { RISK_CHART_GAP } from "../../design/cards/riskRadar";
import { useConnectionNoticeCovers } from "../../devices/RemoteControl";
import { changesOff, changesOffWords, doneThereWords, isView } from "../../devices/viewWords";
import type { CardKindContribution } from "../../plugins/contributions";
import type { CardMount } from "../cardActions";
import { mainMessageRefusal } from "../composer";
import { useCommandKeys } from "../keyHints";
import { useShellStore } from "../store";
import { factStripOf } from "./entryView";

/**
 * The footer's queue group (inline decisions, contract 4.22): how many of
 * the questions the body asks have an answer, and how many of those answers
 * differ from what the card proposed. Picks wait here until a footer button
 * sends them; nothing in the body sends on its own. Words written under a
 * question's Something else row are its answer, so they count as a pick.
 */
function pickedCount(answers: FrameAnswers | undefined): number {
  return (
    answers?.answers.filter((answer) => answer.values.length > 0 || answer.written !== undefined)
      .length ?? 0
  );
}

function footerAnswers(answers: FrameAnswers, preview: boolean): string {
  const answered = preview ? answers.answered : pickedCount(answers);
  return answersLine({ answered, of: answers.of, changed: answers.changed }, preview);
}

export type StackedCardProps = {
  /** Where its body's form is read (`HtmlCardBody`'s `collectRef`). */
  collectRef: React.MutableRefObject<CollectAnswers | null>;
  /** Its one collect handle, which its footer and its reply row share (`EntrySurface`). */
  collect: CollectAnswers;
  card: Card;
  chrome: CardKindContribution["chrome"];
  theme: Theme;
  /** The size the card is shown at, told to its body's document. */
  size: CardWidth;
  /** Prepared before it is shown: only its body, drawn at its final width. */
  bare?: boolean;
  /**
   * The captain can act on it: shown and on screen. A prepared or leaving
   * card raises nothing, and the readings its body posts wait until it is
   * shown before they become its saved draft.
   */
  active?: boolean;
  /**
   * The card's one field, drawn above its choices with Chat at the right
   * edge of their row (INF-924); none while its thread is open beside it.
   */
  reply?: React.ReactNode;
  /** The in-place rung: the body becomes the thread behind a segmented control. */
  inPlaceThread?: boolean;
  threadWorking?: boolean;
  /**
   * While its thread is open beside it, the place under the thread's field
   * where its choices go instead of the card's own foot (the captain's
   * INF-1919 note); its fact strip stays at the card's foot.
   */
  choicesIn?: HTMLElement | null;
  /** Settles with the request's outcome: a body's own `inf.action` rejects with its refusal. */
  onAction: (
    actionId: string,
    source?: CardActionSource,
    value?: unknown,
    collect?: CollectAnswers,
    mounted?: CardMount,
  ) => Promise<void>;
  onPicture?: React.ComponentProps<typeof HtmlCardBody>["onPicture"];
  onDrawn?: () => void;
  /** Its prepared body drew held, or its page was refused or stopped (`HtmlCardBody`). */
  onHeld?: (failed: boolean) => void;
  onBorn?: () => void;
  onInteraction?: () => void;
  style?: CSSProperties;
};

/** A persisted card in its derived chrome, body in the sandboxed frame. */
export function StackedCard({
  card,
  chrome,
  theme,
  size,
  bare = false,
  active = true,
  reply,
  inPlaceThread = false,
  threadWorking = false,
  choicesIn = null,
  onAction,
  onPicture,
  collectRef,
  collect,
  onDrawn,
  onHeld,
  onBorn,
  onInteraction,
  style,
}: StackedCardProps) {
  // Only the shown copy keeps the reading place; a prepared one is bare.
  const bodyRef = useCardReadingPlace(card.id, active);
  const pending = useShellStore((s) => s.pendingCardActions[card.id]);
  const error = useShellStore((s) => s.cardActionErrors[card.id]);
  // On a Mac controlling another, its buttons are off while that Mac is
  // out of reach (docs/view.md): still Tab stops, whose note says until when.
  const offWords = useShellStore((s) =>
    changesOff(s.thisMac) && isView(s.thisMac) ? changesOffWords(s.thisMac) : null,
  );
  // A button done only on that Mac - one that opens one of its Settings
  // sections, or hands the captain a task's browser - says so on rest,
  // before the click; the click sends nothing (`actOnCard`).
  const thisMac = useShellStore((s) => s.thisMac);
  const thereWords = (action: CardAction) =>
    isView(thisMac) ? doneThereWords(thisMac, action) : null;
  const noticeCovers = useConnectionNoticeCovers(offWords);
  const choiceKeys = [
    useCommandKeys(CARD_CHOICE_COMMANDS[0]),
    useCommandKeys(CARD_CHOICE_COMMANDS[1]),
    useCommandKeys(CARD_CHOICE_COMMANDS[2]),
    useCommandKeys(CARD_CHOICE_COMMANDS[3]),
  ];
  // ⌘1 is the default wherever it sits; the rest count leftward from the
  // right edge (docs/keyboard.md).
  const choiceIndex = useMemo(
    () => new Map(choiceOrder(card.actions).map((action, at) => [action.id, at])),
    [card.actions],
  );
  const messages = useShellStore((s) => s.threads[card.id]) ?? [];
  const answers = useShellStore((s) => s.cardAnswers[card.id]);
  // A file or picture goes only as a reply: the choices wait until it has.
  const filesFirst = useShellStore(
    (s) =>
      reply !== undefined &&
      ((s.replyImages[card.id]?.length ?? 0) > 0 || (s.replyPastes[card.id]?.length ?? 0) > 0),
  );
  const setCardAnswers = useShellStore((s) => s.setCardAnswers);
  const [showing, setShowing] = useState<"card" | "thread">("card");
  const bodyEntrance = useBodyEntrance();
  const admitted = useRef(active);
  admitted.current = active;
  // The latest reading a not-yet-shown body posted: its saved draft once shown.
  const heldAnswers = useRef<FrameAnswers | null>(null);
  useEffect(() => {
    const reading = heldAnswers.current;
    if (!active || !reading) return;
    heldAnswers.current = null;
    setCardAnswers(card.id, reading);
  }, [active, card.id, setCardAnswers]);
  // Initial thread history decides the width the body is born at.
  const threadLoaded = useShellStore((s) => s.threadsLoaded[card.id] === true);
  const bodyPending = cardTakesReplies(card) && !threadLoaded;
  const showThread = inPlaceThread && showing === "thread";
  useLayoutEffect(() => {
    if (!bodyPending && showThread) {
      bodyEntrance.onDrawn();
      onDrawn?.();
    }
  }, [bodyPending, showThread, bodyEntrance.onDrawn, onDrawn]);
  // A settle card's fact strip stands beside its buttons, in view however
  // long the body is, and the body shows the rest (`factStripOf`); so
  // does the strip on the note of a task that merges on its own. The stage's
  // draw key names the same body (`drawnBody`).
  const split = useMemo(() => factStripOf(card), [card]);
  const body = split?.body ?? card.body;
  // A merge card's risk chart is chrome at its top right (docs/card-authoring.md
  // "The risk chart"); the body keeps clear of the box it holds.
  const asideRef = useRef<HTMLDivElement>(null);
  const risk = card.risk;
  const marks = split
    ? card.changes?.marks?.map((mark) => (mark > split.at ? mark - split.facts.length : mark))
    : card.changes?.marks;
  const asking = answers !== undefined && answers.of > 0;
  // A closing choice waits until every question the body requires has an
  // answer (the captain's Q2 A); a non-closing one sends what there is.
  const unanswered = asking && answers.answered < answers.of;
  const closeRef = useRef<HTMLButtonElement>(null);
  // The task the card is about leads its head as the card's door to the
  // task's record (INF-358); a card about no task draws no key. A first mate
  // card is its own (INF-2714): its head says first mate, and every task key
  // in its words is a link, the one its buttons act on included.
  const firstmate = firstmateOwnCard(card);
  const found = useCardTask(card);
  const task = firstmate ? null : found;
  const ownTaskId = firstmate ? undefined : card.taskId;
  const groups = footerGroups(card.actions);
  // Every live note's one button sits where a decision's default does, on ⌘1
  // (INF-2794); a core from before it still sends only an answer's Done.
  const noteDone = !bare && card.actions.length === 0 ? card.noteDone : undefined;
  const pressNote = useShellStore((s) => s.pressNote);
  const footer =
    card.actions.length > 0 || reply !== undefined || noteDone ? (
      <>
        {asking && (
          <span
            data-card-answers=""
            aria-live="polite"
            style={{
              alignSelf: "center",
              // The note that a file goes first follows it, at the left.
              marginRight: filesFirst ? undefined : "auto",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
              whiteSpace: "nowrap",
            }}
          >
            {footerAnswers(answers, isPreviewBody(card.body))}
          </span>
        )}
        {filesFirst && card.actions.length > 0 && (
          <span
            data-card-files-first=""
            role="status"
            style={{
              alignSelf: "center",
              marginRight: "auto",
              fontSize: "var(--text-xs)",
              color: "var(--fg-3)",
            }}
          >
            {CARD_FILES_FIRST}
          </span>
        )}
        {(groups.length > 0 ? groups : [{ key: "choices", actions: [] }]).map(
          (group, index, all) => (
            // Each group stays on one row: a narrow card moves the choices
            // down together, never the default alone (design skill
            // ResponseCard footer rule). Under an open thread's field the
            // column is too narrow for that, so a group wraps there, the
            // default staying last at the trailing edge, and no label breaks.
            <div
              key={group.key}
              style={{
                display: "flex",
                gap: "var(--space-2)",
                flexWrap: choicesIn ? "wrap" : "nowrap",
                justifyContent: "flex-end",
                minWidth: 0,
                maxWidth: "100%",
              }}
            >
              {group.actions.map((action) => {
                const at = choiceIndex.get(action.id);
                const choiceKey = at === undefined ? undefined : choiceKeys[at];
                const answering =
                  action.effect?.kind === "host" &&
                  action.effect.op === "confirm-required-action" &&
                  card.awaiting === "answer";
                const actionOff = answering
                  ? "Your first mate is answering on this card"
                  : offWords;
                return (
                  <Button
                    key={action.id}
                    // Where Go to the card's buttons lands (docs/keyboard.md).
                    data-card-action-default={action.default ? "" : undefined}
                    // `cards.decline` presses the decision's way to say no (INF-3108).
                    data-card-declines={action.declines ? "" : undefined}
                    data-card-choice={at !== undefined && at < choiceKeys.length ? at : undefined}
                    aria-keyshortcuts={choiceKey?.keys ? choiceKey["aria-keyshortcuts"] : undefined}
                    // The key sits inside the button at the size its label gives it.
                    keys={choiceKey?.keys}
                    variant={footerVariant(action)}
                    style={{
                      minWidth: choicesIn ? undefined : 0,
                      maxWidth: "100%",
                      flexShrink: 1,
                      whiteSpace: "normal",
                      overflowWrap: choicesIn ? "break-word" : "anywhere",
                      ...(unanswered && action.default
                        ? {
                            background: "var(--bg-2)",
                            color: "var(--fg-3)",
                            borderColor: "var(--line-1)",
                          }
                        : {}),
                    }}
                    pending={pending?.actionId === action.id}
                    disabled={Boolean(pending)}
                    off={actionOff !== null || filesFirst}
                    note={
                      noticeCovers
                        ? undefined
                        : (actionOff ??
                          (filesFirst ? CARD_FILES_FIRST : thereWords(action)) ??
                          undefined)
                    }
                    // The notice shows the reason in place of the label; a
                    // screen reader on the button still hears it.
                    aria-description={actionOff ?? undefined}
                    aria-disabled={unanswered && action.default ? true : undefined}
                    // The offer this footer belongs to rides the click, read now.
                    onClick={() => {
                      if (unanswered && action.default) {
                        void collect(true);
                        return;
                      }
                      void onAction(action.id, "chrome", undefined, collect, card);
                    }}
                  >
                    {action.label}
                  </Button>
                );
              })}
              {noteDone && (
                <Button
                  variant="primary"
                  data-card-action-default=""
                  data-card-choice={0}
                  // `cards.done` presses it, whichever word it carries.
                  data-answer-done-control=""
                  data-note-done={noteDone.closesTask ? "done" : "got-it"}
                  aria-keyshortcuts={
                    choiceKeys[0]?.keys ? choiceKeys[0]["aria-keyshortcuts"] : undefined
                  }
                  keys={choiceKeys[0]?.keys}
                  pending={pending?.actionId === NOTE_DONE_ACTION_ID}
                  disabled={Boolean(pending)}
                  off={offWords !== null}
                  note={noticeCovers ? undefined : (offWords ?? noteDone.restWords)}
                  aria-description={offWords ?? undefined}
                  onClick={() => void pressNote(card.id, card)}
                >
                  {noteDone.label}
                </Button>
              )}
              {/* Chat after the choices, at the right edge (INF-924). */}
              {index === all.length - 1 && reply !== undefined && (
                <ChatButton cardId={card.id} collect={collect} />
              )}
            </div>
          ),
        )}
      </>
    ) : undefined;
  return (
    <>
      {choicesIn &&
        footer &&
        createPortal(
          <div
            data-card-actions=""
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: "var(--space-2)",
              padding: "0 12px 14px",
            }}
          >
            {footer}
          </div>,
          choicesIn,
        )}
      <ResponseCard
        kind={card.ended ? "ended" : chrome}
        bodyRef={bodyRef}
        title={card.title}
        titleWords={<KeyedText text={card.title} own={ownTaskId} />}
        taskKey={task && !bare ? <CardTaskKey task={task} cardId={card.id} /> : undefined}
        meta={cardMetaWords(card.meta)}
        reviewFinding={Boolean(card.reviewTaskId)}
        place={card.place}
        model={card.model}
        revised={card.changes ? revisedLine(card.changes) : undefined}
        asked={card.asked ? <AskedLine asked={card.asked} /> : undefined}
        width="100%"
        // One column of the pair's single container (`CardSurface`), which
        // holds the surface and the floor.
        surface={false}
        bare={bare}
        minHeight={0}
        headExtra={
          inPlaceThread ? (
            <ThreadSegments showing={showing} count={messages.length} onShow={setShowing} />
          ) : undefined
        }
        closeRef={closeRef}
        actions={choicesIn ? undefined : footer}
        comment={reply}
        aside={
          risk && !showThread
            ? { node: <RiskChart risk={risk} />, width: riskChartBox().width, ref: asideRef }
            : undefined
        }
        attachment={
          !bare && ((card.answerDone && !card.noteDone) || card.attachment) ? (
            <>
              {card.answerDone && !card.noteDone && <AnswerDone done={card.answerDone} />}
              {card.attachment && <CardAttachment cardId={card.id} attachment={card.attachment} />}
            </>
          ) : undefined
        }
        facts={
          split && !bare ? (
            <CardFactsFrame facts={split.facts} theme={theme} title={card.title} width={size} />
          ) : undefined
        }
        style={style}
      >
        {error && (
          <p role="alert" style={{ color: "var(--danger)", fontSize: "var(--text-sm)" }}>
            <KeyedText text={error} own={ownTaskId} />
          </p>
        )}
        {bodyPending ? (
          <div aria-busy="true" style={{ minHeight: "var(--space-7)" }} />
        ) : showThread ? (
          <LiveMessageList card={card} messages={messages} working={threadWorking} />
        ) : (
          <HtmlCardBody
            // What happens after the merge leads the body and scrolls away with it (INF-3149).
            lead={afterMergeStrip(card.requiredActions, card.afterMerge)}
            body={body}
            ownTaskId={ownTaskId}
            reveal={bodyEntrance.reveal}
            onDrawn={() => {
              bodyEntrance.onDrawn();
              onDrawn?.();
            }}
            onInteraction={onInteraction}
            admit={() => admitted.current}
            // A prepared body's page is held until the card is shown.
            active={active}
            {...(onHeld ? { onHeld } : {})}
            {...(onBorn ? { onBorn } : {})}
            theme={theme}
            title={card.title}
            // An effect-bearing action is the host chrome's own button and is
            // never declared to the body's frame (`bridgeActionIds`): a card
            // script must not be able to merge its own PR at mount.
            declaredActionIds={bridgeActionIds(card.actions)}
            width={size}
            marks={marks}
            revisionStart={(start) =>
              split && start > split.at ? start - split.facts.length : start
            }
            {...(risk
              ? { inset: { from: asideRef, until: riskBodyInset(), gap: RISK_CHART_GAP } }
              : {})}
            onAction={(actionId, value) => onAction(actionId, "frame", value, undefined, card)}
            onPicture={onPicture}
            // A starter's words go to the main message box without sending.
            onDraft={(text) => {
              const shell = useShellStore.getState();
              if (mainMessageRefusal(shell) === null) shell.beginDraft(text);
            }}
            form={{
              fill: () => useShellStore.getState().cardAnswers[card.id]?.answers,
              onAnswers: (reading) => {
                if (admitted.current) setCardAnswers(card.id, reading);
                else heldAnswers.current = reading;
              },
            }}
            collectRef={collectRef}
          />
        )}
      </ResponseCard>
    </>
  );
}

function AnswerDone({ done }: { done: NonNullable<Card["answerDone"]> }) {
  const doneKeys = useCommandKeys("cards.done");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <div
      data-answer-done=""
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: "var(--space-3)",
      }}
    >
      {error && <span role="alert">{error}</span>}
      <Button
        variant="primary"
        pending={busy}
        data-answer-done-control=""
        {...doneKeys}
        note={done.restWords}
        onClick={() => {
          setBusy(true);
          void window.infinitary.task
            .run(done.taskId, "answer-done")
            .then((result) => {
              if (!result.ok) setError(result.text);
            })
            .catch((error) => setError(String(error)))
            .finally(() => setBusy(false));
        }}
      >
        {done.label}
      </Button>
    </div>
  );
}
