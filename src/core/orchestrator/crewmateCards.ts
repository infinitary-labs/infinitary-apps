import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { cardPictureFiles } from "@shared/cardPictures";
import {
  type CardMutation,
  requestMergeEffectOf,
  requestWriteEffectOf,
  settleEffectOf,
} from "@shared/cards";
import { readyPresentation } from "@shared/changePresentation";
import { everyFailureDiagnosed } from "@shared/checkRepair";
import { currentCheckStatus, everyFailureOnMain } from "@shared/checkSnapshot";
import { forgePlace } from "@shared/forge";
import { fixedHoldWords, overridePasses, softHoldWords } from "@shared/holds";
import type { ValidationPermission } from "@shared/liveValidation";
import { VALIDATION_GAPS_FIELD } from "@shared/liveValidation";
import type { MergeReview } from "@shared/mergeReview";
import { hostedPresentation } from "@shared/presentationDestination";
import { opensPullRequest, type RepoDelivery } from "@shared/repos";
import type { RiskAssessment } from "@shared/risk";
import {
  CHECK_WORDS,
  MERGE_WORDS,
  REVIEW_CAREFULLY_WORDS,
  SKIP_RULES_MERGE_WORDS,
  sendWriteWords,
} from "@shared/vocabulary";
import { NEVER_SENT_AGAIN, type WriteAsk } from "@shared/writeAsk";
import { crewmateCardPicturesDir } from "../paths";
import { lintCrewmateCard } from "../pi/cardLint";
import { verifyKeptValidationEvidence } from "../pi/validationEvidence";
import { LOCAL_MACHINE_ID } from "../session/session";
import {
  CardRefusedError,
  type DeclaredCardInput,
  type EmittedAction,
  type EmittedCardInput,
  labeledActions,
} from "../session/tools";
import { currentChange } from "../storage/changeProjection";
import type { CardRefusal, CompletionOffer, TaskRecord } from "../storage/taskStore";
import { recordValidation as checkValidationTransition } from "../tasks/liveValidation";
import { TaskService } from "../tasks/taskService";
import { CardBrowserActions } from "./cardBrowserActions";
import { revisionNotice } from "./cardChanges";
import type { CardService } from "./cardService";
import { escapeCardText } from "./cardText";
import type { CardCaller } from "./cardThreads";
import type { TaskRuntime } from "./crewRuntime";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";
import { skipRulesStrip, writeAskStrip } from "./requestStrips";
import type { SettleOwners } from "./settleOwners";
import { pendingMergeLine } from "./settleWords";
import { deliverableOf } from "./workShape";

/**
 * The tool's answer when a completion card's revision went up while its
 * checks run (INF-834 friction 4): the words are the captain's to read now,
 * and the merge waits for the checks on its own.
 */
export const COMPLETION_REVISED_WHILE_RUNNING =
  "The card is shown; its merge waits on the checks. Do not emit it again just for that. Read missing results and fix failures as usual.";

/** What a crewmate's cards reach of the supervisor beyond its options. */
export type CrewmateCardsHost = {
  now(): number;
  /** The card stack: the open cards and every write to them. */
  readonly cards: CardService;
  /** Settling and closing, for the merge approval a new merge card replaces. */
  readonly settling: SettleOwners;
  /** Where a task runs, in its card's words (`TaskPlacement.cardPlace`). */
  cardPlace(taskId: string): string | undefined;
  /** A task's delivery posture: the merge mode a settle resolves to. */
  taskDelivery(taskId: string): RepoDelivery | undefined;
  /** Whether a task merges on its own. */
  taskAutonomy(taskId: string): boolean;
  /** Whether a task builds in place on the personal workspace. */
  isPersonalTask(taskId: string): boolean;
  /** Whether the host filed a task to work in place in its project's folder. */
  worksInPlace(taskId: string): boolean;
  /** A merge effect in the task's own words: its pull request's, or a local merge. */
  mergeModeFor(taskId: string): "merge-pr" | "land";
  /** Where a task's crewmate runs: the computer that runs work its record names, or this Mac. */
  machineOf(taskId: string): string;
  /** The version a validation question, or a merge offered after a passed review, answers. */
  validationHead(record: TaskRecord): Promise<string>;
  /** One card's completion offer, replacing that card's earlier entry. */
  keepOffer(taskId: string, offers: readonly CompletionOffer[], offer: CompletionOffer): void;
};

/**
 * A crewmate's own cards as the crew takes them (docs/card-authoring.md,
 * docs/card-threads.md "Shared cards"): its emit_card - its own card, or a
 * contribution to someone else's - the completion card the host finishes
 * with its buttons and holds on its checks, the offer it keeps, the strip
 * of what a request card's click sends, the refusals the task keeps, and
 * whether its crewmate still owes its completion card. The crew
 * supervisor composes it and its callers reach it as
 * `CrewSupervisor.crewmateCards`.
 */
export class CrewmateCards {
  /** A card's browser door: its browser button, its page and its hand-off. */
  private readonly browser: CardBrowserActions;

  constructor(
    private readonly options: CrewSupervisorOptions,
    private readonly host: CrewmateCardsHost,
  ) {
    this.browser = new CardBrowserActions(options);
  }

