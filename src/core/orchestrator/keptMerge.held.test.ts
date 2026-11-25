/**
 * Intent: the captain's report that the approved merge of a clean pull
 * request stayed stuck for over 40 minutes while GitHub answered 409 to
 * every background merge request, until they merged it by hand, and the ask
 * that it never happens again; their choice for a request GitHub keeps
 * holding is "Merge it directly, then tell me".
 *
 * The app's own kept approval (a real CrewSupervisor through the crew
 * harness) sends its merge through the app's real GitHub client
 * (`GitHubForge`) to a scripted GitHub over real HTTP. Every other read of
 * the pull request (checks, readiness, open or merged) is the harness's
 * GitHub stand-in, which reads open and clean until a merge goes through.
 */

import { describe, expect, it, vi } from "vitest";
import { fakeCrewTimersEachTest, settleWakes, tick } from "../../../tests/helpers/crewHarness";
import { APPROVED, approved, type KeptForge } from "../../../tests/helpers/crewHarnessGit";
import { type Route, stub } from "../../../tests/helpers/githubForgeStub";
import type { Forge, ForgeRuleset } from "../forge";

vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

fakeCrewTimersEachTest();

const MERGE_ASYNC = "/repos/octo/meter/pulls/7/merge-async";
const DIRECT = "/repos/octo/meter/pulls/7/merge";
const UUID = "630b9d5e-1f4c-4e8b-9a6d-2e7b8a900b9f";
/** GitHub's documented pending shape: a 409 "returns that request's UUID and merge options". */
const PENDING = {
  status: "pending",
  details: {
    message: "Merge request is in progress.",
    uuid: UUID,
    merge_method: "squash",
    merge_action: "default",
    expected_head_sha: APPROVED,
    bypass_rules: false,
  },
};

/**
 * GitHub as the reported pull request's record shows it, by the minute since
 * the first send: 502 "Server Error" then, 500 with no words from minute 11,
 * and 409 from minute 41 to minute 88. The answers between those recorded
 * moments are this script's filler. The merge request GitHub holds never
 * finishes unless `held` says otherwise, and `direct` is GitHub's answer to
 * the direct merge.
 */
function stuck(
  minute: () => number,
  conflict: () => ReturnType<Route>,
  direct: () => ReturnType<Route>,
  held: () => unknown,
): Record<string, Route> {
  return {
    [`PUT ${MERGE_ASYNC}`]: () => {
      const at = minute();
      if (at < 11) return { status: 502, json: { message: "Server Error" } };
      if (at < 41) return { status: 500 };
      return conflict();
    },
    [`GET ${MERGE_ASYNC}/${UUID}`]: () => ({ json: held() }),
    [`PUT ${DIRECT}`]: direct,
  };
}

/**
 * The harness's GitHub stand-in, with its merges and its reads of a held
 * merge request sent by the app's real GitHub client.
 */
function sendingThrough(
  own: KeptForge,
  real: Awaited<ReturnType<typeof stub>>["forge"],
  queueBranch: boolean,
): Forge {
  return new Proxy(own, {
    get(target, key, receiver) {
      // GitHub's rules for the branch: a merge queue, where the scenario has one.
      if (key === "branchRules")
        return async (): Promise<ForgeRuleset[]> =>
          queueBranch ? [{ id: 1, name: "queue", bypass: "never", rules: ["merge_queue"] }] : [];
      if (key === "putIn") return real.putIn.bind(real);
      if (key === "putInDirectly") return real.putInDirectly.bind(real);
      if (key === "heldMergeState") return real.heldMergeState.bind(real);
      // The project allows a squash.
      if (key === "mergeWays") return async () => ({ squash: true, rebase: false, merge: false });
      return Reflect.get(target, key, receiver);
    },
  }) as unknown as Forge;
}

