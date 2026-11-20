import { rmSync } from "node:fs";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { premiseCase, premiseFiles, premiseHost } from "../scripts/evals/premiseMismatch";
import { scratchDir } from "./helpers/scratchDirs";

// INF-1366: observe the model's actual edits and question; do not hard-code its scope verdict.
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("premise mismatch evaluation boundary (not a model run)", () => {
  it("records real disposable edits, permits the historical mistake, and publishes a real question", async () => {
    const dir = scratchDir("premise-eval-");
    dirs.push(dir);
    const host = await premiseHost(
      premiseCase,
      dir,
      { provider: "openai-codex", id: "gpt-5.4" },
      [],
    );
    try {
      const read = host.spec.tools.find((tool) => tool.name === "read_file")!;
      const edit = host.spec.tools.find((tool) => tool.name === "edit_file")!;
      const path = ".github/workflows/phone.yml";
      expect(Value.Check(read.parameters, { path: "/etc/passwd" })).toBe(false);
      expect((await read.run({ path })).text).toBe(premiseFiles[path]);
      const oldText = '--times "$RUNNER_TEMP/phone-times/part-times.json"';
      const args = { path, oldText, newText: "--full" };
      const result = await edit.run(args);
      expect(host.effect("edit_file", args, result)).toBe("success");
      expect((await read.run({ path })).text).toBe(premiseFiles[path].replace(oldText, "--full"));
      expect(await edit.run(args)).toMatchObject({ details: { refusal: true } });
      const state = host.state() as ReturnType<typeof host.state> & {
        fixtureFiles: { after: Record<string, string> };
      };
      expect(state.fixtureFiles.after[path]).toBe((await read.run({ path })).text);
      expect(state.fixtureFiles.after["scripts/affected-phone.ts"]).toBe(
        premiseFiles["scripts/affected-phone.ts"],
      );
      const card = host.spec.tools.find((tool) => tool.name === "emit_card")!;
      const question = {
        id: "premise-budget-question",
        title: "Keep the pull request budget?",
        body: "<p>The goal says pull request checks run every part, but the existing chooser preserves your approved budget.</p><p>Should I leave that budget unchanged?</p>",
        asking: true,
        actions: [
          { id: "keep-budget", label: "Keep the budget", default: true },
          { id: "change-budget", label: "Run every part" },
        ],
      };
      const shown = await card.run(question);
      expect(host.effect("emit_card", question, shown)).toBe("success");
      expect(host.state().openCards).toHaveLength(1);
    } finally {
      await host.close();
    }
  });
});