  /**
   * A card emitted by a crewmate through its emit_card tool (D-9, Q3). A
   * merge decision on a direct-pr task clears the standing CI gate first
   * (`pendingCiGate`); every other card - notes, non-merge decisions, a
   * local-only task's "Put the work in" - publishes exactly as before, so this
   * stays synchronous whenever the gate does not apply, which is what most
   * of this file's tests exercise.
   */
  /**
   * A crewmate's emit_card: its own card as ever, or a contribution to
   * someone else's (docs/card-threads.md, "Shared cards"), which keeps that
   * card's author, task and answerer and returns the typed result of what
   * the host saved. A card id the record lacks outside the crewmate's own
   * namespace is refused, never filed as a new card.
   */
  crewmateCardWrite(
    task: TaskRuntime,
    input: DeclaredCardInput,
  ): string | CardMutation | Promise<string> {
    const caller: CardCaller = { actor: "crewmate", taskId: task.id };
    const target = this.host.cards.targetOf(caller, input.id);
    // A computer from before shared cards would read the typed result as
    // its own card shown: it is refused before anything is written.
    const machine = this.host.machineOf(task.id);
    if (
      target.kind !== "new" &&
      target.kind !== "own" &&
      machine !== LOCAL_MACHINE_ID &&
      !this.options.machines?.takesSharedCards?.(machine)
    ) {
      const why = `card ${target.id} is not this task's, and ${this.options.machines?.placeOf(machine).who ?? "the computer this task runs on"} runs an older Infinitary that cannot write on someone else's card. Nothing was written; reply on it or report the gap to the first mate.`;
      throw new CardRefusedError(`Card refused: ${why}`, "other", why);
    }
    if (target.kind === "new" || target.kind === "own") {
      if (input.expectedRevision !== undefined) {
        const own = target.kind === "own" ? this.host.cards.cardRead(target.id) : undefined;
        if (own && own.revision !== input.expectedRevision)
          throw new Error(
            `Nothing changed on card "${own.title}" (${own.id}): you read revision ${input.expectedRevision}, and it is at ${own.revision ?? "none"} now. Read it again before revising it.`,
          );
      }
      return this.addCrewmateCard(task, input);
    }
    const unlabeled = input.actions.find((action) => !action.label?.trim());
    if (unlabeled)
      return cardRefusedMutation(
        this.host.cards,
        caller,
        target.id,
        `choice "${unlabeled.id}" needs its label.`,
      );
    const actions = input.actions.map((action) => ({ ...action, label: action.label ?? "" }));
    return this.host.cards.contribute(
      caller,
      { ...input, actions },
      {
        ...(input.expectedRevision !== undefined
          ? { expectedRevision: input.expectedRevision }
          : {}),
        ...(input.contributionReason ? { reason: input.contributionReason } : {}),
        ...(input.operationId ? { operationId: input.operationId } : {}),
        ...(input.answersMessage !== undefined ? { answersMessage: input.answersMessage } : {}),
      },
    );
  }

  /** One card as it stands, for a writer about to revise or answer it. */
  readCard(cardId: string): string {
    const read = this.host.cards.cardRead(cardId.trim());
    if (!read) return `No card "${cardId.trim()}" is on the record. Read the id again.`;
    return JSON.stringify(read, null, 2);
  }

