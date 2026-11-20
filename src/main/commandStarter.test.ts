import { userInfo } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import { commandStarter } from "./commandStarter";
import type { WorkContext } from "./workContext";

// Node throws from userInfo() for an account with no user record; `noRecord` stands that account in.
const account = vi.hoisted(() => ({ noRecord: false }));
vi.mock("node:os", async (actual) => {
  const os = await actual<typeof import("node:os")>();
  const userInfo = ((...args: Parameters<typeof os.userInfo>) => {
    if (account.noRecord) throw new Error("ENOENT: no such file or directory, uv_os_get_passwd");
    return os.userInfo(...args);
  }) as typeof os.userInfo;
  return { ...os, default: { ...os, userInfo }, userInfo };
});

/**
 * Which windows start the command (docs/run.md, "The window starts it"). The
 * captain's answer on the review of INF-1352's piece 7: a development run
 * starts the program only with INFINITARY_WINDOW_STARTS_RUN=1, as isolated
 * runs already do, so `pnpm dev` never loads a real agent that later windows
 * from any working copy would join. launchctl is a stand-in asked nothing.
 */

function starterFor(how: { packaged: boolean; isolated: boolean }) {
  const work = {
    launcher: { executable: "/Applications/Infinitary.app/Contents/MacOS/Infinitary", args: [] },
    serviceManager: { launchctl: async () => ({ ok: true, output: "" }) },
    backgroundEnv: {},
  } as unknown as WorkContext;
  return commandStarter({
    work,
    flavor: "dev",
    dataDir: scratchDir("infinitary-command-starter-"),
    switched: false,
    ...how,
  });
}

describe("which window starts the command", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    account.noRecord = false;
  });

  it("starts none from a development run unless it asks to, isolated or not", () => {
    vi.stubEnv("INFINITARY_WINDOW_STARTS_RUN", "");
    expect(starterFor({ packaged: false, isolated: false })).toBeNull();
    expect(starterFor({ packaged: false, isolated: true })).toBeNull();
    vi.stubEnv("INFINITARY_WINDOW_STARTS_RUN", "1");
    expect(starterFor({ packaged: false, isolated: false })).not.toBeNull();
    expect(starterFor({ packaged: false, isolated: true })).not.toBeNull();
  });

  it("starts one from an installed app, never for isolated data, whatever the setting", () => {
    vi.stubEnv("INFINITARY_WINDOW_STARTS_RUN", "1");
    expect(starterFor({ packaged: true, isolated: true })).toBeNull();
    vi.stubEnv("INFINITARY_WINDOW_STARTS_RUN", "");
    expect(starterFor({ packaged: true, isolated: false })).not.toBeNull();
  });

  // The merge queue's Mac startup check (scripts/check-user-data-dir.sh) found it: an installed app
  // whose home is pinned to another folder started a run with the account's own home, which opened
  // another data folder, and the window waited on it forever.
  it("starts none from an installed app whose home is not the account's own", () => {
    vi.stubEnv("INFINITARY_WINDOW_STARTS_RUN", "");
    vi.stubEnv("CFFIXED_USER_HOME", scratchDir("infinitary-command-starter-home-"));
    expect(starterFor({ packaged: true, isolated: false })).toBeNull();
    vi.stubEnv("CFFIXED_USER_HOME", "");
    vi.stubEnv("HOME", scratchDir("infinitary-command-starter-home-"));
    expect(starterFor({ packaged: true, isolated: false })).toBeNull();
  });

  // The review of the queue repair: a container started with an arbitrary user id has no user
  // record, and the window must still open, running its own first mate.
  it("starts none from an installed app whose account has no user record", () => {
    vi.stubEnv("INFINITARY_WINDOW_STARTS_RUN", "");
    vi.stubEnv("CFFIXED_USER_HOME", "");
    // The account's own home, so only the failed lookup can make the window keep its first mate.
    vi.stubEnv("HOME", userInfo().homedir);
    account.noRecord = true;
    expect(starterFor({ packaged: true, isolated: false })).toBeNull();
  });
});
