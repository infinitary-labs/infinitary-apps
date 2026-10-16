/**
 * The replay window (`--from` / `--to`): one evening out of a userData that
 * has been recording since August. The rule is the one that reproduced the
 * real Sep 14 session turn for turn (fable review, report section 2.2):
 *
 * - JSONL: keep every entry that is not a `message` (`session`,
 *   `model_change`, `thinking_level_change`, `custom`, ...), and a `message`
 *   only when its timestamp falls inside the window. The readers walk lines
 *   in order and a crewmate segment opens at each user message, so dropping
 *   messages by timestamp never splits a turn the window keeps. A
 *   Claude-served session, the seat's or a crewmate's (its dialect read off
 *   its first line by the one session reader), is trimmed by the same rule
 *   over the client's conversation lines - `user`, `assistant` and
 *   `attachment`.
 * - Crewmate sessions: only those with a message inside the window.
 * - Tables: every `tasks` row (a task created before the window is the state
 *   the evening started from), and the `cards` created or resolved inside
 *   it, plus the `supervision_outcomes`, `captain_asks` and card-thread
 *   messages (`card_messages`) inside it.
 *
 * Both ends are inclusive; a missing end is open. Plain Node can load this
 * module (the CLI imports it before the engine's Vite runner exists).
 */

import { readFileSync } from "node:fs";
import { readSession, sessionDialectOf } from "../../src/core/storage/sessionReader.ts";
import { numberColumn, type RecordedTables } from "../recorded-tables.ts";

export type ReplayWindow = { from: number | null; to: number | null };

/** An ISO time (or epoch milliseconds) for `--from` / `--to`. */
export function parseWindowBound(raw: string, flag: string): number {
  const at = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(at)) throw new Error(`${flag} needs an ISO time, got ${raw}`);
  return at;
}

export function windowOf(from: number | null, to: number | null): ReplayWindow | null {
  if (from === null && to === null) return null;
  if (from !== null && to !== null && from > to) {
    throw new Error("--from must not be later than --to");
  }
  return { from, to };
}

export function inWindow(at: number | null, window: ReplayWindow): boolean {
  if (at === null) return false;
  return (window.from === null || at >= window.from) && (window.to === null || at <= window.to);
}

function entryTime(entry: Record<string, unknown>): number | null {
  const value = entry.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** The conversation lines a window trims, by the dialect the text is written in. */
const CLAUDE_CONVERSATION = new Set(["user", "assistant", "attachment"]);

/** The parsed entries of one JSONL text a window keeps, in file order. */
export function windowEntries(
  raw: string,
  window: ReplayWindow | null | undefined,
): { line: string; entry: Record<string, unknown> }[] {
  const claude = window ? sessionDialectOf(raw) === "claude" : false;
  const trimmed = (entry: Record<string, unknown>) =>
    claude ? CLAUDE_CONVERSATION.has(String(entry.type)) : entry.type === "message";
  return raw.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (!entry || typeof entry !== "object") return [];
    if (window && trimmed(entry) && !inWindow(entryTime(entry), window)) return [];
    return [{ line, entry }];
  });
}

/** One JSONL text trimmed to the window; unchanged (bar blank lines) without one. */
export function windowJsonlText(raw: string, window: ReplayWindow | null | undefined): string {
  if (!window) return raw;
  const kept = windowEntries(raw, window).map((item) => item.line);
  return kept.length > 0 ? `${kept.join("\n")}\n` : "";
}

/** Read one session file through the window. */
export function readWindowedJsonl(file: string, window: ReplayWindow | null | undefined): string {
  return windowJsonlText(readFileSync(file, "utf8"), window);
}

/**
 * Whether any of these session files carries a message inside the window,
 * each read through the one session reader, whichever backend wrote it.
 */
export function hasMessageInWindow(files: string[], window: ReplayWindow): boolean {
  return files.some((file) =>
    windowEntries(readSession(file).text, window).some((item) => item.entry.type === "message"),
  );
}

/** The recorded tables a window keeps. */
export function windowTables(
  tables: RecordedTables,
  window: ReplayWindow | null | undefined,
): RecordedTables {
  if (!window) return tables;
  const at = (key: string) => (row: Record<string, unknown>) =>
    inWindow(numberColumn(row, key), window);
  return {
    tasks: tables.tasks,
    cards: tables.cards.filter((row) => at("created_at")(row) || at("resolved_at")(row)),
    supervision_outcomes: tables.supervision_outcomes.filter(at("at")),
    captain_asks: tables.captain_asks.filter(at("at")),
    card_messages: tables.card_messages.filter(at("at")),
  };
}