  private addCrewmateCard(
    task: TaskRuntime,
    input: DeclaredCardInput,
    checkedHead?: string,
    presentationChecked?: { revision: number; head: string },
  ): string | Promise<string> {
    if (input.presentationRevision !== undefined) {
      const revision = input.presentationRevision;
      const offer =
        input.actions.length === 1 &&
        input.actions[0] !== undefined &&
        settleEffectOf(input.actions[0])?.mode === "merge";
      // A task that merges on its own shows the same story as a note before
      // its first mate merges it (INF-547, the captain's direction C): no
      // button, since the merge is not theirs to click, and no required
      // actions, which ride only a merge offer. It keeps the story's risk
      // chart, as the merge card does (INF-1219, direction A).
      const note = input.actions.length === 0 && this.host.taskAutonomy(task.id);
      if (!this.options.completionPresentation || (!offer && !note))
        throw new Error(
          "A saved-story card is only a completion offer for this task, or its note when the task merges on its own.",
        );
      return this.options.completionPresentation(task.id, revision).then(async (presented) => {
        const { revision: shownRevision, ...story } = presented;
        try {
          const ledger = this.options.tasks.get(task.id)?.delivery?.presentation;
          const head = ledger?.completion?.head ?? ledger?.published?.head;
          if (!head)
            throw new Error(
              "The current story has not been published or completed for this destination.",
            );
          const { presentationRevision: _revision, ...rest } = input;
          const shown = offer
            ? story
            : {
                title: story.title,
                body: story.body,
                pictures: story.pictures,
                riskDeclaration: story.riskDeclaration,
                // What the crew starts once the merge goes through shows on
                // the note too: the first mate's merge files it (INF-2796).
                ...(story.afterMerge ? { afterMerge: story.afterMerge } : {}),
              };
          return await this.addCrewmateCard(task, { ...rest, ...shown }, undefined, {
            revision: shownRevision ?? revision,
            head,
          });
        } catch (caught) {
          const files = cardPictureFiles(story.body, this.options.paths.crewmatesDir);
          // A late failure after persistence must not delete a shown card's own evidence.
          const kept = cardPictureFiles(
            this.host.cards.newestForTask(task.id)?.body ?? "",
            this.options.paths.crewmatesDir,
          );
          const retained = new Set([...kept.pictures, ...kept.recordings]);
          const dir = crewmateCardPicturesDir(this.options.paths, task.id);
          await Promise.all(
            [...files.pictures, ...files.recordings].map(async (file) => {
              if (dirname(file) !== dir || retained.has(file)) return;
              await rm(file, { force: true }).catch((error: unknown) => {
                console.warn("Could not remove refused completion story copy", error);
              });
            }),
          );
          throw caught;
        }
      });
    }
    const ownPresentation = this.options.tasks.get(task.id)?.delivery?.presentation;
    if (
      ownPresentation &&
      input.actions.some((action) => settleEffectOf(action)?.mode === "merge") &&
      !presentationChecked
    ) {
      // INF-961: the refusal names the way to a current story, so a crewmate
      // never takes its story as lost; a push after publication needs no new
      // one, since the host republishes it (INF-2509).
      const story = ownPresentation.revisions.at(-1);
      const newest = story?.revision;
      const local = this.host.taskDelivery(task.id) === "local-only";
      const hosted = story !== undefined && hostedPresentation(story.destination);
      throw new Error(
        `Use presentation on the completion card so it shows the current ${local ? "committed" : "published"} story, not a second account of the change. ${newest === undefined ? "" : `This task's newest story is revision ${newest}. `}${local ? "After another commit, prepare a new story with prepare_change, then show its revision as presentation; local-only work skips open_change." : hosted ? "After a push since the story was published, show the same revision as presentation: the app republishes it at the pushed version. Prepare and publish a new revision only when what the story says changed." : "After a push since the story was published, prepare a new story revision at the pushed version with prepare_change and publish it with open_change, then show the completion card with the revision prepare_change returns as presentation."}`,
      );
    }
    const before = this.options.tasks.get(task.id);
    const reviewedMerge =
      before?.delivery?.reviewVerdict === "pass" &&
      input.actions.some((action) => settleEffectOf(action)?.mode === "merge");
    if (!checkedHead && (input.validationDecision || reviewedMerge)) {
      // INF-994: a validation question is kept at every care level, and a
      // merge offered after a passed review reads the version it answers.
      if (!before) throw new Error("The task no longer exists.");
      return this.host.validationHead(before).then(async (head) => {
        const current = this.options.tasks.get(task.id);
        if (!current) throw new Error("The task closed while reading its version.");
        const binding = input.validationDecision;
        if (binding) {
          if (
            input.actions.some(
              (action) =>
                settleEffectOf(action) ||
                requestMergeEffectOf(action) ||
                requestWriteEffectOf(action),
            )
          )
            throw new Error(
              "A validation question cannot also merge or send another write; keep those separate.",
            );
          if (!input.actions.some((action) => action.id === binding.action && !action.effect))
            throw new Error(
              "The validation approval must be an ordinary decision action, not a merge or another effect.",
            );
          const requests = validationRequestsOf(binding);
          if (requests.length > 1) {
            // INF-1824: the checklist's ticks are the captain's own, so no
            // author script or field may share the frame with them.
            const permissions = current.delivery?.liveValidation?.permissions ?? [];
            if (
              new Set(requests).size !== requests.length ||
              requests.some(
                (id) => permissions.find((item) => item.request.id === id)?.request.kind !== "gap",
              )
            )
              throw new Error(
                "A checklist names distinct gap requests of one version; ask about a check approval or an effect on its own card.",
              );
            if (/<script\b/i.test(input.body) || input.body.includes(VALIDATION_GAPS_FIELD))
              throw new Error(
                "A gap checklist card carries no script and no field of its own; the app draws the checklist.",
              );
          }
          let state = current.delivery?.liveValidation;
          for (const request of requests)
            state = checkValidationTransition(
              state,
              {
                kind: "decision",
                request,
                card: input.id ?? "pending",
                action: binding.action,
              },
              {
                head,
                deviceId: current.deviceId ?? null,
                at: this.host.now(),
                decision: { offer: "pending" },
              },
            );
        }
        if (reviewedMerge) {
          const proof = current.delivery?.liveValidation?.runs.at(-1);
          if (proof)
            await verifyKeptValidationEvidence(
              proof.evidence,
              crewmateCardPicturesDir(this.options.paths, task.id),
              task.id,
            );
        }
        this.options.tasks.delivery.recordChangeEvidence(task.id, { validationHead: head });
        return this.addCrewmateCard(task, input, head, presentationChecked);
      });
    }
    // The task's holds speak before the card's shape: a card the task
    // cannot take at all is refused for that, not for its headings.
    if (
      this.host.isPersonalTask(task.id) &&
      (input.actions ?? []).some((action) => settleEffectOf(action) || requestMergeEffectOf(action))
    ) {
      throw new Error(
        "Card refused: this task builds in place on the personal workspace - there is no merge, land, or discard. Show what you built on a note with no actions, then report; a card with actions is only for a genuine decision the captain must make.",
      );
    }
    if (
      this.host.worksInPlace(task.id) &&
      (input.actions ?? []).some((action) => settleEffectOf(action) || requestMergeEffectOf(action))
    ) {
      throw new Error(
        "Card refused: this task works in place in the project's folder - there is no merge, land, or discard, and a completion card is never emitted. Report what you did with report; Infinitary closes the task once what it was for is done. A card is only for a question the captain must answer.",
      );
    }
    if (
      deliverableOf(this.options.tasks.get(task.id)) === "operation" &&
      (input.actions ?? []).some((action) => settleEffectOf(action) || requestMergeEffectOf(action))
    )
      throw new Error(
        "Card refused: an operation has no change to merge or discard. Show the verified effect on a note, then report its evidence for a finished close.",
      );
    // An answer task ships nothing (Task B), so it has no completion card
    // either: the card carrying the answer IS the deliverable, and the task
    // closes when the captain resolves it.
    if (
      this.isAnswerTask(task.id) &&
      (input.actions ?? []).some((action) => settleEffectOf(action) || requestMergeEffectOf(action))
    ) {
      throw new Error(
        "Card refused: this task's deliverable is an answer, not a change - it commits nothing, pushes nothing, and opens no pull request, so there is nothing to merge or discard. Show the answer on this card without a settle action; the captain's choice on it, or your finished report after they close it, is what closes the task.",
      );
    }
    // A merge card names one change (INF-2490): its line says whether the
    // click closes the task, so it cannot both finish and continue.
    if (
      (input.actions ?? []).some((action) => settleEffectOf(action)?.mode === "merge") &&
      (input.actions ?? []).some((action) => requestMergeEffectOf(action))
    )
      throw new Error(
        "Card refused: a merge card offers one merge. settle merge finishes the task with its current change; request_merge merges a reviewed pull request and the task continues. Emit them on separate cards.",
      );
    // A reviewed task's completion card waits on its review (delivery
    // rigor phase 2): the merge is held by the review's `blocks` edge, so a
    // merge decision before the pass could only be refused on the click.
    const record = this.options.tasks.get(task.id);
    if (
      (input.actions ?? []).some((action) => settleEffectOf(action)?.mode === "merge") &&
      input.requiredActions === undefined
    )
      throw new CardRefusedError(
        "Card refused: declare required_actions, including [] when none. Name every action the captain must take after merging.",
        "shape",
        "required_actions is missing",
      );
    if (input.requiredActions !== undefined)
      this.options.tasks.delivery.validateRequiredActions(task.id, input.requiredActions);
    // A merge the blocks rule would refuse on the click is refused here
    // instead: only Firstmate can clear the wait, so the card would be a
    // button that cannot work. (Open children stay a click-time decision:
    // the captain can override that one.)
    if ((input.actions ?? []).some((action) => settleEffectOf(action)?.mode === "merge")) {
      const waiting = this.options.tasks.graph.blockerRefusal(task.id);
      if (waiting) {
        throw new Error(
          `Card refused: this task still waits on open work, so the merge would be refused. ${waiting.text} Report under the five headings with report instead; the first mate clears the wait and tells you when to emit the completion card. ${softHoldWords("waits", "crewmate")}`,
        );
      }
    }
    // A card that asks to send a kept write asks for exactly one, and
    // nothing else that sends (FI3-1571 piece 4); the ask must be this
    // task's and never sent.
    const writes = (input.actions ?? []).flatMap((action) => requestWriteEffectOf(action) ?? []);
    if (writes.length > 0) {
      if (
        writes.length > 1 ||
        (input.actions ?? []).some(
          (action) => settleEffectOf(action) || requestMergeEffectOf(action),
        )
      ) {
        throw new Error(
          "Card refused: a card that asks to send a write asks for exactly one, and carries no merge or discard.",
        );
      }
      const ask = this.writeAskOf(task.id, writes[0]?.ask ?? "");
      if (ask?.kind === "integration")
        throw new Error(
          "The app already presents integration approval cards. Wait for its answer; do not emit another card.",
        );
      if (!ask) {
        throw new Error(
          `Card refused: ask ${writes[0]?.ask} is not on this task. Name the id github_write or an integration's call answered with.`,
        );
      }
      if (ask.sentAt !== undefined) {
        throw new Error(
          `Card refused: ask ${ask.id} was already sent once and is ${NEVER_SENT_AGAIN}. Make a new write with github_write, or call the integration again, to ask again. ${fixedHoldWords("sent-once")}`,
        );
      }
    }
    // The completion card's BUTTONS are the host's (contract v3.6, captain
    // lock 3; audit 4.4b row 2): a crewmate declares the merge and the host
    // attaches the pair the task's posture calls for, so no agent learns
    // merge-pr from land and no prompt asks one to transcribe a label it
    // cannot see. Done before the lint, so the lint reads the card the
    // captain will actually get. So is the browser button: the crewmate
    // names its label and the host names the browser it opens.
    const {
      browserButton,
      browserHandoff,
      browserPage,
      attachment: _undeclared,
      risk: _undeclaredRisk,
      riskDeclaration,
      ...declared
    } = input;
    const handoff = this.browser.browserHandoffOf(declared.actions ?? [], browserHandoff);
    // A browser button with a page opens that page from the project
    // (docs/task-browser.md, "A page from the project"); without one it is
    // the door to the browser the task holds now.
    const attachment =
      browserPage !== undefined
        ? this.browser.pageAttachment(task.id, browserButton, browserPage, handoff !== undefined)
        : this.browser.browserAttachment(task.id, browserButton, handoff !== undefined);
    const finished = this.withCompletionActions(task.id, {
      ...declared,
      ...(attachment ? { attachment } : {}),
    });
    // The shape lint runs at the crewmate boundary too (WI-11), whichever
    // backend's tool emitted the card; a refusal is the tool's error text.
    const refusal = lintCrewmateCard(finished, {
      rigor: this.options.tasks.policiesOf(this.options.tasks.get(task.id))?.rigor.value,
      tieredStory:
        presentationChecked !== undefined &&
        ownPresentation?.revisions.find((story) => story.revision === presentationChecked.revision)
          ?.version === 2,
    });
    if (refusal) throw new CardRefusedError(`Card refused: ${refusal}`, "shape", refusal);
    // The crewmate says the saved sign-in its browser was given did not
    // sign the page in: that save keeps the mark before anything is offered
    // (docs/task-browser.md, "Saved sign-ins").
    const unmarked =
      handoff?.savedFailed && !this.options.browsers?.markSavedSignInFailed?.(task.id, handoff.site)
        ? ` Your browser uses no saved sign-in for ${handoff.site}, so saved_failed marked nothing.`
        : "";
    // A saved sign-in is offered after the lint: the crewmate never learns
    // which sites are saved, so it is never counted for an action it could
    // not declare. A request card is never a completion card, so the pair
    // above is not in it.
    const shown = handoff
      ? {
          ...finished,
          actions: this.browser.withSavedSignIn(task.id, handoff.site, finished.actions),
        }
      : finished;
    // What the click sends, drawn by the host from its own record after the
    // lint (FI3-1571): the author words why, never the call itself.
    const strip =
      (this.requestStrip(task.id, shown.actions) ?? "") +
      (input.validationDecision
        ? this.validationRequestStrip(
            task.id,
            validationRequestsOf(input.validationDecision),
            shown.actions.find((action) => action.id === input.validationDecision?.action)?.label ??
              input.validationDecision.action,
          )
        : "");
    // The story note of a task that merges on its own opens with the line
    // that says so, in the app's words from the setting (INF-1219); the
    // merge rewrites it on the same note (`SettleService`).
    const selfMergeNote = presentationChecked !== undefined && shown.actions.length === 0;
    const autonomySource = this.options.tasks.policiesOf(this.options.tasks.get(task.id))?.autonomy
      .source;
    const lead = selfMergeNote ? pendingMergeLine(autonomySource ?? "project") : "";
    const card = strip || lead ? { ...shown, body: `${lead}${shown.body}${strip}` } : shown;
    // A request for the captain's help pauses the browser before the card
    // goes up (docs/task-browser.md, "Asking for help").
    const paused = handoff ? this.browser.pauseForCaptain(task.id, handoff) : undefined;
    const publish = (checked: boolean, risk?: RiskAssessment) => {
      // The task may have closed while its completion checks were read.
      // A late tool result must not recreate choices retirement removed.
      const current = this.options.tasks.get(task.id);
      if (!current || TaskService.isClosed(current)) {
        throw new Error("Card refused: this task has closed.");
      }
      if (presentationChecked) {
        const ready = readyPresentation(current.delivery?.presentation);
        if (
          ready?.revision !== presentationChecked.revision ||
          ready.head !== presentationChecked.head ||
          (opensPullRequest(this.host.taskDelivery(task.id)) &&
            current.delivery?.headSha !== presentationChecked.head)
        )
          throw new Error(
            "The story or the checked code changed before the completion card could be shown. Publish the current story first.",
          );
      }
      // The model rides beside the meta line as its own chip (the
      // captain's 1C, 2026-09-28), and where the task runs as its own
      // words, never inside it.
      const id = this.host.cards.emitCrewmateCard(
        task.id,
        risk ? { ...card, risk } : card,
        task.title,
        task.session?.modelLabel() ?? task.session?.modelRef()?.id ?? "Unknown model",
        this.host.cardPlace(task.id),
      );
      if (input.validationDecision) {
        const offered = this.host.cards.get(id);
        if (!offered?.offerId) throw new Error("The validation decision has no kept offer.");
        for (const request of validationRequestsOf(input.validationDecision))
          this.options.tasks.delivery.recordLiveValidation(
            task.id,
            {
              kind: "decision",
              request,
              card: id,
              action: input.validationDecision.action,
            },
            {
              head: current.delivery?.validationHead ?? "",
              decision: {
                offer: offered.offerId,
                ...(offered.lifecycleId ? { lifecycle: offered.lifecycleId } : {}),
              },
            },
          );
      }
      // A completion card is up: an earlier refusal no longer stands.
      if (card.actions.some((action) => settleEffectOf(action))) {
        this.options.tasks.delivery.clearCardRefusal(task.id);
      }
      if (
        card.actions.some(
          (action) => settleEffectOf(action)?.mode === "merge" || requestMergeEffectOf(action),
        )
      ) {
        if (card.actions.some((action) => settleEffectOf(action)?.mode === "merge"))
          this.recordCompletionOffer(task.id, id, checked, presentationChecked);
        else
          this.host.settling.approvals.endAuthorization(
            task.id,
            "superseded",
            "its crewmate put up a new merge card",
          );
        const offered = this.host.cards.get(id);
        if (card.requiredActions !== undefined && offered?.offerId)
          this.options.tasks.delivery.declareRequiredActions(task.id, {
            cardId: id,
            offerId: offered.offerId,
            head:
              this.mergeReviewOf(
                task.id,
                card.actions.map((action) => requestMergeEffectOf(action)?.review).find(Boolean) ??
                  "",
              )?.headSha ??
              presentationChecked?.head ??
              current.delivery?.headSha,
            actions: card.requiredActions,
          });
        // The task keeps the risk of its newest completion card; one
        // without any leaves none standing.
        if (risk || current.delivery?.risk)
          this.options.tasks.delivery.recordChangeEvidence(task.id, { risk });
      } else if (selfMergeNote && risk) {
        // So does the story note of a task that merges on its own.
        this.options.tasks.delivery.recordChangeEvidence(task.id, { risk });
      }
      return `${id}${revisionNotice(this.host.cards.revisionChanges(id))}`;
    };
    const gate = this.pendingCiGate(task.id, card);
    const advisory =
      card.actions?.length &&
      !card.actions.some(
        (action) =>
          settleEffectOf(action) || requestMergeEffectOf(action) || requestWriteEffectOf(action),
      ) &&
      currentCheckStatus(record?.delivery) === "green" &&
      record?.delivery &&
      (record.delivery.changeLabel || record.delivery.prNumber !== undefined)
        ? ` No button on this card can merge ${record.delivery.changeLabel ?? `#${record.delivery.prNumber}`}. If the rest needs that merged first, list it in the story's afterMerge and emit the completion decision.`
        : "";
    const pausedWords = handoff
      ? " Your browser is paused for the captain: your browser commands refuse until the captain takes control and returns it, which wakes you once. End your turn when nothing else needs doing; report with waiting_on_captain naming this card."
      : "";
    const answer = (text: string) => `${text}${advisory}${unmarked}${pausedWords}`;
    // A revision that went up while the checks run says what still holds
    // the merge, and what to do once they pass.
    const gated = (risk?: RiskAssessment) =>
      (gate as Promise<"checked" | "running">).then((reading) => {
        const shown = publish(true, risk);
        return reading === "checked" ? shown : `${shown} ${COMPLETION_REVISED_WHILE_RUNNING}`;
      });
    if (riskDeclaration) {
      return gate
        ? gated({ declared: riskDeclaration }).then(answer)
        : answer(publish(false, { declared: riskDeclaration }));
    }
    if (paused) {
      return paused.then(() => (gate ? gated() : publish(false))).then(answer);
    }
    return gate ? gated().then(answer) : answer(publish(false));
  }

