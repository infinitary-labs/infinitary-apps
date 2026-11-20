import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionRecordEntry } from "../storage/sessionRecordStore";
import { chainTo, PrefixDigest } from "./prefixDigest";

// INF-2408 (the captain: "File a fix for later"): the seat's turn close
// re-serialized and hashed its whole recorded chain every turn, and held the
// main thread 551 ms. The fingerprint must stay the one the decision record
// kept - sha256 of JSON.stringify(chain) - while each close reads only what
// the turn added.

const SESSION = "6f1c1a52-3d4e-4b8f-9a10-2c3d4e5f6a7b";

/** Entries in the shape the Claude client records its transcript lines. */
function recorded(count: number, from: string | null = null, start = 0): SessionRecordEntry[] {
  const entries: SessionRecordEntry[] = [];
  let parentUuid = from;
  for (let at = start; at < start + count; at += 1) {
    const uuid = `00000000-0000-4000-8000-${String(at).padStart(12, "0")}`;
    const base = {
      parentUuid,
      isSidechain: false,
      userType: "external",
      cwd: "/Users/captain/infinitary",
      sessionId: SESSION,
      version: "2.1.31",
      gitBranch: "main",
      uuid,
      timestamp: new Date(Date.UTC(2026, 10, 3, 6, 21, at)).toISOString(),
    };
    entries.push(
      at % 3 === 0
        ? {
            ...base,
            type: "user",
            message: { role: "user", content: `How is piece ${at} going? Café — résumé ✓` },
          }
        : at % 3 === 1
          ? {
              ...base,
              type: "assistant",
              requestId: `req_${at}`,
              message: {
                id: `msg_${at}`,
                type: "message",
                role: "assistant",
                model: "claude-opus-5-5",
                content: [{ type: "tool_use", id: `toolu_${at}`, name: "crew_status", input: {} }],
                stop_reason: "tool_use",
                usage: { input_tokens: 12, output_tokens: 40, cache_read_input_tokens: 90_112 },
              },
            }
          : {
              ...base,
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: `toolu_${at - 1}`,
                    content: "crewmate 9: running INF-2342\ncrewmate 12: idle",
                  },
                ],
              },
            },
    );
    parentUuid = uuid;
  }
  return entries;
}

/** The fingerprint as the record defined it: the whole chain, serialized at once. */
function whole(chain: readonly SessionRecordEntry[]) {
  return {
    messageCount: chain.length,
    sha256: createHash("sha256").update(JSON.stringify(chain)).digest("hex"),
  };
}

/**
 * The same entries, each counting how many times it is serialized:
 * JSON.stringify asks every object it serializes for `toJSON`.
 */
function counted(entries: SessionRecordEntry[]) {
  const serialized = new Map<SessionRecordEntry, number>();
  const wrapped = entries.map((entry) => {
    const proxy: SessionRecordEntry = new Proxy(entry, {
      get(target, key, receiver) {
        if (key === "toJSON") serialized.set(proxy, (serialized.get(proxy) ?? 0) + 1);
        return Reflect.get(target, key, receiver);
      },
    });
    return proxy;
  });
  return { entries: wrapped, times: (entry: SessionRecordEntry) => serialized.get(entry) ?? 0 };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("the seat's prefix fingerprint", () => {
  it("is the sha256 of the whole chain's JSON, for an empty, a one-entry and a long chain", () => {
    for (const chain of [[], recorded(1), recorded(40)]) {
      expect(new PrefixDigest().of(chain)).toEqual(whole(chain));
    }
  });

  it("serializes only the entries a grown chain added since the last close", () => {
    const { entries, times } = counted(recorded(30));
    const digest = new PrefixDigest();
    const earlier = entries.slice(0, 24);
    expect(digest.of(earlier)).toEqual(whole(recorded(24)));
    // The next turn's close: the prompt landed on a chain six entries longer.
    expect(digest.of(entries)).toEqual(whole(recorded(30)));
    expect(entries.map(times)).toEqual(entries.map(() => 1));
  });

  it("reads a chain that does not continue the last one whole again", () => {
    const digest = new PrefixDigest();
    digest.of(recorded(12));
    // A compaction starts the chain over at a new root; the old entries are not its start.
    const { entries, times } = counted(recorded(5, null, 100));
    expect(digest.of(entries)).toEqual(whole(recorded(5, null, 100)));
    expect(entries.map(times)).toEqual(entries.map(() => 1));
  });

  it("reads ahead one entry per turn of the event loop and leaves the close nothing to read", async () => {
    const { entries, times } = counted(recorded(6));
    const digest = new PrefixDigest();
    const priming = digest.prime(entries);
    let readWhenOtherWorkRan = -1;
    setImmediate(() => {
      readWhenOtherWorkRan = entries.filter((entry) => times(entry) > 0).length;
    });
    await priming;
    // Other work on the main thread ran while the chain was still being read.
    expect(readWhenOtherWorkRan).toBeGreaterThanOrEqual(0);
    expect(readWhenOtherWorkRan).toBeLessThan(entries.length);
    expect(digest.of(entries)).toEqual(whole(recorded(6)));
    expect(entries.map(times)).toEqual(entries.map(() => 1));
  });

  it("lets a close that comes mid-read finish the chain itself, and the read-ahead stops", async () => {
    const { entries, times } = counted(recorded(9));
    const digest = new PrefixDigest();
    const priming = digest.prime(entries);
    await turn();
    await turn();
    expect(digest.of(entries)).toEqual(whole(recorded(9)));
    await priming;
    expect(entries.map(times)).toEqual(entries.map(() => 1));
    expect(digest.of(entries)).toEqual(whole(recorded(9)));
  });

  it("holds no entry once let go of, as a session that ended asks (INF-2392)", () => {
    const { entries, times } = counted(recorded(4));
    const digest = new PrefixDigest();
    digest.of(entries);
    digest.release();
    expect(digest.of(entries)).toEqual(whole(recorded(4)));
    expect(entries.map(times)).toEqual(entries.map(() => 2));
  });

  it("walks from the prompt's parent to the root, stopping where the copy has no entry", () => {
    const entries = recorded(5);
    const byUuid = new Map(entries.map((entry) => [entry.uuid as string, entry]));
    expect(chainTo(byUuid, entries[4]?.uuid as string)).toEqual(entries);
    expect(chainTo(byUuid, entries[2]?.uuid as string)).toEqual(entries.slice(0, 3));
    expect(chainTo(byUuid, null)).toEqual([]);
    // An entry whose parent the copy does not hold (yet) starts the chain.
    byUuid.delete(entries[1]?.uuid as string);
    expect(chainTo(byUuid, entries[4]?.uuid as string)).toEqual(entries.slice(2));
  });
});
