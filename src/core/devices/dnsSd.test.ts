import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NearbyMacsView } from "@shared/nearbyMacs";
import { describe, expect, it } from "vitest";
import { standInDnsSd } from "../../../tests/helpers/dnsSdStandIn";
import { runDnsSd, runDnsSdHeld } from "./dnsSd";
import { NearbyMacs } from "./nearby";

/**
 * Macs nearby through a real process (docs/devices.md, "Macs nearby"): a
 * stand-in for macOS's dns-sd, started the way the app starts it, browses
 * and answers each Mac's name, and every run is gone once the looking stops.
 * Never macOS's own dns-sd, which would listen on this Mac's network.
 */

// Integration budget (docs/test-cohorts.md): a shell script per run, the
// slowest case 1.40 s at its fastest of three runs on an Apple silicon Mac
// (the held run, which waits out a one-second `-t`), so vitest's 5 s
// default; a poll waits for a run to end for the rest of it
// (tests/helpers/waitWindow.ts).

/** Every run the stand-in started, by its process id. */
function runs(program: string): number[] {
  const pids = join(dirname(program), "pids");
  if (!existsSync(pids)) return [];
  return readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("Macs nearby through dns-sd", () => {
  it("lists the Macs it answers, leaves this Mac out, and ends every run once stopped", async () => {
    const program = standInDnsSd([
      { name: "Kun’s Mac mini", at: "Kuns-Mac-mini.local" },
      { name: "Kun’s MacBook Pro", at: "Kuns-MacBook-Pro.local" },
    ]);
    let seen: NearbyMacsView | null = null;
    const nearby = new NearbyMacs({
      run: runDnsSd(program),
      ownNames: async () => ["kuns-macbook-pro.local"],
      user: "kun",
      changed: (view) => {
        seen = view;
      },
    });
    nearby.ask(true);
    await expect
      .poll(() => seen)
      .toEqual({
        state: "looking",
        user: "kun",
        macs: [{ name: "Kun’s Mac mini", at: "Kuns-Mac-mini.local" }],
      });
    // The browse waits on; both lookups were ended once they answered.
    await expect.poll(() => runs(program).filter(alive).length).toBe(1);
    nearby.ask(false);
    expect(runs(program)).toHaveLength(3);
    await expect.poll(() => runs(program).filter(alive)).toEqual([]);
    expect(seen).toEqual({ state: "off", user: null, macs: [] });
  });

  it("says it could not look when dns-sd cannot start", async () => {
    let seen: NearbyMacsView | null = null;
    const nearby = new NearbyMacs({
      run: runDnsSd(join(dirname(standInDnsSd([])), "missing")),
      ownNames: async () => [],
      user: "kun",
      changed: (view) => {
        seen = view;
      },
    });
    nearby.ask(true);
    await expect.poll(() => seen?.state).toBe("failed");
    nearby.dispose();
  });
});

/**
 * INF-64 piece 1: an announcement (`dns-sd -R`) has no end of its own, so it
 * is held by the app's pipe and ends with it (docs/devices.md, "Announcing to
 * a phone"). Through the same stand-in program; never macOS's own dns-sd.
 */
describe("a held run of dns-sd", () => {
  it("ends dns-sd itself when stopped, and says when dns-sd ends by itself", async () => {
    const program = standInDnsSd([]);
    const ended: boolean[] = [];
    const held = runDnsSdHeld(program)(["-R", "Mini", "_infinitary._tcp", "local.", "1"], {
      line: () => {},
      ended: (finished) => ended.push(finished),
    });
    await expect.poll(() => runs(program)).toHaveLength(1);
    const [pid] = runs(program);
    expect(alive(pid ?? 0)).toBe(true);
    held.stop();
    await expect.poll(() => alive(pid ?? 0)).toBe(false);

    const byItself: boolean[] = [];
    runDnsSdHeld(program)(["-t", "1", "-R", "Mini", "_infinitary._tcp", "local.", "1"], {
      line: () => {},
      ended: (finished) => byItself.push(finished),
    });
    await expect.poll(() => byItself, { timeout: 4_000 }).toEqual([true]);
  });
});
