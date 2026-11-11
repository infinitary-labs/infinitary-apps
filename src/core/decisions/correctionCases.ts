import { createHash, randomUUID } from "node:crypto";
import { CARD_REPLY_MAX_CHARS } from "@shared/cards";
import { CORRECTION_OFFER_WORDS, keptProjectDirection } from "@shared/correctionWords";
import { z } from "zod";
import { FIRSTMATE_CARD_PREFIX } from "../orchestrator/cardEmit";
import { escapeCardText } from "../orchestrator/cardText";
import type { CrewSupervisor } from "../orchestrator/crewSupervisor";
import { STABLE_CARD_ID_MAX } from "../pi/cardTool";
import type { EmittedCardInput } from "../session/tools";
import type { CardStore } from "../storage/cardStore";
import { FIRSTMATE_RECIPIENT, type InboxStore } from "../storage/inboxStore";
import type { TaskService } from "../tasks/taskService";
import type { CorrectionConsumer } from "./correctionConsumer";
import { CORRECTION_CASES } from "./correctionConsumer";
import {
  type CorrectionInput,
  type CorrectionOffer,
  correctionInputSchema,
} from "./correctionTypes";

export const correctionCaseRequestSchema = z.object({
  op: z.enum(["inspect", "offer", "ignore", "recover", "guide"]),
  inputId: z.number().int(),
  projectId: z.string().optional(),
  text: z.string().optional(),
  directionId: z.string().optional(),
  expectedRevision: z.number().int().optional(),
  affectedTaskIds: z.array(z.string()).optional(),
  explicitSourceId: z.string().optional(),
  reply: z.string().optional(),
  answersMessage: z.number().int().optional(),
});
export type CorrectionCaseRequest = z.infer<typeof correctionCaseRequestSchema>;

