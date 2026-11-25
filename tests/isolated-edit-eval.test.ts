import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { editCase, editHost } from "../scripts/evals/isolatedEdit";
import { scratchDir } from "./helpers/scratchDirs";

it("returns one independently checkable assigned edit without exposing the other marker", async () => {
  const dir = scratchDir("isolated-edit-");
  try {
    const host = await editHost(editCase, dir, { provider: "openai-codex", id: "fixture" }, []);
    try {
      expect(host.spec.builtins).toBe("none");
      expect(host.spec.tools.map((tool) => tool.name)).toEqual(["lookup_source", "return_edit"]);
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
        assignment: { accepted: true, before: text, returned: replacement },
      });
    } finally {
      await host.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
