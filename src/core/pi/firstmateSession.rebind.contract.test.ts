import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  MOCK_FM_CHAT_TEXT,
  mockModelsJson,
  startMockProvider,
} from "../../../tests/e2e/mockProvider";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type SeatTestSpec, seatSpec } from "../../../tests/helpers/seatSession";
import { createPiSessionFactory } from "./session";

/**
 * The Pi rebind contract test - the phase-6 pre-ship probe named by the
 * account-broker plan: one Pi session JSONL re-opened under a DIFFERENT
 * ModelRuntime instance (a different account's store). The flagship rebind
 * and the crewmate resume-reselect paths both stand on this being real, so
 * it is measured here against real Pi (no mocked SDK), with each runtime
 * bound to its own isolated store and a local mock provider.
 */

/** The seat as the agent opens it: the seat preset, through Pi's session factory. */
function openSeat({ agentDir, ...input }: SeatTestSpec & { agentDir: string }) {
  return createPiSessionFactory({ agentDir }).open(seatSpec(input));
}

function accountStore(dir: string, port: number): { authPath: string; modelsPath: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, mockModelsJson(port));
  return { authPath: join(dir, "auth.json"), modelsPath };
}

describe("Pi rebind contract (broker phase 6 gate)", () => {
  it("re-opens one rolling session file under a second ModelRuntime with full transcript continuity", {
    timeout: 60_000,
  }, async () => {
    const provider = await startMockProvider();
    const root = scratchDir("infinitary-rebind-");
    const home = join(root, "home");
    const sessionsDir = join(root, "sessions");
    const agentDir = join(root, "pi-agent");
    mkdirSync(home, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });

    try {
      // Attachment 1: account A's runtime over account A's store.
      const storeA = accountStore(join(root, "accounts", "acct_a"), provider.port);
      const runtimeA = await ModelRuntime.create(storeA);
      const first = await openSeat({
        cwd: home,
        sessionsDir,
        agentDir,
        binding: { backend: "pi", runtime: runtimeA },
        model: { provider: "fm-mock", id: "mock-1" },
        tools: [],
      });
      await first.prompt("turn one: chart a course");
      const sessionFile = first.recordPath();
      expect(sessionFile).toBeTruthy();
      first.dispose();

      // Attachment 2: the SAME JSONL over account B's runtime - a
      // different ModelRuntime instance bound to a different store.
      const storeB = accountStore(join(root, "accounts", "acct_b"), provider.port);
      const runtimeB = await ModelRuntime.create(storeB);
      expect(runtimeB).not.toBe(runtimeA);
      const second = await openSeat({
        cwd: home,
        sessionsDir,
        agentDir,
        binding: { backend: "pi", runtime: runtimeB },
        model: { provider: "fm-mock", id: "mock-1" },
        tools: [],
        resume: { backend: "pi", sessionFile: sessionFile as string },
      });
      // The rebind continues the rolling file, never forks a new one.
      expect(second.recordPath()).toBe(sessionFile);
      await second.prompt("turn two: report our position");
      second.dispose();

      // The second turn's provider request (through runtime B) carried the
      // first attachment's transcript: rebind preserves context, not just
      // the file path.
      const lastBody = provider.requestBodies().at(-1) ?? "";
      expect(lastBody).toContain("turn one: chart a course");
      expect(lastBody).toContain("turn two: report our position");

      // And the rolling JSONL holds both turns plus both assistant replies.
      const transcript = readFileSync(sessionFile as string, "utf8");
      expect(transcript).toContain("turn one: chart a course");
      expect(transcript).toContain("turn two: report our position");
      expect(transcript).toContain(MOCK_FM_CHAT_TEXT.slice(0, 20));
    } finally {
      await provider.close();
    }
  });
});
