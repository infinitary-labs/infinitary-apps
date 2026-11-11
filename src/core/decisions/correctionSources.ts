import type { DomNode } from "@shared/cardHeadings";
import { cardWords } from "@shared/cardWords";
import { parseDocument } from "htmlparser2";
import type { CaptainCardInput, CardStore } from "../storage/cardStore";
import type { TaskRecord } from "../storage/taskRecords";
import type { CorrectionConsumer } from "./correctionConsumer";
import { excerptCorrectionCard } from "./correctionContext";
import { type CorrectionContext, correctionState } from "./correctionQuestion";
import type { CorrectionSource } from "./correctionTypes";

/**
 * How much one reply check sends: the whole question, conversation included,
 * and the card text inside it. A size chosen for a cheap question, which the
 * approval screen does not promise; an oversized exact reply is not sent.
 */
export const CORRECTION_EXCERPT_BYTE_LIMIT = 12_000;
export const CORRECTION_CARD_BYTE_LIMIT = 4_000;

/** Physical content omitted by plain-text projection, never a judgment about its importance. */
function nonText(body: string): boolean {
  const omitted = new Set(["svg", "img", "canvas", "video", "audio", "iframe", "object", "script"]);
  const walk = (nodes: DomNode[]): boolean =>
    nodes.some((node) => omitted.has(node.name?.toLowerCase() ?? "") || walk(node.children ?? []));
  return walk(parseDocument(body).children as unknown as DomNode[]);
}

export class CorrectionSources {
  constructor(
    private readonly options: {
      consumer: Pick<CorrectionConsumer, "enqueue">;
      allowed: () => boolean;
      /** An open offer's own card: a reply there answers that offer's wording, not a new check. */
      offerCard?: (cardId: string) => boolean;
      cards: CardStore;
      task: (id: string) => TaskRecord | undefined;
      project: (id: string) => { id: string; name: string } | undefined;
      taskExchange?: (id: string) => {
        preceding: CorrectionContext["preceding"];
        unavailableContext: boolean;
      };
    },
  ) {}

  private submit(source: CorrectionSource, context: CorrectionContext): void {
    if (!this.options.allowed() || !context.latestReply.trim()) return;
    const task = source.taskId ? this.options.task(source.taskId) : undefined;
    if (task) {
      context.task = { title: task.title, ...(task.goal ? { goal: task.goal } : {}) };
      context.project = task.repoId ? this.options.project(task.repoId) : undefined;
    }
    const state = correctionState(
      excerptCorrectionCard(context, CORRECTION_CARD_BYTE_LIMIT),
      CORRECTION_EXCERPT_BYTE_LIMIT,
    );
    // Never truncate the exact latest reply to manufacture a fitting question.
    if (state) this.options.consumer.enqueue(source, state);
  }

  card(input: CaptainCardInput): void {
    if (!this.options.allowed() || this.options.offerCard?.(input.cardId)) return;
    const context: CorrectionContext = {
      latestReply: input.text,
      preceding: [],
      precedingSource: "same-thread",
      unavailableContext: input.contextMissing,
    };
    let used = 0;
    for (const row of this.options.cards.originalMessagesBefore(
      input.cardId,
      input.precedingMessageId,
    )) {
      if (row.text === undefined) {
        context.unavailableContext = true;
        break;
      }
      const entry = {
        who:
          row.who === "captain"
            ? ("captain" as const)
            : row.who === "host"
              ? ("host" as const)
              : ("author" as const),
        text: row.text,
      };
      used += Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (used > CORRECTION_EXCERPT_BYTE_LIMIT) {
        context.unavailableContext = true;
        break;
      }
      context.preceding.unshift(entry);
    }
    const offer = input.offerId ? this.options.cards.offer(input.cardId, input.offerId) : undefined;
    if (offer) {
      context.addressedCard = { title: offer.payload.title, text: cardWords(offer.payload.body) };
      context.unavailableContext ||=
        nonText(offer.payload.body) || Boolean(offer.payload.pictures?.length);
    } else context.unavailableContext = true;
    this.submit(
      {
        key: `card:${input.sourceId}`,
        kind: "card",
        cardId: input.cardId,
        observationId: input.sourceId,
        at: input.at,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      },
      context,
    );
  }

  composer(
    source: CorrectionSource,
    text: string,
    before: Iterable<{ text: string | undefined; reply: string | undefined }>,
  ): void {
    if (!this.options.allowed()) return;
    const context: CorrectionContext = {
      latestReply: text,
      preceding: [],
      precedingSource: "recent-conversation",
      unavailableContext: false,
    };
    let used = 0;
    for (const turn of before) {
      const entries: CorrectionContext["preceding"] = [];
      if (turn.text !== undefined) entries.push({ who: "captain", text: turn.text });
      if (turn.reply) entries.push({ who: "author", text: turn.reply });
      else context.unavailableContext = true;
      used += Buffer.byteLength(JSON.stringify(entries), "utf8");
      if (used > CORRECTION_EXCERPT_BYTE_LIMIT) {
        context.unavailableContext = true;
        break;
      }
      context.preceding.unshift(...entries);
      if (turn.text === undefined) {
        context.unavailableContext = true;
        break;
      }
    }
    this.submit(source, context);
  }

  crewmate(source: CorrectionSource, text: string): void {
    if (!this.options.allowed()) return;
    // Read only the existing task's nearest original input and plain report, never a transcript.
    const exchange = source.taskId ? this.options.taskExchange?.(source.taskId) : undefined;
    this.submit(source, {
      latestReply: text,
      preceding: exchange?.preceding ?? [],
      precedingSource: "same-thread",
      unavailableContext: exchange?.unavailableContext ?? true,
    });
  }
}