  /**
   * A completion offer went up (FI3-304). It replaces any standing merge
   * approval - the crewmate is asking again - and, when its checks were
   * just read green, its offer is kept with the head they read: the
   * baseline a click on exactly that offer approves. An offer that shows
   * the same content at another head is ambiguous and keeps no baseline.
   * The change it was shown for is kept apart from the baseline (INF-2490):
   * an offer that approves no head still refuses its click once another
   * change is current.
   */
  private recordCompletionOffer(
    taskId: string,
    cardId: string,
    checked: boolean,
    presentation?: { revision: number; head: string },
  ): void {
    this.host.settling.approvals.endAuthorization(
      taskId,
      "superseded",
      "its crewmate put up a new completion card",
    );
    const record = this.options.tasks.get(taskId);
    const offerId = this.host.cards.get(cardId)?.offerId;
    const head = presentation?.head ?? record?.delivery?.headSha;
    // The offer is for the task's current change, whoever opened it (INF-2490).
    const prNumber = record ? currentChange(record.delivery, record.branch).number : undefined;
    if (!record || !offerId || !head) return;
    const offers = record.delivery?.completionOffers ?? [];
    const same = (offer: { cardId: string; offerId: string }) =>
      offer.cardId === cardId && offer.offerId === offerId;
    const ambiguous = offers.some((offer) => same(offer) && offer.headSha !== head);
    const baseline =
      !ambiguous &&
      (checked || presentation !== undefined) &&
      (prNumber !== undefined || presentation !== undefined);
    if (!baseline && prNumber === undefined) {
      if (ambiguous)
        this.options.tasks.delivery.recordPermissionRecords(taskId, {
          completionOffers: offers.filter((offer) => !same(offer)),
        });
      return;
    }
    this.host.keepOffer(taskId, offers, {
      cardId,
      offerId,
      headSha: head,
      ...(prNumber === undefined ? {} : { shownFor: prNumber }),
      ...(baseline && prNumber !== undefined ? { prNumber } : {}),
      ...(baseline && presentation
        ? {
            presentationRevision: presentation.revision,
            presentationContentHash: readyPresentation(record.delivery?.presentation)?.contentHash,
          }
        : {}),
      at: this.host.now(),
    });
  }

