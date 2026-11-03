import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appPathsFor, crewmateSessionsDir } from "../../src/core/paths";

/**
 * INF-2394 measure 4: session serialization and placement follow the real transcript readers.
 * The journey still authors every message, timestamp and tool call it needs.
 * @journey-area src/core/storage/sessionReader.ts
 * @journey-area src/core/tasks/crewActions.ts
 * @journey-area src/core/tasks/crewTranscript.ts
 * @journey-area src/core/observe/
 */

export function seedTranscript(
  file: string,
  entries: readonly unknown[],
  finalNewline = true,
): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + (finalNewline ? "\n" : ""),
  );
  return file;
}

export function seedCrewTranscript(
  userDataDir: string,
  taskId: string,
  filename: string,
  entries: readonly unknown[],
): string {
  return seedTranscript(
    join(crewmateSessionsDir(appPathsFor(userDataDir), taskId), filename),
    entries,
    entries.length > 0,
  );
}

/** The long-history journey's real message rows; generation stays beside its format owner. */
export function observeTranscriptEntries(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    type: "message",
    id: `turn-${i}`,
    timestamp: new Date(1_790_000_000_000 + i * 1000).toISOString(),
    message: {
      role: "user",
      content: `Transcript row ${i}\n${"A wrapped line of local debugging evidence. ".repeat(i % 13)}`,
    },
  }));
}
