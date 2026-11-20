import { createHash } from "node:crypto";
import type { DecisionState } from "@shared/decisions";
import type { DecisionStore } from "../storage/decisionStore";
import { FIRSTMATE_RECIPIENT, type InboxStore } from "../storage/inboxStore";
import { CORRECTION_QUESTION } from "./correctionQuestion";
import {
  type CorrectionInput,
  type CorrectionSource,
  correctionInputSchema,
} from "./correctionTypes";
import type { DecisionModels } from "./decisionModel";

export const CORRECTION_QUESTIONS = "correction-questions";
export const CORRECTION_CASES = "correction-cases";

/** Durable work only; neither its model nor its receipt can write a direction. */
export class CorrectionConsumer {
  private busy = false;
  private stopped = false;
  private controller: AbortController | undefined;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly options: {
      inbox: InboxStore;
      ledger: DecisionStore;
      models: Pick<DecisionModels, "decide" | "allowsUse">;
      exists: (source: CorrectionSource) => boolean;
      now: () => number;
    },
  ) {
    options.inbox.reserveServiceRecipient(CORRECTION_QUESTIONS);
    options.inbox.reserveServiceRecipient(CORRECTION_CASES);
    this.unsubscribe = options.inbox.onChange(() => void this.drain());
  }

  enqueue(source: CorrectionSource, state: DecisionState): void {
    if (this.stopped || !this.options.models.allowsUse("reply-checks")) return;
    if (this.options.ledger.correction(source.key)) return;
    this.options.inbox.enqueueWake(
      CORRECTION_QUESTIONS,
      {
        facts: { kind: "correction-input", source, state },
        once: "correction-input",
      },
      "agent",
      source.key,
    );
  }

  /** Withdraw pending automatic work as well as the request currently in flight. */
  withdraw(): void {
    this.controller?.abort();
    const rows = this.options.inbox.allFor(CORRECTION_QUESTIONS);
    const discarded = this.options.inbox.allFor(CORRECTION_CASES).filter((row) => {
      const parsed = correctionInputSchema.safeParse(row.facts);
      return parsed.success && !parsed.data.offer;
    });
    const ids = new Set(discarded.map((row) => row.id));
    const reviews = this.options.inbox
      .allFor(FIRSTMATE_RECIPIENT)
      .filter((row) => row.facts?.kind === "correction-review" && ids.has(row.facts.inputId));
    this.options.inbox.ack([...rows, ...discarded, ...reviews].map((row) => row.id));
  }

  async drain(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (;;) {
        const row = this.options.inbox.pending(CORRECTION_QUESTIONS, this.options.now(), {
          limit: 1,
        })[0];
        if (!row || this.stopped) break;
        const parsed = correctionInputSchema.safeParse(row.facts);
        if (
          !parsed.success ||
          this.options.ledger.correction(parsed.data.source.key) ||
          !this.options.models.allowsUse("reply-checks") ||
          !this.options.exists(parsed.data.source)
        ) {
          this.options.inbox.ack([row.id]);
          continue;
        }
        const input = parsed.data;
        this.options.inbox.markDelivered([row.id]);
        const controller = new AbortController();
        this.controller = controller;
        const answers = await this.options.models.decide(
          {
            purpose: "Reply checks",
            use: "reply-checks",
            ...(input.source.taskId ? { taskId: input.source.taskId } : {}),
          },
          input.state,
          { correction: CORRECTION_QUESTION },
          controller.signal,
        );
        if (this.stopped) break;
        const answer = answers.correction;
        this.options.ledger.transaction(() => {
          if (!this.options.inbox.get(row.id)) return;
          if (
            !answer ||
            controller.signal.aborted ||
            !this.options.models.allowsUse("reply-checks") ||
            !this.options.exists(input.source)
          ) {
            this.options.inbox.ack([row.id]);
            return;
          }
          if (!this.options.ledger.correction(input.source.key)) {
            this.options.ledger.recordCorrection({
              sourceKey: input.source.key,
              taskId: input.source.taskId,
              at: this.options.now(),
              questionId: "correction",
              stateSha: createHash("sha256").update(JSON.stringify(input.state)).digest("hex"),
              answer,
            });
            if (answer.outcome === "answered" && answer.value === "review") {
              // Keep the bounded source packet only while this case is being handled.
              this.options.inbox.reassign([row.id], CORRECTION_CASES);
              this.options.inbox.enqueueWake(
                FIRSTMATE_RECIPIENT,
                {
                  facts: { kind: "correction-review", inputId: row.id, source: input.source },
                  once: "correction-review",
                },
                "agent",
                input.source.key,
              );
              return;
            }
          }
          this.options.inbox.ack([row.id]);
        });
      }
    } finally {
      this.controller = undefined;
      this.busy = false;
    }
  }

  input(id: number): CorrectionInput | undefined {
    const row = this.options.inbox.get(id);
    if (row?.recipient !== CORRECTION_CASES) return undefined;
    const parsed = correctionInputSchema.safeParse(row.facts);
    return parsed.success ? parsed.data : undefined;
  }
  /** The Settings purge: every queued check and case goes, the request in flight included. */
  purge(): void {
    this.controller?.abort();
    this.options.inbox.deleteFor(CORRECTION_QUESTIONS);
    this.options.inbox.deleteFor(CORRECTION_CASES);
  }
  complete(id: number): void {
    this.options.inbox.ack([id]);
  }
  dispose(): void {
    this.stopped = true;
    this.controller?.abort();
    this.unsubscribe();
  }
}
