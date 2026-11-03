import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SessionRecordStore } from "./sessionRecordStore";

const SESSION = "11111111-2222-4333-8444-555555555555";

function setup(): { transcripts: SessionRecordStore; source: string } {
  const dir = scratchDir("infinitary-session-record-");
  const clientDir = join(dir, "client", "projects", "-firstmate-home");
  mkdirSync(clientDir, { recursive: true });
  return {
    transcripts: new SessionRecordStore(join(dir, "firstmate", "claude")),
    source: join(clientDir, `${SESSION}.jsonl`),
  };
}

const line = (entry: object) => `${JSON.stringify(entry)}\n`;

describe("the Claude seat's transcript copy", () => {
  it("holds nothing, and says so, while the client has no transcript", () => {
    const { transcripts, source } = setup();
    expect(transcripts.mirror(SESSION, null)).toEqual({ kind: "no-source" });
    expect(transcripts.mirror(SESSION, source)).toEqual({ kind: "no-source" });
    expect(transcripts.has(SESSION)).toBe(false);
    expect(transcripts.entries(SESSION)).toEqual([]);
  });

  it("copies the client's file byte for byte, one idle boundary's growth at a time", () => {
    const { transcripts, source } = setup();
    writeFileSync(source, line({ type: "user", uuid: "a" }));
    expect(transcripts.mirror(SESSION, source)).toEqual({
      kind: "copied",
      bytes: Buffer.byteLength(line({ type: "user", uuid: "a" })),
    });
    appendFileSync(
      source,
      line({ type: "assistant", uuid: "b" }) + line({ type: "queue-operation" }),
    );
    transcripts.mirror(SESSION, source);
    // A pass with nothing new appends nothing.
    transcripts.mirror(SESSION, source);
    expect(readFileSync(transcripts.transcriptPath(SESSION), "utf8")).toBe(
      readFileSync(source, "utf8"),
    );
    expect(transcripts.entries(SESSION)).toEqual([
      { type: "user", uuid: "a" },
      { type: "assistant", uuid: "b" },
      { type: "queue-operation" },
    ]);
    expect(transcripts.has(SESSION)).toBe(true);
  });

  it("keeps its copy when the client's file is gone, as after the client's own sweep", () => {
    const { transcripts, source } = setup();
    writeFileSync(source, line({ type: "user", uuid: "a" }));
    transcripts.mirror(SESSION, source);
    expect(transcripts.mirror(SESSION, join(source, "..", "gone.jsonl"))).toEqual({
      kind: "no-source",
    });
    expect(transcripts.entries(SESSION)).toEqual([{ type: "user", uuid: "a" }]);
  });

  it("never splices in a file that no longer extends the copy", () => {
    const { transcripts, source } = setup();
    writeFileSync(
      source,
      line({ type: "user", uuid: "a" }) + line({ type: "assistant", uuid: "b" }),
    );
    transcripts.mirror(SESSION, source);
    writeFileSync(
      source,
      line({ type: "user", uuid: "z" }) + line({ type: "assistant", uuid: "y" }),
    );
    expect(transcripts.mirror(SESSION, source)).toEqual({ kind: "diverged" });
    writeFileSync(source, line({ type: "user", uuid: "a" }));
    expect(transcripts.mirror(SESSION, source)).toEqual({ kind: "diverged" });
    expect(transcripts.entries(SESSION)).toEqual([
      { type: "user", uuid: "a" },
      { type: "assistant", uuid: "b" },
    ]);
  });

  it("reads past a line the client was still writing, and completes it on the next pass", () => {
    const { transcripts, source } = setup();
    writeFileSync(source, `${line({ type: "user", uuid: "a" })}{"type":"assis`);
    transcripts.mirror(SESSION, source);
    expect(transcripts.entries(SESSION)).toEqual([{ type: "user", uuid: "a" }]);
    appendFileSync(source, 'tant","uuid":"b"}\n');
    transcripts.mirror(SESSION, source);
    expect(transcripts.entries(SESSION)).toEqual([
      { type: "user", uuid: "a" },
      { type: "assistant", uuid: "b" },
    ]);
  });

  // INF-2392: the app held every session it ever read parsed in memory for
  // as long as it ran; a session that ends lets go of its entries.
  it("lets go of a session's parsed entries, and reads them again from the copy when asked", () => {
    const { transcripts, source } = setup();
    writeFileSync(source, `${line({ type: "user", uuid: "a" })}{"type":"assis`);
    transcripts.mirror(SESSION, source);
    const before = transcripts.index(SESSION);
    expect(before.entries).toEqual([{ type: "user", uuid: "a" }]);
    expect(transcripts.holdsParsed(SESSION)).toBe(true);
    transcripts.release(SESSION);
    expect(transcripts.holdsParsed(SESSION)).toBe(false);
    // The copy on disk stays; a later read parses it from its start, the
    // unfinished line included once the client completes it.
    appendFileSync(source, 'tant","uuid":"b"}\n');
    transcripts.mirror(SESSION, source);
    const after = transcripts.index(SESSION);
    expect(after).not.toBe(before);
    expect(after.entries).toEqual([
      { type: "user", uuid: "a" },
      { type: "assistant", uuid: "b" },
    ]);
    expect(after.byUuid.get("b")).toEqual({ type: "assistant", uuid: "b" });
  });

  // INF-2392: the unfinished line was kept as a view of the whole read, so a
  // session's first read stayed alive for as long as its entries were held.
  // Node copies a short line into its shared allocation pool, whose block is
  // `Buffer.poolSize` bytes (64 KiB from Node 24.22, 8 KiB before), so the
  // first read is larger than that block: only a view of it holds as much.
  it("keeps only the unfinished line's own bytes between reads", () => {
    const { transcripts, source } = setup();
    const filler = "x".repeat(Buffer.poolSize);
    const written = `${line({ type: "user", uuid: "a", filler })}{"type":"assis`;
    writeFileSync(source, written);
    transcripts.mirror(SESSION, source);
    const held = transcripts.index(SESSION) as unknown as { partial: Buffer };
    expect(held.partial.toString("utf8")).toBe('{"type":"assis');
    expect(held.partial.buffer.byteLength).toBeLessThan(Buffer.byteLength(written));
  });

  // INF-2408 (the captain: "File a fix for later"): the seat reads what its
  // copy gained during a turn without holding the main thread, so the turn's
  // close has nothing left to parse. The copy it leaves must be the one a
  // plain read builds.
  describe("read ahead of the turn's close", () => {
    const turnLines = (from: number, count: number) =>
      Array.from({ length: count }, (_, at) =>
        line({
          type: (from + at) % 2 === 0 ? "user" : "assistant",
          uuid: `u${from + at}`,
          parentUuid: from + at === 0 ? null : `u${from + at - 1}`,
          message: { role: "user", content: `piece ${from + at} — résumé` },
        }),
      ).join("");
    const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

    it("leaves the copy a plain read of the file would build, one line per turn of the event loop", async () => {
      const { transcripts, source } = setup();
      writeFileSync(source, turnLines(0, 3));
      transcripts.mirror(SESSION, source);
      // The copy as the seat holds it; watching it reads nothing of the file.
      const held = transcripts.index(SESSION);
      appendFileSync(source, turnLines(3, 5));
      transcripts.mirror(SESSION, source);
      const reading = transcripts.catchUp(SESSION);
      let entriesWhenOtherWorkRan = -1;
      const watch = async () => {
        // The bytes are read off the main thread first; then each line takes a turn.
        while (held.entries.length === 3) await turn();
        entriesWhenOtherWorkRan = held.entries.length;
      };
      await Promise.all([reading, watch()]);
      expect(entriesWhenOtherWorkRan).toBeGreaterThan(3);
      expect(entriesWhenOtherWorkRan).toBeLessThan(8);
      const plain = new SessionRecordStore(dirname(transcripts.transcriptPath(SESSION)));
      expect(transcripts.index(SESSION)).toBe(held);
      expect(held.entries).toEqual(plain.index(SESSION).entries);
      expect([...held.byUuid.keys()]).toEqual([...plain.index(SESSION).byUuid.keys()]);
    });

    it("carries on from a plain read that came mid-way, with no line twice or missing", async () => {
      const { transcripts, source } = setup();
      writeFileSync(source, turnLines(0, 2));
      transcripts.mirror(SESSION, source);
      const held = transcripts.index(SESSION);
      appendFileSync(source, turnLines(2, 6));
      transcripts.mirror(SESSION, source);
      const reading = transcripts.catchUp(SESSION);
      while (held.entries.length === 2) await turn();
      expect(held.entries.length).toBeLessThan(8);
      // The turn's close comes while the read-ahead is mid-way, after one more
      // line, reads the rest itself, and the read-ahead stops.
      appendFileSync(source, turnLines(8, 1));
      transcripts.mirror(SESSION, source);
      const closing = transcripts.index(SESSION).entries.map((entry) => entry.uuid);
      await reading;
      const expected = Array.from({ length: 9 }, (_, at) => `u${at}`);
      expect(closing).toEqual(expected);
      expect(transcripts.index(SESSION).entries.map((entry) => entry.uuid)).toEqual(expected);
    });

    it("reads once when a second read-ahead starts, and the second covers what came after", async () => {
      const { transcripts, source } = setup();
      // The copy as the seat holds it; watching it reads nothing of the file.
      const held = transcripts.index(SESSION);
      writeFileSync(source, turnLines(0, 4));
      transcripts.mirror(SESSION, source);
      // The seat opens: one read-ahead; a turn starts soon after with lines the client added.
      const opening = transcripts.catchUp(SESSION);
      await turn();
      appendFileSync(source, turnLines(4, 3));
      transcripts.mirror(SESSION, source);
      const turnStart = transcripts.catchUp(SESSION);
      await Promise.all([opening, turnStart]);
      expect(held.entries.map((entry) => entry.uuid)).toEqual(
        Array.from({ length: 7 }, (_, at) => `u${at}`),
      );
    });

    it("leaves a copy let go of mid-read let go of, as a session that ended asks", async () => {
      const { transcripts, source } = setup();
      writeFileSync(source, turnLines(0, 6));
      transcripts.mirror(SESSION, source);
      const reading = transcripts.catchUp(SESSION);
      const waiting = transcripts.catchUp(SESSION);
      await turn();
      await turn();
      transcripts.release(SESSION);
      await Promise.all([reading, waiting]);
      expect(transcripts.holdsParsed(SESSION)).toBe(false);
    });

    it("waits for the end of a line the client was still writing, keeping only its own bytes", async () => {
      const { transcripts, source } = setup();
      const filler = "x".repeat(64 * 1024);
      writeFileSync(source, `${line({ type: "user", uuid: "u0", filler })}{"type":"assis`);
      transcripts.mirror(SESSION, source);
      await transcripts.catchUp(SESSION);
      const held = transcripts.index(SESSION);
      expect(held.entries.map((entry) => entry.uuid)).toEqual(["u0"]);
      // INF-2392: the unfinished line is its own copy, not a view of the whole read.
      const { partial } = held as unknown as { partial: Buffer };
      expect(partial.toString("utf8")).toBe('{"type":"assis');
      expect(partial.buffer.byteLength).toBeLessThan(filler.length);
      appendFileSync(source, `tant","uuid":"u1"}\n${turnLines(2, 1)}`);
      transcripts.mirror(SESSION, source);
      await transcripts.catchUp(SESSION);
      expect(transcripts.index(SESSION).entries.map((entry) => entry.uuid)).toEqual([
        "u0",
        "u1",
        "u2",
      ]);
    });
  });

  it("stamps the sidecar beside the copy, oldest first", async () => {
    const { transcripts } = setup();
    await transcripts.stamp(SESSION, {
      kind: "contract",
      at: 1,
      version: "4.13",
      prompt_sha: "p",
      tools_sha: "t",
    });
    await transcripts.stamp(SESSION, { kind: "served", at: 2, prompt: null, steers: [] });
    expect(transcripts.sidecarPath(SESSION)).toBe(
      transcripts.transcriptPath(SESSION).replace(/\.jsonl$/, ".served.jsonl"),
    );
    expect(transcripts.sidecar(SESSION).map((record) => record.kind)).toEqual([
      "contract",
      "served",
    ]);
  });

  it("refuses anything but a session id as a file name", () => {
    const { transcripts } = setup();
    expect(() => transcripts.transcriptPath("../escape")).toThrow("Not a session id");
  });
});
