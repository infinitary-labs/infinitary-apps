import { isUtf8 } from "node:buffer";
import { type ReadValue, readValue, zeroFill } from "./bringReaders";

/** Bound recursion while skipping unknown JSON fields. */
const JSON_DEPTH_MAX = 64;

/** Exact top-level field names only. No output-derived text escapes this reader. */
export function readJson(output: Buffer, names: readonly string[]): Map<string, ReadValue> | null {
  if (!isUtf8(output)) return null;
  const selected = new Set(names);
  const found = new Map<string, ReadValue>();
  // Reuse one zeroable scratch buffer for decoded strings, including keys.
  const bytes = Buffer.alloc(output.length);
  let at = 0;
  const invalid = () => {
    throw new Error("Invalid JSON source.");
  };
  const peek = () => output[at];
  const space = () => {
    while (peek() === 32 || peek() === 9 || peek() === 10 || peek() === 13) at++;
  };
  const take = (byte: number) => {
    if (peek() !== byte) return false;
    at++;
    return true;
  };
  const need = (byte: number) => {
    if (!take(byte)) invalid();
  };
  const hex = () => {
    let code = 0;
    for (let i = 0; i < 4; i++) {
      const b = output[at++] ?? 0;
      const n =
        b >= 48 && b <= 57 ? b - 48 : (b | 32) >= 97 && (b | 32) <= 102 ? (b | 32) - 87 : -1;
      if (n < 0) invalid();
      code = code * 16 + n;
    }
    return code;
  };
  const string = (decode: boolean) => {
    need(34);
    let size = 0;
    let text = true;
    while (!take(34)) {
      const b = output[at++] ?? 0;
      if (b < 32) invalid();
      if (b !== 92) {
        if (decode) bytes[size++] = b;
        continue;
      }
      const escaped = output[at++];
      if (escaped === 117) {
        let point = hex();
        if (point >= 0xd800 && point <= 0xdbff && peek() === 92 && output[at + 1] === 117) {
          at += 2;
          const low = hex();
          if (low >= 0xdc00 && low <= 0xdfff)
            point = 0x10000 + (point - 0xd800) * 1024 + low - 0xdc00;
          else at -= 6;
        }
        if (point >= 0xd800 && point <= 0xdfff) text = false;
        else if (decode) {
          if (point >= 0x10000) bytes[size++] = 0xf0 | (point >> 18);
          if (point >= 0x10000) bytes[size++] = 0x80 | ((point >> 12) & 63);
          else if (point >= 0x800) bytes[size++] = 0xe0 | (point >> 12);
          if (point >= 0x800) bytes[size++] = 0x80 | ((point >> 6) & 63);
          else if (point >= 0x80) bytes[size++] = 0xc0 | (point >> 6);
          bytes[size++] = point >= 0x80 ? 0x80 | (point & 63) : point;
        }
        continue;
      }
      const decoded =
        escaped === 34 || escaped === 47 || escaped === 92
          ? escaped
          : escaped === 98
            ? 8
            : escaped === 102
              ? 12
              : escaped === 110
                ? 10
                : escaped === 114
                  ? 13
                  : escaped === 116
                    ? 9
                    : undefined;
      if (decoded === undefined) return invalid();
      if (decode) bytes[size++] = decoded;
    }
    return { size, text };
  };
  const digit = () => (peek() ?? 0) >= 48 && (peek() ?? 0) <= 57;
  const digits = () => {
    if (!digit()) invalid();
    while (digit()) at++;
  };
  const value = (depth: number) => {
    if (depth > JSON_DEPTH_MAX) invalid();
    if (peek() === 34) {
      string(false);
      return;
    }
    const object = take(123);
    if (object || take(91)) {
      const end = object ? 125 : 93;
      space();
      if (take(end)) return;
      do {
        space();
        if (object) {
          string(false);
          space();
          need(58);
          space();
        }
        value(depth + 1);
        space();
      } while (take(44));
      need(end);
      return;
    }
    const word =
      peek() === 110 ? "null" : peek() === 116 ? "true" : peek() === 102 ? "false" : null;
    if (word) {
      for (const letter of word) need(letter.charCodeAt(0));
      return;
    }
    take(45);
    if (!take(48)) digits();
    if (take(46)) digits();
    if (take(69) || take(101)) {
      if (!take(43)) take(45);
      digits();
    }
  };
  try {
    space();
    need(123);
    space();
    if (!take(125)) {
      do {
        space();
        const key = string(true);
        const name = key.text ? bytes.toString("utf8", 0, key.size) : undefined;
        bytes.fill(0, 0, key.size);
        space();
        need(58);
        space();
        if (name !== undefined && selected.has(name)) {
          // A duplicate selected field is ambiguous: keep nothing.
          if (found.has(name)) invalid();
          if (peek() === 34) {
            const field = string(true);
            found.set(name, field.text ? readValue(bytes.subarray(0, field.size)) : "not-text");
            bytes.fill(0, 0, field.size);
          } else {
            value(1);
            found.set(name, "not-text");
          }
        } else value(1);
        space();
      } while (take(44));
      need(125);
    }
    space();
    if (at !== output.length) invalid();
    return found;
  } catch {
    zeroFill(found.values());
    return null;
  } finally {
    bytes.fill(0);
  }
}
