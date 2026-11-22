/**
 * The served-input frame (R2 prospective provenance): the one convention by
 * which the host marks what it puts in front of a model, so a reader can
 * tell the host's context block, an operational wake, and the captain's own
 * words apart STRUCTURALLY - never by finding `[fm-op]` or `[user]` inside
 * text that may quote either.
 *
 * It reuses Firstmate's canonical operational-input marker rather than
 * inventing a parallel one: U+2063 (INVISIBLE SEPARATOR) followed by
 * `FIRSTMATE_OP: v1 <kind> [<origin>]: `. Context omits the origin; wake and
 * user segments serialize it after the kind. Every segment of a served input
 * opens with that header, segments are joined by one blank line, and the mark is
 * removed from every segment body before framing - so the only U+2063
 * characters in a framed input are segment boundaries the host wrote, and
 * pasted or quoted text can never open a segment of its own.
 *
 *   U+2063 FIRSTMATE_OP: v1 context: [fm-op] context (not the user)\n...
 *   \n\n
 *   U+2063 FIRSTMATE_OP: v1 wake crewmate-report: [fm-op] crewmate 1 reported ...
 *   \n\n
 *   U+2063 FIRSTMATE_OP: v1 user captain: [user]\n<the captain's words>
 *
 * The bodies keep the labels the prompts already speak of (`[fm-op]`,
 * `[user]`, `[wake]`, `[context]`); the header is the boundary, the label is
 * only wording. Nothing classifies by a label: who a segment came from is
 * its `ServedOrigin`, a typed field the emitter stamps on the durable inbox
 * row and the host carries onto the segment and the decision record. The
 * origin is serialized in the frame header as well as carried on the live
 * segment. A parser also accepts the older v1 `<kind>: ` header and leaves its
 * origin absent. An input that does not open with the header is
 * historical (pre-frame) text and parses as `null` - a reader falls back to
 * its own legacy rules and says so.
 *
 * No imports: the offline scripts load this file through Node's type
 * stripping, and the renderer may read it too.
 */

/** U+2063 INVISIBLE SEPARATOR - Firstmate's operational-input mark. */
export const SERVED_FRAME_MARK = String.fromCharCode(0x2063);

/** The landed Firstmate operational prefix, reused verbatim. */
export const SERVED_FRAME_PREFIX = `${SERVED_FRAME_MARK}FIRSTMATE_OP: `;

export const SERVED_FRAME_VERSION = "v1";

export type ServedSegmentKind = "context" | "wake" | "user";

export const SERVED_SEGMENT_KINDS: readonly ServedSegmentKind[] = ["context", "wake", "user"];

/**
 * Who a served wake or user segment came from - the frame's finer sub-type
 * (`ServedOrigin`).
 * `captain` is the captain's own words (a `user` segment); every other
 * origin is a `wake`: `crewmate-report` a crewmate's report (the row's ref
 * names the task), `scheduled` a schedule firing, `supervision` a fleet
 * event supervision escalated, `agent` any other host operation. Stamped by
 * the host at the emitting call site, never read out of a body.
 */
export const SERVED_ORIGINS = [
  "captain",
  "crewmate-report",
  "scheduled",
  "supervision",
  "agent",
] as const;

export type ServedOrigin = (typeof SERVED_ORIGINS)[number];

export type ServedWakeOrigin = Exclude<ServedOrigin, "captain">;

export function segmentKindOf(origin: ServedOrigin): "user" | "wake" {
  return origin === "captain" ? "user" : "wake";
}

export const SERVED_FRAME_JOIN = "\n\n";

export type ServedSegmentInput =
  | { kind: "context"; body: string; origin?: never }
  | { kind: "wake"; body: string; origin: ServedWakeOrigin }
  | { kind: "user"; body: string; origin: "captain" };

export type ServedSegment = {
  kind: ServedSegmentKind;
  /** The origin the host stamped; absent on context and older v1 headers. */
  origin?: ServedOrigin;
  /** The body as served (mark already removed). */
  body: string;
  /** Offset of the body's first character in the framed text. */
  start: number;
  /** Offset one past the body's last character. */
  end: number;
};

export type FramedInput = {
  text: string;
  segments: ServedSegment[];
  /** How many U+2063 characters were removed from bodies (0 almost always). */
  neutralized: number;
};