  /**
   * The completion card as the host finishes it (contract v3.6, captain lock
   * 3 of 2026-09-19 on the visual-density audit, 4.4b row 2). Until v3.5 the
   * crewmate descriptor spelled out the two buttons - their exact labels by
   * posture, the discard's `danger`, its `confirm` - and every Pi crewmate
   * dutifully transcribed facts the host already held, while the Claude
   * crewmates that never received the text got the label right 4 times in 8.
   * Now a crewmate declares the merge and nothing else: the host reads the
   * posture and writes the pair.
   *
   * `confirm` is deliberately NOT host-set. It means "the body already says
   * this branch has unlanded commits or uncommitted edits", which is a claim
   * about the body, not a fact the host holds - and setting it would discard
   * real work without the captain choosing. Left off, a discard that would
   * destroy something returns the structured `unlanded-work` refusal and its
   * ways out, which is the captain's confirmation (WI-12).
   *
   * The crewmate declares the merge without a label, as it is told
   * (FI3-249): every action the host keeps as declared needs words of its
   * own, and one without them refuses the card (`labeledActions`).
   */
  mergeReviewOf(taskId: string, reviewId: string): MergeReview | undefined {
    return this.options.tasks
      .get(taskId)
      ?.delivery?.mergeReviews?.find((review) => review.id === reviewId);
  }

