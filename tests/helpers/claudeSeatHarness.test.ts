import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, onTestFinished } from "vitest";
import { encodeClaudeProjectDir } from "../../src/core/claude/claudeTranscript";
import { clientRecords, enqueued } from "./claudeSeatHarness";
import { scratchDir } from "./scratchDirs";

const STEER = "Mind the right side too.";

/** One transcript line, in the shape the pinned client writes it. */
function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

/** What the client writes once a prompt's turn is in a tool: the prompt queued and taken in, and the call. */
function turnInATool(sessionId: string): string {
  const at = new Date().toISOString();
  const uuid = randomUUID();
  return [
    line({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: at,
      sessionId,
      content: "Which way?",
    }),
    line({ type: "queue-operation", operation: "dequeue", timestamp: at, sessionId }),
    line({
      type: "user",
      message: { role: "user", content: "Which way?" },
      uuid,
      timestamp: at,
      sessionId,
    }),
    line({
      type: "assistant",
      parentUuid: uuid,
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "mcp__infinitary__look_up", input: {} }],
        stop_reason: "tool_use",
      },
      uuid: randomUUID(),
      timestamp: at,
      sessionId,
    }),
  ].join("");
}

// INF-802: both steer tests that wait on clientRecords stalled for their whole
// 15 s on hosted Linux. The client makes its transcript only when it first
// writes, after the wait began, and goes on writing in bursts; Node 24.21's
// recursive watch there read a new file before watching it, so a burst that
// landed in between woke nothing, and the tool's gate never opened.
describe("clientRecords", () => {
  it.each([
    ["already there", true],
    ["made after the wait began", false],
  ])(
    "sees a steer the client queues just after the wait first read its transcript, its folder %s",
    async (_folder, folderFirst) => {
      const home = scratchDir("infinitary-client-records-");
      const box = {
        configDir: join(home, ".claude"),
        cwd: join(home, "firstmate", "home"),
        onCleanup: (release: () => void) => onTestFinished(release),
      };
      const sessionId = randomUUID();
      const folder = join(box.configDir, "projects", encodeClaudeProjectDir(box.cwd));
      const transcript = join(folder, `${sessionId}.jsonl`);
      if (folderFirst) mkdirSync(folder, { recursive: true });
      const steerQueued = enqueued(STEER);
      let read = false;
      const queued = clientRecords(box, sessionId, (entry) => {
        // The wait is reading the transcript: the client queues the steer right now.
        if (!read) {
          read = true;
          appendFileSync(
            transcript,
            line({
              type: "queue-operation",
              operation: "enqueue",
              timestamp: new Date().toISOString(),
              sessionId,
              content: STEER,
            }),
          );
        }
        return steerQueued(entry);
      });
      mkdirSync(folder, { recursive: true });
      writeFileSync(transcript, turnInATool(sessionId));
      await queued;
    },
  );
});
