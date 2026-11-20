import { fencedSpans, fenceReminder } from "@shared/outsideData";

/**
 * Replacing the words from outside a saved record holds, once they are due
 * to go (INF-952; docs/task-retention.md, "Words from outside"). Each span
 * the integrations fenced (`@shared/outsideData`) carries its label and when
 * it was read, so a pass finds it wherever it was saved - a model's tool
 * result, the Claude client's copy of it, a rule's prompt - and puts a short
 * note in its place. Only the span goes: the line, the conversation and
 * every other word stay as they were.
 *
 * Words read before the fence existed carry no mark. A conversation still
 * shows the call that fetched them - the first mate's `use_integration`,
 * or a crewmate's `infinitary-integrations-axi call` - so the result of
 * such a call goes whole (`LegacyCalls`), dated by its own line.
 */

/** Whether a label's words read at `at` are due to go. */
export type DueSpan = (label: string, at: number) => boolean;

export type ScrubRule = {
  due: DueSpan;
  /** What stands where a label's words were. */
  note: (label: string) => string;
};

/**
 * The calls that fetched a label's words before they were fenced: any
 * integration name or id the label's integrations answered to, lowercased.
 */
export type LegacyCalls = { label: string; names: readonly string[] };

/** A closing mark, for an answer cut before its opening one (`tail`, a shell's truncation). */
const CLOSING = /\[\[\/([a-z][a-z0-9-]*) fence=([0-9a-f]{16})\]\]/g;

/** The integrations command a crewmate calls an action through (`src/core/axi/integrationCommands.ts`). */
const COMMAND_CALL = /infinitary-integrations-axi\s+call\s+(?:'([^']*)'|"([^"]*)"|([^\s'"]+))/g;

/** What one rewrite did: the text after it, and how many spans and results it replaced. */
export type Scrubbed<T> = { value: T; replaced: number };

/**
 * The text with every due span replaced by its label's note. A closing mark
 * whose opening the text does not hold - the answer was cut before it -
 * takes everything before it, read no later than `cutAt`.
 */
export function scrubText(text: string, rule: ScrubRule, cutAt: number): Scrubbed<string> {
  if (!text.includes("[[")) return { value: text, replaced: 0 };
  const spans = fencedSpans(text);
  let out = "";
  let from = 0;
  let replaced = 0;
  const firstOpening = spans[0]?.start ?? text.length;
  let cut: { label: string; value: string; end: number } | undefined;
  for (const found of text.slice(0, firstOpening).matchAll(CLOSING)) {
    const [mark, label = "", value = ""] = found;
    cut = { label, value, end: found.index + mark.length };
  }
  if (cut && rule.due(cut.label, cutAt)) {
    out = rule.note(cut.label);
    from = afterReminder(text, cut.end, cut.label, cut.value);
    replaced += 1;
  }
  for (const span of spans) {
    if (span.start < from || !rule.due(span.label, span.at)) continue;
    const start = beforeReminder(text, from, span.start, span.label, span.value);
    out += text.slice(from, start) + rule.note(span.label);
    from = span.closed ? afterReminder(text, span.end, span.label, span.value) : span.end;
    replaced += 1;
  }
  if (replaced === 0) return { value: text, replaced: 0 };
  return { value: out + text.slice(from), replaced };
}

/**
 * The text with every fenced span replaced, whatever its kind or age, for a
 * copy of a crewmate's steer that keeps none: its timeline line, and the
 * first mate's notice of news a parked task got, whose overflow file no
 * pass visits (docs/automation.md, "A rule that ends a hold"). The words
 * stay only in the crewmate's conversation, which the pass cleans.
 */
export function withoutOutsideWords(text: string, at: number): string {
  return scrubText(
    text,
    {
      due: () => true,
      note: (label) => `[${label} words from outside, kept only in the crewmate's conversation]`,
    },
    at,
  ).value;
}

/** Before the line that names a whole answer's fence, when it leads the opening mark. */
function beforeReminder(
  text: string,
  from: number,
  start: number,
  label: string,
  value: string,
): number {
  const reminder = `${fenceReminder(label, value)}\n`;
  const at = start - reminder.length;
  return at >= from && text.startsWith(reminder, at) ? at : start;
}

/** Past the line that names a whole answer's fence, when it follows the closing mark. */
function afterReminder(text: string, end: number, label: string, value: string): number {
  const reminder = `\n${fenceReminder(label, value)}`;
  return text.startsWith(reminder, end) ? end + reminder.length : end;
}

/** Any JSON value with every string's due spans replaced. */
export function scrubValue(value: unknown, rule: ScrubRule, cutAt: number): Scrubbed<unknown> {
  if (typeof value === "string") return scrubText(value, rule, cutAt);
  if (Array.isArray(value)) {
    let replaced = 0;
    const next = value.map((item) => {
      const done = scrubValue(item, rule, cutAt);
      replaced += done.replaced;
      return done.value;
    });
    return replaced ? { value: next, replaced } : { value, replaced: 0 };
  }
  if (value && typeof value === "object") {
    let replaced = 0;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const done = scrubValue(item, rule, cutAt);
      replaced += done.replaced;
      next[key] = done.value;
    }
    return replaced ? { value: next, replaced } : { value, replaced: 0 };
  }
  return { value, replaced: 0 };
}

type Entry = Record<string, unknown>;