  /** A write this task's crewmate asked to send, by the id `github_write` answered with. */
  private writeAskOf(taskId: string, askId: string): WriteAsk | undefined {
    return this.options.tasks.get(taskId)?.delivery?.writeAsks?.find((ask) => ask.id === askId);
  }

  /**
   * The host's strip for a card whose button sends something where the
   * project lives (`./requestStrips.ts`): a kept write, or a merge past the
   * branch rules. Undefined for every other card.
   */
  private requestStrip(taskId: string, actions: readonly EmittedAction[]): string | undefined {
    for (const action of actions) {
      const write = requestWriteEffectOf(action);
      const ask = write ? this.writeAskOf(taskId, write.ask) : undefined;
      if (ask) return writeAskStrip(ask);
      const merge = requestMergeEffectOf(action);
      const review = merge ? this.mergeReviewOf(taskId, merge.review) : undefined;
      if (review?.skips) {
        return skipRulesStrip(
          review,
          forgePlace({ kind: "github", host: review.host }) ?? "GitHub",
        );
      }
    }
    return undefined;
  }

  private withCompletionActions(taskId: string, input: DeclaredCardInput): EmittedCardInput {
    const actions = input.actions ?? [];
    if (actions.some((action) => requestWriteEffectOf(action))) {
      // The host names the send, after where it goes (FI3-1571 piece 4); the
      // crewmate's own Not now stays beside it.
      const labeled = actions.map((action) => {
        const effect = requestWriteEffectOf(action);
        if (!effect) return action;
        const ask = this.writeAskOf(taskId, effect.ask);
        return {
          ...action,
          id: action.id || "send",
          label: sendWriteWords(ask?.place ?? "GitHub"),
          default: true,
          effect,
        };
      });
      return { ...input, actions: labeledActions(labeled) };
    }
    if (actions.some((action) => requestMergeEffectOf(action))) {
      // A request is not a completion pair. The host names the button; it
      // does not add Discard, which would close a task watching someone else's pull request.
      const labeled = actions.map((action) => {
        const effect = requestMergeEffectOf(action);
        if (!effect) return action;
        return {
          ...action,
          id: action.id || "merge",
          label: this.mergeReviewOf(taskId, effect.review)?.skips
            ? SKIP_RULES_MERGE_WORDS
            : MERGE_WORDS["merge-pr"],
          default: true,
          effect,
        };
      });
      return { ...input, actions: labeledActions(labeled) };
    }
    if (!actions.some((action) => settleEffectOf(action)?.mode === "merge")) {
      return { ...input, actions: labeledActions(actions) };
    }
    // Only the SETTLE actions are the host's. A card still carries exactly
    // the other actions its author declared (cards/tasks/agents P0): a
    // crewmate's own deferral, or a question it wants answered with the
    // merge, is its offer to make and comes back to it on the click.
    const declared = labeledActions(actions.filter((action) => !settleEffectOf(action)));
    const merge: EmittedAction = {
      id: "merge",
      label: MERGE_WORDS[this.host.mergeModeFor(taskId)],
      default: true,
      effect: { kind: "settle", mode: "merge" },
    };
    const discard: EmittedAction = {
      id: "discard",
      label: "Discard",
      danger: true,
      effect: { kind: "settle", mode: "discard" },
    };
    // A Quick or Default pull request can be made Careful from its merge
    // card (INF-562): drawn between Discard and Merge, so it takes ⌘2.
    const careful: EmittedAction[] = this.offersCareful(taskId)
      ? [{ id: "review-carefully", label: REVIEW_CAREFULLY_WORDS, care: "reviewed" }]
      : [];
    return { ...input, actions: [...declared, merge, discard, ...careful] };
  }

  /**
   * Whether a task's merge card offers Review carefully: pull-request work
   * the captain merges himself, below Careful. Local merges, work that
   * merges on its own and a Careful task get no button.
   */
  private offersCareful(taskId: string): boolean {
    if (this.host.mergeModeFor(taskId) !== "merge-pr") return false;
    const policies = this.options.tasks.policiesOf(this.options.tasks.get(taskId));
    return policies !== null && !policies.autonomy.value && policies.rigor.value !== "reviewed";
  }

  /**
   * Whether a task's own crewmate is still the one that emits its completion
   * card (contract v3.6, captain lock 3; audit 4.4b row 9). True while the
   * work is active on a posture that settles at all and no completion card
   * has been emitted on it yet - which is exactly the window in which a
   * Firstmate merge card would duplicate the one the crewmate is about to
   * write. Once that card exists the window closes: a settle refusal's ways
   * out are then a legitimate Firstmate card on the same task.
   */
  crewmateOwesCompletion(taskId: string): boolean {
    const record = this.options.tasks.get(taskId);
    if (record?.status !== "active" || record.kind !== "work") return false;
    if (record.shape?.kind === "review" || this.host.isPersonalTask(taskId)) return false;
    if (record.shape?.in_place) return false;
    // An answer task emits no completion card at all (Task B): it ships
    // nothing, so nobody owes one.
    if (deliverableOf(record) !== "change") return false;
    return !this.host.cards.hasCompletionCard(taskId);
  }

