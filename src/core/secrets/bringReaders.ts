/**
 * How a bring reads what its source handed over (docs/secrets.md, "Bringing
 * secrets from another tool"). Every reader works on bytes and answers
 * buffers, never strings, so the caller can fill each one with zeros once it
 * is sealed. A reader never throws on what it reads: a name it cannot find is
 * simply absent.
 */

import { isUtf8 } from "node:buffer";

/** The shapes a source hands secrets over in. */
export type BringReads = "value" | "lines" | "env0" | "json";

/**
 * The largest value a bring keeps: Automic Vault's own bound on one secret,
 * the tool this ability was built for first. A larger value is reported
 * `too-large` by name and never kept.
 */
export const BRING_VALUE_MAX_BYTES = 1024 * 1024;

export type ReadValue = Buffer | "empty" | "too-large" | "not-text";

const EQUALS = 0x3d;
const NEWLINE = 0x0a;
const RETURN = 0x0d;
const SPACE = 0x20;
const TAB = 0x09;
const HASH = 0x23;
const BACKSLASH = 0x5c;
const SINGLE = 0x27;
const DOUBLE = 0x22;
const BACKTICK = 0x60;

/** Whether the bytes are well-formed UTF-8 with no zero byte: text a variable can carry. */
export function isText(bytes: Buffer): boolean {
  return !bytes.includes(0) && isUtf8(bytes);
}

/** A copy of the value, or why it cannot be kept. */
export function judged(bytes: Buffer): ReadValue {
  if (bytes.length === 0) return "empty";
  if (bytes.length > BRING_VALUE_MAX_BYTES) return "too-large";
  if (!isText(bytes)) return "not-text";
  return Buffer.from(bytes);
}

/**
 * The whole output as one value. `trim` removes one line end at the very
 * end, as a tool that prints a value and then a newline adds it; nothing
 * else is changed.
 */
export function readValue(output: Buffer, trim?: "newline"): ReadValue {
  let end = output.length;
  if (trim === "newline" && end > 0 && output[end - 1] === NEWLINE) {
    end -= 1;
    if (end > 0 && output[end - 1] === RETURN) end -= 1;
  }
  return judged(output.subarray(0, end));
}

/**
 * `NAME=value` entries each ended by a zero byte, as `/usr/bin/env -0`
 * prints its environment. A value may hold any byte but zero, line ends
 * included. When a name appears twice the last one counts, as in an
 * environment.
 */
export function readEnv0(output: Buffer): Map<string, ReadValue> {
  const found = new Map<string, ReadValue>();
  let start = 0;
  while (start < output.length) {
    let end = output.indexOf(0, start);
    if (end < 0) end = output.length;
    const entry = output.subarray(start, end);
    const equals = entry.indexOf(EQUALS);
    if (equals > 0) {
      const name = entry.subarray(0, equals).toString("latin1");
      const previous = found.get(name);
      if (Buffer.isBuffer(previous)) previous.fill(0);
      found.set(name, judged(entry.subarray(equals + 1)));
    }
    start = end + 1;
  }
  return found;
}

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_.-]/;

/**
 * The lines of a `.env` file: `NAME=value`, with an optional `export ` in
 * front, blank lines and `#` comments skipped. A value in single quotes or
 * backticks is taken as written, one in double quotes reads `\n`, `\r`,
 * `\t`, `\"` and `\\`, and either may run over several lines; an unquoted
 * value ends at the line end, loses the spaces around it and a ` #`
 * comment after it. Windows line ends read as line ends. The last of a
 * repeated name counts.
 */
export function readLines(output: Buffer): Map<string, ReadValue> {
  const found = new Map<string, ReadValue>();
  // One scratch buffer the size of the input: no value can be longer.
  const scratch = Buffer.alloc(output.length);
  let at = 0;
  const peek = (offset = 0) => output[at + offset];
  const skipLine = () => {
    while (at < output.length && output[at] !== NEWLINE) at += 1;
    at += 1;
  };
  const skipSpaces = () => {
    while (peek() === SPACE || peek() === TAB) at += 1;
  };
  try {
    while (at < output.length) {
      skipSpaces();
      const first = peek();
      if (first === undefined) break;
      if (first === NEWLINE || first === RETURN || first === HASH) {
        skipLine();
        continue;
      }
      if (output.subarray(at, at + 7).toString("latin1") === "export ") {
        at += 7;
        skipSpaces();
      }
      let name = "";
      if (NAME_START.test(String.fromCharCode(peek() ?? 0))) {
        while (at < output.length && NAME_PART.test(String.fromCharCode(output[at] as number))) {
          name += String.fromCharCode(output[at] as number);
          at += 1;
        }
      }
      skipSpaces();
      if (!name || peek() !== EQUALS) {
        skipLine();
        continue;
      }
      at += 1;
      skipSpaces();
      let length = 0;
      const quote = peek();
      if (quote === SINGLE || quote === DOUBLE || quote === BACKTICK) {
        at += 1;
        let closed = false;
        while (at < output.length) {
          const byte = output[at] as number;
          if (byte === quote) {
            closed = true;
            at += 1;
            break;
          }
          if (byte === RETURN && output[at + 1] === NEWLINE) {
            at += 1;
            continue;
          }
          if (quote === DOUBLE && byte === BACKSLASH && at + 1 < output.length) {
            const next = output[at + 1] as number;
            const escaped =
              next === 0x6e
                ? NEWLINE
                : next === 0x72
                  ? RETURN
                  : next === 0x74
                    ? TAB
                    : next === DOUBLE || next === BACKSLASH
                      ? next
                      : undefined;
            if (escaped !== undefined) {
              scratch[length++] = escaped;
              at += 2;
              continue;
            }
          }
          scratch[length++] = byte;
          at += 1;
        }
        if (!closed) {
          // An unclosed quote is not a value this reader can be sure of.
          scratch.fill(0, 0, length);
          continue;
        }
        skipLine();
      } else {
        while (at < output.length && output[at] !== NEWLINE) {
          const byte = output[at] as number;
          const before = output[at - 1];
          if (byte === HASH && (before === SPACE || before === TAB)) break;
          scratch[length++] = byte;
          at += 1;
        }
        while (length > 0) {
          const last = scratch[length - 1];
          if (last !== SPACE && last !== TAB && last !== RETURN) break;
          length -= 1;
        }
        skipLine();
      }
      const previous = found.get(name);
      if (Buffer.isBuffer(previous)) previous.fill(0);
      found.set(name, judged(scratch.subarray(0, length)));
      scratch.fill(0, 0, length);
    }
  } finally {
    scratch.fill(0);
  }
  return found;
}

export function zeroFill(values: Iterable<ReadValue | undefined>): void {
  for (const value of values) if (Buffer.isBuffer(value)) value.fill(0);
}