function record(value: unknown): Entry | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Entry) : undefined;
}

/** When a saved line was written: Pi's and the Claude client's ISO `timestamp`. */
function lineTime(entry: Entry, fallback: number): number {
  const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(at) ? at : fallback;
}

/** The tool calls a line's assistant message made: Pi's `toolCall` and the Claude client's `tool_use`. */
function toolCalls(entry: Entry): { id: string; name: string; input: Entry | undefined }[] {
  const message = record(entry.message);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => {
    const call = record(block);
    if (!call || (call.type !== "toolCall" && call.type !== "tool_use")) return [];
    if (typeof call.id !== "string" || typeof call.name !== "string") return [];
    return [{ id: call.id, name: call.name, input: record(call.arguments ?? call.input) }];
  });
}

/** Whether a call fetched one of the label's integrations' answers. */
function fetchedFrom(
  call: { name: string; input: Entry | undefined },
  names: Set<string>,
): boolean {
  if (call.name === "use_integration" || call.name.endsWith("__use_integration")) {
    return typeof call.input?.name === "string" && names.has(call.input.name.toLowerCase());
  }
  const command = call.input?.command;
  if (typeof command !== "string") return false;
  for (const found of command.matchAll(COMMAND_CALL)) {
    const name = found[1] ?? found[2] ?? found[3] ?? "";
    if (names.has(name.toLowerCase())) return true;
  }
  return false;
}

/** A tool result line answering one of `ids`, with its words replaced by `note`; undefined otherwise. */
function replacedResult(entry: Entry, ids: Set<string>, note: string): Entry | undefined {
  const message = record(entry.message);
  if (!message) return undefined;
  // Pi: one message per result.
  if (message.role === "toolResult" && typeof message.toolCallId === "string") {
    if (!ids.has(message.toolCallId)) return undefined;
    return { ...entry, message: { ...message, content: [{ type: "text", text: note }] } };
  }
  // The Claude client: result blocks in a user line, and its own copy beside them.
  if (message.role !== "user" || !Array.isArray(message.content)) return undefined;
  let hit = false;
  const content = message.content.map((block) => {
    const result = record(block);
    if (result?.type !== "tool_result" || typeof result.tool_use_id !== "string") return block;
    if (!ids.has(result.tool_use_id)) return block;
    hit = true;
    return { ...result, content: note };
  });
  if (!hit) return undefined;
  const next: Entry = { ...entry, message: { ...message, content } };
  if ("toolUseResult" in entry) next.toolUseResult = replacedCopy(entry.toolUseResult, note);
  return next;
}

/** The Claude client's own copy of a result: its output words replaced, its flags kept. */
function replacedCopy(copy: unknown, note: string): unknown {
  if (typeof copy === "string") return note;
  if (Array.isArray(copy)) return [{ type: "text", text: note }];
  const fields = record(copy);
  if (!fields) return copy;
  const next: Entry = { ...fields };
  for (const key of ["stdout", "stderr", "content", "text", "output"])
    if (typeof next[key] === "string" && next[key] !== "") next[key] = key === "stdout" ? note : "";
  return next;
}

/**
 * A saved JSONL record with its due words replaced. A line that changes is
 * written again; every other line, and a last line not yet ended, stays
 * byte for byte.
 */
export function scrubJsonLines(
  content: string,
  rule: ScrubRule,
  options: { at: number; legacy?: readonly LegacyCalls[] },
): Scrubbed<string> {
  const lines = content.split("\n");
  // The text after the last newline is a line still being written.
  const whole = lines.length - 1;
  const legacy = (options.legacy ?? []).map((calls) => ({
    label: calls.label,
    names: new Set(calls.names.map((name) => name.toLowerCase())),
    ids: new Set<string>(),
  }));
  const watchesCalls =
    legacy.length > 0 &&
    (content.includes("use_integration") || content.includes("infinitary-integrations-axi"));
  let replaced = 0;
  for (let index = 0; index < whole; index += 1) {
    const line = lines[index] ?? "";
    const marked = line.includes("[[");
    const callish =
      watchesCalls &&
      (line.includes("use_integration") ||
        line.includes("infinitary-integrations-axi") ||
        line.includes("toolResult") ||
        line.includes("tool_result"));
    if (!marked && !callish) continue;
    let entry: Entry | undefined;
    try {
      entry = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (!entry) continue;
    const at = lineTime(entry, options.at);
    let next = entry;
    let count = 0;
    if (callish) {
      for (const calls of legacy) {
        for (const call of toolCalls(entry))
          if (fetchedFrom(call, calls.names)) calls.ids.add(call.id);
        if (calls.ids.size === 0 || !rule.due(calls.label, at)) continue;
        // A fenced answer goes span by span below, with the rest of its result kept.
        if (line.includes(`[[${calls.label} fence=`) || line.includes(`[[/${calls.label} fence=`))
          continue;
        const result = replacedResult(next, calls.ids, rule.note(calls.label));
        if (result) {
          next = result;
          count += 1;
        }
      }
    }
    if (marked || count > 0) {
      const done = scrubValue(next, rule, at);
      next = done.value as Entry;
      count += done.replaced;
    }
    if (count === 0) continue;
    lines[index] = JSON.stringify(next);
    replaced += count;
  }
  return replaced ? { value: lines.join("\n"), replaced } : { value: content, replaced: 0 };
}