function header(kind: ServedSegmentKind, origin?: ServedOrigin): string {
  return `${SERVED_FRAME_PREFIX}${SERVED_FRAME_VERSION} ${kind}${origin ? ` ${origin}` : ""}: `;
}

function parseHeader(
  text: string,
  at: number,
): {
  kind: ServedSegmentKind;
  origin?: ServedOrigin;
  length: number;
} | null {
  const prefix = `${SERVED_FRAME_PREFIX}${SERVED_FRAME_VERSION} `;
  if (!text.startsWith(prefix, at)) return null;
  const valueAt = at + prefix.length;
  for (const kind of SERVED_SEGMENT_KINDS) {
    const oldHeader = `${kind}: `;
    if (text.startsWith(oldHeader, valueAt))
      return { kind, length: prefix.length + oldHeader.length };
    if (kind === "context") continue;
    for (const origin of SERVED_ORIGINS) {
      if (segmentKindOf(origin) !== kind) continue;
      const typedHeader = `${kind} ${origin}: `;
      if (text.startsWith(typedHeader, valueAt)) {
        return { kind, origin, length: prefix.length + typedHeader.length };
      }
    }
  }
  return null;
}

/** A body can never carry a boundary of its own. */
export function neutralizeFrameMarks(body: string): { body: string; removed: number } {
  if (!body.includes(SERVED_FRAME_MARK)) return { body, removed: 0 };
  const parts = body.split(SERVED_FRAME_MARK);
  return { body: parts.join(""), removed: parts.length - 1 };
}

export function frameServedInput(segments: ServedSegmentInput[]): FramedInput {
  let text = "";
  let neutralized = 0;
  const out: ServedSegment[] = [];
  segments.forEach((segment, index) => {
    // Keep runtime guards for JavaScript callers and malformed deserialized
    // values even though TypeScript callers receive the stricter union.
    const candidate = segment as {
      kind: ServedSegmentKind;
      body: string;
      origin?: ServedOrigin;
    };
    if (candidate.kind !== "context" && !candidate.origin) {
      throw new Error(`a ${candidate.kind} segment requires an origin`);
    }
    if (
      candidate.origin &&
      (candidate.kind === "context" || segmentKindOf(candidate.origin) !== candidate.kind)
    ) {
      throw new Error(`a ${candidate.kind} segment cannot carry origin ${candidate.origin}`);
    }
    const clean = neutralizeFrameMarks(candidate.body);
    neutralized += clean.removed;
    if (index > 0) text += SERVED_FRAME_JOIN;
    text += header(candidate.kind, candidate.origin);
    const start = text.length;
    text += clean.body;
    out.push({
      kind: candidate.kind,
      ...(candidate.origin ? { origin: candidate.origin } : {}),
      body: clean.body,
      start,
      end: text.length,
    });
  });
  return { text, segments: out, neutralized };
}

export function isFramedInput(text: string): boolean {
  return text.startsWith(`${SERVED_FRAME_PREFIX}${SERVED_FRAME_VERSION} `);
}

/**
 * The typed segments of a framed input, or `null` when the text is not a
 * well-formed frame (historical text, or a malformed one - never guessed).
 */
export function parseServedInput(text: string): ServedSegment[] | null {
  if (!isFramedInput(text)) return null;
  const marks: number[] = [];
  for (
    let at = text.indexOf(SERVED_FRAME_MARK);
    at >= 0;
    at = text.indexOf(SERVED_FRAME_MARK, at + 1)
  ) {
    marks.push(at);
  }
  const segments: ServedSegment[] = [];
  for (let index = 0; index < marks.length; index += 1) {
    const at = marks[index] as number;
    const next = marks[index + 1];
    const parsedHeader = parseHeader(text, at);
    if (!parsedHeader) return null;
    const { kind, origin } = parsedHeader;
    const start = at + parsedHeader.length;
    let end = next ?? text.length;
    if (next !== undefined) {
      if (text.slice(next - SERVED_FRAME_JOIN.length, next) !== SERVED_FRAME_JOIN) return null;
      end = next - SERVED_FRAME_JOIN.length;
    }
    if (end < start) return null;
    segments.push({
      kind,
      ...(origin ? { origin } : {}),
      body: text.slice(start, end),
      start,
      end,
    });
  }
  return segments;
}
