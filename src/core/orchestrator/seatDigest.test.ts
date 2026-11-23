import { describe, expect, it } from "vitest";
import {
  appendDigest,
  digestEntry,
  digestFor,
  SEAT_DIGEST_EXCERPT_CHARS,
  SEAT_DIGEST_KEPT,
  SEAT_DIGEST_TOOLS,
  SEAT_DIGEST_TURNS,
  type SeatDigestEntry,
  seatIdentity,
} from "./seatDigest";
import { renderWake } from "./wakes";

const PI = seatIdentity("pi", "pi-1");
const CLAUDE = seatIdentity("claude", "claude-1");

function turn(seat: string, index: number, extra: Partial<Parameters<typeof digestEntry>[0]> = {}) {
  return digestEntry({
    seat,
    at: index,
    trigger: "captain",
    asked: [`ask ${index}`],
    tools: ["spawn_crewmate"],
    said: `said ${index}`,
    failed: false,
    ...extra,
  });
}

describe("the seat digest (the owner's Q4 b)", () => {
  it("caps every excerpt and the tool list, however long the turn was", () => {
    const entry = digestEntry({
      seat: PI,
      at: 1,
      trigger: "captain",
      asked: ["x".repeat(2_000), "and more"],
      tools: Array.from({ length: 20 }, (_, index) => `tool_${index % 12}`),
      said: `  ${"y ".repeat(1_000)}  `,
      failed: true,
    });
    expect(entry.asked).toHaveLength(SEAT_DIGEST_EXCERPT_CHARS);
    expect(entry.asked?.endsWith("…")).toBe(true);
    expect(entry.said?.length).toBeLessThanOrEqual(SEAT_DIGEST_EXCERPT_CHARS);
    // Repeats count once, in first-call order, up to the cap.
    expect(entry.tools).toEqual(
      Array.from({ length: SEAT_DIGEST_TOOLS }, (_, index) => `tool_${index}`),
    );
    expect(entry.failed).toBe(true);
    expect(
      digestEntry({ seat: PI, at: 2, trigger: "operation", tools: [], failed: false }),
    ).toEqual({ seat: PI, at: 2, trigger: "operation", tools: [] });
  });

  it("keeps the newest turns on the record and hands a session only the turns it has not seen", () => {
    let entries: SeatDigestEntry[] = [];
    for (let index = 0; index < 4; index += 1) entries = appendDigest(entries, turn(CLAUDE, index));
    for (let index = 4; index < 20; index += 1) entries = appendDigest(entries, turn(PI, index));
    expect(entries).toHaveLength(SEAT_DIGEST_KEPT);

    // Moving to Claude: the Pi turns since Claude's own last one, newest capped.
    const toClaude = digestFor(entries, CLAUDE);
    expect(toClaude).toHaveLength(SEAT_DIGEST_TURNS);
    expect(toClaude.map((entry) => entry.asked)).toEqual(
      [14, 15, 16, 17, 18, 19].map((index) => `ask ${index}`),
    );
    expect(toClaude[0]).not.toHaveProperty("seat");

    // Moving back to Pi right after: nothing it has not seen.
    expect(digestFor(entries, PI)).toEqual([]);
    entries = appendDigest(entries, turn(CLAUDE, 20));
    expect(digestFor(entries, PI).map((entry) => entry.asked)).toEqual(["ask 20"]);
  });

  it("rides the seat-moved wake bounded, whatever the turns held", () => {
    const heavy = Array.from({ length: SEAT_DIGEST_KEPT }, (_, index) =>
      digestEntry({
        seat: PI,
        at: index,
        trigger: "captain",
        asked: ["a".repeat(5_000)],
        tools: Array.from({ length: 30 }, (_, tool) => `a_long_tool_name_${tool}`),
        said: "b".repeat(5_000),
        failed: true,
      }),
    );
    const text = renderWake({
      facts: {
        kind: "seat-moved",
        from: { provider: "Codex", model: "gpt-5.5" },
        to: { provider: "Claude", model: "claude-opus" },
        reason: "no_headroom",
        carried: false,
        recent: digestFor(heavy, CLAUDE),
      },
    });
    expect(text.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(
      SEAT_DIGEST_TURNS,
    );
    expect(text.length).toBeLessThan(5_500);
  });
});

describe("the seat-moved wake", () => {
  const from = { provider: "Claude", model: "claude-opus" };
  const to = { provider: "Codex", model: "gpt-5.5" };

  it("says where the seat went and why, and that the conversation carried over when it did", () => {
    expect(renderWake({ facts: { kind: "seat-moved", from, to, carried: true, recent: [] } })).toBe(
      "[fm-op] Your seat moved on the captain's word: you now answer on Codex (gpt-5.5); before, you answered on Claude (claude-opus). This conversation carried over.",
    );
  });

  it("names the context block as the truth, and lists what the host saw of each turn it cannot read back", () => {
    expect(
      renderWake({
        facts: {
          kind: "seat-moved",
          from,
          to,
          reason: "refused",
          carried: false,
          recent: [
            { trigger: "captain", asked: "ship it", tools: ["settle_task"], said: "Merging." },
            { trigger: "operation", tools: [], failed: true },
          ],
        },
      }),
    ).toBe(
      [
        "[fm-op] Your seat moved on the captain's word: you now answer on Codex (gpt-5.5); before, you answered on Claude (claude-opus), which had stopped answering. Your conversation there does not carry over to this one: the context block is the host's truth about the crew, tasks and cards. Your last 2 turns there, as the host recorded them, oldest first:",
        '- the captain said "ship it"; you used settle_task; you said "Merging."',
        "- operational updates; you used no tool; the turn failed",
      ].join("\n"),
    );
    expect(
      renderWake({
        facts: { kind: "seat-moved", from, to, carried: false, recent: [] },
      }),
    ).toContain(
      "The host has no record of turns you took there that this conversation has not seen.",
    );
  });

  it("says the instructions changed, not the captain's word, when a new conversation starts for them", () => {
    const seat = { provider: "Claude", model: "claude-opus" };
    expect(
      renderWake({
        facts: {
          kind: "seat-moved",
          from: seat,
          to: seat,
          reason: "instructions",
          carried: false,
          recent: [{ trigger: "captain", asked: "remember cobalt", tools: [] }],
        },
      }),
    ).toBe(
      [
        "[fm-op] Your instructions changed, so you now answer in a new conversation on Claude (claude-opus). Your conversation before the change does not carry over to this one: the context block is the host's truth about the crew, tasks and cards. Your last turn before the change, as the host recorded it:",
        '- the captain said "remember cobalt"; you used no tool',
      ].join("\n"),
    );
  });
});
