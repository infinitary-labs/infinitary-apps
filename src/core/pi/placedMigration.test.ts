import { copyFileSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { writeMoveRecord } from "../folderMove/record";
import { migrateConversations } from "../helper/migrateConversations";

/** INF-416 L, captain: migrate before removal; preserve history, order, and the recovery copy. */
function fixture(later: boolean) {
  const root = scratchDir("infinitary-conversation-migration-");
  const from = join(root, "firstmate-3000");
  const to = join(root, "infinitary");
  const older = join(from, "work", "tasks", "footer", "sessions");
  const current = join(to, "work", "tasks", "footer", "sessions");
  mkdirSync(older, { recursive: true });
  mkdirSync(current, { recursive: true });
  const record = SessionManager.create(join(from, "worktrees", "footer"), older);
  const turn = (session: SessionManager, text: string) => {
    session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "On it." }],
      api: "openai-responses",
      provider: "openai-codex",
      model: "gpt-6-astra",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        input: 100,
        output: 3,
        totalTokens: 103,
        cacheRead: 0,
        cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
  };
  turn(record, "Build the footer.");
  const source = record.getSessionFile() as string;
  const target = join(current, basename(source));
  copyFileSync(source, target);
  turn(SessionManager.open(source, older), "Fix the header too.");
  if (later) turn(SessionManager.open(target, current), "Check the sidebar.");
  const at = new Date(1_000).toISOString();
  writeMoveRecord(to, { schemaVersion: 1, state: "done", from, to, at });
  utimesSync(source, new Date(2_000), new Date(2_000));
  const words = () =>
    SessionManager.open(target)
      .buildSessionContext()
      .messages.filter((message) => message.role === "user")
      .map((message) => message.content);
  return { dataDir: join(to, "work"), source, target, words };
}

describe("protocol 9's one-time conversation migration", () => {
  for (const later of [false, true]) {
    it(`preserves the older turns${later ? " before newer turns" : ""}, once across restarts`, () => {
      const at = fixture(later);
      const recovery = readFileSync(at.source, "utf8");
      const prefix = readFileSync(at.target, "utf8");
      migrateConversations(at.dataDir);
      expect(at.words()).toEqual([
        "Build the footer.",
        "Fix the header too.",
        ...(later ? ["Check the sidebar."] : []),
      ]);
      const migrated = readFileSync(at.target, "utf8");
      console.info(
        "Migrated conversation:",
        JSON.stringify({
          turns: at.words(),
          olderCopyUnchanged: readFileSync(at.source, "utf8") === recovery,
          currentRecordOnlyGrew: migrated.startsWith(prefix),
        }),
      );
      expect(migrated.startsWith(prefix)).toBe(true);
      expect(readFileSync(at.source, "utf8")).toBe(recovery);
      migrateConversations(at.dataDir);
      expect(readFileSync(at.target, "utf8")).toBe(migrated);
      // A lost marker after the append is the crash window: replay still appends nothing.
      rmSync(join(at.dataDir, "conversation-folders.json"));
      migrateConversations(at.dataDir);
      expect(readFileSync(at.target, "utf8")).toBe(migrated);
    });
  }
  it("recovers a record absent from the moved copy", () => {
    const at = fixture(false);
    rmSync(at.target);
    migrateConversations(at.dataDir);
    expect(readFileSync(at.target, "utf8")).toBe(readFileSync(at.source, "utf8"));
    expect(at.words()).toEqual(["Build the footer.", "Fix the header too."]);
  });
  it("refuses a different conversation without committing the migration", () => {
    const at = fixture(false);
    const other = SessionManager.create(
      scratchDir("infinitary-other-work-"),
      scratchDir("infinitary-other-record-"),
    );
    other.appendMessage({ role: "user", content: "A different task.", timestamp: Date.now() });
    writeFileSync(at.target, readFileSync(other.getSessionFile() as string));
    const before = readFileSync(at.target, "utf8");
    expect(() => migrateConversations(at.dataDir)).toThrow("different conversations");
    expect(readFileSync(at.target, "utf8")).toBe(before);
    // After repair, the same migration still runs; a refusal wrote no completion marker.
    writeFileSync(at.target, readFileSync(at.source));
    migrateConversations(at.dataDir);
    expect(at.words()).toEqual(["Build the footer.", "Fix the header too."]);
  });
});
