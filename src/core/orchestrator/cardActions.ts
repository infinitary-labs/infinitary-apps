import { randomUUID } from "node:crypto";
import { attachmentWords } from "@shared/attachments";
import { replyWithSettings } from "@shared/cardAnswerLines";
import { type CardNote, cardNotesSchema, noteTexts } from "@shared/cardNotes";
import {
  anythingElseOf,
  CARD_ANSWERS_MAX_BYTES,
  CARD_ANSWERS_TOO_LONG,
  CARD_REPLY_MAX_CHARS,
  type Card,
  type CardAnswer,
  type CardThread,
  cardAnswerer,
  cardAnswersBytes,
  cardAnswersSchema,
  cardMessageText,
  cardSubmissionSchema,
  cardTakesReplies,
  mergeEffectOf,
  onStage,
  type ShellEffect,
  scriptChooser,
  type TurnImage,
} from "@shared/cards";
import { readyPresentation } from "@shared/changePresentation";
import { isFeedbackRequest } from "@shared/feedback";
import { choiceWords } from "@shared/holds";
import * as m from "@shared/i18n/messages.generated";
import { notAllowedAsks } from "@shared/integrations";
import { VALIDATION_GAPS_FIELD } from "@shared/liveValidation";
import { heldMerges } from "@shared/mergeHeld";
import { SECRET_BRING_CARD_WORDS } from "@shared/secretBring";
import { SECRET_ASK_CARD_WORDS } from "@shared/secrets";
import { z } from "zod";
import { ACTION_VALUE_MAX_BYTES } from "../../shared/plugins/bridge";
import { askedFromAView } from "../askedFromAView";
import { THROUGH_THE_COMMAND, throughNow } from "../askedFromTheCommand";
import { keepImages } from "../attachments";
import type { BrowserReturned, PageUnanswered } from "../browser/taskBrowsers";
import type { IntegrationAskTaken } from "../integrations";
import { type MessageFile, withPastedFiles } from "../overflow";
import { checklistApprovesNothing, StaleValidationDecisionError } from "../tasks/liveValidation";
import { TaskService } from "../tasks/taskService";
import { carriedText, type WakeChoice } from "./captainWakes";
import { CardBrowserClicks } from "./cardBrowserClicks";
import { cardEmitter, FIRSTMATE_CARD_PREFIX } from "./cardEmit";
import type { CardInteractionEvidence } from "./cardEvidence";
import type { CardService } from "./cardService";
import {
  chromeValue,
  type KeptCarried,
  keepCarried,
  keptPictures,
  type NotePress,
} from "./cardSubmissionValue";
import { CardWriteAsks } from "./cardWriteAsks";
import type { CrewCore } from "./crewCore";
import { SUPERVISOR_STEER } from "./crewRuntime";
import { standingAuthorization } from "./mergeAuthorization";
import { MergeCardActions } from "./mergeCardActions";
import { reviewedTaskOf } from "./reviewCard";
import { reviewHistory } from "./reviewHistory";
import { holdsMerge, type MergeBehind } from "./settleCardFacts";
import { askedUnderCardLine } from "./threadWords";
import type { TypedWake } from "./wakes";

/**
 * A gesture as the consequential checks below read it: its offer, lifecycle
 * and remount decide, and what pressed the button (`input`) is never part
 * of that reading, so an input this home cannot read never refuses a press
 * (docs/card-evidence.md, "What a click carries").
 */
const gestureSchema = cardSubmissionSchema.extend({ input: z.unknown().optional() });

/** Typed refusal lets non-UI consumers retain the open card rather than accept it. */
export class CardChoiceUnavailableError extends Error {
  constructor(
    reason:
      | "not-ready"
      | "task-closed"
      | "undeclared"
      | "action-changed"
      | "merge-behind"
      | "merge-redrawn"
      | "nothing-ticked" = "not-ready",
    behind?: MergeBehind,
  ) {
    super(
      reason === "merge-behind"
        ? mergeBehindRefusal(behind)
        : reason === "merge-redrawn"
          ? "This card changed while you were reading it, so I did not merge. Read it again before you choose."
          : reason === "nothing-ticked"
            ? "Tick at least one check to accept it, or choose another option."
            : reason === "action-changed"
              ? "This action changed or still waits for other work. Read its current card before confirming."
              : reason === "undeclared"
                ? "This choice is not offered on this card. Choose one of its available options."
                : reason === "task-closed"
                  ? "This choice is not available. Its task is no longer open."
                  : "This choice is not ready. Wait for the card to return.",
    );
  }
}

/**
 * The refused click on a merge card behind its change (INF-4031): what
 * changed, and that the card now shows it, since the refusal holds or
 * redraws the card at once.
 */
function mergeBehindRefusal(behind: MergeBehind | undefined): string {
  if (behind?.why === "earlier") return m.mergeRefusedEarlier();
  if (behind?.why === "other")
    return "Another pull request became this task's current change after this card went up, so I did not merge. The card now says so.";
  const version = behind?.current ? `, ${behind.current.slice(0, 7)},` : "";
  return `A newer version${version} was pushed after this card went up, so I did not merge. The card now shows it.`;
}

/**
 * The captain's card actions (docs/card-threads.md): a click on a card's
 * button, dispatched on its declared effect, a reply typed under a card,
 * a crewmate's kept write sent on the captain's click, and an ordinary
 * read's close told to its author. Shares the crew's state through
 * `CrewCore`, and composes the merge card's part (`MergeCardActions`), a
 * request card's browser (`CardBrowserClicks`) and the held writes a card
 * answers (`CardWriteAsks`).
 */
export class CardActions {
  readonly merges: MergeCardActions;
  private readonly browsers: CardBrowserClicks;
  private readonly writeAsks: CardWriteAsks;