  /**
   * Read the offered change before binding the card to its exact version.
   * The offer itself is the crew's judgment; only actual check facts hold
   * its merge, and the captain still gives separate consent at the click.
   */
  private pendingCiGate(
    taskId: string,
    input: EmittedCardInput,
  ): Promise<"checked" | "running"> | undefined {
    const requested = input.actions.map((action) => requestMergeEffectOf(action)).find(Boolean);
    if (requested) {
      if (!this.options.reviewGate) return undefined;
      const reviewId = requested.review;
      return this.options.reviewGate(taskId, reviewId).then((refusal) => {
        if (refusal) throw new CardRefusedError(refusal, "checks", refusal);
        return "checked" as const;
      });
    }
    const carriesMerge = input.actions.some((action) => settleEffectOf(action)?.mode === "merge");
    if (!carriesMerge || !opensPullRequest(this.host.taskDelivery(taskId))) return undefined;
    if (!this.options.checkCi) return undefined;
    return this.options.checkCi(taskId).then((result) => {
      const read =
        typeof result === "string"
          ? { overall: result, recorded: true, problem: undefined }
          : result;
      if (!read.recorded || read.overall === "no-pr") {
        const why =
          read.problem ??
          (read.overall === "no-pr"
            ? "no open pull request was found for its branch"
            : "the proposed change could not be read");
        throw new CardRefusedError(
          `Card refused: ${why}. Read the proposed change before offering its exact version.${this.waitingReplyNote(taskId)}`,
          "checks",
          why,
        );
      }
      // A pull request merged outside the app has nothing left to check:
      // the captain's click closes the task as merged (FI3-213).
      if (read.overall === "green" || read.overall === "merged") return "checked" as const;
      // The captain's override on the checks lets the card go up at the
      // version it covers; the merge reads the same record.
      const delivery = this.options.tasks.get(taskId)?.delivery;
      if (overridePasses(delivery, "checks", delivery?.headSha)) return "checked" as const;
      // The checks hold a new merge card until the pull request's own checks
      // pass (INF-1891, the captain: "the app turns the merge card down
      // until the pull request's own checks pass"). A revision of the card
      // already up goes up while they run (INF-834 friction 4): its words
      // are the captain's to read now, and its merge waits on its own.
      if (read.overall === "pending" && this.host.cards.openCompletionCard(taskId, input.id))
        return "running" as const;
      // Failed checks let the card up with Merge anyway beside the merge in
      // two cases: every failed check carries the crewmate's diagnosis
      // (INF-1891, as stable 0.6.1 did), or the default branch's newest run
      // of every failed check failed too (INF-1915 fix 1), which the strip
      // states from that fact, so the crewmate spends no rerun and asks for
      // no reopening and the captain decides on the card: merge now, or
      // wait for main's fix, which the app watches. The offer is still the
      // crew's judgment (INF-1555 F12): the facts stay on the card and hold
      // the merge at the click, never a second readiness declaration.
      if (
        read.overall === "red" &&
        delivery &&
        (everyFailureOnMain(delivery) || everyFailureDiagnosed(delivery))
      )
        return "checked" as const;
      const state =
        read.overall === "pending" && read.problem
          ? `${CHECK_WORDS.pending} (${read.problem})`
          : CHECK_WORDS[read.overall];
      // An empty reading with no declaration is pending, never no checks
      // (INF-1955): the refusal names the declaration that registers them
      // absent, so a project that runs no checks is not held for a wake
      // that never comes.
      const reading = delivery?.checks;
      const empty =
        read.overall === "pending" &&
        reading !== undefined &&
        reading.headSha === delivery?.headSha &&
        reading.items.length === 0 &&
        !reading.absenceDeclared &&
        !reading.problem;
      throw new CardRefusedError(
        `Card refused: the checks read ${state}, not passed; a merge decision must wait. Read them again with check_change, fix or wait, and emit the completion card again once they pass.${read.overall === "red" ? " If they still fail after you tried, it goes up once every failed check at this version carries your diagnosis (check_change diagnosis), and the app offers Merge anyway on it; when main's newest run of every failed check failed too, the reading says so and the card goes up at once stating that fact, so spend no rerun on it." : ""}${empty ? " No check has registered at this version: if this pull request has no checks at all, declare that with check_change absentChecks (its version, the evidence and the local gate run at it), and the reading then says no checks; an empty reading alone stays pending." : ""}${this.waitingReplyNote(taskId)} ${softHoldWords("checks", "crewmate")}`,
        "checks",
        `its checks read ${state}, not passed`,
      );
    });
  }

  /**
   * The checks hold a completion card back while the captain's reply under
   * one of the task's cards still waits for its author (FI3-643): the
   * refusal asks for the thread answer now, so his reply is not left
   * silent until they pass. The card itself waits for them.
   */
  private waitingReplyNote(taskId: string): string {
    return this.host.cards.threadAwaitingAuthor(taskId)
      ? " The captain's reply in your card's thread is still unanswered: answer it now with reply, in one line saying what you did and who goes next, naming their message in answers_message, and update the card once the proposed change can be read."
      : "";
  }

  /**
   * The card tool refused this task's completion card (FI3-401). The
   * refusal stands on the record until a completion card goes up, and the
   * report wake and `crew_status` carry it, so a report that says the card
   * went up is read beside the fact that it did not. A task that has no
   * completion card - the personal workspace, an answer task - or one
   * already closed records nothing: its refusal already says so.
   */
  recordCardRefusal(task: TaskRuntime, refusal: Omit<CardRefusal, "at">): void {
    const record = this.options.tasks.get(task.id);
    if (!record || TaskService.isClosed(record)) return;
    if (this.host.isPersonalTask(task.id) || deliverableOf(record) !== "change") return;
    if (record.shape?.in_place) return;
    this.options.tasks.delivery.recordCardRefusal(task.id, refusal);
  }

