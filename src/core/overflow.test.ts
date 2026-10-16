import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeLater, scratchDir } from "../../tests/helpers/scratchDirs";
import {
  appendOverflow,
  capWithOverflow,
  initOverflowDir,
  overflowFilePath,
  withPastedFiles,
} from "./overflow";

// Runs before any test below wires initOverflowDir, so it exercises the
// module's fresh, unconfigured state - a script or a test file that never
// calls initOverflowDir must still get a usable path, not a throw.
it("falls back to the OS temp dir when no app dir has been wired yet", () => {
  const text = "y".repeat(50);
  const excerpt = capWithOverflow(text, "unwired", { limit: 5 });
  const file = /full text: (.+)\]$/.exec(excerpt)?.[1] ?? "";
  removeLater(dirname(file));
  expect(dirname(file)).toBe(join(tmpdir(), "infinitary-overflow"));
  expect(readFileSync(file, "utf8")).toBe(text);
});

describe("capWithOverflow", () => {
  let dir: string;

  beforeEach(() => {
    dir = scratchDir("fm-overflow-test-");
    initOverflowDir(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rides text at or under the limit through unchanged", () => {
    const text = "a crewmate's short, complete report";
    expect(capWithOverflow(text, "report", { limit: 100 })).toBe(text);
  });

  it("spills the full text to a file and points to it when text exceeds the limit", () => {
    const text = `head${"x".repeat(200)}tail`;
    const result = capWithOverflow(text, "report", { limit: 10 });
    expect(result.startsWith("head")).toBe(true);
    expect(result).toContain("[truncated 198 more characters; full text: ");
    const filePath = result.match(/full text: (.+)\]$/)?.[1];
    expect(filePath).toBeTruthy();
    expect(readFileSync(filePath ?? "", "utf8")).toBe(text);
  });

  it("writes every pasted file exactly, including a short many-line CRLF paste", () => {
    const files = [{ text: `transcript\r\n${"x".repeat(78426)}` }, { text: "line\r\n".repeat(21) }];
    const sent = withPastedFiles("summarize", files);
    expect(sent.startsWith(`summarize\n\n${files[0]?.text.slice(0, 2000)}`)).toBe(true);
    const paths = [...sent.matchAll(/full text: (.+)\]/g)].map((m) => m[1]);
    expect(paths).toHaveLength(2);
    paths.forEach((path, i) => {
      expect(readFileSync(path ?? "", "utf8")).toBe(files[i]?.text);
    });
    expect(sent).toContain("[truncated 0 more characters;");
  });

  it("keeps the tail instead of the head when asked, still pointing at the full text", () => {
    const text = `head${"x".repeat(200)}tail`;
    const result = capWithOverflow(text, "job-tail", { limit: 10, keep: "tail" });
    expect(result.endsWith("xxtail")).toBe(true);
    expect(result).toContain("[truncated 198 earlier characters; full text: ");
    const filePath = result.match(/full text: (.+)\]/)?.[1];
    expect(filePath).toBeTruthy();
    expect(readFileSync(filePath ?? "", "utf8")).toBe(text);
  });
});

describe("appendOverflow / overflowFilePath", () => {
  let dir: string;

  beforeEach(() => {
    dir = scratchDir("fm-overflow-test-");
    initOverflowDir(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends repeated chunks to the same stable path for one id", () => {
    const path = overflowFilePath("job-output", "job-1");
    appendOverflow(path, "first chunk\n");
    appendOverflow(path, "second chunk\n");
    expect(readFileSync(path, "utf8")).toBe("first chunk\nsecond chunk\n");
  });
});
