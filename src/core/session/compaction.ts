import type { SessionSpec } from "./session";

/** Captain’s INF-447 ruling: app-owned for now, not a user setting. */
export const SESSION_COMPACTION_TOKENS = 300_000;

/**
 * The one automatic summary rule every Pi conversation of the first mate and
 * the crew carries (INF-6693): summarize at `SESSION_COMPACTION_TOKENS`, or
 * before a request would cross the model's first usable price step, where
 * every input token costs more, when that comes sooner. Claude sessions take
 * the same point through the client's own window (`CLAUDE_COMPACTION_SETTINGS`).
 */
export const SESSION_COMPACTION = {
  maxContextTokens: SESSION_COMPACTION_TOKENS,
  belowPriceStep: true,
} as const satisfies NonNullable<SessionSpec["compaction"]>;
