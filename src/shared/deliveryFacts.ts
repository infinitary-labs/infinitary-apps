import { z } from "zod";

/**
 * The delivery facts a done close records (INF-3169's plan, piece 2;
 * docs/task-record.md, "One close as done"): each fact the close could
 * read about where the work went, marked as checked by the app, as stated
 * by the first mate, or as unread when the app could not read it. A fact
 * the app cannot read is recorded as unread and never stops the close.
 */
export type DeliveryFactBasis = "checked" | "stated" | "unread";

export type DeliveryFactKind =
  /** A pull request the close named, or one of the task's own. */
  | "pull-request"
  /** A commit the close named on the main branch. */
  | "commit"
  /** The task's working copy: commits and uncommitted edits, saved by the close. */
  | "work"
  /** The task that carries this one's work on. */
  | "carrier"
  /** Where an answer went: a task built on it, or its report. */
  | "answer"
  /** The open parts that stay planned. */
  | "parts"
  /** A release or result the first mate named. */
  | "evidence";

export type DeliveryFact = {
  kind: DeliveryFactKind;
  basis: DeliveryFactBasis;
  /** The fact in the captain's words, as the record shows it. */
  text: string;
};

/** Why a done close says the work is done (`settle_task` mode done's `why`). */
export const DONE_WHYS = ["answered", "finished", "released", "carried_on", "merged"] as const;
export type DoneWhy = (typeof DONE_WHYS)[number];

/** The facts a close recorded, read back from its timeline event's data; empty for any other close. */
export function deliveryFactsOf(data: Record<string, unknown> | undefined): DeliveryFact[] {
  const facts = data?.deliveryFacts;
  if (!Array.isArray(facts)) return [];
  return facts.filter(
    (fact): fact is DeliveryFact =>
      typeof fact === "object" &&
      fact !== null &&
      typeof (fact as DeliveryFact).text === "string" &&
      ["checked", "stated", "unread"].includes((fact as DeliveryFact).basis),
  );
}

/**
 * A delivery fact as the task record shows it (INF-3169's plan, piece 3):
 * its words and how the app knows it. The kind stays on the close event.
 */
export const recordDeliveryFactSchema = z.object({
  basis: z.enum(["checked", "stated", "unread"]),
  text: z.string().min(1),
});
export type RecordDeliveryFact = z.infer<typeof recordDeliveryFactSchema>;

/** The micro label over the facts on the record. */
export const DELIVERY_FACTS_LABEL = "Delivered";

/** How the record says each fact is known. */
export const DELIVERY_BASIS_WORDS: Record<DeliveryFactBasis, string> = {
  checked: "Checked",
  stated: "As stated",
  unread: "Not read",
};