/** Pending case data is draft work on the existing inbox/card/task owners, never a direction store. */
export class CorrectionCases {
  constructor(
    private readonly options: {
      consumer: CorrectionConsumer;
      inbox: InboxStore;
      cards: CardStore;
      tasks: TaskService;
      supervisor: CrewSupervisor;
      now: () => number;
      project: (id: string) => { id: string; name: string } | undefined;
      direction: (
        id: string,
      ) =>
        | { id: string; text: string; scope: string; revision: number; retired?: boolean }
        | undefined;
    },
  ) {}
  private pending(): { id: number; input: CorrectionInput }[] {
    return this.options.inbox.allFor(CORRECTION_CASES).flatMap((row) => {
      const parsed = correctionInputSchema.safeParse(row.facts);
      return parsed.success ? [{ id: row.id, input: parsed.data }] : [];
    });
  }
  private save(id: number, input: CorrectionInput): void {
    this.options.inbox.revise(id, { facts: input });
  }
  private finish(id: number): void {
    const notices = this.options.inbox
      .allFor(FIRSTMATE_RECIPIENT)
      .filter((row) => row.facts?.kind === "correction-review" && row.facts.inputId === id);
    this.options.inbox.ack([id, ...notices.map((row) => row.id)]);
  }
  /** The card resolves normally; only its independent operation waits for saving. */
  retains(cardId: string, action: string, actor: string, offerId?: string): boolean {
    const found = this.pending().find(({ input }) => input.offer?.cardId === cardId);
    if (!found?.input.offer) return false;
    if (actor === "captain" && action === found.input.offer.keepActionId) {
      const chosen = [found.input.offer, ...(found.input.previousOffers ?? [])].find(
        (offer) => offer.cardOfferId === offerId,
      );
      if (!chosen || !offerId) {
        // A Keep on wording no offer recorded, such as a card revised outside
        // `offer`, can never be read back against it. Unless a written keep
        // request already holds the operation, the card resolves like any
        // first-mate card, whose choice reaches the first mate, and the case ends.
        if (found.input.explicitSourceId) return true;
        this.finish(found.id);
        return false;
      }
      this.save(found.id, { ...found.input, offer: chosen, choiceOfferId: offerId });
      this.queueSelected(found.id, found.input, offerId);
      return true;
    }
    if (action === found.input.offer.declineActionId || action === "closed") this.finish(found.id);
    return false;
  }
  async handle(raw: CorrectionCaseRequest): Promise<unknown> {
    const request = correctionCaseRequestSchema.parse(raw);
    const input = this.options.consumer.input(request.inputId);
    if (!input) return { status: "handled", message: "This source case is no longer pending." };
    if (request.op === "inspect") {
      const latest = input.offer
        ? this.options.cards
            .observations(input.offer.cardId)
            .findLast((entry) => this.options.cards.captainInput(entry.id) !== undefined)
        : undefined;
      const { previousOffers: _history, ...shown } = input;
      return {
        ...shown,
        relatedCases: this.pending()
          .filter(
            (entry) =>
              entry.id !== request.inputId &&
              Boolean(
                (input.source.cardId &&
                  (entry.input.source.cardId === input.source.cardId ||
                    entry.input.offer?.cardId === input.source.cardId)) ||
                  (input.source.taskId && entry.input.source.taskId === input.source.taskId),
              ),
          )
          .map((entry) => ({
            inputId: entry.id,
            source: entry.input.source,
            offer: entry.input.offer,
          })),
        latestWrittenSource: latest
          ? {
              ...this.options.cards.captainInput(latest.id),
              ...(latest.kind === "message_ref" ? { messageId: latest.payload.messageId } : {}),
            }
          : undefined,
      };
    }
    if (request.op === "ignore") {
      const chosen =
        input.offer &&
        !input.offer.savedRevision &&
        (this.options.cards.chosenAction(input.offer.cardId) === input.offer.keepActionId ||
          input.explicitSourceId);
      const why = request.reply?.trim();
      if (chosen && !why)
        throw new Error(
          "The keep choice is pending saving; recover it, or give reply telling the captain why it cannot be kept.",
        );
      if (why && why.length > CARD_REPLY_MAX_CHARS)
        throw new Error(`A reply is at most ${CARD_REPLY_MAX_CHARS} characters.`);
      // The captain chose Keep, and their Keep took the offer off the stack:
      // the reason goes where the kept confirmation goes, and into the feed.
      if (chosen && why && input.offer) {
        this.tell(input, input.offer.cardId, why);
        const own = this.options.tasks.capture.openCardTaskFor(input.offer.cardId);
        if (own)
          this.options.tasks.note(own.id, why, {
            actor: "firstmate",
            news: true,
            feed: true,
            data: { feedLine: true },
          });
      }
      this.withdrawOffer(
        input,
        chosen
          ? "The chosen instruction could not be saved."
          : "This correction needs no new standing instruction.",
      );
      this.finish(request.inputId);
      return { status: "ignored" };
    }
    if (request.op === "recover") {
      if (request.explicitSourceId) {
        const written = this.options.cards.captainInput(request.explicitSourceId);
        if (!written?.text || written.cardId !== input.offer?.cardId)
          throw new Error("Name the actual captain-written request on this offer.");
        input.explicitSourceId = request.explicitSourceId;
        this.save(request.inputId, input);
        this.queueSelected(request.inputId, input, request.explicitSourceId);
        const own = input.offer
          ? this.options.tasks.capture.openCardTaskFor(input.offer.cardId)
          : undefined;
        if (own)
          this.options.tasks.placement.setGate(
            own.id,
            null,
            "an explicit keep request awaits verified saving",
          );
      }
      return this.recover(request.inputId, input);
    }
    if (request.op === "guide") return this.guide(request, input);
    const project = request.projectId ? this.options.project(request.projectId) : undefined;
    if (!project || !request.text?.trim())
      throw new Error("Identify the intended project and exact wording before offering.");
    const replacementId =
      request.directionId ??
      (input.offer?.expectedRevision !== undefined ? input.offer.directionId : undefined);
    const expectedRevision =
      request.expectedRevision ??
      (replacementId === input.offer?.directionId ? input.offer?.expectedRevision : undefined);
    const existing = replacementId ? this.options.direction(replacementId) : undefined;
    if (replacementId && (!existing || existing.retired || existing.revision !== expectedRevision))
      throw new Error(
        "Read the existing direction and its current revision before proposing a replacement.",
      );
    if (existing && existing.scope !== project.id)
      throw new Error("A replacement keeps the existing project reach.");
    if (input.offer?.savedRevision) throw new Error("This offer is already saved.");
    const cardId =
      input.offer?.cardId ??
      `${FIRSTMATE_CARD_PREFIX}${createHash("sha256")
        .update(input.source.key)
        .digest("hex")
        .slice(0, STABLE_CARD_ID_MAX - FIRSTMATE_CARD_PREFIX.length)}`;
    const offer = {
      cardId,
      directionId: replacementId ?? input.offer?.directionId ?? `d:${randomUUID()}`,
      projectId: project.id,
      text: request.text.trim(),
      keepActionId: "keep-project",
      declineActionId: "just-this-time",
      ...(expectedRevision !== undefined ? { expectedRevision } : {}),
    };
    const quote =
      typeof input.state.facts.latest_captain_reply === "string"
        ? input.state.facts.latest_captain_reply
        : "";
    const sourceTask = input.source.taskId
      ? this.options.tasks.get(input.source.taskId)
      : input.source.cardId
        ? this.options.tasks.capture.taskForCard(input.source.cardId)
        : undefined;
    const sourceLink = sourceTask?.key
      ? `<p>From your correction on <a href="#" data-inf-task="${escapeCardText(sourceTask.key)}">${escapeCardText(sourceTask.key)}</a>.</p>`
      : "<p>From your correction in the main conversation.</p>";
    const card: EmittedCardInput = {
      id: cardId,
      title: CORRECTION_OFFER_WORDS.title,
      continues: true,
      ...(request.reply ? { reply: request.reply } : {}),
      ...(request.answersMessage !== undefined ? { answersMessage: request.answersMessage } : {}),
      body:
        `<p>Keep this instruction for <strong>${escapeCardText(project.name)}</strong>?</p>${sourceLink}` +
        (existing
          ? `<p>Current wording</p><blockquote>${escapeCardText(existing.text)}</blockquote><p>Proposed wording</p>`
          : "") +
        `<blockquote style="white-space:pre-wrap">${escapeCardText(offer.text)}</blockquote><p>Reply to change the wording before keeping it.</p>` +
        `<details><summary>Your correction</summary><p>${escapeCardText(quote)}</p></details>`,
      actions: [
        { id: offer.declineActionId, label: CORRECTION_OFFER_WORDS.decline, declines: true },
        { id: offer.keepActionId, label: CORRECTION_OFFER_WORDS.keep, default: true },
      ],
    };
    this.options.inbox.transaction(() => {
      if (this.options.cards.chosenAction(cardId) !== undefined) this.options.cards.reopen(cardId);
      const actualId = this.options.supervisor.cards.addFirstmateCard(card);
      if (actualId !== cardId)
        throw new Error("The offer's stable card identity was not preserved.");
      const published = this.options.cards.get(cardId);
      this.save(request.inputId, {
        ...input,
        offer: { ...offer, cardOfferId: published?.offerId },
        previousOffers: input.offer ? [...(input.previousOffers ?? []), input.offer] : [],
        choiceOfferId: undefined,
        explicitSourceId: undefined,
      });
      const own = this.options.tasks.capture.openCardTaskFor(cardId);
      if (!own)
        this.options.tasks.capture.fileHostCardTask({
          id: randomUUID(),
          title: card.title,
          cardId,
        });
      else this.options.tasks.placement.setGate(own.id, { kind: "captain", ref: cardId });
    });
    return {
      status: "offered",
      cardId,
      direction: {
        id: offer.directionId,
        text: offer.text,
        scope: offer.projectId,
        expectedRevision: offer.expectedRevision,
      },
    };
  }