  private validationRequestStrip(
    taskId: string,
    requestIds: string[],
    approvalLabel: string,
  ): string {
    const permissions = requestIds.map((requestId) => {
      const permission = this.options.tasks
        .get(taskId)
        ?.delivery?.liveValidation?.permissions.find((item) => item.request.id === requestId);
      if (!permission) throw new Error("That validation request is not on this task.");
      return permission;
    });
    const permission = permissions[0] as ValidationPermission;
    const request = permission.request;
    const lasting =
      "This version and every later one, until that check runs and fails or leaves the list of checks. It records no live pass and merges nothing.";
    const gapDetails = (gap: ValidationPermission) => {
      if (gap.request.kind !== "gap") return "";
      const list = (items: string[]) =>
        `<ul>${items.map((item) => `<li>${escapeCardText(item)}</li>`).join("")}</ul>`;
      return [
        "<details><summary>The recorded gap</summary><dl>",
        `<dt>Version</dt><dd class="inf-mono">${escapeCardText(gap.request.head.slice(0, 7))}</dd>`,
        `<dt>Missing</dt><dd>${escapeCardText(gap.request.missingCapability)}</dd>`,
        `<dt>Why it cannot run</dt><dd>${escapeCardText(gap.request.reason)}</dd>`,
        `<dt>Tried instead</dt><dd>${list(gap.request.alternatives.map((item) => `${item.attempted}: ${item.result}`))}</dd>`,
        `<dt>Ways to close it</dt><dd>${list(gap.request.remedies)}</dd>`,
        "</dl></details>",
      ].join("");
    };
    if (permissions.length > 1) {
      // INF-1824: one checklist for a version's gaps. Rows start unticked;
      // the click accepts exactly the ticked rows and keeps the rest held.
      return [
        '<section class="inf-call inf-call-gap" data-inf-call="gap">',
        `<fieldset data-inf-options-only><legend>${escapeCardText(approvalLabel)} lets the ticked checks go ahead without live proof and keeps the rest held</legend>`,
        '<label><input type="checkbox" data-inf-check-all> Check all</label>',
        ...permissions.map(
          (gap) =>
            `<div><label><input type="checkbox" name="${VALIDATION_GAPS_FIELD}" value="${escapeCardText(gap.request.id)}"> ${escapeCardText(gap.scenario.action)}</label>${gapDetails(gap)}</div>`,
        ),
        "</fieldset>",
        `<p class="inf-muted">${lasting}</p>`,
        `<script>(function(){var all=document.querySelector("[data-inf-check-all]");var rows=Array.prototype.slice.call(document.querySelectorAll('input[name="${VALIDATION_GAPS_FIELD}"]'));all.addEventListener("change",function(){var on=all.checked;rows.forEach(function(row){row.checked=on;});rows.forEach(function(row){row.dispatchEvent(new Event("change",{bubbles:true}));});});rows.forEach(function(row){row.addEventListener("change",function(){all.checked=rows.every(function(r){return r.checked;});});});})();</script>`,
        "</section>",
      ].join("");
    }
    if (request.kind === "gap") {
      return [
        '<section class="inf-call inf-call-gap" data-inf-call="gap">',
        `<div class="inf-call-k">${escapeCardText(approvalLabel)} lets this go ahead without live proof of</div>`,
        `<div class="inf-call-line" data-inf-call-line>${escapeCardText(permission.scenario.action)}</div>`,
        `<p class="inf-muted">${lasting}</p>`,
        gapDetails(permission),
        "</section>",
      ].join("");
    }
    if (request.kind === "check") {
      // INF-1824: the approval is kept on the check by its id, for the
      // resources and cost per run the check declares.
      const entries: [string, string][] = [
        ["Check", permission.scenario.action],
        ["What it uses", permission.scenario.resources ?? ""],
        ["Cost of one run", permission.scenario.cost ?? ""],
      ];
      return `<section class="inf-panel"><h3>Check approval</h3><dl>${entries.map(([name, value]) => `<dt>${escapeCardText(name)}</dt><dd>${escapeCardText(value)}</dd>`).join("")}</dl><p>${escapeCardText(approvalLabel)} covers every later run of this check in this task, after fixes and on later versions, while each run uses only these and costs no more than this. It grants no merge permission.</p></section>`;
    }
    const entries: [string, string][] = [
      ["Version", request.head.slice(0, 7)],
      ["Scenario", permission.scenario.action],
    ];
    entries.push(
      ["Action", request.action],
      ["Destination", request.destination],
      ["Who can see it", request.audience],
      ["Purpose", request.purpose],
      ["Lasting effects", request.lastingEffects],
      ["Cleanup", request.cleanup],
      ["Access", request.access],
    );
    const exact = request.forgeWrite
      ? `<details><summary>Exact request</summary><pre>${escapeCardText(`${request.forgeWrite.host} ${request.forgeWrite.method} ${request.forgeWrite.path}\nBody SHA-256: ${request.forgeWrite.bodyDigest ?? "No body"}`)}</pre></details>`
      : "";
    return `<section class="inf-panel"><h3>Validation action</h3><dl>${entries.map(([name, value]) => `<dt>${escapeCardText(name)}</dt><dd>${escapeCardText(value)}</dd>`).join("")}</dl>${exact}<p>This choice grants no merge permission and covers only this action.</p></section>`;
  }

  /** Whether this task ships nothing: its deliverable is an answer. */
  private isAnswerTask(taskId: string): boolean {
    return deliverableOf(this.options.tasks.get(taskId)) === "answer";
  }
}

/** The validation requests one card binds: its request, then any further gaps of its checklist. */
function validationRequestsOf(binding: { request: string; gaps?: string[] }): string[] {
  return [binding.request, ...(binding.gaps ?? [])];
}

/** A contribution refused before it reached the card's writer, in its typed shape. */
function cardRefusedMutation(
  cards: CardService,
  caller: CardCaller,
  cardId: string,
  refusal: string,
): CardMutation {
  const read = cards.cardRead(cardId);
  return {
    effect: "refused",
    cardId,
    ...(read?.title ? { title: read.title } : {}),
    ...(read?.lifecycle ? { lifecycleId: read.lifecycle } : {}),
    ...(read?.revision ? { revision: read.revision } : {}),
    contributor: cards.contributorOf(caller),
    display: "available",
    refusal,
  };
}
