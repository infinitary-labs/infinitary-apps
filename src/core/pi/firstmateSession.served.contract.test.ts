import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { mockModelsJson } from "../../../tests/e2e/mockModels";
import { startMockProvider } from "../../../tests/e2e/mockProvider";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seatSpec } from "../../../tests/helpers/seatSession";
import { createPiSessionFactory } from "./session";

/**
 * R2 provenance against real Pi (no mocked SDK): where a served input landed
 * is read from the session Pi actually wrote. The prompt's entry holds the
 * exact text, its parent is the tip of the prefix the model was sent, and
 * the prefix fingerprint is the messages that preceded it.
 */

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Entry = { type: string; id: string; parentId: string | null; message?: unknown };

/** Message payloads on the branch that ends at `entryId`, oldest first. */
function messageBranch(byId: Map<string, Entry>, entryId: string | null): unknown[] {
  const branch: unknown[] = [];
  for (
    let at = entryId ? byId.get(entryId) : undefined;
    at;
    at = at.parentId ? byId.get(at.parentId) : undefined
  ) {
    if (at.type === "message") branch.unshift(at.message);
  }
  return branch;
}

describe("served state (R2 provenance)", () => {
  it("locates each prompt in the session file with the prefix it extended", {
    timeout: 60_000,
  }, async () => {
    const provider = await startMockProvider();
    const root = scratchDir("infinitary-served-");
    const home = join(root, "home");
    const sessionsDir = join(root, "sessions");
    mkdirSync(home, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    const store = join(root, "store");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "models.json"), mockModelsJson(provider.port));
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(store, "auth.json"),
        modelsPath: join(store, "models.json"),
      });
      const session = await createPiSessionFactory({ agentDir: join(root, "pi-agent") }).open(
        seatSpec({
          cwd: home,
          sessionsDir,
          binding: { backend: "pi", runtime: runtime },
          model: { provider: "fm-mock", id: "mock-1" },
          tools: [],
        }),
      );
      expect(session.servedState?.()).toBeUndefined();

      const reads: string[] = [];
      session.subscribe((event) => {
        if (event.type === "input_read") reads.push(event.textSha256);
      });
      await session.prompt("turn one: chart a course");
      const first = session.servedState?.();
      await session.prompt("turn two: report our position");
      const second = session.servedState?.();
      expect(reads).toEqual([
        sha256("turn one: chart a course"),
        sha256("turn two: report our position"),
      ]);
      const file = session.recordPath() as string;
      session.dispose();

      const entries = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Entry)
        .filter((entry) => entry.type !== "session");
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const messageText = (entry: Entry | undefined) => {
        const content = (entry?.message as { content?: unknown } | undefined)?.content;
        return Array.isArray(content)
          ? content.map((part) => (part as { text?: string }).text ?? "").join("")
          : String(content ?? "");
      };

      expect(first?.sessionFile).toBe(file);
      // Pi 0.87 keeps the system prompt as a transcript message, so the first
      // user turn extends that one message rather than an empty prefix.
      const firstBranch = messageBranch(byId, first?.prompt?.parentEntryId ?? null);
      expect(first?.prompt?.prefix?.messageCount).toBe(firstBranch.length);
      expect(firstBranch).toHaveLength(1);
      expect((firstBranch[0] as { role?: string }).role).toBe("system");
      expect(first?.prompt?.prefix?.sha256).toBe(sha256(JSON.stringify(firstBranch)));
      expect(messageText(byId.get(first?.prompt?.entryId ?? ""))).toBe("turn one: chart a course");
      expect(first?.prompt?.textSha256).toBe(sha256("turn one: chart a course"));

      const promptEntry = byId.get(second?.prompt?.entryId ?? "");
      expect(messageText(promptEntry)).toBe("turn two: report our position");
      expect(promptEntry?.parentId).toBe(second?.prompt?.parentEntryId);
      // The prefix is exactly the messages on the branch before the prompt.
      const branch = messageBranch(byId, second?.prompt?.parentEntryId ?? null);
      expect(second?.prompt?.prefix?.messageCount).toBe(branch.length);
      expect(branch.length).toBeGreaterThanOrEqual(2);
      expect(second?.prompt?.prefix?.sha256).toBe(sha256(JSON.stringify(branch)));
      expect(second?.steers).toEqual([]);
    } finally {
      await provider.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
