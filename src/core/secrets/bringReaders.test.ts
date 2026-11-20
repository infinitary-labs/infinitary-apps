import { describe, expect, it } from "vitest";
import { readJson } from "./bringJson";
import {
  BRING_VALUE_MAX_BYTES,
  type ReadValue,
  readEnv0,
  readLines,
  readValue,
  zeroFill,
} from "./bringReaders";

// Intent: INF-4718's plan, piece 1, chosen by the captain: a bring reads a
// tool's output as one value, as .env lines or as zero-ended entries, so
// secrets kept in Automic Vault, a .env file or the macOS Keychain come into
// Secrets without an agent reading them. Every value here is invented.

const text = (value: ReadValue | undefined) =>
  Buffer.isBuffer(value) ? value.toString("utf8") : value;
const all = (found: Map<string, ReadValue>) =>
  Object.fromEntries([...found].map(([name, value]) => [name, text(value)]));

/** A .env file as projects write them: comments, export, quotes, a multi-line key and Windows line ends. */
const DOTENV = [
  "# Local development settings",
  "export DATABASE_URL=postgres://app:invented-pass@localhost:5432/app",
  "STRIPE_SECRET_KEY = sk_test_invented4718 # the test-mode key",
  "PASSWORD_WITH_HASH=invented#hash",
  "SINGLE='literal $HOME \\n kept'",
  'DOUBLE="line one\\nline two \\"quoted\\""',
  "BACKTICK=`backtick value`",
  'PRIVATE_KEY="-----BEGIN INVENTED KEY-----',
  "bW9jayBrZXk=",
  '-----END INVENTED KEY-----"',
  "EMPTY=",
  "COMMENT_ONLY= # nothing here",
  "not a variable line",
  "WINDOWS=crlf-value\r",
  "REPEATED=first",
  "REPEATED=second",
  "",
].join("\n");

describe("reading a bring's output", () => {
  it("reads .env lines by their names, as the tools that write them mean them", () => {
    expect(all(readLines(Buffer.from(DOTENV)))).toEqual({
      DATABASE_URL: "postgres://app:invented-pass@localhost:5432/app",
      STRIPE_SECRET_KEY: "sk_test_invented4718",
      PASSWORD_WITH_HASH: "invented#hash",
      SINGLE: "literal $HOME \\n kept",
      DOUBLE: 'line one\nline two "quoted"',
      BACKTICK: "backtick value",
      PRIVATE_KEY: "-----BEGIN INVENTED KEY-----\nbW9jayBrZXk=\n-----END INVENTED KEY-----",
      EMPTY: "empty",
      COMMENT_ONLY: "empty",
      WINDOWS: "crlf-value",
      REPEATED: "second",
    });
  });

  it("drops a value whose quote never closes", () => {
    expect(all(readLines(Buffer.from('GOOD=kept\nBROKEN="never closed\nOTHER=x\n')))).toEqual({
      GOOD: "kept",
    });
  });

  it("reads zero-ended entries, values with line ends and equals signs included", () => {
    const output = Buffer.from(
      "PATH=/usr/bin\0AV_TOKEN=invented=token\nsecond line\0EMPTY=\0BINARY=\xff\0",
      "latin1",
    );
    expect(all(readEnv0(output))).toEqual({
      PATH: "/usr/bin",
      AV_TOKEN: "invented=token\nsecond line",
      EMPTY: "empty",
      BINARY: "not-text",
    });
  });

  it("reads one value, dropping only the one line end the tool printed after it", () => {
    expect(text(readValue(Buffer.from("invented-value\n"), "newline"))).toBe("invented-value");
    expect(text(readValue(Buffer.from("invented-value\r\n"), "newline"))).toBe("invented-value");
    expect(text(readValue(Buffer.from("two ends\n\n"), "newline"))).toBe("two ends\n");
    expect(text(readValue(Buffer.from("kept as printed\n")))).toBe("kept as printed\n");
    expect(readValue(Buffer.from("\n"), "newline")).toBe("empty");
  });

  it("names a value it cannot keep: too large, or not text", () => {
    expect(readValue(Buffer.alloc(BRING_VALUE_MAX_BYTES + 1, 0x61))).toBe("too-large");
    expect(text(readValue(Buffer.alloc(BRING_VALUE_MAX_BYTES, 0x61)))).toHaveLength(
      BRING_VALUE_MAX_BYTES,
    );
    expect(readValue(Buffer.from([0x61, 0x00, 0x62]))).toBe("not-text");
    expect(readValue(Buffer.from([0xc0, 0xaf]))).toBe("not-text");
    // Lead bytes no UTF-8 sequence starts with: kept as text, they would reach a program altered.
    for (const lead of [0xf5, 0xf8, 0xff])
      expect(readValue(Buffer.from([lead, 0x80, 0x80]))).toBe("not-text");
    expect(text(readValue(Buffer.from("pässwörd ✓ 🔑")))).toBe("pässwörd ✓ 🔑");
  });

  it("answers copies, and fills them with zeros on request, leaving the output to its owner", () => {
    const output = Buffer.from("TOKEN=invented-zero-me\n");
    const found = readLines(output);
    const value = found.get("TOKEN");
    if (!Buffer.isBuffer(value)) throw new Error("Not read.");
    zeroFill(found.values());
    expect(value.every((byte) => byte === 0)).toBe(true);
    expect(output.toString()).toBe("TOKEN=invented-zero-me\n");
  });
});

describe("named JSON fields (the approved secrets move)", () => {
  it("reads exact top-level strings without listing fields or coercing other types", () => {
    const output = Buffer.from(
      String.raw`{"\u006bey":"private\n\u00df\ud83d\udd11", "zero":"\u0000", "empty":"", "count":10, "other":{"key":"shadow","arr":[false,1.2e-5,null]}}`,
    );
    expect(readJson(output, ["key", "zero", "empty", "count", "not-present"])).toEqual(
      new Map<string, Buffer | string>([
        ["key", Buffer.from("private\nß🔑")],
        ["zero", "not-text"],
        ["empty", "empty"],
        ["count", "not-text"],
      ]),
    );
  });
  it.each([
    '[{"key":"value"}]',
    '{"key":"first","\\u006bey":"second"}',
    '{"key":"value","extra":[1,]}',
    '{"key":"value"} trailing',
  ])("refuses a malformed or ambiguous source without returning partial values", (text) => {
    expect(readJson(Buffer.from(text), ["key"])).toBeNull();
  });
});
