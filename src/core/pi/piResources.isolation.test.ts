import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";

// This is an import boundary, not a fake prompt: all prompt builders below are
// real. A reader on Claude or a recorded session must not initialize Pi's SDK.
vi.mock("@earendil-works/pi-coding-agent", () => {
  throw new Error("A prompt-only read initialized Pi's runtime");
});

it("builds and fingerprints the served prompts without loading the Pi runtime", async () => {
  const prompts = await import("./piResources");
  expect(prompts.buildCrewmateSystemPrompt("claude")).toContain(
    prompts.crewmateBackendNote("claude"),
  );
  expect(prompts.buildCrewmateSystemPrompt("pi")).toContain(prompts.crewmateBackendNote("pi"));
  expect(prompts.firstmatePromptSha()).toBe(
    createHash("sha256").update(prompts.buildFirstmateSystemPrompt()).digest("hex"),
  );
  expect(prompts.kindClassifierInstructionSha()).toBe(
    createHash("sha256").update(prompts.buildKindClassifierInstruction()).digest("hex"),
  );
});