  constructor(private readonly core: CrewCore) {
    this.merges = new MergeCardActions(core);
    this.browsers = new CardBrowserClicks(core, {
      taskTitle: (taskId) => this.taskTitle(taskId),
      steerChoice: (taskId, card, source, choice, browserGone) =>
        this.steerChoice(taskId, card, source, choice, browserGone),
    });
    this.writeAsks = new CardWriteAsks(core);
  }

  /**
   * The captain's reply, typed under a card. A crewmate card's reply is a
   * captain steer to that crewmate - the same control-plane path a card
   * click takes, stamped `via: "thread"`. A Firstmate card's reply is a
   * captain turn about that card. It resolves nothing: the card's buttons
   * stay pinned and the decision is still his to make.
   *
   * Delivery is not awaited, exactly as a card click's round-trip is not:
   * the message is on the record the moment it is typed, and a delivery
   * failure is a feed line rather than a lost reply. Images ride where the
   * session can carry them.
   */
  replyToCard(
    cardId: string,
    rawText: string,
    images?: TurnImage[],
    submission?: unknown,
    answers?: CardAnswer[],
    files?: { text: string; name?: string }[],
    notes?: CardNote[],
    /**
     * The note whose own button these words rode, which that press just
     * closed (`replyWithNotePress`); the first mate takes them when the press
     * closed its task.
     */
    pressed?: { card: Card; closesTask: boolean },
  ): CardThread {
    const id = cardId.trim();
    // An ended card keeps its reply field (INF-3071): the words reach its
    // author, or the first mate once its task has closed, as on an open card.
    const card = pressed?.card ?? this.core.cards.get(id) ?? this.core.cards.ended.get(id);
    if (!card) {
      throw new Error(
        this.core.cards.stored(id)
          ? `Card "${id}" is closed; its thread takes no more replies.`
          : `Unknown card "${id}".`,
      );
    }
    if (!cardTakesReplies(card)) {
      throw new Error(
        card.replies === false
          ? `Card "${id}" takes no reply.`
          : `Card "${id}" has no author to reply to.`,
      );
    }
    const typed = rawText.trim();
    const hasImages = Boolean(images?.length);
    if (notes) cardNotesSchema.parse(notes);
    if (!typed && !hasImages && !files?.length && !notes?.length)
      throw new Error("A reply needs some words.");
    if (typed.length > CARD_REPLY_MAX_CHARS) {
      throw new Error(`A reply is at most ${CARD_REPLY_MAX_CHARS} characters.`);
    }
    if (answers) {
      cardAnswersSchema.parse(answers);
      if (cardAnswersBytes(answers) > CARD_ANSWERS_MAX_BYTES) {
        throw new Error(CARD_ANSWERS_TOO_LONG);
      }
    }
    const messageFiles: MessageFile[] = [];
    const text = withPastedFiles(typed, files, messageFiles);
    const context = replyWithSettings(cardMessageText({ text, notes }), answers);
    // The thread names what rode along: a picture is a line, never markup.
    // The row keeps the text as the author read it; the thread reads the
    // settings back apart from his words (`CardStore.messages`, FI3-617).
    const shown = hasImages
      ? `${replyWithSettings(text, answers)}${text ? "\n" : ""}[attached ${attachmentWords(
          (images ?? []).map((image) => ({ name: image.name || image.mimeType.slice(6) })),
        )}]`
      : replyWithSettings(text, answers);
    // A note its closed task kept has no crewmate left to answer: the
    // Firstmate takes the reply, as it does on its own card.
    const closedTask = card.taskId ? this.core.options.tasks.get(card.taskId) : undefined;
    // A host card the first mate answers names it (`Card.answeredBy`).
    // A /feedback reply is a feedback request for the first mate about this
    // card, never words for its author (docs/feedback.md).
    const feedback = isFeedbackRequest(typed);
    const toFirstmate =
      feedback ||
      pressed?.closesTask === true ||
      cardAnswerer(card) === "firstmate" ||
      (closedTask !== undefined && TaskService.isClosed(closedTask));
    // An accepted reply to a crewmate owns copies of its pictures before the
    // thread or the lane records it (the Firstmate's own turn keeps its own).
    const kept =
      hasImages && !toFirstmate && card.taskId ? keepImages(randomUUID(), images ?? []) : undefined;
    const asked = this.core.cards.addMessage(
      id,
      "captain",
      shown || (notes?.length ? "" : "sent a picture"),
      submission,
      answers,
      undefined,
      false,
      { notes, captainText: typed, ...(feedback ? { owesNoAnswer: true as const } : {}) },
    );
    if (toFirstmate) {
      const delivery: [messageFiles?: MessageFile[], receipt?: string] = notes?.length
        ? [
            messageFiles.length ? messageFiles : undefined,
            [typed, ...noteTexts(notes)].filter(Boolean).join("\n"),
          ]
        : messageFiles.length
          ? [messageFiles]
          : [];
      // The message keeps the line it was typed as (INF-6115 piece 3).
      const [pasted, receipt] = delivery;
      this.core
        .hooks()
        .converseAboutCard?.(
          id,
          context,
          hasImages ? images : undefined,
          pasted,
          receipt,
          asked.id,
        );
      return this.core.cards.thread(id);
    }
    const taskId = card.taskId;
    if (taskId) {
      // The card stays shown with its thread while its author answers;
      // this one line is the send's record in the feed (the captain's Q2 A).
      const crewmate = this.core.tasks.get(taskId)?.crewmate ?? "the crewmate";
      this.core.options.broadcastEvent({
        type: "firstmate_note",
        text: askedUnderCardLine(crewmate, card.title),
      });
      const reply: TypedWake = {
        facts: {
          kind: "thread-reply",
          card: {
            id: card.id,
            title: card.title,
            messageId: asked.id,
            ...(card.lifecycleId ? { lifecycle: card.lifecycleId } : {}),
          },
          words: text,
          answers,
          notes,
          ...this.captainFrom(),
          ...(this.browsers.browserHeldFor(card) ? { browserHeld: true as const } : {}),
          ...(card.author === "host" ? { appCard: true as const } : {}),
        },
      };
      void this.core.steer
        .steerCrewmate(taskId, reply, "captain", {
          via: "thread",
          cardId: id,
          images: hasImages ? images : undefined,
          attachments: kept,
        })
        .catch((caught: unknown) => {
          const message = caught instanceof Error ? caught.message : String(caught);
          this.core.options.broadcastEvent({
            type: "firstmate_note",
            text: `Could not deliver the reply on "${card.title}": ${message}`,
            taskId,
          });
        });
    }
    return this.core.cards.thread(id);
  }

