import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { editCase, editHost, evaluation } from "../scripts/evals/isolatedEdit";
import { allowanceRefusal, runEvaluation } from "../scripts/evals/runner";
import { scratchDir } from "./helpers/scratchDirs";

it("returns one independently checkable assigned edit without exposing the other marker", async () => {
  const dir = scratchDir("isolated-edit-");
  try {
    const host = await editHost(editCase, dir, { provider: "openai-codex", id: "fixture" }, []);
    try {
      expect(host.spec.builtins).toBe("none");
      expect(host.spec.tools.map((tool) => tool.name)).toEqual(["lookup_source", "return_edit"]);
      await host.dispatch!(async (assignment) => {
        expect(assignment).toBe(editCase.context);
        const [lookup, submit] = host.spec.tools;
        const hidden = readFileSync(join(dir, "other.json"), "utf8");
        expect(JSON.stringify([host.prompt, host.spec.instructions])).not.toContain(hidden);
        expect((await lookup!.run({ name: "other.json" })).text).toBe("null");
        const { version, text } = JSON.parse((await lookup!.run({ name: "labels.json" })).text);
        expect(text).not.toContain(hidden);
        const replacement = text.replace('"Draft"', '"Ready"');
        expect(await submit!.run({ version: "stale", text: replacement })).toMatchObject({
          details: { refusal: true },
        });
        expect(host.state()).toMatchObject({ assignment: { accepted: false } });
        await submit!.run({ version, text: replacement });
        expect(await submit!.run({ version, text: "second" })).toMatchObject({
          details: { refusal: true },
        });
        expect(host.state()).toMatchObject({
          assignment: {
            accepted: true,
            before: text,
            returned: replacement,
            outsideMarker: hidden,
          },
        });
      });
    } finally {
      await host.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("refuses credit-ambiguous evaluation before spending even a matching sheet", async () => {
  const root = scratchDir("isolated-edit-sheet-");
  try {
    const role = {
      backend: "pi" as const,
      accountId: "fixture",
      accountLabel: "Fixture",
      provider: "openai-codex",
      model: "fixture",
    };
    const opts = {
      out: join(root, "out"),
      userData: join(root, "profile"),
      version: "fixture",
      sourceHash: "fixture",
      roles: { firstmate: role, builder: role },
    };
    const factory = vi.fn(async () => {
      throw new Error("Unexpected connection");
    });
    const deps = { module: evaluation, factory };
    const dry = await runEvaluation(opts, deps);
    await expect(
      runEvaluation({ ...opts, live: true, approvedHash: dry.sheetHash }, deps),
    ).rejects.toBe(allowanceRefusal);
    expect(factory).not.toHaveBeenCalled();
    expect(existsSync(join(opts.out, "run-started.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
