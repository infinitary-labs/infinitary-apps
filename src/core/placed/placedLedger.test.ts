import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type CallLine, PlacedLedger } from "./placedLedger";

/**
 * The answers the home keeps for a task on a computer that runs work
 * (`calls.jsonl`): only a missing file holds none. One that cannot be read
 * fails whatever reads it, rather than reading as no answer yet (INF-6032).
 */

const answered: CallLine = {
  callId: "progress-kept",
  channel: "inf:work:progress",
  after: 3,
  answer: { ok: true },
};
const refused: CallLine = {
  callId: answered.callId,
  channel: answered.channel,
  after: 4,
  error: "Refused.",
};

function failure(read: () => unknown): string | undefined {
  try {
    read();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

describe("a placed task's kept answers", () => {
  it("holds none before its first answer, and keeps that answer for the next read", () => {
    const dir = join(scratchDir("placed-ledger-"), "placed");
    const ledger = new PlacedLedger(dir);
    expect(ledger.answered(answered.callId)).toBeUndefined();
    expect(ledger.lines()).toEqual([]);
    ledger.keep(answered);
    expect(new PlacedLedger(dir).answered(answered.callId)).toEqual(answered);
  });

  it("fails to answer or keep while its file cannot be read, and answers once it can", () => {
    const dir = scratchDir("placed-ledger-");
    const calls = join(dir, "calls.jsonl");
    // A folder where the file belongs cannot be read on macOS, Linux or Windows.
    mkdirSync(calls);
    const ledger = new PlacedLedger(dir);
    expect(failure(() => ledger.answered(answered.callId))).toBe("EISDIR");
    expect(failure(() => ledger.lines())).toBe("EISDIR");
    expect(failure(() => ledger.keep(refused))).toBe("EISDIR");
    rmSync(calls, { recursive: true });
    writeFileSync(calls, `${JSON.stringify(answered)}\n`);
    expect(ledger.answered(answered.callId)).toEqual(answered);
    expect(ledger.lines()).toEqual([answered]);
  });

  // Windows has no write-only file, and root reads any file.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "keeps no refusal over an answer it could not read",
    () => {
      const dir = scratchDir("placed-ledger-");
      const calls = join(dir, "calls.jsonl");
      writeFileSync(calls, `${JSON.stringify(answered)}\n`);
      chmodSync(calls, 0o200);
      const ledger = new PlacedLedger(dir);
      try {
        expect(failure(() => ledger.answered(answered.callId))).toBe("EACCES");
        expect(failure(() => ledger.keep(refused))).toBe("EACCES");
      } finally {
        chmodSync(calls, 0o600);
      }
      expect(readFileSync(calls, "utf8")).toBe(`${JSON.stringify(answered)}\n`);
      expect(ledger.answered(answered.callId)).toEqual(answered);
    },
  );
});
