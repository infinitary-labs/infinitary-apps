import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { mockModelsJson } from "../../../tests/e2e/mockModels";
import { startMockProvider } from "../../../tests/e2e/mockProvider";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seatSpec } from "../../../tests/helpers/seatSession";
import { SEQUENCES_SEED, sequencesSha } from "../personal/sequencesSkill";
import {
  buildFirstmateSystemPrompt,
  FIRSTMATE_CONTRACT_VERSION,
  firstmatePromptSha,
  toolsFingerprint,
} from "./piResources";
import { createPiSessionFactory, FIRSTMATE_CONTRACT_ENTRY } from "./session";

/**
 * The captain's sequences against real Pi (docs/sequences.md, contract
 * v4.6): what the provider is actually sent. The document rides Pi's
 * appended prompt section after the byte-stable prompt, a change is served
 * on the next prompt and replaces the old text rather than stacking beside
 * it, and the session file records which document each turn saw.
 */

function systemOf(body: string): string {
  const messages = (JSON.parse(body) as { messages: { role: string; content: unknown }[] })
    .messages;
  const system = messages.find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

describe("the served sequences (contract v4.6)", () => {
  it("appends the document after the prompt, re-serves a change at the next prompt, and stamps its sha", {
    timeout: 60_000,
  }, async () => {
    const provider = await startMockProvider();
    const root = scratchDir("infinitary-sequences-");
    const store = join(root, "store");
    mkdirSync(store, { recursive: true });
    mkdirSync(join(root, "home"), { recursive: true });
    mkdirSync(join(root, "sessions"), { recursive: true });
    writeFileSync(join(store, "models.json"), mockModelsJson(provider.port));
    const seed = SEQUENCES_SEED.trim();
    const edited = `${seed}\n\n## chore - small mechanical work\n- implement: one step, no plan.`;
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(store, "auth.json"),
        modelsPath: join(store, "models.json"),
      });
      const session = await createPiSessionFactory({ agentDir: join(root, "pi-agent") }).open(
        seatSpec({
          cwd: join(root, "home"),
          sessionsDir: join(root, "sessions"),
          binding: { backend: "pi", runtime: runtime },
          model: { provider: "fm-mock", id: "mock-1" },
          tools: [],
          instructions: { text: seed, sha: sequencesSha(seed) },
        }),
      );
      await session.prompt("turn one");
      // An idle boundary: the captain edited the document between turns.
      session.serveInstructions?.({ text: edited, sha: sequencesSha(edited) });
      await session.prompt("turn two");
      // Unchanged since: served as it is, nothing new recorded.
      session.serveInstructions?.({ text: edited, sha: sequencesSha(edited) });
      await session.prompt("turn three");
      const file = session.recordPath() as string;
      session.dispose();

      const [first, second, third] = provider.requestBodies().map(systemOf);
      const prompt = buildFirstmateSystemPrompt();
      expect(first).toContain(prompt);
      expect(first).toContain(`<addendum>\n${seed}\n</addendum>`);
      expect(first?.indexOf(prompt)).toBeLessThan(first?.indexOf("<addendum>") ?? -1);
      // The change replaces the old text; it never stacks beside it.
      expect(second).toContain(prompt);
      expect(second).toContain(`<addendum>\n${edited}\n</addendum>`);
      expect(second?.split("<addendum>").length).toBe(2);
      expect(third).toBe(second);

      const stamps = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; customType?: string; data?: unknown })
        .filter((entry) => entry.type === "custom" && entry.customType === FIRSTMATE_CONTRACT_ENTRY)
        .map((entry) => entry.data);
      // prompt_sha stays the byte-stable prompt's alone: the captain's text
      // never moves the trainable contract's stamp.
      expect(stamps).toEqual([
        {
          version: FIRSTMATE_CONTRACT_VERSION,
          prompt_sha: firstmatePromptSha(),
          instructions_sha: sequencesSha(seed),
          tools_sha: toolsFingerprint([]),
        },
        {
          version: FIRSTMATE_CONTRACT_VERSION,
          prompt_sha: firstmatePromptSha(),
          instructions_sha: sequencesSha(edited),
          tools_sha: toolsFingerprint([]),
        },
      ]);
    } finally {
      await provider.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
