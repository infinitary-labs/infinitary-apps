import { z } from "zod";

/** Explicit correlation, shared by both model adapters and work transport (INF-2214). */
export const crewResponseSchema = z.object({
  requestId: z.string().min(1),
  responseId: z.string().min(1),
  status: z.enum(["answered", "not-yet-answered"]),
});
export type CrewResponse = z.infer<typeof crewResponseSchema>;

/** The captain's card message a request concerns, in the card's lifecycle when it was asked. */
export type ResponseCard = { id: string; lifecycle: string; messageId: number };

export type ResponsePolicy = {
  mode: "expected" | "guidance-only";
  cancel?: string[];
  card?: ResponseCard;
  sourceSession?: string | null;
  /**
   * The captain's message the request was asked for, by its saved id: the
   * message waits for the answer and is due when it comes back
   * (docs/task-capture.md "How a message ends").
   */
  ask?: string;
};

/**
 * A response policy as a steer asks it: its card may leave out the
 * lifecycle, which the host fills with the card's current one, since the
 * first mate is never shown a card's lifecycle (INF-4165 finding 6).
 */
export type AskedResponsePolicy = Omit<ResponsePolicy, "card"> & {
  card?: Omit<ResponseCard, "lifecycle"> & { lifecycle?: string };
};

export type ResponseRequest = {
  id: string;
  inboxId: number;
  sourceSession: string | null;
  sourceMessage: string | null;
  targetTask: string;
  targetSession: string | null;
  body: string;
  card: ResponseCard | null;
  state: "pending" | "answered" | "cancelled";
  createdAt: number;
};

export type SavedCrewResponse = CrewResponse & {
  contributorTask: string;
  contributorSession: string | null;
  text: string;
  at: number;
  wakeId: number;
  /** A backend input-read witness, not merely an attempted prompt. */
  deliveredAt: number | null;
  /** A clean handling acknowledgement, not correctness or understanding. */
  handledAt: number | null;
  /** The card thread line that carried it, when a reply did (major 15). */
  cardMessageId?: number;
};
