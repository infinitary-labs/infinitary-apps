/**
 * The character emotes the Firstmate agent may ask for, in one place: the
 * `emote` tool's parameter, the `firstmate_emote` event and the renderer's
 * character all read this list.
 *
 * The reply emotes are the short acknowledgements for the replies that
 * carry no card (captain's board verdict, 2026-09-22): nod "got it", salute
 * "on it", tick "all set", tuck "noted", aww "any time". They are drawn in
 * `src/renderer/src/character/replies.ts`, and one asked for during the
 * Firstmate's own turn plays as that turn ends. The ones the host fires
 * itself carry the words of AUTOMATIC_EMOTE_WORDS below.
 */
export const REPLY_EMOTES = ["nod", "salute", "tick", "tuck", "aww"] as const;

export type ReplyEmote = (typeof REPLY_EMOTES)[number];

export const FIRSTMATE_EMOTES = [
  "greet",
  "celebrate",
  "ponder",
  "confused",
  "fidget",
  ...REPLY_EMOTES,
] as const;

export type AgentEmote = (typeof FIRSTMATE_EMOTES)[number];

export const isReplyEmote = (name: string): name is ReplyEmote =>
  (REPLY_EMOTES as readonly string[]).includes(name);

/**
 * The idle fidget pool the character draws from (renderer
 * character/machine.ts, which owns the draw order and durations).
 */
export type FidgetVariant =
  | "roll"
  | "yawn"
  | "orbit"
  // The sky fidgets (renderer character/sky.ts): the captain's picks from
  // the eleven-fidget prototype review, 2026-09-29.
  | "orion"
  | "dipper"
  | "saturn"
  | "galaxy"
  | "algol"
  | "blackhole";

/**
 * The words of the reply emotes the host fires itself on a captain turn
 * (FirstmateAgent.replyEmote): a steer delivered nods, a note kept tucks, a
 * personalize or app change applied ticks. The first of them in a turn is
 * its reply line beside the captain's message when the Firstmate gave no
 * words, card or started work of its own (core orchestrator/replyLine.ts,
 * docs/composer.md "The last turn"). Each is clean and within
 * EMOTE_WORDS_MAX by the shared rule (`emoteWords`; emotes.test.ts).
 */
export const AUTOMATIC_EMOTE_WORDS = {
  nod: "Got it",
  tuck: "Noted",
  tick: "All set",
} as const satisfies Record<HostReplyEmote, string>;

/** The reply emotes the host fires itself, each with its own words. */
export type HostReplyEmote = "nod" | "tuck" | "tick";

/**
 * The most words an emote may carry, in characters (Unicode code points):
 * the captain's choice of 40 on FI3-622's plan, which fits one line in the
 * narrowest docked stage.
 */
export const EMOTE_WORDS_MAX = 40;

/**
 * The words an emote carries, by the one rule the `emote` tool and the
 * `firstmate_emote` event read: trimmed, every
 * whitespace run (line breaks included) one space, control characters
 * dropped, counted in code points. Empty after that is no words; past
 * EMOTE_WORDS_MAX is refused, never cut short.
 */
export type EmoteWords =
  | { kind: "none" }
  | { kind: "words"; text: string }
  | { kind: "too-long"; length: number };

export function emoteWords(raw: string | undefined): EmoteWords {
  const text = (raw ?? "")
    .replace(/\s+/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!text) return { kind: "none" };
  const length = [...text].length;
  return length > EMOTE_WORDS_MAX ? { kind: "too-long", length } : { kind: "words", text };
}
