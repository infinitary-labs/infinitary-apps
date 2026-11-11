import { cutText } from "@shared/textCut";
import { z } from "zod";

/**
 * The bounded digest of the Firstmate's recent turns that a seat move
 * carries across (the owner's Q4 b, W1 S9; docs/architecture.md §16 "A
 * paused seat"). Each backend keeps its own rolling session - the two
 * transcript formats do not carry across - so the first turn after a move
 * that changed sessions is told, as typed facts on its `seat-moved` wake,
 * what the host itself saw of the turns it cannot read back: who each one
 * answered, the captain's words, the tools it called and its closing words.
 * Never a copy of the other backend's transcript: every field is what the
 * host observed on its own seam, and every one is capped here.
 *
 * The bound: at most `SEAT_DIGEST_TURNS` turns ride one wake, each quoted
 * excerpt is at most `SEAT_DIGEST_EXCERPT_CHARS` characters, and a turn
 * names at most `SEAT_DIGEST_TOOLS` tools - so the whole seat-moved wake
 * stays under 5,500 characters, however long the turns were (measured at
 * the worst case in `seatDigest.test.ts`). The record keeps
 * `SEAT_DIGEST_KEPT` turns, so a move back still finds the turns its
 * target has not seen.
 */

export const SEAT_DIGEST_TURNS = 6;
export const SEAT_DIGEST_EXCERPT_CHARS = 280;
export const SEAT_DIGEST_TOOLS = 8;
export const SEAT_DIGEST_KEPT = 12;

/** One recent Firstmate turn as the host recorded it, capped. */
export type SeatDigestTurn = {
  /** Who the turn answered: the captain's words, or operational updates alone. */
  trigger: "captain" | "operation";
  /** The captain's words it answered, capped. */
  asked?: string;
  /** The tools it called, in first-call order, without repeats. */
  tools: string[];
  /** Its closing words, capped. */
  said?: string;
  /** The turn failed before it finished. */
  failed?: boolean;
};

/** A digest turn on the record: which seat's session served it, and when. */
export type SeatDigestEntry = SeatDigestTurn & {
  /** The session that served it (`<backend>:<session id>`). */
  seat: string;
  at: number;
};

const seatDigestTurnSchema = z.object({
  trigger: z.enum(["captain", "operation"]),
  asked: z.string().optional(),
  tools: z.array(z.string()),
  said: z.string().optional(),
  failed: z.boolean().optional(),
});

export const seatDigestEntrySchema = seatDigestTurnSchema.extend({
  seat: z.string(),
  at: z.number(),
});

/** A session's identity on the record: the backend and the session it resumes. */
export function seatIdentity(backend: string, sessionId: string): string {
  return `${backend}:${sessionId}`;
}

/** One turn as the record keeps it: every excerpt and the tool list capped. */
export function digestEntry(input: {
  seat: string;
  at: number;
  trigger: "captain" | "operation";
  asked?: readonly string[];
  tools: readonly string[];
  said?: string;
  failed: boolean;
}): SeatDigestEntry {
  const asked = excerpt((input.asked ?? []).join(" / "));
  const said = excerpt(input.said ?? "");
  return {
    seat: input.seat,
    at: input.at,
    trigger: input.trigger,
    ...(asked ? { asked } : {}),
    tools: [...new Set(input.tools)].slice(0, SEAT_DIGEST_TOOLS),
    ...(said ? { said } : {}),
    ...(input.failed ? { failed: true } : {}),
  };
}

/** The record with one more turn, oldest dropped past `SEAT_DIGEST_KEPT`. */
export function appendDigest(
  entries: readonly SeatDigestEntry[],
  entry: SeatDigestEntry,
): SeatDigestEntry[] {
  return [...entries, entry].slice(-SEAT_DIGEST_KEPT);
}

/**
 * The turns a session has not seen, for the wake that moves the seat onto
 * it: those served elsewhere since that session's own last turn, the
 * newest `SEAT_DIGEST_TURNS` of them, oldest first.
 */
export function digestFor(entries: readonly SeatDigestEntry[], seat: string): SeatDigestTurn[] {
  let from = 0;
  entries.forEach((entry, index) => {
    if (entry.seat === seat) from = index + 1;
  });
  return entries
    .slice(from)
    .slice(-SEAT_DIGEST_TURNS)
    .map(({ seat: _seat, at: _at, ...turn }) => turn);
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SEAT_DIGEST_EXCERPT_CHARS) return flat;
  return `${cutText(flat, SEAT_DIGEST_EXCERPT_CHARS - 1).trimEnd()}…`;
}