  /** A task's title for a feed line, or what the caller had when there is no record. */
  taskTitle(taskId: string | null | undefined): string {
    if (!taskId) return "a task";
    return this.core.options.tasks.get(taskId)?.title ?? taskId;
  }

  /**
   * A card action (cards/tasks/agents P1): the host dispatches on the
   * action's declared EFFECT and never on its id. A settle effect runs the
   * host settle for the card's task (a merge resolved from the delivery
   * posture); an open effect is handed to the shell; a host effect is one
   * of the agent-down cards' own operations; no effect is a reply - an
   * [fm-op] for a Firstmate card, a steer for a crewmate's. Returns the
   * shell-level effect the renderer applies, if any; card bookkeeping
   * happens here.
   *
   * A footer click carries the answers to the questions the body asked with
   * its own form (inline decisions, contract 4.22): they ride the choice's
   * wake in words, and a closing choice records them on the card row and
   * the task's `card_resolved` event.
   */
  act(
    cardId: string,
    actionId: string,
    source: "chrome" | "frame" = "chrome",
    value?: unknown,
    submission?: unknown,
  ): { effect?: ShellEffect } {
    // The version the captain chose from: the stage's, while a revision
    // waits on its author's close-out.
    const card = this.core.cards.shown(cardId);
    if (!card) return {};
    // A reviewer's question is the builder's to answer once its review closed.
    const asked = reviewedTaskOf(card, this.core.options.tasks) ?? card.taskId;
    const associated = asked
      ? this.core.options.tasks.get(asked)
      : (this.core.options.tasks.capture.openCardTaskFor(card.id) ??
        this.core.options.tasks.capture.taskForCard(card.id));
    const taskUnavailable = Boolean(
      (asked && !associated) || (associated && TaskService.isClosed(associated)),
    );
    if (!onStage(card) || card.status !== "ready" || taskUnavailable) {
      throw new CardChoiceUnavailableError(taskUnavailable ? "task-closed" : "not-ready");
    }
    // Admit only an action declared by the shown offer, before any choice
    // bookkeeping. Resolution can close the card's answer task as well.
    const chosen = card.actions.find((action) => action.id === actionId);
    if (!chosen) {
      // A Merge the app took off a card behind its change (INF-4031) says why.
      const behind = heldMerges(card.body)?.some((held) => held.id === actionId)
        ? this.merges.mergeBehind(card, associated)
        : undefined;
      if (holdsMerge(behind)) throw new CardChoiceUnavailableError("merge-behind", behind);
      throw new CardChoiceUnavailableError("undeclared");
    }
    // A put-off (INF-3846 piece 3) is kept only on the captain's own click,
    // never a body's script; the frame is never offered it (`bridgeActionIds`).
    if (chosen.until && source !== "chrome") throw new CardChoiceUnavailableError("undeclared");
    // Keep on an ask card goes with its typed values on `inf:secrets:keep`, never
    // as a choice: a window or phone that draws no field, an older one, sends it
    // here, and the card stays up saying where to answer (docs/secrets.md).
    if (chosen.effect?.kind === "host" && chosen.effect.op === "secrets-keep")
      throw new Error(SECRET_ASK_CARD_WORDS.elsewhere);
    // Bring into Secrets goes with its ticked rows on `inf:secrets:bring`, never as a choice.
    if (chosen.effect?.kind === "host" && chosen.effect.op === "secrets-bring")
      throw new Error(SECRET_BRING_CARD_WORDS.fine);
    // An act Settings shows only on the first mate's own computer (docs/view.md): a paired
    // window's click, an older one's included, leaves the card up for the captain there.
    if (chosen.effect?.kind === "open" && chosen.effect.fromHome && askedFromAView())
      throw new Error(m.viewFromHomeOnlyThere());
    // A frame value belongs only to a frame reply, never a host effect; a
    // footer click's value is only ever its answers.
    let valueJson: string | undefined;
    if (source === "frame" && value !== undefined) {
      const json = JSON.stringify(value);
      if (json === undefined || Buffer.byteLength(json, "utf8") > ACTION_VALUE_MAX_BYTES) {
        throw new Error("Card settings must be JSON no larger than 4,096 bytes.");
      }
      valueJson = json;
    }
    // A body script's own choice carries nothing from the card's field.
    const chrome = source === "chrome" ? chromeValue(value) : undefined;
    const answers = chrome?.answers;
    const decisionTaskId = card.taskId ?? associated?.id;
    if (source === "frame" && (chosen.effect || chosen.care)) {
      throw new Error("This action is available only from the card controls.");
    }
    // The request stays with the page (docs/task-browser.md, "Asking for
    // help"): the captain's open-browser click on a request card hands him
    // its browser and leaves the card up, docked beside the page with its
    // thread, until his Return control closes it. A card whose browser is
    // gone is answered as before, so its crewmate hears that it was gone.
    if (
      source === "chrome" &&
      chosen.effect?.kind === "open" &&
      chosen.effect.target === "browser" &&
      !chosen.effect.savedSignIn &&
      card.attachment?.kind === "browser" &&
      card.attachment.handoff &&
      card.taskId &&
      card.attachment.taskId === card.taskId &&
      !this.browsers.cardBrowserGone(card.taskId, card.attachment)
    )
      return this.browsers.openBrowserBesideCard(card, { id: chosen.id, label: chosen.label });
    // The record keeps the task as it stood before this choice moves it
    // (docs/card-evidence.md), beside what the shell said it showed.
    const context = decisionTaskId
      ? this.core.options.tasks.capture.decisionContext(decisionTaskId)
      : undefined;
    const evidence: CardInteractionEvidence = {
      source,
      ...(submission !== undefined ? { submission } : {}),
      ...(valueJson !== undefined ? { frameValue: valueJson } : {}),
      ...(context ? { context } : { contextGap: decisionTaskId ? "task-missing" : "no-task" }),
    };
    const by = source === "chrome" ? "captain" : scriptChooser(card.author);
    // Resolution records the choice and its true source, not operation
    // success. All actions retire their card before external work starts.
    // An answer task closes on this very resolution (Task B), so its
    // crewmate is gone: the choice has nowhere to round-trip to.
    const effect = chosen.effect;
    // The one merge effect (INF-2744), whichever pull request it names.
    const merge = mergeEffectOf(chosen);
    // A merge click merges the change its card was shown for, at the version
    // it showed: a card behind its change is refused (`mergeBehind`), and
    // the card is held or redrawn at once, so the next look shows why.
    if (merge && !merge.review && associated) {
      if (this.merges.unboundStoryClick(card, associated)) {
        this.core.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("action-changed");
      }
      const behind = this.merges.mergeBehind(card, associated);
      if (holdsMerge(behind)) {
        this.core.cards.refreshSettleFacts([associated.id]);
        this.core.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("merge-behind", behind);
      }
    }
    const exception =
      chosen.passes === "checks" && source === "chrome"
        ? this.merges.checkExceptionTarget(card)
        : undefined;
    if (chosen.passes === "checks" && source === "chrome" && !exception)
      throw new CardChoiceUnavailableError("action-changed");
    // The captain's merge click mints his approval of the offer he was
    // reading, in the resolution's own transaction (FI3-304). A frame or
    // agent never reaches here with a settle effect, so nothing else can.
    // An approval of another pull request than the one whose approval
    // stands waits its turn, and the host runs it then (INF-2746).
    let queued = false;
    const approve =
      source === "chrome" &&
      card.taskId &&
      merge &&
      (merge.review || this.merges.mergeModeFor(card.taskId) === "merge-pr")
        ? () => {
            queued =
              this.core.settling.approvals.authorizeMerge(
                card.taskId as string,
                {
                  cardId: card.id,
                  ...(card.lifecycleId ? { lifecycleId: card.lifecycleId } : {}),
                  ...(card.offerId ? { offerId: card.offerId } : {}),
                  actionId,
                  ...interactionOf(submission),
                },
                merge.proceedWithOpen ?? false,
                merge.review,
                { after: merge.after },
              ) === "queued";
          }
        : undefined;
    const confirming = effect?.kind === "host" && effect.op === "confirm-required-action";
    const consequentialMerge = card.requiredActions !== undefined && merge !== undefined;
    if ((confirming || consequentialMerge) && submission !== undefined) {
      const gesture = gestureSchema.safeParse(submission);
      if (
        !gesture.success ||
        gesture.data.remounted ||
        gesture.data.offerId !== card.offerId ||
        gesture.data.lifecycleId !== card.lifecycleId
      ) {
        this.core.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError(merge ? "merge-redrawn" : "action-changed");
      }
    }
    if (effect?.kind === "host" && effect.op === "confirm-required-action") {
      if (this.core.cards.get(card.id)?.awaiting === "answer")
        throw new CardChoiceUnavailableError("not-ready");
      const [id, generation] = (effect.arg ?? "").split(":");
      const action = associated?.delivery?.captainAction;
      if (
        !id ||
        id !== card.taskId ||
        !action ||
        action.generation !== Number(generation) ||
        action.presentedGeneration !== Number(generation) ||
        !this.core.options.tasks.delivery.captainActionReady(id)
      ) {
        if (id && this.core.options.tasks.delivery.captainActionReady(id)) {
          this.core.cards.presentRequiredAction(id);
          this.core.cards.showOpenCard(action?.cardId ?? card.id);
        }
        throw new CardChoiceUnavailableError("action-changed");
      }
    }
    const carryOffer =
      source === "chrome" && merge && card.taskId
        ? () => {
            if (card.requiredActions !== undefined && card.offerId)
              this.core.options.tasks.delivery.declareRequiredActions(card.taskId as string, {
                cardId: card.id,
                offerId: card.offerId,
                actions: card.requiredActions,
                head: merge.review
                  ? this.core.crewmateCards.mergeReviewOf(card.taskId as string, merge.review)
                      ?.headSha
                  : (readyPresentation(associated?.delivery?.presentation)?.head ??
                    associated?.delivery?.headSha),
              });
            else if (associated?.delivery?.requiredActionOffer)
              this.core.options.tasks.delivery.recordPermissionRecords(card.taskId as string, {
                requiredActionOffer: undefined,
              });
            // Which card's after-merge steps the captain saw, for a merge
            // with no kept approval to say it (INF-4574).
            if (!merge.review && card.offerId)
              this.core.options.tasks.delivery.recordMergeClick(
                card.taskId as string,
                card.id,
                card.offerId,
              );
            approve?.();
          }
        : approve;
    const validationDecision = associated?.delivery?.liveValidation?.permissions.some(
      (item) => item.state === "requested" && item.decision?.card === card.id,
    );
    if (validationDecision) {
      if (
        !associated?.delivery?.liveValidation?.permissions.some(
          (item) =>
            item.state === "requested" &&
            item.decision?.card === card.id &&
            item.decision.offer === card.offerId,
        )
      ) {
        this.core.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("action-changed");
      }
      const gesture = submission === undefined ? undefined : gestureSchema.safeParse(submission);
      if (
        source !== "chrome" ||
        (gesture &&
          (!gesture.success ||
            gesture.data.remounted ||
            gesture.data.offerId !== card.offerId ||
            gesture.data.lifecycleId !== card.lifecycleId))
      ) {
        this.core.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("action-changed");
      }
      // INF-4497 finding 3: approving a checklist with no row ticked accepts
      // nothing, so it is refused and records no decision; the card stays.
      if (
        associated?.delivery?.liveValidation &&
        card.offerId &&
        checklistApprovesNothing(associated.delivery.liveValidation, {
          card: card.id,
          offer: card.offerId,
          action: actionId,
          ticked: answers?.find((answer) => answer.name === VALIDATION_GAPS_FIELD)?.values ?? [],
        })
      ) {
        this.core.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("nothing-ticked");
      }
    }
    // INF-3170 piece 2: the captain's own click on a crewmate's marked yes
    // is kept as what they allowed. A click on an older offer of the card,
    // whose yes may have covered something else, is refused.
    const allowanceOffer =
      source === "chrome" && card.taskId && card.author === "crewmate"
        ? this.core.options.tasks.delivery.allowanceOffer(
            card.taskId,
            card.id,
            card.offerId,
            actionId,
          )
        : undefined;
    if (allowanceOffer && submission !== undefined) {
      const gesture = gestureSchema.safeParse(submission);
      if (!gesture.success || gesture.data.remounted || gesture.data.offerId !== card.offerId) {
        this.core.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("action-changed");
      }
    }
    // A crewmate's approval card lists the asks that joined it while it
    // waited (INF-2993 piece 2): a click answers exactly the asks of the
    // offer it showed, so a click on an older offer is refused and the card
    // shows its current list.
    if (
      card.taskId &&
      card.author === "host" &&
      effect?.kind === "request_write" &&
      effect.integration &&
      submission !== undefined
    ) {
      const gesture = gestureSchema.safeParse(submission);
      if (!gesture.success || gesture.data.remounted || gesture.data.offerId !== card.offerId) {
        this.core.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("action-changed");
      }
    }
    // INF-1108: the first mate's held call waits on its card's own row, which
    // this resolution closes, so the click takes it in the same transaction.
    const firstmateAsk =
      !card.taskId &&
      associated &&
      card.author === "host" &&
      source === "chrome" &&
      effect?.kind === "request_write" &&
      effect.integration
        ? { rowId: associated.id, ask: effect.ask, choice: effect.integration }
        : undefined;
    let takenFirstmateAsk: IntegrationAskTaken | undefined;
    // INF-4446: the captain's yes to a check, kept with their other yeses.
    let checkYes = false;
    // What else the field sent goes on the choice's record, its pictures
    // copied once for every reader (`choice-attachments.md`).
    const kept = chrome?.carried ? keepCarried(chrome.carried) : undefined;
    if (kept) evidence.carried = kept.record;
    let closedAnswer: ReturnType<CardService["resolve"]>;
    try {
      closedAnswer = this.core.cards.resolve(
        card,
        actionId,
        actionId,
        answers,
        by,
        evidence,
        () => {
          if (chosen.until) this.core.cards.putOffs.keep(card, actionId, chosen.until);
          // The captain's click on a merge card of the task's own change is
          // their last act there, which a returning merge card names
          // (INF-5035, `sinceSeen.ts`), with or without a sighting before it.
          if (source === "chrome" && card.offerId)
            this.core.cards.keepSeenMerge(
              card,
              card.offerId,
              merge ? { kind: "approved" } : { kind: "chose", button: chosen.label },
            );
          if (firstmateAsk)
            takenFirstmateAsk = this.core.options.tasks.delivery.takeWriteAsk(
              firstmateAsk.rowId,
              firstmateAsk.ask,
            );
          if (validationDecision && card.taskId && card.offerId)
            checkYes = this.core.options.tasks.delivery.decideLiveValidation(card.taskId, {
              card: card.id,
              offer: card.offerId,
              action: actionId,
              label: chosen.label,
              words: choiceWords(chosen.label, card.title, anythingElseOf(answers)),
              head: associated?.delivery?.validationHead ?? "",
              ticked:
                answers?.find((answer) => answer.name === VALIDATION_GAPS_FIELD)?.values ?? [],
            });
          if (allowanceOffer && card.taskId)
            this.core.options.tasks.delivery.recordAllowance(card.taskId, {
              words: choiceWords(chosen.label, card.title, anythingElseOf(answers)),
              covers: allowanceOffer.covers,
              card: card.id,
              at: this.core.now(),
            });
          carryOffer?.();
          if (card.taskId && associated?.delivery?.captainAction) {
            if (effect?.kind === "host" && effect.op === "confirm-required-action") {
              const [id, generation] = (effect.arg ?? "").split(":");
              if (id === card.taskId)
                this.core.options.tasks.delivery.completeCaptainAction(
                  id,
                  Number(generation),
                  "confirmed",
                );
            } else this.core.options.tasks.delivery.deferCaptainAction(card.taskId);
          }
        },
      );
    } catch (error) {
      if (!(error instanceof StaleValidationDecisionError) || !card.taskId || !card.offerId)
        throw error;
      this.core.options.tasks.delivery.expireValidationDecision(
        card.taskId,
        card.id,
        card.offerId,
        error.message,
      );
      this.core.cards.put({
        ...card,
        actions: [],
        title: "This validation question needs a new answer",
        body: `<p>This question changed, so I accepted no answer.</p><p>The crewmate must ask about the current validation facts.</p>${card.body}`,
      });
      this.core.cards.showOpenCard(card.id);
      // The app's own notice (INF-765): the captain's click was refused, so
      // it is neither his answer nor the first mate's steer, and it reopens
      // no cap either would.
      void this.core.steer
        .steerInternal(
          card.taskId,
          {
            facts: {
              kind: "validation-question-stale",
              card: card.id,
              reason: error.message,
            },
          },
          { ...SUPERVISOR_STEER, cardId: card.id },
        )
        .catch((caught: unknown) => {
          console.warn("[crew] stale validation notice not delivered:", caught);
        });
      throw new CardChoiceUnavailableError("action-changed");
    }
    // The yes waits on the crewmate's lane ahead of the choice, as the
    // whole list it now reads; a yes to a check joins that list (INF-4446).
    if ((allowanceOffer || checkYes) && card.taskId)
      this.core.overrides.allowedNoticed(card.taskId);
    const choice: WakeChoice = {
      id: actionId,
      label: chosen.label,
      ...(valueJson !== undefined ? { value: valueJson } : {}),
      ...(answers ? { answers } : {}),
      ...(kept ? { carried: kept.record } : {}),
    };
    // Where no author hears the choice - the app carried it out, or nobody
    // reads it - the first mate is told once, with what went with it. An
    // answer task's own close carries it on the first mate's closing notice.
    // On the app's own card for a crewmate's ask, what the captain wrote
    // with a button goes to that crewmate instead, beside the outcome its
    // ask hears on its own (`Card.answeredBy`). Words left in the field of a
    // host card the first mate answers go to the first mate, so a press
    // beside them never drops them.
    const asker =
      card.author === "host" && card.taskId && cardAnswerer(card) === "crewmate"
        ? card.taskId
        : undefined;
    const wordsForFirstmate =
      card.author === "host" &&
      card.answeredBy === "firstmate" &&
      anythingElseOf(answers) !== undefined;
    const tellFirstmate = () => {
      if (closedAnswer) return;
      if (asker && source === "chrome" && (kept || anythingElseOf(answers)))
        this.steerChoice(asker, card, source, choice, undefined, kept, true);
      else if (kept || wordsForFirstmate) this.carriedOut(card, choice, decisionTaskId);
    };
    // Review carefully (INF-562): the captain's care lands on the record
    // first, so its notice waits on the crewmate's lane ahead of the choice
    // that starts it below, the way any choice on its card does.
    if (
      chosen.care &&
      card.taskId &&
      !closedAnswer &&
      this.merges.careFromCard(card, card.taskId, chosen.label, chosen.care)
    )
      void this.merges.reviewFromCard(card, card.taskId, chosen.label);
    // Merge anyway (INF-1137 friction 6): his click passes the checks at
    // the card's version before the merge below runs, so it merges now.
    if (exception && card.taskId && !closedAnswer)
      this.merges.passChecksFromCard(card, exception, chosen.label, anythingElseOf(answers));
    // The merge card's click (INF-2744): the one merge effect, whichever
    // pull request it names and whatever it declared follows. Only this
    // chrome click runs it; the declaration granted nothing.
    if (merge) {
      tellFirstmate();
      if (!card.taskId || source !== "chrome" || queued) return {};
      // A merge sent earlier whose outcome was never read back came along
      // with this approval of its pull request: the click reads it back
      // first, as the kept run does, and sends nothing until it resolves.
      if (standingAuthorization(this.core.options.tasks.get(card.taskId)?.delivery)?.attempt) {
        void this.core.settling.kept.runMergeAuthorization(card.taskId).catch((caught: unknown) => {
          console.warn("[crew] kept merge read-back failed:", caught);
        });
        return {};
      }
      if (merge.review) {
        void this.core.settling.kept
          .requestMerge(card.taskId, merge.review, false, merge.after)
          .catch((caught: unknown) => {
            console.warn("[crew] requested merge failed:", caught);
          });
        return {};
      }
      void this.core.settling.settle.reportCardSettle(
        card.taskId,
        this.merges.mergeModeFor(card.taskId),
        undefined,
        merge.proceedWithOpen,
        merge.after,
      );
      return {};
    }
    if (effect) tellFirstmate();
    switch (effect?.kind) {
      case "settle": {
        // Host-owned teardown: the host runs it instead of steering the
        // crewmate, and reportCardSettle wakes the Firstmate with whatever
        // came back - so the choice still round-trips, just after the work.
        // Every emit boundary refuses a settle without a task; belt and
        // braces here rather than a settle of nothing.
        if (!card.taskId) return {};
        void this.core.settling.settle.reportCardSettle(
          card.taskId,
          "discard",
          effect.confirm,
          effect.proceedWithOpen,
        );
        return {};
      }
      case "request_write": {
        // The declaration sent nothing. Only this chrome click sends the
        // kept write, once; the crewmate hears what came of it once.
        if (firstmateAsk && takenFirstmateAsk) {
          this.core.integrationAsks.answerFirstmateAsk(
            firstmateAsk.rowId,
            firstmateAsk.ask,
            takenFirstmateAsk,
            firstmateAsk.choice,
          );
          return {};
        }
        if (!card.taskId || source !== "chrome") return {};
        const taskId = card.taskId;
        const askId = effect.ask;
        if (effect.integration) {
          // Integration asks can only be answered on the app's own card.
          if (card.author !== "host") return {};
          // The rows the captain unticked; a row the click carries no
          // reading of (an older card, a key with no frame) stays allowed.
          const refused = notAllowedAsks(answers);
          void this.writeAsks.answerIntegrationCard(
            card.id,
            taskId,
            askId,
            effect.integration,
            refused,
          );
          return {};
        }
        this.writeAsks.answerWriteAsk(card.id, taskId, askId);
        return {};
      }
      case "open":
        if (effect.target === "browser") {
          // Only a crewmate still there can hear that the card's browser was
          // gone; what else went with the choice went to the first mate.
          const told = closedAnswer ? undefined : withoutCarried(choice);
          return effect.savedSignIn
            ? this.browsers.grantSavedSignInFromCard(card, told)
            : this.browsers.openBrowserFromCard(card, told);
        }
        return {
          effect: {
            kind: "open",
            target: effect.target,
            ...(effect.signIn ? { signIn: effect.signIn } : {}),
            ...(effect.make ? { make: effect.make } : {}),
            ...(effect.remove ? { remove: effect.remove } : {}),
            ...(effect.add ? { add: effect.add } : {}),
            ...(effect.addressForm ? { addressForm: effect.addressForm } : {}),
            ...(effect.update ? { update: effect.update } : {}),
            ...(effect.privateSite ? { privateSite: effect.privateSite } : {}),
            ...(effect.signInOn ? { signInOn: effect.signInOn } : {}),
            ...(effect.forgeSignInOn ? { forgeSignInOn: effect.forgeSignInOn } : {}),
            ...(effect.section ? { section: effect.section } : {}),
            ...(effect.item ? { item: effect.item } : {}),
            ...(effect.phone ? { phone: effect.phone } : {}),
          },
        };
      case "host":
        return this.core.hostOps.runHostOp(effect, answers);
      default:
        break;
    }
    if (source === "chrome" && card.taskId && associated?.delivery?.captainAction) {
      // An ordinary conversational choice closes its offer, just like any
      // card action. The outstanding operation is then offered again so its
      // author can answer on the same card, without completing the action.
      this.core.cards.presentRequiredAction(card.taskId);
      const output = anythingElseOf(answers);
      const carried = chrome?.carried;
      this.replyToCard(
        card.id,
        output ? `${chosen.label}\n\n${output}` : chosen.label,
        carried?.images,
        undefined,
        undefined,
        carried?.files,
        carried?.notes,
      );
      return {};
    }
    if (cardId.startsWith(FIRSTMATE_CARD_PREFIX)) {
      const wake: TypedWake = {
        facts: {
          kind: "card-choice",
          to: "firstmate",
          source,
          card: {
            id: card.id,
            title: card.title,
            ...(decisionTaskId ? { taskId: decisionTaskId } : {}),
          },
          choice,
          // A choice the captain's own command made says so (INF-3898 piece 2).
          ...(source === "chrome" && throughNow() ? { through: THROUGH_THE_COMMAND } : {}),
        },
      };
      const hooks = this.core.hooks();
      if (source === "chrome" && hooks.notifyCaptainChoice)
        hooks.notifyCaptainChoice(wake, decisionTaskId);
      else hooks.notifyOp(wake, "agent", decisionTaskId);
    } else if (card.taskId && !closedAnswer && card.author === "crewmate" && card.reviewTaskId) {
      // A reviewer's Review finding card (INF-4338's direction D): the
      // choice is the builder's to act on, with no first mate turn between.
      this.reviewChoice(card, card.taskId, source, choice, kept);
    } else if (card.taskId && !closedAnswer && card.author !== "host") {
      // The action round-trip: a declared choice on a crewmate's card
      // reaches its still-running session as a steering message. A host
      // card's choice with no effect only closes that card. The minus
      // instead keeps it pending.
      this.steerChoice(card.taskId, card, source, choice, undefined, kept);
    } else tellFirstmate();
    return {};
  }

