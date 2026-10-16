import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeAccountModels, readAccountModels } from "../scripts/account-models.ts";
import { type MainDeps, main, parseArgs } from "../scripts/check-account-models.ts";
import { catalogRefreshesSettled } from "../src/core/pi/modelRuntime";
import { RELEASE_USER_DATA_FOLDER } from "../src/shared/userDataFolders";
import { scratchDir } from "./helpers/scratchDirs";
import { withScratchHome } from "./helpers/scratchHome";

/**
 * The live check for the Codex and Grok account lists (docs/model-lists.md)
 * against a real profile's account store and the real Pi catalog - only
 * the network read itself is stood in for, since that is what only a
 * signed-in machine can answer.
 */

let previousOffline: string | undefined;
beforeAll(() => {
  previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
});
afterAll(async () => {
  await catalogRefreshesSettled();
  if (previousOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = previousOffline;
});

function profileWithGrok(): string {
  const userData = scratchDir("infinitary-account-models-");
  const store = join(userData, "accounts", "xai", "acct_grok");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(store, "auth.json"),
    JSON.stringify({ xai: { type: "api_key", key: "sk-secret-value" } }),
    {
      mode: 0o600,
    },
  );
  writeFileSync(
    join(userData, "accounts", "registry.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "acct_grok",
          providerId: "xai",
          kind: "api_key",
          label: "Personal",
          enabled: true,
          createdAt: 1,
        },
      ],
      pins: {},
    }),
    { mode: 0o600 },
  );
  return userData;
}

describe("check-account-models", () => {
  it("reads the release profile unless told otherwise", () => {
    // The installed release's folder, read under a scratch home rather than this computer's.
    withScratchHome((appData) => {
      expect(parseArgs([]).userDataDir).toBe(join(appData, RELEASE_USER_DATA_FOLDER));
    });
    expect(parseArgs(["--user-data", "/tmp/p"]).userDataDir).toBe("/tmp/p");
    expect(() => parseArgs(["--nope"])).toThrow("unknown argument");
  });

  it("reports an accepted list with what the filter would hide, and never a secret", async () => {
    const reports = await readAccountModels(profileWithGrok(), {
      readers: {
        xai: async () => ({ status: "ok", models: [{ id: "grok-4.7" }, { id: "grok-4.6" }] }),
      },
    });
    expect(reports).toHaveLength(1);
    expect(reports[0]?.rail).toEqual({ ok: true });
    const text = describeAccountModels(reports);
    expect(text).toContain("xai (Personal): 2 models");
    expect(text).toContain("ids: grok-4.6, grok-4.7");
    expect(text).toMatch(/rail: accepted - the filter would hide grok-4\.3, grok-4\.5/);
    expect(text).not.toContain("sk-secret-value");
  });

  it("names the refusal when the list leaves out a default", async () => {
    const reports = await readAccountModels(profileWithGrok(), {
      readers: { xai: async () => ({ status: "ok", models: [{ id: "grok-4.5" }] }) },
    });
    expect(describeAccountModels(reports)).toContain(
      "rail: refused (omits grok-4.7) - the app would serve Pi's catalog unfiltered",
    );
  });

  it("exits 0 only when every account's list was read and accepted", async () => {
    const lines: string[] = [];
    const deps = (result: "ok" | "failed"): MainDeps => ({
      load: async () => ({
        module: {
          CHECKED_PROVIDERS: ["openai-codex", "xai"],
          readAccountModels: async () => [
            {
              providerId: "xai",
              accountLabel: "Personal",
              result:
                result === "ok"
                  ? { status: "ok", models: [{ id: "grok-4.7" }] }
                  : { status: "failed", reason: "signed_out", detail: "HTTP 401" },
              piIds: ["grok-4.7"],
              ...(result === "ok" ? { rail: { ok: true as const } } : {}),
            },
          ],
          describeAccountModels,
        },
      }),
      print: (line) => lines.push(line),
    });
    expect(await main(["--user-data", "/tmp/p"], deps("ok"))).toBe(0);
    expect(await main(["--user-data", "/tmp/p"], deps("failed"))).toBe(1);
    expect(lines.at(-1)).toContain("not read (signed_out: HTTP 401)");
  });
});
