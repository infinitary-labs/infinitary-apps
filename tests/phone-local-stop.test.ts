import { describe, expect, it } from "vitest";
import {
  PHONE_PARTS,
  phoneJobs,
  phoneStopsEarly,
  runDeviceLanes,
} from "../scripts/phone-test-plan";

// The table's first part, the one each lane runs first.
const first = PHONE_PARTS[0].name;

// INF-2014's accepted choice: "A failed phone repeat gives back its place".
// Use the gate's actual device/part plan and its existing abort/close interface, without Xcode.
describe("local phone repeats", () => {
  it("defaults local gates to fail-fast, keeps CI discovery and honors explicit choices", () => {
    expect(phoneStopsEarly({})).toBe(true);
    expect(phoneStopsEarly({ CI: "true" })).toBe(false);
    expect(phoneStopsEarly({ INFINITARY_PHONE_STOP_EARLY: "0" })).toBe(false);
    expect(phoneStopsEarly({ CI: "true", INFINITARY_PHONE_STOP_EARLY: "1" })).toBe(true);
  });

  it("aborts the other device, starts no later parts or rounds, and closes before returning the place", async () => {
    const events: string[] = [];
    const jobs = phoneJobs(["iphone", "ipad"]);
    const stopEarly = phoneStopsEarly({});
    const repeat = async () => {
      // The caller's existing `for ... || exit` loop stops when the gate rejects.
      for (let round = 1; round <= 3; round += 1) {
        events.push(`round ${round}: take place`);
        try {
          const results = await runDeviceLanes(
            jobs,
            2,
            {
              open: async (device) => device,
              run: async ({ device, part }, _opened, stopping) => {
                events.push(`${device} ${part}`);
                if (device === "iphone") return { outcome: "failed" };
                await new Promise<void>((resolve) => {
                  stopping.addEventListener(
                    "abort",
                    () => {
                      events.push(`${device}: stopped`);
                      resolve();
                    },
                    { once: true },
                  );
                });
                return { outcome: "stopped" };
              },
              close: async (device) => {
                events.push(`${device}: deleted`);
              },
            },
            stopEarly ? ({ outcome }) => outcome === "failed" : undefined,
          );
          if (results.some((result) => result?.outcome === "failed"))
            throw new Error(`The phone gate failed: iphone ${first}`);
        } finally {
          events.push(`round ${round}: return place`);
        }
      }
    };
    await expect(repeat()).rejects.toThrow(`The phone gate failed: iphone ${first}`);
    console.info("Phone lane API trace (stand-in devices and place):", JSON.stringify(events));
    expect(events).toEqual([
      "round 1: take place",
      `ipad ${first}`,
      `iphone ${first}`,
      "ipad: stopped",
      "iphone: deleted",
      "ipad: deleted",
      "round 1: return place",
    ]);
  });

  it("still runs every part on both devices when full discovery is explicitly requested", async () => {
    const jobs = phoneJobs(["iphone", "ipad"]);
    const started: string[] = [];
    const stopEarly = phoneStopsEarly({ INFINITARY_PHONE_STOP_EARLY: "0" });
    const results = await runDeviceLanes(
      jobs,
      2,
      {
        open: async (device) => device,
        run: async ({ device, part }) => {
          started.push(`${device} ${part}`);
          return { outcome: part === first ? "failed" : "passed" };
        },
        close: async () => {},
      },
      stopEarly ? ({ outcome }) => outcome === "failed" : undefined,
    );
    expect(started.sort()).toEqual(jobs.map(({ device, part }) => `${device} ${part}`).sort());
    expect(results.filter((result) => result?.outcome === "failed")).toHaveLength(2);
    expect(results).toHaveLength(jobs.length);
  });
});
