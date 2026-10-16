import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