const MINUTE = 60_000;
/** Let real HTTP and the app's own short waits run, without moving the clock by more than a second or two. */
async function settle(until: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !until(); i++) {
    await vi.advanceTimersByTimeAsync(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/**
 * The captain approves the merge at minute 0 and `minutes` pass. Each minute
 * the app's own rider runs every approval whose wait came due, and the first
 * mate tries its own merge at the minutes the record shows.
 */
async function replay(
  minutes: number,
  conflict: () => ReturnType<Route>,
  direct: (merge: () => void) => ReturnType<Route>,
  where: { queueBranch?: boolean; held?: () => unknown } = {},
) {
  let started = Date.now();
  const minute = () => Math.round((Date.now() - started) / MINUTE);
  let standIn: KeptForge | undefined;
  const github = await stub(
    stuck(
      minute,
      conflict,
      () =>
        direct(() => {
          if (standIn) standIn.merged = true;
        }),
      where.held ?? (() => PENDING),
    ),
    [],
  );
  const h = await approved({
    forgeFor: (_repo, own) => {
      standIn = own;
      return sendingThrough(own, github.forge, where.queueBranch ?? false);
    },
  });
  const repoId = h.tasks.get(h.taskId)?.repoId;
  if (!repoId) throw new Error("Missing project");
  // The project merges on its own; the first mate's merge passes the gate there.
  h.repos.configure(repoId, { autonomy: true });
  started = Date.now();
  /** Every request GitHub saw, with the minute it arrived. */
  const stamped: string[] = [];
  const stamp = () => {
    for (const request of github.seen.slice(stamped.length))
      stamped.push(
        `${minute()} ${request.method} ${request.url.replace("/repos/octo/meter/pulls/7/", "")}`,
      );
  };
  const due = () => {
    const at = h.authorization()?.retryAt;
    return at !== undefined && at <= Date.now();
  };
  const firstmate = async () => {
    let answer: { text: string; ok: boolean } | undefined;
    void h.supervisor.settling.settle.settleTaskDetailed(h.taskId, "merge-pr").then((result) => {
      answer = result;
    });
    await settle(() => answer !== undefined);
    stamp();
    return answer;
  };
  const pass = async (count: number, firstmateAt = new Set<number>()) => {
    const heard: (string | undefined)[] = [];
    for (let i = 0; i < count; i++) {
      await vi.advanceTimersByTimeAsync(MINUTE);
      if (due()) {
        h.supervisor.settling.kept.reconcileMergeAuthorizations(Date.now());
        await settle(() => !due());
        stamp();
      }
      if (firstmateAt.has(minute())) heard.push((await firstmate())?.text.split("\n")[0]);
    }
    return heard;
  };

  // The captain's click on the merge card.
  h.supervisor.cardActions.act(h.card.id, "merge");
  await settle(() => h.authorization()?.waiting?.on === "outcome" && !due());
  h.crewmate.finishPrompt();
  await tick();
  stamp();
  const heard = await pass(minutes, new Set([11, 41, 53, 88]));
  return { h, heard, stamped, pass, github };
}

const merges = (merge: () => void) => {
  merge();
  return { json: { merged: true, sha: "squash01" } };
};
/** The requests GitHub saw from the first 409 on, each with its minute. */
const fromFirstConflict = (stamped: string[]) =>
  stamped.filter((line) => Number(line.split(" ")[0]) >= 41);
/** Every request that could change the pull request, from the first 409 on. */
const writes = (stamped: string[]) =>
  fromFirstConflict(stamped).filter((line) => line.includes(" PUT "));
const timelineOf = (h: Awaited<ReturnType<typeof replay>>["h"]) =>
  h.tasks.timeline(h.taskId).map((event) => event.text ?? "");
const TOLD_ONCE =
  "GitHub had held the first merge request for 5 minutes without finishing it, so the app merged the pull request directly at the approved version. Tell the captain that once; nothing else is needed.";

describe("a merge request GitHub holds for an approved, clean pull request", () => {
  it("follows the request a 409 names without sending it again, merges directly once five minutes on, and wakes the first mate once to tell the captain", async () => {
    const { h, heard, stamped, github } = await replay(
      88,
      () => ({ status: 409, json: PENDING }),
      merges,
    );
    // The first 409 arrives at minute 41: one read of the request it names
    // then, one more five minutes later, and the direct merge beside it.
    expect(fromFirstConflict(stamped)).toEqual([
      "41 PUT merge-async",
      `41 GET merge-async/${UUID}`,
      `46 GET merge-async/${UUID}`,
      "46 PUT merge",
    ]);
    const direct = github.seen.find((request) => request.url === DIRECT);
    expect(direct?.body).toMatchObject({ sha: APPROVED, merge_method: "squash" });
    const record = h.tasks.get(h.taskId);
    expect(record?.status).toBe("done");
    expect(record?.closedReason).toBe("merged");
    expect(h.authorization()?.receipt).toMatchObject({ head: APPROVED, sha: "squash01" });
    // The first mate's own merge at minute 41 sent nothing beside the approval's, and heard why.
    expect(heard[1]).toContain(
      `Cannot merge yet: GitHub is holding an earlier merge request of #7 (${UUID})`,
    );
    expect(heard.slice(2)).toEqual([
      "#7 is already merged on GitHub.",
      "#7 is already merged on GitHub.",
    ]);
    // Activity says it, and one wake tells the first mate to tell the captain.
    expect(timelineOf(h).filter((text) => text.startsWith("Merged #7"))).toEqual([
      `Merged #7 on GitHub directly, after GitHub held the first merge request. https://github.com/o/r/pull/7 ${TOLD_ONCE}`,
    ]);
    const wakes = settleWakes(h.ops).filter((wake) => wake.includes("Merged #7"));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(TOLD_ONCE);
    expect(h.cards()).toHaveLength(0);
    await h.supervisor.disposeAll();
  });

  it("bounds a hold GitHub does not name the same way: the reported 409 with no words is merged directly five minutes on", async () => {
    const { h, stamped } = await replay(88, () => ({ status: 409 }), merges);
    expect(fromFirstConflict(stamped)).toEqual(["41 PUT merge-async", "46 PUT merge"]);
    const record = h.tasks.get(h.taskId);
    expect(record?.status).toBe("done");
    expect(record?.closedReason).toBe("merged");
    await h.supervisor.disposeAll();
  });

  it("sends the direct merge once: when GitHub refuses it the first mate is woken once with the reason and nothing but reads follows", async () => {
    const refusal = "Pull Request is not mergeable";
    const { h, stamped, pass } = await replay(
      88,
      () => ({ status: 409, json: PENDING }),
      () => ({ status: 405, json: { message: refusal } }),
    );
    // Three more hours.
    await pass(180);
    // Neither the rider nor the first mate's merges at minutes 53 and 88 send anything more.
    expect(writes(stamped)).toEqual(["41 PUT merge-async", "46 PUT merge"]);
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    expect(h.authorization()?.status).toBe("standing");
    expect(h.authorization()?.heldMerge).toMatchObject({ request: UUID, direct: "refused" });
    const wakes = settleWakes(h.ops).filter((wake) => wake.includes(refusal));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(`GitHub answered 405 to PUT ${DIRECT}: ${refusal}`);
    expect(h.cards()).toHaveLength(0);
    // A merge by hand on GitHub is still read and closes the task.
    h.forge.merged = true;
    await pass(31);
    expect(h.tasks.get(h.taskId)?.status).toBe("done");
    await h.supervisor.disposeAll();
  });

  it("never sends the direct merge again when its answer never came, and reads the pull request instead", async () => {
    const { h, stamped, pass } = await replay(
      88,
      () => ({ status: 409, json: PENDING }),
      // GitHub merges it and the answer is lost on the way back.
      () => ({ status: 502, json: { message: "Server Error" } }),
    );
    await pass(180);
    expect(writes(stamped)).toEqual(["41 PUT merge-async", "46 PUT merge"]);
    expect(h.authorization()?.heldMerge).toMatchObject({ request: UUID, direct: "sent" });
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    // The pull request reads merged: the task closes and the first mate is told once.
    h.forge.merged = true;
    await pass(31);
    expect(h.tasks.get(h.taskId)?.status).toBe("done");
    const wakes = settleWakes(h.ops).filter((wake) => wake.includes("Merged #7"));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain("Tell the captain that once");
    expect(writes(stamped)).toEqual(["41 PUT merge-async", "46 PUT merge"]);
    await h.supervisor.disposeAll();
  });

  it("sends no direct merge where the branch takes merges only through its merge queue, and wakes the first mate once to say so", async () => {
    const { h, stamped, pass } = await replay(88, () => ({ status: 409, json: PENDING }), merges, {
      queueBranch: true,
    });
    await pass(180);
    expect(writes(stamped)).toEqual(["41 PUT merge-async"]);
    expect(h.authorization()?.heldMerge).toMatchObject({ request: UUID, direct: "queue" });
    expect(h.tasks.get(h.taskId)?.status).toBe("active");
    const wakes = settleWakes(h.ops).filter((wake) => wake.includes("merge queue"));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toContain(
      "GitHub has held an earlier merge request of #7 for 5 minutes without finishing it, and main takes merges only through its merge queue, so the app does not send its direct merge",
    );
    await h.supervisor.disposeAll();
  });

  it("hands a held request GitHub's merge queue took to the queue's own wait, and sends nothing", async () => {
    let queued = false;
    const { h, stamped, pass } = await replay(43, () => ({ status: 409, json: PENDING }), merges, {
      held: () => (queued ? { status: "enqueued", details: {} } : PENDING),
    });
    expect(h.authorization()?.heldMerge).toMatchObject({ request: UUID });
    queued = true;
    // The pull request reads in the queue from then on.
    h.forge.inQueue = true;
    await pass(60);
    expect(writes(stamped)).toEqual(["41 PUT merge-async"]);
    expect(h.authorization()?.waiting?.on).toBe("host-queue");
    expect(h.authorization()?.handed).toMatchObject({ head: APPROVED });
    expect(h.authorization()?.heldMerge).toBeUndefined();
    await h.supervisor.disposeAll();
  });
});
