import { randomUUID } from "node:crypto";
import { attachmentWords } from "@shared/attachments";
import { replyWithSettings } from "@shared/cardAnswerLines";
import { type CardNote, cardNotesSchema, noteTexts } from "@shared/cardNotes";
import {
  anythingElseOf,
  CARD_ANSWERS_BOUND_REFUSAL,
  CARD_ANSWERS_MAX_BYTES,
  CARD_ANSWERS_TOO_LONG,
  CARD_REPLY_MAX_CHARS,
  type Card,
  type CardAnswer,
  type CardThread,
  cardAnswersBytes,
  cardAnswersSchema,
  cardChromeValueSchema,
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
import { currentCheckStatus, failedBatch } from "@shared/checkSnapshot";
import { HERE } from "@shared/deviceNames";
import { hasChangeRequests, sameRequestLink } from "@shared/forge";
import { changePageUrl } from "@shared/forgeKinds";
import { choiceWords, type HoldOverride, overridePasses, overrideWords } from "@shared/holds";
import * as m from "@shared/i18n/messages.generated";
import {
  type IntegrationApprovalChoice,
  NOT_ALLOWED_WHY,
  notAllowedAsks,
} from "@shared/integrations";
import { VALIDATION_GAPS_FIELD } from "@shared/liveValidation";
import { heldMerges } from "@shared/mergeHeld";
import { storyAtOrigin } from "@shared/presentationDestination";
import { opensPullRequest } from "@shared/repos";
import type { Rigor } from "@shared/rigor";
import { SECRET_BRING_CARD_WORDS } from "@shared/secretBring";
import { SECRET_ASK_CARD_WORDS } from "@shared/secrets";
import {
  attachmentStanding,
  type TaskBrowserCommandResult,
  type TaskBrowserHandle,
} from "@shared/taskBrowser";
import { MERGE_WORDS, mergeWordsFor, REVIEW_CAREFULLY_WORDS } from "@shared/vocabulary";
import { allowanceCovers, type IntegrationAllowance } from "@shared/writeAsk";
import { z } from "zod";
import { ACTION_VALUE_MAX_BYTES } from "../../shared/plugins/bridge";
import { askedFromAView } from "../askedFromAView";
import { THROUGH_THE_COMMAND, throughNow } from "../askedFromTheCommand";
import { keepImages } from "../attachments";
import type { BrowserReturned, PageUnanswered } from "../browser/taskBrowsers";
import type { IntegrationAskTaken } from "../integrations";
import { type MessageFile, withPastedFiles } from "../overflow";
import { currentChange } from "../storage/changeProjection";
import { checklistApprovesNothing, StaleValidationDecisionError } from "../tasks/liveValidation";
import { TaskGraphRefusal } from "../tasks/taskGraph";
import { TaskService } from "../tasks/taskService";
import type { CardActionUndone, WakeChoice } from "./captainWakes";
import { cardEmitter, FIRSTMATE_CARD_PREFIX } from "./cardEmit";
import type { CardInteractionEvidence } from "./cardEvidence";
import type { CardService } from "./cardService";
import type { CrewCore } from "./crewCore";
import { SUPERVISOR_STEER } from "./crewRuntime";
import type { WriteAskSent } from "./githubGateway";
import {
  listedOn,
  waitingIntegrationAsks,
  writeAnsweredFacts,
  writeSentLine,
} from "./integrationAsks";
import {
  approvableOffer,
  matchesOfferDestination,
  standingAuthorization,
  taskPull,
} from "./mergeAuthorization";
import { publicationRepo } from "./publicationRepo";
import { reviewedTaskOf } from "./reviewCard";
import { reviewHistory } from "./reviewHistory";
import { holdsMerge, type MergeBehind } from "./settleCardFacts";
import { askedUnderCardLine } from "./threadWords";
import type { TypedWake } from "./wakes";
import { mergesInOwnBatch } from "./workShape";

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
 * `CrewCore`.
 */
export class CardActions {
  /** Words for a return's one wake, by task (`holdReturnWords`). */
  private readonly returnWords = new Map<string, string>();

  constructor(private readonly core: CrewCore) {}

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
    // The host's stuck alert names the first mate as its answerer (INF-1670).
    const toFirstmate =
      pressed?.closesTask === true ||
      card.author === "firstmate" ||
      card.answeredBy === "firstmate" ||
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
      { notes, captainText: typed },
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
      this.core
        .hooks()
        .converseAboutCard?.(id, context, hasImages ? images : undefined, ...delivery);
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
          ...(this.browserHeldFor(card) ? { browserHeld: true as const } : {}),
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

  /**
   * Whether the captain holds the browser a request card asked about
   * (docs/task-browser.md, "Asking for help"): its reply comes from beside
   * the page, which its crewmate cannot see until he returns control.
   */
  private browserHeldFor(card: Card): boolean {
    const attachment = card.attachment;
    if (!card.taskId || attachment?.kind !== "browser" || !attachment.handoff) return false;
    const fact = this.core.options.browsers?.fact(card.taskId);
    return (
      fact?.state === "open" &&
      attachmentStanding(attachment, fact) === "same" &&
      (fact.control === "captain" || fact.control === "taking")
    );
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
        ? this.mergeBehind(card, associated)
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
    const answers = source === "chrome" ? chromeAnswers(value) : undefined;
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
      !this.cardBrowserGone(card.taskId, card.attachment)
    )
      return this.openBrowserBesideCard(card, { id: chosen.id, label: chosen.label });
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
      if (this.unboundStoryClick(card, associated)) {
        this.core.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("action-changed");
      }
      const behind = this.mergeBehind(card, associated);
      if (holdsMerge(behind)) {
        this.core.cards.refreshSettleFacts([associated.id]);
        this.core.cards.showOpenCard(card.id);
        throw new CardChoiceUnavailableError("merge-behind", behind);
      }
    }
    const exception =
      chosen.passes === "checks" && source === "chrome"
        ? this.checkExceptionTarget(card)
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
      (merge.review || this.mergeModeFor(card.taskId) === "merge-pr")
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
    };
    // Review carefully (INF-562): the captain's care lands on the record
    // first, so its notice waits on the crewmate's lane ahead of the choice
    // that starts it below, the way any choice on its card does.
    if (
      chosen.care &&
      card.taskId &&
      !closedAnswer &&
      this.careFromCard(card, card.taskId, chosen.label, chosen.care)
    )
      void this.reviewFromCard(card, card.taskId, chosen.label);
    // Merge anyway (INF-1137 friction 6): his click passes the checks at
    // the card's version before the merge below runs, so it merges now.
    if (exception && card.taskId && !closedAnswer)
      this.passChecksFromCard(card, exception, chosen.label, anythingElseOf(answers));
    // The merge card's click (INF-2744): the one merge effect, whichever
    // pull request it names and whatever it declared follows. Only this
    // chrome click runs it; the declaration granted nothing.
    if (merge) {
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
        this.mergeModeFor(card.taskId),
        undefined,
        merge.proceedWithOpen,
        merge.after,
      );
      return {};
    }
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
          void this.answerIntegrationCard(card.id, taskId, askId, effect.integration, refused);
          return {};
        }
        this.answerWriteAsk(card.id, taskId, askId);
        return {};
      }
      case "open":
        if (effect.target === "browser") {
          // Only a crewmate still there can hear that the card's browser was gone.
          const told = closedAnswer ? undefined : choice;
          return effect.savedSignIn
            ? this.grantSavedSignInFromCard(card, told)
            : this.openBrowserFromCard(card, told);
        }
        return {
          effect: {
            kind: "open",
            target: effect.target,
            ...(effect.signIn ? { signIn: effect.signIn } : {}),
            ...(effect.make ? { make: effect.make } : {}),
            ...(effect.remove ? { remove: effect.remove } : {}),
            ...(effect.add ? { add: effect.add } : {}),
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
      this.replyToCard(card.id, output ? `${chosen.label}\n\n${output}` : chosen.label);
      return {};
    }
    if (cardId.startsWith(FIRSTMATE_CARD_PREFIX)) {
      // The answer to a Firstmate decision card returns to the agent.
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
      this.reviewChoice(card, card.taskId, source, choice);
    } else if (card.taskId && !closedAnswer && card.author !== "host") {
      // The action round-trip: a declared choice on a crewmate's card
      // reaches its still-running session as a steering message. A host
      // card's choice with no effect only closes that card. The minus
      // instead keeps it pending.
      this.steerChoice(card.taskId, card, source, choice);
    }
    return {};
  }

  /**
   * The captain's care from a card's button (INF-562): the same writer and
   * notice as update_task, with the captain as its author and the merge
   * card as where it came from. A refusal is a feed line and the first
   * mate's wake, never a silent no-op.
   */
  private careFromCard(card: Card, taskId: string, label: string, care: Rigor): boolean {
    const before = this.core.options.tasks.policiesOf(this.core.options.tasks.get(taskId));
    try {
      this.core.options.tasks.updateFields(
        taskId,
        { policies: { rigor: care }, direction: "the merge card" },
        "captain",
      );
    } catch (caught) {
      if (!(caught instanceof TaskGraphRefusal)) throw caught;
      this.core.options.broadcastEvent({ type: "firstmate_note", text: caught.message, taskId });
      this.cardActionUndone(card, taskId, label, "set-rigor", caught.message);
      return false;
    }
    this.core.policiesChanged(taskId, { rigor: care }, before);
    return true;
  }

  /**
   * The review the captain's Review carefully asks for (INF-1875): the app
   * starts it on the builder's committed version - the one its merge card
   * offered - as soon as the care is on the record. The click is a typed
   * fact starting an operation, never a judgment; the reviewer's brief
   * carries the card the captain read. A task whose record holds no words
   * of the captain's is reviewed against its goal (INF-4072 finding 1).
   * What the app cannot start it says in the feed and wakes the first mate
   * with at once, to start the review as on any Careful task.
   */
  private async reviewFromCard(card: Card, taskId: string, label: string): Promise<void> {
    const builder = this.core.options.tasks.get(taskId);
    if (!builder || TaskService.isClosed(builder)) return;
    try {
      const { taskId: reviewId, review: assigned } = await this.core.intake.commissionReview(
        {
          title: `Review: ${builder.title}`,
          intent: builder.intent ?? { goal: builder.goal?.trim() || builder.title, userWords: "" },
          ...(builder.repoId ? { repoId: builder.repoId } : {}),
        },
        builder.id,
      );
      const review = this.core.options.tasks.get(reviewId);
      // The review reads the builder's newest commit, which can be newer
      // than the version the merge card offered: the note names both
      // when they differ (INF-3141).
      const offered = builder.delivery?.headSha;
      const at = assigned.head.slice(0, 7);
      if (this.core.options.tasks.get(taskId))
        this.core.options.tasks.note(
          taskId,
          `the app started review ${review?.key || reviewId} of version ${at}${
            offered && offered !== assigned.head
              ? `, newer than ${offered.slice(0, 7)} on the merge card`
              : ""
          }${assigned.uncommitted ? "; edits not yet committed are not in it" : ""}`,
          { news: true, data: { reviewTaskId: reviewId } },
        );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.core.options.broadcastEvent({
        type: "firstmate_note",
        text: `${REVIEW_CAREFULLY_WORDS}: the app could not start the review of ${builder.key || builder.id}: ${message}`,
        taskId,
      });
      this.cardActionUndone(card, taskId, label, "start-review", message);
    }
  }

  /**
   * A card button the app could not carry out (INF-4072 finding 1): the
   * first mate hears it at once, with the reason, on the task's ref.
   */
  private cardActionUndone(
    card: Card,
    taskId: string,
    label: string,
    undone: CardActionUndone,
    reason: string,
  ): void {
    const record = this.core.options.tasks.get(taskId);
    this.core.hooks().notifyOp(
      {
        facts: {
          kind: "card-action-undone",
          card: { id: card.id, title: card.title },
          task: { id: taskId, key: record?.key || taskId, title: record?.title ?? card.title },
          label,
          undone,
          reason,
        },
      },
      "agent",
      taskId,
    );
  }

  /**
   * The captain's Merge anyway click (INF-1137 friction 6): his own word,
   * one click, that the failed checks do not hold the version the card
   * offers. It is the recorded override on the checks for that version
   * (`HoldOverride`), in his name and with the button's words as its
   * reason, so the merge it starts and every other site that reads the
   * checks hold see the same record. A new version brings the hold back.
   */
  private passChecksFromCard(
    card: Card,
    target: { head: string; prNumber: number; prUrl: string },
    label: string,
    written?: string,
  ): void {
    const taskId = card.taskId;
    if (!taskId) return;
    const override: HoldOverride = {
      words: choiceWords(label, card.title, written),
      holds: ["checks"],
      until: "version",
      ...target,
      at: this.core.now(),
    };
    this.core.options.tasks.delivery.recordPermissionRecords(
      taskId,
      { override },
      {
        kind: "note",
        actor: "captain",
        feed: true,
        text: overrideWords(override),
        data: { news: true },
      },
    );
    this.core.overrides.overrideNoticed(taskId, override);
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

  /** A choice on a crewmate's card, steered to its session through the task's durable lane. */
  private steerChoice(
    taskId: string,
    card: Card,
    source: "chrome" | "frame",
    choice: WakeChoice,
    browserGone?: "stopped" | "quit",
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
            choice,
            ...(source === "chrome" ? this.captainFrom() : {}),
            ...(browserGone ? { browserGone } : {}),
          },
        },
        source === "chrome" ? "captain" : "firstmate",
        { via: "card", cardId: card.id },
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
        excerpt: `The captain chose "${choice.label}" on "${card.title}".`,
        history: reviewHistory(this.core.options.tasks, builder),
      },
      once: `review-decision:${card.id}:${card.offerId ?? card.lifecycleId ?? ""}`,
    };
    void this.core.steer
      .steerCrewmate(builder.id, wake, source === "chrome" ? "captain" : "firstmate", {
        via: "card",
        cardId: card.id,
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

  /**
   * Whether the browser a request card's attachment names is gone
   * (docs/task-browser.md, "Asking for help"), read off the task's browser
   * fact as the view reads it (`attachmentStanding`): ended by the app's
   * quit since, or stopped in this run, with or without a newer one after
   * it. Absent while that browser still runs.
   */
  private cardBrowserGone(
    taskId: string,
    handle: TaskBrowserHandle,
  ): "stopped" | "quit" | undefined {
    const fact = this.core.options.browsers?.fact(taskId);
    const standing = attachmentStanding(handle, fact);
    if (standing === "restarted") return "quit";
    return standing === "replaced" || fact?.state !== "open" ? "stopped" : undefined;
  }

  /**
   * The captain's open-browser click reached no browser: the one his
   * request card names is gone. The card stays answered, its crewmate hears
   * his choice and that its browser was gone, so it can open the site again
   * and ask anew, and the feed says so.
   */
  private cardBrowserWasGone(
    card: Card,
    taskId: string,
    told: WakeChoice,
    gone: "stopped" | "quit",
  ): void {
    this.core.options.broadcastEvent({
      type: "firstmate_note",
      text: `The card's browser for "${this.taskTitle(taskId)}" had stopped${gone === "quit" ? " when Infinitary quit" : ""}, so its crewmate is told to open the site again and ask you anew.`,
      taskId,
    });
    this.steerChoice(taskId, card, "chrome", told, gone);
  }

  /**
   * The captain's click on a request card's open-browser action
   * (docs/task-browser.md, "Asking for help"): the browser the card's
   * attachment names passes to him - its crewmate's command finishing first
   * - and the shell opens its view. A newer or older browser is never taken:
   * the view opens on whatever the task's browser is now, saying so. Only a
   * click on the card's own controls reaches here (`act` refuses an effect
   * from a frame), and the crewmate is told nothing until he returns it -
   * unless that browser is gone, when it hears his choice (`told`) at once.
   */
  private openBrowserFromCard(card: Card, told?: WakeChoice): { effect?: ShellEffect } {
    const attachment = card.attachment;
    const taskId = card.taskId;
    if (!taskId || attachment?.kind !== "browser" || attachment.taskId !== taskId) return {};
    const handle = { session: attachment.session, generation: attachment.generation };
    const taken: Promise<TaskBrowserCommandResult | undefined> =
      this.core.options.browsers?.takeControl(taskId, handle) ?? Promise.resolve(undefined);
    void taken
      .catch(() => undefined)
      .then((result) => {
        if (result?.ok || !told) return;
        const gone = this.cardBrowserGone(taskId, handle);
        if (gone) this.cardBrowserWasGone(card, taskId, told, gone);
      });
    return {
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId, ...handle, cardId: card.id },
      },
    };
  }

  /**
   * The captain's open-browser click on a request card whose browser still
   * runs (docs/task-browser.md, "Asking for help"): that browser passes to
   * him and the shell opens its view, as `openBrowserFromCard` does, but the
   * card stays up unanswered, docked beside the page. His Return control
   * takes it down (`takeDownAnsweredRequests`). Should the browser turn out
   * gone before he holds it, the card leaves and its crewmate hears his
   * choice (`told`) and that the browser was gone.
   */
  private openBrowserBesideCard(card: Card, told: WakeChoice): { effect?: ShellEffect } {
    const attachment = card.attachment;
    const taskId = card.taskId;
    if (!taskId || attachment?.kind !== "browser") return {};
    const handle = { session: attachment.session, generation: attachment.generation };
    const taken: Promise<TaskBrowserCommandResult | undefined> =
      this.core.options.browsers?.takeControl(taskId, handle) ?? Promise.resolve(undefined);
    void taken
      .catch(() => undefined)
      .then((result) => {
        if (result?.ok) return;
        const gone = this.cardBrowserGone(taskId, handle);
        if (!gone || !this.core.cards.get(card.id)) return;
        this.core.cards.takeDown(card.id, "browser-gone");
        this.cardBrowserWasGone(card, taskId, told, gone);
      });
    return {
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId, ...handle, cardId: card.id },
      },
    };
  }

  /**
   * The captain's click on a request card's saved sign-in
   * (docs/task-browser.md, "Signed-in sites"): the browser the card's
   * attachment names gets the site's saved sign-in and goes back to its
   * crewmate, and the shell opens its view, where the captain watches it
   * carry on. When the saved sign-in cannot be used the browser stays paused
   * for the captain, and the feed says why; when that browser is gone, its
   * crewmate hears his choice (`told`) at once, as an open-browser click's
   * does.
   */
  private grantSavedSignInFromCard(card: Card, told?: WakeChoice): { effect?: ShellEffect } {
    const attachment = card.attachment;
    const taskId = card.taskId;
    if (!taskId || attachment?.kind !== "browser" || attachment.taskId !== taskId) return {};
    const handle = { session: attachment.session, generation: attachment.generation };
    const refused = (text: string) => {
      const gone = this.cardBrowserGone(taskId, handle);
      if (gone) {
        if (told) this.cardBrowserWasGone(card, taskId, told, gone);
        return;
      }
      this.core.options.broadcastEvent({
        type: "firstmate_note",
        text: `Your sign-in was not used for "${this.taskTitle(taskId)}": ${text} Its browser is still paused for you.`,
        taskId,
      });
    };
    const browsers = this.core.options.browsers;
    if (!browsers?.grantSavedSignIn) refused(`${HERE.this} keeps no sign-ins.`);
    else {
      void browsers
        .grantSavedSignIn(taskId, handle)
        .then((result) => {
          if (!result.ok) refused(result.text);
        })
        .catch(() => refused(`${HERE.this} could not use it right now.`));
    }
    return {
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId, ...handle, cardId: card.id },
      },
    };
  }

  /**
   * The captain handed a task's browser back (docs/task-browser.md, "Taking
   * control"): its crewmate's one steer, named by the return so the inbox
   * queues it once, through the task's durable lane like any other. A
   * request card still up for that browser goes first.
   */
  browserReturned(taskId: string, returned: BrowserReturned): void {
    this.takeDownAnsweredRequests(taskId);
    // Words the captain left in the docked request's field ride this one wake.
    const words = this.returnWords.get(taskId);
    this.returnWords.delete(taskId);
    if (this.core.options.inbox.woken(taskId, returned.once)) return;
    this.core.options.tasks.turns.endIdle(taskId);
    const wake: TypedWake = {
      facts: {
        kind: "browser-returned",
        site: returned.site,
        ...(returned.after ? { after: returned.after } : {}),
        ...(returned.saved ? { saved: true as const } : {}),
        ...(words ? { words } : {}),
      },
      once: returned.once,
    };
    void this.core.steer.steerInternal(taskId, wake, SUPERVISOR_STEER).catch((caught: unknown) => {
      // No conversation to resume: the ladder reads the task on its own clock.
      console.warn("[crew] browser return's steer not delivered:", caught);
    });
  }

  /**
   * Nothing answers at the page the captain opened in a task's browser
   * (docs/task-browser.md, "When nothing answers"): its crewmate's one
   * steer for that outage, through the task's durable lane. While a turn of
   * its crewmate runs the steer still goes, and the lane hands it to the
   * crewmate at its next chance, so a view that says it was asked is true.
   */
  pageUnanswered(taskId: string, unanswered: PageUnanswered): void {
    const tasks = this.core.options.tasks;
    const record = tasks.get(taskId);
    if (!record || record.status === "done" || record.status === "dropped") return;
    if (this.core.options.inbox.woken(taskId, unanswered.once)) return;
    tasks.turns.endIdle(taskId);
    const wake: TypedWake = {
      facts: {
        kind: "page-unanswered",
        site: unanswered.site,
        url: unanswered.url,
        ...(unanswered.start ? { start: unanswered.start } : {}),
      },
      once: unanswered.once,
    };
    void this.core.steer.steerInternal(taskId, wake, SUPERVISOR_STEER).catch((caught: unknown) => {
      // No conversation to resume: the ladder reads the task on its own clock.
      console.warn("[crew] page-unanswered steer not delivered:", caught);
    });
  }

  /**
   * The words the captain left in a docked request's reply field as he
   * pressed Return control (docs/task-browser.md, "Asking for help"): kept
   * for the return's one wake, which may arrive from another computer after
   * the press answers. A refused return lets them go (`null`).
   */
  holdReturnWords(taskId: string, words: string | null): void {
    const typed = words?.trim();
    if (typed) this.returnWords.set(taskId, typed.slice(0, CARD_REPLY_MAX_CHARS));
    else this.returnWords.delete(taskId);
  }

  /**
   * A request card whose browser the captain just handed back asked for
   * what he has done (docs/task-browser.md, "Asking for help"): his
   * open-browser click left it docked beside the page, or he took that
   * browser from the record. The card leaves on his return, so he comes back
   * to no card, and its crewmate hears only the return's one wake, which
   * carries any words he left in its field. A card naming an older browser
   * stays, since its click tells its crewmate that browser is gone.
   */
  private takeDownAnsweredRequests(taskId: string): void {
    const fact = this.core.options.browsers?.fact(taskId);
    for (const open of [...this.core.cards.values()]) {
      const card = this.core.cards.shown(open.id);
      const attachment = card?.attachment;
      if (!card || card.taskId !== taskId || attachment?.kind !== "browser") continue;
      if (!attachment.handoff || attachmentStanding(attachment, fact) !== "same") continue;
      this.core.cards.takeDown(card.id, "browser-returned");
    }
  }

  /**
   * A merge effect in the task's own words: the PR on a direct-pr repo, the
   * branch into the local checkout otherwise. The agent that declared the
   * effect never learns the difference (ruling D2).
   */
  mergeModeFor(taskId: string): "merge-pr" | "land" {
    return opensPullRequest(this.core.facts.taskDelivery(taskId)) ? "merge-pr" : "land";
  }

  /**
   * Why an open merge card no longer shows its task's current change
   * (INF-4031), the one fact its click and its drawing both read. A card
   * shown for another change than the current one is behind it (INF-2490),
   * unless its click is kept to the pull request it showed (INF-2746).
   * Approval follows the code, never the story's words (INF-3623): a card
   * with a story is behind after another commit - the newest story's
   * version, or the pull request's own newer one; a newer story at the
   * version it showed only asks for a redraw.
   */
  mergeBehind(
    card: Card,
    associated = card.taskId ? this.core.options.tasks.get(card.taskId) : undefined,
  ): MergeBehind | null | undefined {
    if (!associated || TaskService.isClosed(associated)) return undefined;
    const delivery = associated.delivery;
    const offered = delivery?.completionOffers?.find(
      (offer) => offer.cardId === card.id && offer.offerId === card.offerId,
    );
    // A card with no offer of its own shows no version to fall behind.
    if (!offered) return undefined;
    if (offered.retired) return { why: "other", shown: offered.headSha };
    const shownFor = offered.shownFor ?? offered.prNumber;
    const current = currentChange(delivery, associated.branch);
    const changes = this.core.options.tasks.changesFor(associated.id);
    const candidate = taskPull(associated, changes, shownFor, offered.destination);
    const repoId = offered.destination?.repoId ?? candidate?.review?.repoId ?? associated.repoId;
    const repo = repoId ? this.core.options.repos.get(repoId) : undefined;
    const another =
      shownFor !== undefined &&
      (shownFor !== current.number ||
        (current.branch !== offered.destination?.branch && offered.destination !== undefined) ||
        (delivery?.checkTarget?.repoId ?? associated.repoId) !== repoId);
    const elsewhere =
      another &&
      candidate &&
      approvableOffer(
        associated,
        repo,
        this.core.facts.taskDelivery(associated.id),
        { cardId: card.id, offerId: card.offerId },
        changes,
        candidate,
      )
        ? candidate
        : undefined;
    const shown = { shown: offered.headSha };
    if (
      (repo &&
        !matchesOfferDestination(associated, repo, offered, candidate?.branch ?? current.branch)) ||
      (offered.destination && !repo)
    )
      // An offer an earlier version saved names no destination: its click
      // approves nothing, though nothing else became the current change.
      return { why: !offered.destination && !another ? "earlier" : "other", ...shown };
    if (another && !elsewhere) return { why: "other", ...shown };
    const ledger = this.core.options.tasks.delivery.changePresentation(
      associated.id,
      elsewhere?.branch ?? current.branch,
      shownFor ?? current.number,
    );
    const newest = ledger?.revisions.at(-1);
    // Older plain-host cards did not bind the address. Keep their click only where
    // the currently confirmed story still identifies exactly what the card showed.
    if (
      repo?.origin &&
      opensPullRequest(this.core.facts.taskDelivery(associated.id)) &&
      !hasChangeRequests(repo.host?.kind) &&
      offered.presentationRevision !== undefined &&
      (!newest ||
        !storyAtOrigin(newest.destination, publicationRepo(associated, repo).origin ?? null) ||
        (!offered.destination &&
          (!offered.presentationContentHash ||
            readyPresentation(ledger)?.contentHash !== offered.presentationContentHash)))
    )
      return { why: "other", ...shown };
    const read = !elsewhere && current.number !== undefined ? delivery?.headSha : undefined;
    const pushed = read !== undefined && read !== offered?.headSha;
    const story = ledger !== undefined || offered?.presentationRevision !== undefined;
    // Its publication is part of the reading, so a story confirmed published
    // after it was saved is read again and redrawn (INF-4031).
    const revision = newest
      ? {
          newest: newest.revision,
          published: `${ledger?.published?.revision ?? "-"}:${ledger?.publication?.state ?? "-"}`,
        }
      : {};
    if (story && (!offered?.presentationRevision || pushed || offered.headSha !== newest?.head)) {
      const now = pushed ? read : newest?.head;
      return { why: "pushed", ...shown, ...(now ? { current: now } : {}), ...revision };
    }
    if (newest && offered?.presentationRevision && newest.revision > offered.presentationRevision)
      return { why: "story", ...shown, current: newest.head, ...revision };
    return null;
  }

  /**
   * A merge click on a card with no offer of its own while the task's change
   * has a saved story (INF-3623): it shows no version the click could
   * approve, so it is refused, as before INF-4031.
   */
  private unboundStoryClick(
    card: Card,
    associated: NonNullable<ReturnType<TaskService["get"]>>,
  ): boolean {
    const delivery = associated.delivery;
    if (delivery?.completionOffers?.some((o) => o.cardId === card.id && o.offerId === card.offerId))
      return false;
    const current = currentChange(delivery, associated.branch);
    return (
      this.core.options.tasks.delivery.changePresentation(
        associated.id,
        current.branch,
        current.number,
      ) !== undefined
    );
  }

  /**
   * What a completion card's merge says it does (captain INF-1555 F12):
   * pending checks keep the captain's approval and read Merge when checks pass;
   * failed checks read Merge after fixing errors (captain INF-1555 F20);
   * otherwise Merge the pull request. Raw check results remain separate. The captain's override on the checks
   * at the card's version passes either, so a click merges now and it reads
   * Merge the pull request (INF-756). Undefined - the
   * label as it stands - on a card whose click approves nothing
   * (`approvableOffer`), where a click on such checks is only refused.
   */
  mergeLabel(card: Card): string | undefined {
    const record = card.taskId ? this.core.options.tasks.get(card.taskId) : undefined;
    if (!record) return undefined;
    const repo = record.repoId ? this.core.options.repos.get(record.repoId) : undefined;
    const offer = approvableOffer(record, repo, this.core.facts.taskDelivery(record.id), {
      cardId: card.id,
      offerId: card.offerId,
    });
    if (!offer) return undefined;
    // A merge of a reviewed pull request merges it; the task's own change
    // goes in by its project's way, a batched one in the next batch (INF-4196).
    const delivery = this.core.facts.taskDelivery(record.id);
    const merge = card.actions.map(mergeEffectOf).find(Boolean);
    const passed = merge?.review
      ? MERGE_WORDS["merge-pr"]
      : mergeWordsFor(delivery, mergesInOwnBatch(record, repo));
    const head = offer.baseline.headSha;
    if (
      record.delivery?.headSha === head &&
      overridePasses(
        record.delivery,
        "checks",
        head,
        record.delivery?.prNumber === undefined ? undefined : (record.delivery.prUrl ?? null),
      )
    )
      return passed;
    const ci = currentCheckStatus(record.delivery);
    if (ci === "red") return MERGE_WORDS.afterFixing;
    return ci === "pending" ? MERGE_WORDS.whenChecksPass : passed;
  }

  /**
   * Whether a completion card offers Merge anyway beside its merge
   * (INF-1137 friction 6): on an offer a click would approve, while the
   * pull request is still at the card's version and its checks failed,
   * and the captain's override does not already pass them.
   * It goes when the checks no longer fail or a new version comes. Never
   * beside a failed batch check of a change that merges in a batch: no
   * checks override passes a batch, so it could do nothing a fix does not
   * (INF-3208).
   */
  mergeAnyway(card: Card): boolean {
    return this.checkExceptionTarget(card) !== undefined;
  }

  private checkExceptionTarget(
    card: Card,
  ): { head: string; prNumber: number; prUrl: string } | undefined {
    const record = card.taskId ? this.core.options.tasks.get(card.taskId) : undefined;
    if (!record?.delivery) return undefined;
    const offered = record.delivery.completionOffers?.find(
      (item) => item.cardId === card.id && item.offerId === card.offerId,
    );
    const destination = offered?.destination;
    if (!offered || !destination || offered.prNumber === undefined) return undefined;
    const repo = this.core.options.repos.get(destination.repoId);
    const changes = this.core.options.tasks.changesFor(record.id);
    const pull = taskPull(record, changes, offered.prNumber, destination);
    const offer =
      pull &&
      approvableOffer(
        record,
        repo,
        this.core.facts.taskDelivery(record.id),
        { cardId: card.id, offerId: card.offerId },
        changes,
        pull,
      );
    if (!offer || !repo?.host) return undefined;
    const { headSha: head } = offer.baseline;
    const { host, owner, name } = offer;
    const prNumber = offered.prNumber;
    const prUrl = changePageUrl(repo.host.kind, host, `${owner}/${name}`, prNumber);
    const saved = changes.find(
      (item) =>
        item.repoId === destination.repoId &&
        item.head.branch === destination.branch &&
        sameRequestLink(item.handle?.url, prUrl),
    );
    const current = sameRequestLink(record.delivery.prUrl, prUrl);
    const red = current
      ? record.delivery.headSha === head && currentCheckStatus(record.delivery) === "red"
      : saved?.versions.at(-1)?.head === head && saved.versions.at(-1)?.checks?.state === "red";
    if (
      !red ||
      (current && failedBatch(record.delivery, head)) ||
      overridePasses(record.delivery, "checks", head, prUrl)
    )
      return undefined;
    return { head, prNumber, prUrl };
  }

  /** The captain's click on a kept write where a project lives: sent once, its crewmate told once. */
  private answerWriteAsk(cardId: string, taskId: string, askId: string): void {
    void this.core.options.sendWriteAsk?.(taskId, askId).then((sent) => {
      const still = this.core.options.tasks.get(taskId);
      if (!still || TaskService.isClosed(still)) return;
      if (sent.ask)
        this.core.options.tasks.note(taskId, writeSentLine(sent), {
          news: false,
          feed: true,
          actor: "host",
        });
      this.tellWriteAnswered(taskId, cardId, [{ id: askId, sent }]);
    });
  }

  /**
   * The captain's click on a crewmate's integration approval card answers
   * every ask it listed (INF-2993 piece 2), oldest first: one the captain
   * unticked is refused in the app's words, the others run once each with the choice.
   * An Allow for the rest of this task also runs the task's other waiting
   * asks inside it. Every ask is taken before the first runs, so none can
   * drop or run twice, and the crewmate hears every outcome in one steer.
   */
  private async answerIntegrationCard(
    cardId: string,
    taskId: string,
    askId: string,
    choice: IntegrationApprovalChoice,
    notAllowed: readonly string[],
  ): Promise<void> {
    const delivery = this.core.options.tasks.delivery;
    const send = this.core.options.sendTakenIntegrationAsk;
    if (!send) return;
    const listed = listedOn(this.core.options.tasks.get(taskId)?.delivery?.writeAsks, cardId);
    const ids = listed.length > 0 ? listed.map((ask) => ask.id) : [askId];
    const outcomes: { id: string; sent: WriteAskSent }[] = [];
    const taken: { id: string; taken: IntegrationAskTaken }[] = [];
    for (const id of ids) {
      const took = delivery.takeWriteAsk(taskId, id);
      if (notAllowed.includes(id) && "ask" in took) {
        const outcome = { kind: "refused" as const, why: NOT_ALLOWED_WHY };
        delivery.recordWriteAskOutcome(taskId, id, outcome);
        const ask = took.ask;
        outcomes.push({
          id,
          sent: {
            ok: false,
            ask,
            call: ask.kind === "integration" ? ask.action : "",
            place: ask.place,
            outcome,
          },
        });
      } else taken.push({ id, taken: took });
    }
    const allowances: IntegrationAllowance[] = [];
    const run = async (id: string, took: IntegrationAskTaken, as: IntegrationApprovalChoice) => {
      const sent: WriteAskSent = await send(taskId, took, as).catch((caught: unknown) => {
        const why = caught instanceof Error ? caught.message : String(caught);
        const ask = "ask" in took ? took.ask : undefined;
        if (ask) delivery.recordWriteAskOutcome(taskId, id, { kind: "unknown", why });
        return {
          ok: false,
          ...(ask ? { ask } : {}),
          call: ask?.kind === "integration" ? ask.action : "",
          place: ask?.place ?? "",
          outcome: ask ? { kind: "unknown" as const, why } : { kind: "refused" as const, why },
        };
      });
      if (sent.allowance) allowances.push(sent.allowance);
      outcomes.push({ id, sent });
    };
    for (const one of taken) await run(one.id, one.taken, choice);
    // The waiting asks of the same task inside a new allowance run on the
    // same click (INF-2993), their cards revised or taken down. An ask
    // whose card its crewmate withdrew no longer waits, so it never runs
    // (INF-3307 audit).
    const covered = waitingIntegrationAsks(
      this.core.options.tasks.get(taskId)?.delivery?.writeAsks,
    ).filter(
      (ask) =>
        this.core.cards.get(ask.card ?? `integration-ask-${ask.id}`) !== undefined &&
        allowances.some((allowance) => allowanceCovers(allowance, ask)),
    );
    const more = covered.map((ask) => ({
      id: ask.id,
      taken: delivery.takeWriteAsk(taskId, ask.id),
    }));
    for (const card of new Set(covered.map((ask) => ask.card ?? `integration-ask-${ask.id}`)))
      this.core.integrationAsks.showAsks(taskId, card);
    for (const one of more) await run(one.id, one.taken, "once");
    const still = this.core.options.tasks.get(taskId);
    if (!still || TaskService.isClosed(still)) return;
    // One line per allowance, however many of the card's asks it covered.
    const named = new Set<string>();
    for (const { sent } of outcomes) {
      if (!sent.ask) continue;
      this.core.options.tasks.note(taskId, writeSentLine(sent), {
        news: false,
        feed: true,
        actor: "host",
      });
      const allowed = sent.allowance && `${sent.allowance.action}\n${sent.allowance.scope}`;
      if (allowed && !named.has(allowed) && sent.allowance && sent.ask.kind === "integration") {
        named.add(allowed);
        this.core.options.tasks.note(
          taskId,
          `The captain allowed ${sent.ask.action} on ${sent.place} for the rest of this task, for ${sent.allowance.words}.`,
          { news: false, feed: true, actor: "host" },
        );
      }
    }
    const order = new Map(
      [...ids, ...covered.map((ask) => ask.id)].map((id, index) => [id, index]),
    );
    outcomes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    this.tellWriteAnswered(taskId, cardId, outcomes);
  }

  /** One `write-answered` steer naming every outcome of one click, in its card's order. */
  private tellWriteAnswered(
    taskId: string,
    cardId: string,
    outcomes: readonly { id: string; sent: WriteAskSent }[],
  ): void {
    const [first, ...rest] = outcomes;
    if (!first) return;
    void this.core.steer
      .steerCrewmate(
        taskId,
        {
          facts: {
            ...writeAnsweredFacts(first.id, first.sent),
            ...(rest.length > 0
              ? {
                  also: rest.map((one) => {
                    const { kind: _kind, ...facts } = writeAnsweredFacts(one.id, one.sent);
                    return facts;
                  }),
                }
              : {}),
          },
          once: `write-answered:${first.id}`,
        },
        "captain",
        { via: "card", cardId },
      )
      .catch((caught: unknown) => {
        console.warn("[crew] write outcome not delivered:", caught);
      });
  }

  /**
   * The words left in a note's field when the captain presses its own button
   * (Done or Got it) go to its author as their reply once the press has
   * closed the note, as they ride any other button (INF-924): the first mate
   * takes them when Done closed the note's task. They are read off the
   * press's value as the `anything_else` answer, before the press, so a value
   * that does not parse refuses the press rather than drop them.
   */
  notePressWords(value: unknown): string | undefined {
    return anythingElseOf(chromeAnswers(value));
  }

  /** The words a note's press carried, sent after that press closed the note. */
  replyWithNotePress(card: Card, words: string, closesTask: boolean): void {
    this.replyToCard(card.id, words, undefined, undefined, undefined, undefined, undefined, {
      card,
      closesTask,
    });
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

/**
 * The answers a footer click carries (inline decisions, contract 4.22), read
 * off its value: undefined for a click that carries none, which is every
 * card without a form and every caller from before the form. A value that
 * names answers and does not parse, or weighs more than the value bound,
 * refuses the click rather than dropping the captain's picks unsaid.
 */
function chromeAnswers(value: unknown): CardAnswer[] | undefined {
  if (typeof value !== "object" || value === null || !("answers" in value)) return undefined;
  const parsed = cardChromeValueSchema.safeParse(value);
  if (!parsed.success) throw new Error("The card's answers could not be read.");
  if (cardAnswersBytes(parsed.data.answers) > CARD_ANSWERS_MAX_BYTES) {
    throw new Error(CARD_ANSWERS_BOUND_REFUSAL);
  }
  return parsed.data.answers.length > 0 ? parsed.data.answers : undefined;
}

/** The gesture's own id the shell minted at a click, when it sent a well-formed one. */
function interactionOf(submission: unknown): { interactionId?: string } {
  const id = (submission as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id.length >= 8 && id.length <= 64 ? { interactionId: id } : {};
}
