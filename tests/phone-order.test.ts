import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  contractOf,
  GITHUB_PATIENCE,
  phoneChanges,
  phoneRuns,
  readGitHub,
  storeRelease,
  testFlightBuilds,
} from "../scripts/phone-order.ts";
import type { AppleRead } from "../scripts/phone-release.ts";
import { contractAccess } from "../src/shared/contractFeatures.ts";
import { PROTOCOL_VERSION, VIEW_FLOOR } from "../src/shared/ipc.ts";
import { runJobNames } from "./helpers/ciJobNames";

/**
 * INF-1649, the captain's words: "alpha desktop builds wait for phone build is on
 * testflight. stable desktop releases wait for phone builds are live in app store
 * (which we haven't done yet, so enforce this only once the first ios app release
 * is live in app store)".
 */
describe("the release order between the phone and the desktop app", () => {
  it("reads a commit's contract and floor, and a commit from before the floor as strict", () => {
    const today = readFileSync("src/shared/ipc.ts", "utf8");
    expect(contractOf(today)).toEqual({
      major: Number(PROTOCOL_VERSION.split(".")[0]),
      floor: VIEW_FLOOR,
    });
    const beforeFloor = today.replace(/export const VIEW_FLOOR = \d+;/, "");
    expect(contractOf(beforeFloor).floor).toBeNull();
  });

  it("waits for exactly the phone builds the connection would answer in full", () => {
    for (let phone = 9; phone <= 14; phone++)
      for (let desktop = 9; desktop <= 14; desktop++)
        for (const phoneFloor of [null, 9, 11, 12, 13])
          for (const desktopFloor of [null, 9, 11, 12, 13]) {
            if (phoneFloor !== null && phoneFloor > phone) continue;
            if (desktopFloor !== null && desktopFloor > desktop) continue;
            // A desktop from before the floor (INF-1649 review R1) applied the
            // strict rule to every view: contractAccess with no view.
            const access =
              desktopFloor === null
                ? contractAccess(`${phone}.0.0`, `${desktop}.0.0`)
                : contractAccess(`${phone}.0.0`, `${desktop}.0.0`, {
                    ...(phoneFloor === null ? {} : { clientFloor: phoneFloor }),
                    homeFloor: desktopFloor,
                  });
            expect(
              phoneChanges(
                { major: phone, floor: phoneFloor },
                { major: desktop, floor: desktopFloor },
              ),
              `phone ${phone}/${phoneFloor} on desktop ${desktop}/${desktopFloor}`,
            ).toBe(access === "full");
          }
  });

  // ios-release.yml's runs as GitHub lists them, newest first.
  const run = (id: number, run_number: number, head_sha: string, display_title: string) => ({
    id,
    run_number,
    head_sha,
    display_title,
    status: "completed",
    conclusion: "success",
  });
  const runs = [
    run(40500000000, 7, "a".repeat(40), "Infinitary 0.6.0 — check build 6.1"),
    run(40423353350, 6, "8b6c1af32".padEnd(40, "0"), "Infinitary 0.5.0 — TestFlight"),
    run(40222788969, 5, "02123128a".padEnd(40, "0"), "Infinitary 0.4.0 — TestFlight"),
  ];

  it("counts a build on TestFlight once Apple confirmed it, by its own run or a later check", async () => {
    const availability = new Map([
      [40500000000, "success"],
      [40423353350, "failure"],
      [40222788969, "success"],
    ]);
    const builds = await testFlightBuilds(runs, async (one) => [
      { name: "resolve", status: "completed", conclusion: "success" },
      { name: "availability", status: "completed", conclusion: availability.get(one.id) ?? null },
    ]);
    expect(builds).toEqual([
      { build: "6.1", source: "8b6c1af32".padEnd(40, "0") },
      { build: "5.1", source: "02123128a".padEnd(40, "0") },
    ]);
  });

  // INF-2413: runs after the trigger-first rename name the job as ios-release.yml
  // does for each request (docs/testing.md, "CI job names").
  it("counts a build whose availability job is named trigger first, by its own run or a later check", async () => {
    const named = (check_build: string) =>
      runJobNames("ios-release.yml", {
        github: { event_name: "workflow_dispatch" },
        inputs: { version: "0.6.0", check_build },
        needs: {
          resolve: { result: "success", outputs: { mode: check_build ? "status" : "release" } },
          testflight: { result: "success" },
        },
      }).find((name) => name.endsWith("Confirm TestFlight availability")) as string;
    expect(named("")).toBe("Requested TestFlight · Confirm TestFlight availability");
    expect(named("6.1")).toBe("Requested TestFlight status · Confirm TestFlight availability");
    const builds = await testFlightBuilds(runs, async (one) => [
      {
        name: named(one.display_title.includes("check build") ? "6.1" : ""),
        status: "completed",
        conclusion: one.id === 40423353350 ? "failure" : "success",
      },
    ]);
    expect(builds).toEqual([
      { build: "6.1", source: "8b6c1af32".padEnd(40, "0") },
      { build: "5.1", source: "02123128a".padEnd(40, "0") },
    ]);
  });

  // INF-1784: the run's external testing job goes on after availability passed,
  // for ten minutes or more while Apple prepares the build for outside testers.
  it("counts a build whose availability job passed while its run still adds it to external testing", async () => {
    const running = (id: number, run_number: number, head_sha: string) => ({
      ...run(id, run_number, head_sha, "Infinitary 0.7.0 — TestFlight"),
      status: "in_progress",
      conclusion: null,
    });
    const confirmed = running(40700000000, 9, "e".repeat(40));
    const confirming = running(40800000000, 10, "f".repeat(40));
    const builds = await testFlightBuilds([confirming, confirmed], async (one) =>
      one.id === confirmed.id
        ? [
            {
              name: "Requested TestFlight · Confirm TestFlight availability",
              status: "completed",
              conclusion: "success",
            },
            {
              name: "Requested TestFlight · Add the build to external testing",
              status: "in_progress",
              conclusion: null,
            },
          ]
        : [
            {
              name: "Requested TestFlight · Confirm TestFlight availability",
              status: "in_progress",
              conclusion: null,
            },
          ],
    );
    expect(builds).toEqual([{ build: "9.1", source: "e".repeat(40) }]);
  });

  it("reads every page of runs, so a check of a build whose run is on a later page still counts", async () => {
    // INF-1649 review R6: GitHub answers at most 100 runs a page.
    const older = run(40000000000, 1, "c".repeat(40), "Infinitary 0.1.0 — TestFlight");
    const pages = [runs, [older]];
    const read: number[] = [];
    const all = await phoneRuns(async (page) => {
      read.push(page);
      return { total_count: runs.length + 1, workflow_runs: pages[page - 1] ?? [] };
    });
    expect(read).toEqual([1, 2]);
    const checkOfOlder = run(40600000000, 8, "d".repeat(40), "Infinitary 0.6.0 — check build 1.2");
    const builds = await testFlightBuilds([checkOfOlder, ...all], async (one) => [
      {
        name: "availability",
        status: "completed",
        conclusion: one.id === 40600000000 ? "success" : "failure",
      },
    ]);
    expect(builds).toEqual([{ build: "1.2", source: "c".repeat(40) }]);
  });

  // INF-4061: alpha run 43384480422 failed when GitHub answered one 502 to this
  // read of an old phone run's jobs, though a build that fit was on TestFlight.
  it("waits out GitHub not answering a read, and fails at once on an answer about what was read", async () => {
    const path =
      "/repos/infinitary-labs/infinitary/actions/runs/42099484998/jobs?filter=latest&per_page=100";
    const jobs = {
      total_count: 1,
      jobs: [
        {
          name: "Requested TestFlight · Confirm TestFlight availability",
          status: "completed",
          conclusion: "success",
        },
      ],
    };
    // GitHub's answers in turn, the last one repeated.
    const reader = (first: () => Response, ...then: Array<() => Response>) => {
      let clock = 0;
      const asked: string[] = [];
      const waits: string[] = [];
      const options = {
        request: (async (url: string | URL | Request) => {
          asked.push(String(url));
          return ([first, ...then][Math.min(asked.length - 1, then.length)] ?? first)();
        }) as typeof fetch,
        pause: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
        log: (line: string) => waits.push(line),
      };
      return { read: () => readGitHub(path, "token", options), asked, waits };
    };

    const lost = () => {
      throw new TypeError("fetch failed");
    };
    const blip = reader(
      () => new Response("Server Error", { status: 502 }),
      lost,
      () => Response.json(jobs),
    );
    await expect(blip.read()).resolves.toEqual(jobs);
    expect(blip.asked).toEqual(Array(3).fill(`https://api.github.com${path}`));
    expect(blip.waits).toEqual([
      `GitHub gave HTTP 502 for ${path} after 0s; it is not answering, so the read is tried again in ${GITHUB_PATIENCE.pauseMs / 1000}s.`,
      `GitHub gave no answer (fetch failed) for ${path} after ${GITHUB_PATIENCE.pauseMs / 1000}s; it is not answering, so the read is tried again in ${GITHUB_PATIENCE.pauseMs / 1000}s.`,
    ]);

    for (const status of [401, 403, 404]) {
      const refused = reader(() => new Response("{}", { status }));
      await expect(refused.read()).rejects.toThrow(`GitHub answered ${status} for ${path}.`);
      expect(refused.asked).toHaveLength(1);
    }
    const garbled = reader(() => new Response("<html>"));
    await expect(garbled.read()).rejects.toThrow(`GitHub's answer for ${path} is not JSON.`);
    expect(garbled.asked).toHaveLength(1);

    const down = reader(() => new Response("Service Unavailable", { status: 503 }));
    const patience = GITHUB_PATIENCE.patienceMs / 1000;
    await expect(down.read()).rejects.toThrow(
      `GitHub still gave HTTP 503 for ${path} after ${patience}s of waiting; it is not answering, so the phone builds are unread.`,
    );
    expect(down.asked).toHaveLength(GITHUB_PATIENCE.patienceMs / GITHUB_PATIENCE.pauseMs + 1);
  });

  // The captain's "enforce this only once the first ios app release is live in app store" and,
  // on review R7, "Once the app has been released, stable releases always need a compatible live phone version".
  it("waits for no phone until a version was released in the App Store, then for a live build even after one is withdrawn", async () => {
    const apple =
      (versions: unknown[], included: unknown[] = []): AppleRead =>
      async () =>
        ({ data: versions, included }) as Awaited<ReturnType<AppleRead>>;
    const inReview = {
      id: "v1",
      type: "appStoreVersions",
      attributes: { appStoreState: "WAITING_FOR_REVIEW", appVersionState: "WAITING_FOR_REVIEW" },
      relationships: { build: { data: { id: "b6", type: "builds" } } },
    };
    expect(await storeRelease(apple([inReview]), "app")).toEqual({ released: false, live: null });
    const live = {
      ...inReview,
      attributes: { appStoreState: "READY_FOR_SALE", appVersionState: "READY_FOR_DISTRIBUTION" },
    };
    const build = { id: "b6", type: "builds", attributes: { version: "6.1" } };
    expect(await storeRelease(apple([live], [build]), "app")).toEqual({
      released: true,
      live: "6.1",
    });
    await expect(storeRelease(apple([live]), "app")).rejects.toThrow("without its build");
    // Withdrawn from sale with no other version live: released, so a stable still waits.
    for (const removed of [
      "DEVELOPER_REMOVED_FROM_SALE",
      "REMOVED_FROM_SALE",
      "REPLACED_WITH_NEW_VERSION",
    ]) {
      const gone = {
        ...inReview,
        attributes: { appStoreState: removed, appVersionState: removed },
      };
      expect(await storeRelease(apple([inReview, gone]), "app")).toEqual({
        released: true,
        live: null,
      });
    }
  });
});
