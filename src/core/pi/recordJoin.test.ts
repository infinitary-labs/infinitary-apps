import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { joinRecord } from "./recordJoin";

// INF-378: a work computer whose earlier version went on writing a
// conversation's record into the older folder after the one-time move, then
// resumed from the copy the move left behind, must resume from every turn,
// in the order they were taken, and keep each one.

const usage = {
  input: 100,
  output: 10,
  totalTokens: 110,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** A turn as Pi records it: the words it was asked, then its answer. */
function turn(record: SessionManager, asked: string, answered: string): void {
  record.appendMessage({ role: "user", content: asked, timestamp: Date.now() });
  record.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: answered }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-6-astra",
    stopReason: "stop",
    timestamp: Date.now(),
    usage,
  });
}

/** The words of the conversation Pi resumes from `file`, in the order it sends them. */
function resumed(file: string): string[] {
  return SessionManager.open(file)
    .buildSessionContext()
    .messages.map((message) => {
      if (message.role === "compactionSummary") return `summary: ${message.summary}`;
      if (!("content" in message)) return message.role;
      const { content } = message;
      return typeof content === "string"
        ? content
        : content.map((part) => ("text" in part ? part.text : part.type)).join(" ");
    });
}

/**
 * A conversation begun in the older folder and copied by the move, with a
 * turn the earlier version then took there: the older copy and the moved one.
 */
function movedConversation() {
  const cwd = scratchDir("infinitary-record-join-work-");
  const older = scratchDir("infinitary-record-join-older-");
  const here = scratchDir("infinitary-record-join-here-");
  const record = SessionManager.create(cwd, older);
  turn(record, "Build the footer.", "Started on the footer.");
  const olderFile = record.getSessionFile() as string;
  const file = join(here, basename(olderFile));
  mkdirSync(here, { recursive: true });
  copyFileSync(olderFile, file);
  turn(SessionManager.open(olderFile, older, cwd), "Fix the header too.", "Fixed the header.");
  return { cwd, here, olderFile, file };
}

describe("joinRecord", () => {
  it("continues a record the move left behind with the turns its older copy gained", () => {
    const { olderFile, file } = movedConversation();
    const older = readFileSync(olderFile, "utf8");

    expect(joinRecord(olderFile, file)).toBe("continued");
    expect(resumed(file)).toEqual([
      "Build the footer.",
      "Started on the footer.",
      "Fix the header too.",
      "Fixed the header.",
    ]);
    expect(readFileSync(file, "utf8")).toBe(older);
    expect(readFileSync(olderFile, "utf8")).toBe(older);
    expect(joinRecord(olderFile, file)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(older);
  });

  it("puts the turns since then after the older copy's, keeping every one and leaving out their compaction", () => {
    const { cwd, here, olderFile, file } = movedConversation();
    const older = readFileSync(olderFile, "utf8");
    // A later version resumed from the copy here without those turns, and
    // Pi compacted that conversation while it ran.
    const since = SessionManager.open(file, here, cwd);
    turn(since, "Resume the native tests.", "Running them.");
    since.appendCompaction("Built the footer only.", since.getLeafId(), 120_000);
    turn(since, "Go on.", "Going on.");
    const before = readFileSync(file, "utf8");
    expect(resumed(file)[0]).toBe("summary: Built the footer only.");

    expect(joinRecord(olderFile, file)).toBe("rejoined");
    expect(resumed(file)).toEqual([
      "Build the footer.",
      "Started on the footer.",
      "Fix the header too.",
      "Fixed the header.",
      "Resume the native tests.",
      "Running them.",
      "Go on.",
      "Going on.",
    ]);
    // Only appended: the home's copy of the record goes on from where it ends.
    expect(readFileSync(file, "utf8").startsWith(before)).toBe(true);
    expect(readFileSync(olderFile, "utf8")).toBe(older);

    // Joined once: the next open finds nothing to bring, and the next turn
    // follows the last one.
    const after = readFileSync(file, "utf8");
    expect(joinRecord(olderFile, file)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(after);
    turn(SessionManager.open(file, here, cwd), "Check the footer again.", "It holds.");
    expect(resumed(file).slice(-2)).toEqual(["Check the footer again.", "It holds."]);
  });

  it("leaves a record alone when the other copy holds nothing it lacks, or is another conversation", () => {
    const { cwd, here, olderFile, file } = movedConversation();
    expect(joinRecord(olderFile, file)).toBe("continued");
    turn(SessionManager.open(file, here, cwd), "Check the footer again.", "It holds.");
    const joined = readFileSync(file, "utf8");
    expect(joinRecord(olderFile, file)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(joined);

    const other = SessionManager.create(cwd, scratchDir("infinitary-record-join-other-"));
    turn(other, "Plan the phone app.", "Planned.");
    expect(joinRecord(other.getSessionFile() as string, file)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe(joined);
  });
});
