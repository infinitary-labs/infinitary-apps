import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CODEX_SAVED_RESET_FLOOR } from "@shared/savedResets";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { checkCodexCli, parseCodexVersion } from "./codexCli";

/**
 * The Codex CLI the person installed (INF-5478's plan, piece 1:
 * docs/codex-client.md): found on the search path first, and refused below
 * the oldest version that names each saved reset, as an update rather than
 * an install.
 */

function onPath() {
  const dir = scratchDir("infinitary-codex-cli-");
  const file = join(dir, "codex");
  writeFileSync(file, "#!/bin/sh\necho codex-cli 0.155.1\n");
  chmodSync(file, 0o755);
  return { file, env: { PATH: dir, HOME: dir } };
}

describe("the Codex CLI check", () => {
  it("reads the version Codex prints", () => {
    expect(parseCodexVersion("codex-cli 0.155.1\n")).toBe("0.155.1");
    expect(parseCodexVersion("codex-cli")).toBeUndefined();
  });

  it("finds the Codex on the search path, ready from the floor up and old below it or unreadable", async () => {
    const { file, env } = onPath();
    const check = (version: string | undefined) =>
      checkCodexCli({
        env,
        platform: "darwin",
        readVersion: async () => version,
        lookup: async () => undefined,
      });
    await expect(check(CODEX_SAVED_RESET_FLOOR)).resolves.toEqual({
      state: "ready",
      executable: file,
      version: CODEX_SAVED_RESET_FLOOR,
    });
    await expect(check("0.142.0")).resolves.toEqual({
      state: "old",
      executable: file,
      version: "0.142.0",
    });
    await expect(check(undefined)).resolves.toEqual({
      state: "old",
      executable: file,
      version: "unknown",
    });
  });

  it("takes INFINITARY_CODEX_CLI outright, and a missing one is no Codex rather than the one on the path", async () => {
    const { file, env } = onPath();
    const reach = {
      platform: "darwin",
      readVersion: async () => "0.155.1",
      lookup: async () => file,
    };
    await expect(
      checkCodexCli({ ...reach, env: { ...env, INFINITARY_CODEX_CLI: join(env.HOME, "nothing") } }),
    ).resolves.toEqual({ state: "missing" });
    await expect(
      checkCodexCli({ ...reach, env: { PATH: "", INFINITARY_CODEX_CLI: file } }),
    ).resolves.toMatchObject({ state: "ready", executable: file });
  });
});
