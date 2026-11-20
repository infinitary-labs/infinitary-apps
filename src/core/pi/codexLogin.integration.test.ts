import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { catalogRefreshesSettled, createModelRuntime } from "./modelRuntime";

/**
 * Real Pi openai-codex login, stopped before any browser open: the first
 * thing it must do is ask how to sign in. A hang with no prompt is the
 * Connect bug. We never answer, so the authorize URL is never emitted.
 */

describe("Codex oauth login", () => {
  // The runtime's background catalog refresh reads and writes auth.json and
  // models-store.json in this test's folder, and the file's cleanup removes
  // the folder once the file ends. A refresh still running then put the
  // folder back, and the unit run failed on the leftover folder
  // (docs/testing.md: work that writes after a test returns is awaited).
  afterEach(async () => {
    await catalogRefreshesSettled();
  });

  it("asks for a login method instead of hanging with no follow-up", async () => {
    process.env.PI_OFFLINE = "1";
    const dir = scratchDir("infinitary-codex-login-");
    const runtime = await createModelRuntime({
      authPath: join(dir, "auth.json"),
      modelsPath: join(dir, "models.json"),
    });
    const abort = new AbortController();
    const prompts: { type: string; message: string }[] = [];
    const login = runtime.login("openai-codex", "oauth", {
      signal: abort.signal,
      prompt: async (prompt) => {
        prompts.push({ type: prompt.type, message: prompt.message });
        return new Promise(() => {});
      },
      notify: () => {},
    });
    await vi.waitFor(
      () => {
        expect(prompts[0]?.type).toBe("select");
      },
      { timeout: 10_000 },
    );
    expect(prompts[0]?.message).toMatch(/login method/i);
    abort.abort(new Error("stop"));
    await expect(login).rejects.toThrow();
  }, 20_000);
});
