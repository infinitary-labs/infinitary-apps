import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { DEMO_POSTER } from "../../../tests/e2e/demoFixtures";
import { noSurfaceProof } from "../../../tests/helpers/liveValidation";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { cardPictureUrl } from "../../shared/cardPictures";
import { liveValidationSummary } from "../../shared/liveValidationSummary";
import {
  keepValidationEvidence,
  readKeptValidationEvidence,
  verifyKeptValidationEvidence,
} from "./validationEvidence";

// Observe real filesystem/hash work; no fabricated file contents or digest readings.
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
vi.mock("node:crypto", async (load) => {
  const actual = await load<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

async function fixture() {
  const dir = scratchDir("inf-validation-proof-");
  const root = {
    taskId: "proof-task",
    worktree: join(dir, "worktree"),
    dir: join(dir, "cards"),
    evidenceDir: join(dir, "evidence"),
  };
  await Promise.all([mkdir(root.worktree), mkdir(root.evidenceDir)]);
  const head = "a".repeat(40);
  // The actual public summary, rather than an invented pass/fail log.
  const transcript = JSON.stringify(liveValidationSummary(noSurfaceProof(head), head, false));
  const source = join(root.evidenceDir, "record.json");
  await writeFile(source, transcript);
  const input = {
    kind: "run" as const,
    id: "read-summary",
    head,
    scenarioRevision: 1,
    completion: "complete" as const,
    verdict: "go" as const,
    reason: "Read the real summary interface.",
    observations: [],
    evidence: [
      {
        id: "summary",
        path: source,
        description: "The actual no-surface summary returned by the record reader.",
      },
    ],
  };
  return { root, input, transcript, source };
}

describe("INF-125 selected proof custody", () => {
  it("records a no-surface result before an evidence folder exists", async () => {
    const head = "a".repeat(40);
    const run = {
      kind: "run" as const,
      id: "no-surface",
      head,
      scenarioRevision: 1,
      completion: "complete" as const,
      verdict: "no-surface" as const,
      reason: "Only explanatory prose changed.",
      observations: [],
      evidence: [],
    };
    await expect(keepValidationEvidence(run, undefined)).resolves.toEqual(run);
  });

  it("keeps the observed bytes independently of scratch and detects changed or missing kept proof", async () => {
    const { root, input, source, transcript } = await fixture();
    const kept = await keepValidationEvidence(input, root);
    if (kept.kind !== "run") throw new Error("Expected a run");
    await rm(source);
    expect(kept.evidence[0]?.text).toBe(transcript);
    const metadata = kept.evidence.map(({ text: _text, ...item }) => item);
    expect(readKeptValidationEvidence(metadata, root.dir, root.taskId)[0]?.text).toBe(transcript);
    expect(metadata[0]).not.toHaveProperty("text");
    await expect(
      verifyKeptValidationEvidence(kept.evidence, root.dir, root.taskId),
    ).resolves.toBeUndefined();
    const file = join(root.dir, kept.evidence[0]!.file);
    expect(await readFile(file, "utf8")).toBe(transcript);
    await writeFile(file, "changed");
    await expect(
      verifyKeptValidationEvidence(kept.evidence, root.dir, root.taskId),
    ).rejects.toThrow(/byte count|changed/);
    await rm(file);
    await expect(
      verifyKeptValidationEvidence(kept.evidence, root.dir, root.taskId),
    ).rejects.toThrow();
  });

  it("INF-203 N3: repeated record reads load only text and leave digest verification to the gates", async () => {
    const { root, input, transcript } = await fixture();
    const kept = await keepValidationEvidence(input, root);
    if (kept.kind !== "run") throw new Error("Expected a run");
    const metadata = kept.evidence.map(({ text: _text, ...item }) => item);
    // Existing poster bytes, not a fabricated media measurement.
    const poster = DEMO_POSTER.bytes;
    if (!poster) throw new Error("The demo poster must supply its bytes.");
    const file = `${root.taskId}-${crypto.createHash("sha256").update(poster).digest("hex")}.png`;
    await writeFile(join(root.dir, file), poster);
    const media = {
      id: "poster",
      description: "The existing demo poster",
      file,
      bytes: poster.length,
      digest: file.slice(root.taskId.length + 1, -4),
      picture: cardPictureUrl(file.slice(0, -4), "png"),
    };
    const expected = await realpath(join(root.dir, metadata[0]!.file));
    const reads = vi.mocked(fs.readFileSync);
    const hashes = vi.mocked(crypto.createHash);
    reads.mockClear();
    hashes.mockClear();
    try {
      for (let index = 0; index < 3; index++) {
        const result = readKeptValidationEvidence([...metadata, media], root.dir, root.taskId);
        expect(result[0]?.text).toBe(transcript);
        expect(result[1]).toBe(media);
      }
      expect(reads.mock.calls.map(([file]) => String(file))).toEqual(Array(3).fill(expected));
      expect(hashes).not.toHaveBeenCalled();
      const readPaths = reads.mock.calls.map(([file]) => String(file));
      console.log(
        "INF-203 record presentation",
        JSON.stringify({
          textReads: readPaths.filter((file) => file === expected).length,
          mediaReads: readPaths.filter((file) => file !== expected).length,
          digestComputations: hashes.mock.calls.length,
          transcriptBytes: metadata[0]?.bytes,
        }),
      );
    } finally {
      reads.mockClear();
      hashes.mockClear();
    }
  });

  it("refuses display text that differs from kept bytes and a kept symlink outside the task", async () => {
    const { root, input, source } = await fixture();
    const kept = await keepValidationEvidence(input, root);
    if (kept.kind !== "run") throw new Error("Expected a run");
    const original = kept.evidence[0]!;
    await expect(
      verifyKeptValidationEvidence(
        [{ ...original, text: "A claim not in the observed record" }],
        root.dir,
        root.taskId,
      ),
    ).rejects.toThrow("transcript");
    const file = join(root.dir, original.file);
    await rm(file);
    await symlink(source, file);
    await expect(
      verifyKeptValidationEvidence(kept.evidence, root.dir, root.taskId),
    ).rejects.toThrow("task's folder");
  });

  it("refuses arbitrary files outside the evidence home and whole databases", async () => {
    const { root, input } = await fixture();
    const outside = join(scratchDir("inf-other-proof-"), "record.json");
    await writeFile(outside, "{}");
    await expect(
      keepValidationEvidence(
        { ...input, evidence: [{ ...input.evidence[0]!, path: outside }] },
        root,
      ),
    ).rejects.toThrow("evidence folder");
    const database = join(root.evidenceDir, "state.db");
    await writeFile(database, "not a selected transcript");
    await expect(
      keepValidationEvidence(
        { ...input, evidence: [{ ...input.evidence[0]!, path: database }] },
        root,
      ),
    ).rejects.toThrow();
  });

  it("INF-3389: refuses a note or script as a kind a run record does not keep, never as a picture", async () => {
    const { root, input } = await fixture();
    // Real files of each kind: the Careful guidance's own Markdown and this module's own script.
    const note = await readFile(
      fileURLToPath(
        new URL("../../../resources/runbooks/care/skills/careful-change/SKILL.md", import.meta.url),
      ),
      "utf8",
    );
    const script = await readFile(
      fileURLToPath(new URL("./validationEvidence.ts", import.meta.url)),
      "utf8",
    );
    const keep = async (name: string, bytes: string) => {
      const path = join(root.evidenceDir, name);
      await writeFile(path, bytes);
      const selected = { id: "selected", path, description: `The selected ${name}` };
      return keepValidationEvidence({ ...input, evidence: [selected] }, root);
    };
    for (const [name, bytes] of [
      ["proof-completion.md", note],
      ["proof-script.ts", script],
    ] as const) {
      const refused = keep(name, bytes);
      await expect(refused).rejects.toThrow("is not a kind a run record keeps");
      await expect(refused).rejects.toThrow(".txt, .json or .log");
    }
    // The kind the refusal names keeps the same note as text.
    const kept = await keep("proof-completion.txt", note);
    if (kept.kind !== "run") throw new Error("Expected a run");
    expect(kept.evidence[0]?.text).toBe(note);
    // A file named as a picture is still checked as one.
    await expect(keep("misnamed.png", note)).rejects.toThrow(
      "is not a structurally valid PNG, JPEG or WebP",
    );
  });
});