  /**
   * A choice whose author hears nothing of what the card's field sent with
   * it (`choice-attachments.md`): a merge, a discard or an app card's own
   * button the app carried out, or a card nobody reads. The first mate is
   * told once, on a turn of its own, with the pictures in it.
   */
  private carriedOut(card: Card, choice: WakeChoice, taskId: string | undefined): void {
    const wake: TypedWake = {
      facts: {
        kind: "card-choice",
        to: "firstmate",
        source: "chrome",
        card: { id: card.id, title: card.title, ...(taskId ? { taskId } : {}) },
        choice,
        carriedOut: true,
        ...(throughNow() ? { through: THROUGH_THE_COMMAND } : {}),
      },
    };
    const hooks = this.core.hooks();
    if (hooks.notifyCaptainChoice) hooks.notifyCaptainChoice(wake, taskId);
    else hooks.notifyOp(wake, "agent", taskId);
  }

  /**
   * Where the captain input running now came from, for a crewmate's steer
   * (docs/devices.md, "Where the captain is"): nothing outside the captain's
   * own input, or with one computer.
   */
  private captainFrom(): { from?: string } {
    const from = this.core.options.captainPlaces?.inputFrom();
    return from ? { from } : {};
  }

  private steerChoice(
    taskId: string,
    card: Card,
    source: "chrome" | "frame",
    choice: WakeChoice,
    browserGone?: "stopped" | "quit",
    kept?: KeptCarried,
    carriedOut?: true,
  ): void {
    void this.core.steer
      .steerCrewmate(
        taskId,
        {
          facts: {
            kind: "card-choice",
            to: "crewmate",
            source,
            card: { title: card.title, id: card.id },
            // Its pictures ride the steer, kept on the lane row by reference.
            choice,
            ...(source === "chrome" ? this.captainFrom() : {}),
            ...(browserGone ? { browserGone } : {}),
            ...(carriedOut ? { carriedOut } : {}),
          },
        },
        source === "chrome" ? "captain" : "firstmate",
        { via: "card", cardId: card.id, ...keptPictures(kept) },
      )
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        this.core.options.broadcastEvent({
          type: "firstmate_note",
          text: `Could not deliver the card choice for "${this.taskTitle(taskId)}": ${message}`,
          taskId,
        });
      });
  }

  /**
   * The captain's choice on a reviewer's own Review finding card goes to the
   * builder the review reads, with the review history that now holds it;
   * the builder's next report returns to the reviewer (`Reviews.returnToReview`).
   */
  private reviewChoice(
    card: Card,
    reviewId: string,
    source: "chrome" | "frame",
    choice: WakeChoice,
    kept?: KeptCarried,
  ): void {
    const review = this.core.options.tasks.get(reviewId);
    const builder = review?.parentId ? this.core.options.tasks.get(review.parentId) : undefined;
    if (!builder || TaskService.isClosed(builder)) return;
    const wake: TypedWake = {
      facts: {
        kind: "review-handoff",
        from: review?.key || reviewId,
        head: review?.delivery?.headSha ?? "the reviewed version",
        // After the review closed, no reviewer reads the answer: the builder
        // delivers a chosen change as a new version.
        stage: review && TaskService.isClosed(review) ? "decided" : "decision",
        excerpt: `The captain chose "${choice.label}" on "${card.title}".${carriedText(choice.carried)}`,
        history: reviewHistory(this.core.options.tasks, builder),
      },
      once: `review-decision:${card.id}:${card.offerId ?? card.lifecycleId ?? ""}`,
    };
    void this.core.steer
      .steerCrewmate(builder.id, wake, source === "chrome" ? "captain" : "firstmate", {
        via: "card",
        cardId: card.id,
        ...keptPictures(kept),
      })
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        this.core.options.broadcastEvent({
          type: "firstmate_note",
          text: `Could not deliver the card choice for "${builder.title}": ${message}`,
          taskId: builder.id,
        });
      });
  }

  // The browser's events reach the card stack here (`homeTaskBrowsers.ts`,
  // `inf:browser:return`); their owner is `CardBrowserClicks`.
  browserReturned(taskId: string, returned: BrowserReturned): void {
    this.browsers.browserReturned(taskId, returned);
  }

  pageUnanswered(taskId: string, unanswered: PageUnanswered): void {
    this.browsers.pageUnanswered(taskId, unanswered);
  }

  holdReturnWords(taskId: string, words: string | null): void {
    this.browsers.holdReturnWords(taskId, words);
  }

  /**
   * The words left in a note's field when the captain presses its own button
   * (Done or Got it) go to its author as their reply once the press has
   * closed the note, as they ride any other button (INF-924): the first mate
   * takes them when Done closed the note's task. They are read off the
   * press's value as the `anything_else` answer, before the press, so a value
   * that does not parse refuses the press rather than drop them.
   */
  notePress(value: unknown): NotePress | undefined {
    const { answers, carried } = chromeValue(value);
    const words = anythingElseOf(answers);
    return words !== undefined || carried ? { words: words ?? "", carried } : undefined;
  }

  /** An ended card's Close: what its field held goes as the reply it already sends. */
  replyWithEndedClose(cardId: string, press: NotePress): void {
    const { words, carried } = press;
    this.replyToCard(
      cardId,
      words,
      carried?.images,
      undefined,
      undefined,
      carried?.files,
      carried?.notes,
    );
  }

  /** What a note's press carried, sent after that press closed the note. */
  replyWithNotePress(card: Card, press: NotePress, closesTask: boolean): void {
    const { words, carried } = press;
    this.replyToCard(
      card.id,
      words,
      carried?.images,
      undefined,
      undefined,
      carried?.files,
      carried?.notes,
      { card, closesTask },
    );
  }

  /**
   * An ordinary read or duplicate closure on a live task reaches its author
   * through the existing turn path. Only an ordinary read acknowledges its note;
   * `duplicateOf` names the earlier card a duplicate closure repeats.
   */
  tellCardClosed(
    card: Card,
    duplicateOf?: { id: string; title: string },
    /** Words rode the press: the crewmate hears the read with them, even once finished. */
    withWords = false,
  ): void {
    const cardId = card.id;
    const taskId = card.taskId;
    const record = taskId ? this.core.options.tasks.get(taskId) : undefined;
    if (!taskId || !record || TaskService.isClosed(record)) return;
    if (cardEmitter(card.id, taskId) !== "crewmate") return;
    // A crewmate that declared its work finished has nothing left to do
    // (INF-2718): its read is not restarted as a turn - after an update a
    // fresh conversation raised the closed note again (INF-2662) - and the
    // idle ladder hands its close to the first mate once no card of its is
    // up (`IdleLadder.finishedRead`). Words that rode the read wait for its
    // answer: the read and the words reach it in one turn, and the close is
    // asked once that turn ends.
    if (!duplicateOf && !withWords && record.delivery?.finishedAt !== undefined) {
      this.core.ladder.finishedRead(taskId, this.core.now());
      return;
    }
    // A record no crewmate can hear - no live session and none to resume -
    // has nobody to tell; the close stays on the record alone.
    if (!this.core.tasks.has(taskId) && !record.sessionFile) return;
    void this.core.steer
      .steerCrewmate(
        taskId,
        {
          facts: {
            kind: "card-closed",
            card: { id: card.id, title: card.title },
            ...(duplicateOf ? { duplicateOf } : { read: true as const }),
          },
        },
        "captain",
        { via: "card", cardId },
      )
      .catch((caught: unknown) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        this.core.options.broadcastEvent({
          type: "firstmate_note",
          text: `Could not deliver your close of "${card.title}" for "${this.taskTitle(taskId)}": ${message}`,
          taskId,
        });
      });
  }
}

/** A choice without anything the field sent besides its words. */
function withoutCarried(choice: WakeChoice): WakeChoice {
  const { carried: _carried, ...plain } = choice;
  return plain;
}

/** The gesture's own id the shell minted at a click, when it sent a well-formed one. */
function interactionOf(submission: unknown): { interactionId?: string } {
  const id = (submission as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id.length >= 8 && id.length <= 64 ? { interactionId: id } : {};
}
