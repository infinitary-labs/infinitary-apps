import { existsSync } from "node:fs";
import { createKeyIdentity } from "@core/devices/identity";
import { JoinedHome } from "@core/devices/joinedHome";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { leaveWorkHome, type WorkHomeSeams } from "./workHome";

/**
 * A reset leaves the home this computer runs work for (docs/reset.md,
 * "Before it quits"; the approved plan's "Leave" for a first mate this
 * computer works for): the home hears Leave when it answers, and the work
 * lets it go either way, so the fresh install is joined to nothing.
 */

function joinedWork() {
  const dataDir = scratchDir("inf-reset-work-");
  const identity = createKeyIdentity("work device");
  new JoinedHome(dataDir, () => {}).join(
    {
      at: "192.0.2.20:47623",
      homeKey: "K".repeat(43),
      deviceId: "mini",
      kind: "work",
      key: identity.key,
      cert: identity.cert,
      onHomeMac: false,
    },
    1_000,
  );
  return dataDir;
}

function home(answers: boolean) {
  const heard: string[] = [];
  let clock = 0;
  const seams: WorkHomeSeams = {
    reachMs: 1_000,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    link: (grant) => {
      let open = false;
      return {
        start: () => {
          heard.push(`dial ${grant.at}`);
          open = answers;
        },
        connection: () => (open ? {} : null),
        leave: async () => {
          heard.push(open ? "leave" : "leave unheard");
          return open;
        },
      };
    },
  };
  return { heard, seams };
}

describe("leaving the home this computer works for", () => {
  it("tells a home in reach, then lets it go", async () => {
    const dataDir = joinedWork();
    const { heard, seams } = home(true);
    expect(await leaveWorkHome({ dataDir, background: null }, seams)).toBe(true);
    expect(heard).toEqual(["dial 192.0.2.20:47623", "leave"]);
    expect(new JoinedHome(dataDir, () => {}).read()).toBeNull();
  });

  it("still lets a home out of reach go after the wait", async () => {
    const dataDir = joinedWork();
    const { heard, seams } = home(false);
    expect(await leaveWorkHome({ dataDir, background: null }, seams)).toBe(true);
    expect(heard).toEqual(["dial 192.0.2.20:47623", "leave unheard"]);
    expect(new JoinedHome(dataDir, () => {}).read()).toBeNull();
  });

  it("dials nothing where this computer works for no home", async () => {
    const dataDir = scratchDir("inf-reset-work-none-");
    const { heard, seams } = home(true);
    expect(await leaveWorkHome({ dataDir, background: null }, seams)).toBe(true);
    expect(heard).toEqual([]);
    expect(existsSync(dataDir)).toBe(true);
  });
});