  /** Called after the existing writer's successful readback; never discover cases by their wording. */
  saved(directionId: string): void {
    for (const { id, input } of this.pending())
      if (input.offer?.directionId.replace(/^d:/, "") === directionId.replace(/^d:/, ""))
        this.recover(id, input);
  }
  /**
   * Ask the first mate to save the captain's choice, once per chosen offer.
   * The retry is the one more ask after a turn on the first ended without the
   * save landing: a new fact, with its own facts and name, and never a third.
   */
  private queueSelected(id: number, input: CorrectionInput, selected: string, retry = false): void {
    this.options.inbox.enqueueWake(
      FIRSTMATE_RECIPIENT,
      {
        facts: {
          kind: "correction-review",
          inputId: id,
          source: input.source,
          selected: true,
          ...(retry ? { retry: true as const } : {}),
        },
        once: `correction-save${retry ? "-retry" : ""}:${selected}`,
      },
      "agent",
      input.source.key,
    );
  }
  /** An ask to save this case still waits on the first mate, or its turn holds it. */
  private asking(id: number): boolean {
    return [
      ...this.options.inbox.allFor(FIRSTMATE_RECIPIENT),
      ...this.options.inbox.inFlight(FIRSTMATE_RECIPIENT),
    ].some(
      (row) =>
        row.facts?.kind === "correction-review" &&
        row.facts.inputId === id &&
        row.facts.selected === true,
    );
  }
  /** The chosen save has not landed: the direction still reads as it did when offered. */
  private unwritten(offer: CorrectionOffer): boolean {
    if (!this.options.project(offer.projectId)) return false;
    const actual = this.options.direction(offer.directionId);
    return offer.expectedRevision === undefined
      ? actual === undefined
      : actual?.retired !== true && actual?.revision === offer.expectedRevision;
  }
  /** An open case's offer card, whose own thread answers that offer's wording. */
  offering(cardId: string): boolean {
    return this.pending().some(({ input }) => input.offer?.cardId === cardId);
  }
  /**
   * The Settings purge (D-13): every pending check and case goes with the
   * captain's words it holds. A chosen offer's operation has no gate naming
   * its card, so that card's evidence goes here too.
   */
  purge(): void {
    const pending = this.pending();
    const reviews = [
      ...this.options.inbox.allFor(FIRSTMATE_RECIPIENT),
      ...this.options.inbox.inFlight(FIRSTMATE_RECIPIENT),
    ].filter((row) => row.facts?.kind === "correction-review");
    this.options.inbox.ack(reviews.map((row) => row.id));
    this.options.consumer.purge();
    this.options.supervisor.cards.purgeEvidence(
      pending.flatMap(({ input }) => (input.offer ? [input.offer.cardId] : [])),
    );
  }
  /**
   * What became of an instruction the captain chose to keep, said on its
   * offer card and where their reply was: that card, or its task's record.
   */
  private tell(input: CorrectionInput, offerCardId: string, text: string): void {
    this.options.supervisor.cards.addMessage(offerCardId, "firstmate", text);
    if (input.source.cardId && input.source.cardId !== offerCardId)
      this.options.supervisor.cards.addMessage(input.source.cardId, "firstmate", text);
    else if (input.source.taskId)
      this.options.tasks.note(input.source.taskId, text, {
        actor: "firstmate",
        feed: false,
        news: false,
      });
  }
  private withdrawOffer(input: CorrectionInput, reason: string): void {
    if (!input.offer) return;
    if (this.options.supervisor.cards.has(input.offer.cardId))
      this.options.supervisor.cards.close(input.offer.cardId, { kind: "firstmate" }, reason);
    const own = this.options.tasks.capture.openCardTaskFor(input.offer.cardId);
    if (own)
      this.options.tasks.close(own.id, {
        status: "done",
        reason: "answered",
        actor: "firstmate",
        text: reason,
        feed: false,
      });
  }
  private recover(id: number, input: CorrectionInput): unknown {
    const pendingOffer = input.offer;
    if (!pendingOffer) return { status: "review-pending" };
    if (!this.options.project(pendingOffer.projectId))
      return {
        status: "not-kept",
        reason: "The named project is no longer available; the save remains pending.",
      };
    let offer = pendingOffer;
    const keepActionId = offer.keepActionId;
    const closing = this.options.cards
      .observations(offer.cardId)
      .findLast(
        (entry) =>
          entry.kind === "action" &&
          entry.actor === "captain" &&
          entry.payload.closes &&
          entry.payload.actionId === keepActionId,
      );
    const choice = input.choiceOfferId ?? closing?.offerId;
    const chosen = [offer, ...(input.previousOffers ?? [])].find(
      (entry) => entry.cardOfferId === choice,
    );
    const explicit = input.explicitSourceId
      ? this.options.cards.captainInput(input.explicitSourceId)
      : undefined;
    const explicitlyRequested = Boolean(explicit?.text && explicit.cardId === offer.cardId);
    if ((!choice || !chosen) && !explicitlyRequested)
      return {
        status: "choice-pending",
        reason: "The exact displayed offer is not yet confirmed.",
      };
    offer = explicitlyRequested ? offer : (chosen ?? offer);
    const changedBinding =
      input.choiceOfferId !== choice || input.offer?.cardOfferId !== offer.cardOfferId;
    input = { ...input, offer, ...(choice ? { choiceOfferId: choice } : {}) };
    if (changedBinding) this.save(id, input);
    if (
      !explicitlyRequested &&
      this.options.cards.chosenAction(offer.cardId) !== offer.keepActionId
    )
      return { status: "choice-pending" };
    if (!this.options.project(offer.projectId))
      return { status: "not-kept", reason: "The project was removed." };
    const actual = this.options.direction(offer.directionId);
    if (
      !actual ||
      actual.retired === true ||
      actual.text !== offer.text ||
      actual.scope !== offer.projectId ||
      actual.revision !== (offer.expectedRevision === undefined ? 1 : offer.expectedRevision + 1)
    )
      return {
        status: "not-kept",
        directionId: offer.directionId,
        expectedRevision: offer.expectedRevision,
        message: "Read the direction before retrying. A newer revision must not be overwritten.",
      };
    if (!offer.savedRevision) {
      const project = this.options.project(offer.projectId);
      this.options.inbox.transaction(() => {
        this.save(id, { ...input, offer: { ...offer, savedRevision: actual.revision } });
        if (explicitlyRequested) {
          const open = this.options.cards.get(offer.cardId);
          if (open && this.options.supervisor.cards.has(offer.cardId))
            this.options.supervisor.cards.resolve(
              open,
              offer.keepActionId,
              offer.keepActionId,
              undefined,
              "firstmate",
            );
        }
        const row = this.options.tasks.capture.openCardTaskFor(offer.cardId);
        if (row)
          this.options.tasks.close(row.id, {
            status: "done",
            reason: "answered",
            actor: "firstmate",
            text: "the direction was saved and read back",
            feed: false,
          });
        this.tell(
          input,
          offer.cardId,
          keptProjectDirection(project?.name ?? "this project", actual.text),
        );
      });
    }
    return {
      status: "kept",
      direction: actual,
      next: "Declare only affected running task ids with guide, or an empty list when none need immediate guidance.",
    };
  }
  private async guide(request: CorrectionCaseRequest, input: CorrectionInput): Promise<unknown> {
    const offer = input.offer;
    if (!offer?.savedRevision)
      throw new Error("Recover and verify the saved direction before guidance.");
    const verifyCurrent = () => {
      const current = this.options.direction(offer.directionId);
      if (
        !current ||
        current.retired ||
        current.revision !== offer.savedRevision ||
        current.text !== offer.text ||
        current.scope !== offer.projectId
      )
        throw new Error(
          "The direction changed after saving; read its current wording before guiding work.",
        );
    };
    verifyCurrent();
    if (request.affectedTaskIds === undefined)
      throw new Error("Declare affected task ids, or an explicit empty list.");
    const sent: string[] = [];
    for (const id of new Set(request.affectedTaskIds)) {
      const task = this.options.tasks.get(id);
      if (!task || task.status !== "active" || task.repoId !== offer.projectId) continue;
      const once = `kept-direction:${offer.directionId}:${offer.savedRevision}`;
      if (this.options.inbox.woken(id, once)) continue;
      verifyCurrent();
      await this.options.supervisor.steer.steerInternal(
        id,
        {
          facts: {
            kind: "kept-project-direction",
            id: offer.directionId,
            revision: offer.savedRevision,
            text: offer.text,
          },
          once,
        },
        { actor: "firstmate", via: "tool", decision: null, cardId: offer.cardId },
      );
      sent.push(id);
    }
    this.finish(request.inputId);
    return { status: "complete", told: sent };
  }
  sweep(): void {
    for (const { id, input } of this.pending()) {
      const offer = input.offer;
      if (!offer) continue;
      const choice = this.options.cards.chosenAction(offer.cardId);
      if (
        !this.options.project(offer.projectId) &&
        choice !== offer.keepActionId &&
        !input.explicitSourceId
      ) {
        this.withdrawOffer(input, "The named project is no longer available.");
        this.finish(id);
        continue;
      }
      if (choice === offer.declineActionId) {
        this.finish(id);
        continue;
      }
      if (choice === offer.keepActionId || input.explicitSourceId) {
        const result = this.recover(id, input) as { status: string };
        const current = this.options.consumer.input(id);
        const selected = current?.choiceOfferId ?? input.explicitSourceId;
        if (
          result.status === "not-kept" &&
          selected &&
          this.unwritten(current?.offer ?? offer) &&
          !this.asking(id)
        )
          this.queueSelected(
            id,
            input,
            selected,
            this.options.inbox.woken(input.source.key, `correction-save:${selected}`),
          );
        if (result.status === "kept")
          this.options.inbox.enqueueWake(
            FIRSTMATE_RECIPIENT,
            {
              facts: { kind: "correction-review", inputId: id, source: input.source, saved: true },
              once: "correction-guidance",
            },
            "agent",
            input.source.key,
          );
      } else if (
        this.options.supervisor.cards.has(offer.cardId) &&
        !this.options.tasks.capture.openCardTaskFor(offer.cardId)
      ) {
        this.options.tasks.capture.fileHostCardTask({
          id: randomUUID(),
          title: CORRECTION_OFFER_WORDS.title,
          cardId: offer.cardId,
        });
      }
    }
  }
}
