import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { firstmateTools } from "../../../tests/helpers/firstmateTools";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type SeatTestSpec, seatSpec } from "../../../tests/helpers/seatSession";
import { appPathsFor } from "../paths";
import type { SessionEvent } from "../session/session";
import { SessionRecordStore } from "../storage/sessionRecordStore";
import type { ClaudeRateLimit } from "./claudeEvents";
import { defaultClaudeConfigDir } from "./claudeQuota";
import { createClaudeSessionFactory } from "./session";

/**
 * The Claude seat on the machine's own Claude login (W1 S6) - the lab probe
 * of 2026-09-26, promoted. It runs the production factory unchanged: the
 * installed client, the default login (CLAUDE_CONFIG_DIR unset), the real
 * prompt and the Firstmate's 26 tools, against Anthropic.
 *
 * OPT-IN ONLY (`INFINITARY_CLAUDE_SEAT_LIVE=1`), never in CI: it spends a few
 * turns of the person's plan. It never starts a sign-in - the seat has no
 * way to - so on a machine that is not signed in it fails with a typed
 * `signed_out` instead. The hermetic twin of every behaviour here is
 * `claudeFirstmateSession.integration.test.ts`, which runs in CI.
 */

const LIVE = process.env.INFINITARY_CLAUDE_SEAT_LIVE === "1";

// A cold client start plus a few real turns on the person's plan.
vi.setConfig({ testTimeout: 180_000 });

describe.runIf(LIVE)("the Claude seat on this machine's own login", () => {
  it("answers, steers, resumes and records a real session", async () => {
    const home = scratchDir("infinitary-claude-seat-live-");
    const cwd = join(home, "firstmate", "home");
    const claudeDir = appPathsFor(home).firstmateClaudeDir;
    const store = new SessionRecordStore(claudeDir);
    const readings: ClaudeRateLimit[] = [];
    const sessions = createClaudeSessionFactory({
      configDir: defaultClaudeConfigDir(),
      records: () => store,
      clock: { now: () => Date.now(), register: () => () => {} },
      onRateLimit: (_accountId, reading) => readings.push(reading),
    });
    const factory = (input: SeatTestSpec) => sessions.open(seatSpec(input));
    const spec: SeatTestSpec = {
      cwd,
      sessionsDir: join(home, "firstmate", "sessions"),
      claudeDir,
      binding: { backend: "claude", accountId: "live" },
      model: { provider: "anthropic-claude", id: "claude-haiku-4-5" },
      tools: await firstmateTools(),
      instructions: { text: "Keep every answer to one short line.", sha: "live" },
    };
    mkdirSync(cwd, { recursive: true });

    const first = await factory(spec);
    const events: SessionEvent[] = [];
    first.subscribe((event) => events.push(event));
    await first.prompt(
      "Call crew_status once, then answer with one line saying how many crewmates there are.",
    );
    expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_start", toolName: "crew_status" }),
    );
    expect(events.find((event) => event.type === "turn_closed" && event.text)).toBeDefined();

    // A steer while the next turn runs is answered inside it.
    const steered = first.prompt("Count from one to five, one number per line.");
    await first.steer("Actually, stop at three.");
    await steered;
    expect(first.takeUndeliveredSteers?.()).toEqual([]);

    first.dispose();
    await first.closed();
    expect(store.entries(first.sessionId).length).toBeGreaterThan(0);

    const second = await factory({
      ...spec,
      resume: { backend: "claude", sessionId: first.sessionId },
    });
    expect(second.sessionId).toBe(first.sessionId);
    await second.prompt("In one word: which tool did you call first in this conversation?");
    second.dispose();
    await second.closed();
    console.log(`[live] session ${first.sessionId}, plan readings:`, readings);
  });
});
