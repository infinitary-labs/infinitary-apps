import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keepValidationEvidence } from "@core/pi/validationEvidence";
import type { LiveValidationSummary } from "@shared/liveValidationSummary";
import type { FrameDemo } from "@shared/plugins/bridge";
import { describe, expect, it } from "vitest";
import { recordProofDemo, recordProofPictures } from "../src/shared/recordProof";
import { DEMO_POSTER, GIF_DEMO_RECORDING } from "./e2e/demoFixtures";
import { scratchDir } from "./helpers/scratchDirs";

describe("INF-125: retained proof opens through the existing viewer", () => {
  it("opens only the record's kept image and recording, never plays without a press, and uses kept captions and duration", async () => {
    const root = scratchDir("inf-record-proof-");
    const picture = join(root, "poster.png");
    const media = join(root, "recording.gif");
    if (!DEMO_POSTER.bytes) throw new Error("The recorded fixture must supply its poster bytes.");
    await writeFile(picture, DEMO_POSTER.bytes);
    await writeFile(media, GIF_DEMO_RECORDING.bytes);
    const run = await keepValidationEvidence(
      {
        kind: "run",
        id: "attachment-fixture",
        head: "a".repeat(40),
        scenarioRevision: 1,
        completion: "complete",
        verdict: "inconclusive",
        reason: "Attachment presentation only, not a live validation judgment.",
        observations: [],
        evidence: [
          {
            id: "recording",
            path: "recording.gif",
            poster: "poster.png",
            description: DEMO_POSTER.alt,
          },
        ],
      },
      { taskId: "proof-owner", worktree: root, dir: join(root, "kept") },
    );
    if (run.kind !== "run") throw new Error("Expected kept recording");
    const kept = run.evidence[0];
    if (!kept?.picture || !kept.media) throw new Error("Expected kept media URLs");
    const proof: LiveValidationSummary = {
      label: "",
      reason: "Attachment fixture",
      revision: 1,
      rows: [
        {
          id: "attachment",
          action: "Read the retained attachment",
          result: "Not reviewed",
          reason: "Only tests presentation",
          evidence: run.evidence,
        },
      ],
    };
    const poster = {
      src: kept.picture,
      alt: kept.description,
      width: DEMO_POSTER.width,
      height: DEMO_POSTER.height,
    };
    const request: FrameDemo = {
      src: kept.media,
      poster,
      caption: "A frame-supplied caption",
      durationMs: 1,
      play: true,
    };
    expect(recordProofPictures(proof, 0, [poster])?.pictures).toEqual([poster]);
    expect(recordProofDemo(proof, request, true)?.demo).toEqual({
      src: kept.media,
      kind: "gif",
      caption: kept.description,
      durationMs: kept.durationMs,
      play: true,
    });
    expect(kept.durationMs).toBeGreaterThan(0);
    expect(recordProofDemo(proof, request, false)?.demo.play).toBe(false);
    expect(recordProofPictures(undefined, 0, [poster])).toBeUndefined();
    expect(
      recordProofPictures(proof, 0, [
        { ...poster, src: poster.src.replace("proof-owner", "other-owner") },
      ]),
    ).toBeUndefined();
    expect(
      recordProofDemo(
        proof,
        { ...request, src: request.src.replace("proof-owner", "other-owner") },
        true,
      ),
    ).toBeUndefined();
    expect(
      recordProofDemo(
        proof,
        {
          ...request,
          poster: { ...poster, src: poster.src.replace("proof-owner", "other-owner") },
        },
        true,
      ),
    ).toBeUndefined();
  });
});
