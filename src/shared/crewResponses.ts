import { z } from "zod";

/** Explicit correlation, shared by both model adapters and work transport (INF-2214). */
export const crewResponseSchema = z.object({
  requestId: z.string().min(1),
  responseId: z.string().min(1),
  status: z.enum(["answered", "not-yet-answered"]),
});
export type CrewResponse = z.infer<typeof crewResponseSchema>;

export type ResponsePolicy = {
  mode: "expected" | "guidance-only";
  cancel?: string[];
  card?: { id: string; lifecycle: string; messageId: number };
  sourceSession?: string | null;
};

export type ResponseRequest = {
  id: string;
  inboxId: number;
  sourceSession: string | null;
  sourceMessage: string | null;
  targetTask: string;
  targetSession: string | null;
  body: string;
  card: { id: string; lifecycle: string; messageId: number } | null;
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
