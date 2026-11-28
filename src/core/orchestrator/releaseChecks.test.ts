/**
 * The host's release check (docs/task-record.md, "A release check"; INF-7198's
 * approved plan, Part 2, the captain's pick "A short crewmate check, only while
 * a task waits, reading however the project ships"). Each case drives the
 * supervisor's own doors over the stand-in workspace, whose `originTags` plays
 * origin's tags, on the harness's faked clock, and reads the task record, the
 * crewmate's briefs and the report sort.
 */

import * as m from "@shared/i18n/messages.generated";
import { isReleaseCheck } from "@shared/routingPolicy";
import { describe, expect, it, vi } from "vitest";
import {
  fakeCrewmate,
  fakeCrewTimersEachTest,
  setup,
  tick,
} from "../../../tests/helpers/crewHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { seedTask } from "../tasks/seedTask";
import { seedProject } from "../workspace/seedProject";
import { RELEASE_CHECK_FLOOR_MS, RELEASE_CHECK_GAP_MS } from "./releaseChecks";

fakeCrewTimersEachTest();

const HOUR = 60 * 60 * 1000;
const MERGE_COMMIT = "f634d07dd4a1c0ffee5eed0123456789abcdef01";
const RELEASE = {
  version: "0.8.12-alpha.67",
  url: "https://github.com/octo/shop/releases/tag/v0.8.12-alpha.67",
  evidence:
    "The fix's merge commit is an ancestor of the release's commit; the release was published after the merge.",
};

/**
 * Project shop, its folder on disk, a fix merged now with its merge commit and
 * no first release, and the issue's waiting task with `moment` release waiting
 * on it, as the Outside work items runbook files one.
 */
function shop(options: { waiting?: "release" | "merge" | "none" } = {}) {
  const crewmate = fakeCrewmate();
  const h = setup(crewmate);
  seedProject(h.db, {
    id: "shop",
    name: "shop",
    path: scratchDir("infinitary-release-check-"),
    origin: "https://github.com/octo/shop.git",
    delivery: "direct-pr",
  });
  let tags = "tags-at-merge";
  const originTags = vi.fn(async (_folder: string) => tags);
  Object.assign(h.workspace, { originTags });
  seedTask(h.tasks, {
    id: "fix",
    title: "Fix the negative reading",
    status: "queued",
    startPolicy: "on-request",
    repoId: "shop",
  });
  seedDelivery(h.tasks, "fix", { mergedSha: MERGE_COMMIT });
  h.tasks.close("fix", { status: "done", reason: "merged", actor: "host" });
  const moment = options.waiting ?? "release";
  if (moment !== "none") {
    seedTask(h.tasks, {
      id: "tell-item",
      title: "Tell the issue how the fix ended",
      status: "queued",
      repoId: "shop",
      blockedBy: ["fix"],
      shape: { kind: "unclear", side_effect: true, side_effect_moment: moment },
    });
  }
  const checks = () =>
    h.tasks.list().filter((row) => row.repoId === "shop" && isReleaseCheck(row.shape?.in_place));
  const look = async () => {
    await h.supervisor.inPlaceWork.releaseChecks.look();
    await tick();
  };
  return {
    ...h,
    crewmate,
    originTags,
    checks,
    look,
    pushTag: (digest: string) => {
      tags = digest;
    },
  };
}

/** The check's crewmate reports, its turn ends, and the host's minute read runs. */
async function reportAndSettle(
  h: ReturnType<typeof shop>,
  text: string,
  declared?: Parameters<NonNullable<(typeof h.specs)[number]["onReport"]>>[2],
) {
  await h.specs.at(-1)?.onReport?.(text, undefined, declared);
  h.crewmate.finishPrompt();
  await tick();
  await h.supervisor.inPlaceWork.closeCurrentFolders();
  await tick();
}

describe("the host's release check", () => {
  // Plan Part 2: "While it is empty, nothing runs."
  it("reads nothing and files nothing while no release-moment task waits on unreleased merged work", async () => {
    for (const waiting of ["none", "merge"] as const) {
      const h = shop({ waiting });
      vi.advanceTimersByTime(2 * RELEASE_CHECK_FLOOR_MS);
      await h.look();
      expect(h.originTags).not.toHaveBeenCalled();
      expect(h.checks()).toEqual([]);
    }

    const released = shop();
    seedDelivery(released.tasks, "fix", { firstRelease: RELEASE });
    vi.advanceTimersByTime(2 * RELEASE_CHECK_FLOOR_MS);
    await released.look();
    expect(released.originTags).not.toHaveBeenCalled();
    expect(released.checks()).toEqual([]);
  });

  // Plan Part 2: "It starts when the project's clone first sees a tag it has not seen, at most
  // every few hours, and at least once a day otherwise."
  it("starts on a tag its last check did not see, never within three hours of the last, at most one at a time, and daily with no tag", async () => {
    const h = shop();
    await h.look();
    expect(h.originTags).toHaveBeenCalledTimes(1);
    expect(h.checks()).toEqual([]);

    h.pushTag("tags-with-alpha-67");
    await h.look();
    const [first] = h.checks();
    if (!first) throw new Error("no release check was filed on a new tag");
    expect(first).toMatchObject({ title: m.taskReleaseCheckTitle(), startPolicy: "when-ready" });
    expect(first.shape?.in_place).toEqual({
      release: { tasks: ["fix"], tags: "tags-with-alpha-67" },
    });
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1));
    const fix = h.tasks.get("fix");
    expect(h.crewmate.promptCalls[0]).toContain(
      `- ${fix?.key} "Fix the negative reading": merged ${new Date(fix?.closedAt ?? 0).toISOString()}, merge commit ${MERGE_COMMIT}`,
    );

    h.pushTag("tags-with-alpha-68");
    vi.advanceTimersByTime(RELEASE_CHECK_GAP_MS);
    await h.look();
    expect(h.checks()).toHaveLength(1);

    await reportAndSettle(h, "The fix is in no published release yet.");
    expect(h.tasks.get(first.id)).toMatchObject({ status: "done", closedReason: "finished" });
    expect(h.tasks.get("tell-item")?.status).toBe("open");

    vi.setSystemTime(first.createdAt + RELEASE_CHECK_GAP_MS - 60_000);
    await h.look();
    expect(h.checks()).toHaveLength(1);

    vi.setSystemTime(first.createdAt + RELEASE_CHECK_GAP_MS);
    await h.look();
    const second = h.checks().find((row) => row.id !== first.id);
    if (!second) throw new Error("no release check was filed on the next tag");
    expect(second.shape?.in_place).toEqual({
      release: { tasks: ["fix"], tags: "tags-with-alpha-68" },
    });
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(2));
    await reportAndSettle(h, "Still in no published release.");

    vi.setSystemTime(second.createdAt + RELEASE_CHECK_FLOOR_MS - 60_000);
    await h.look();
    expect(h.checks()).toHaveLength(2);
    vi.setSystemTime(second.createdAt + RELEASE_CHECK_FLOOR_MS);
    await h.look();
    expect(h.checks()).toHaveLength(3);
  });

  it("with no tag read and no check yet, starts a day after the oldest listed merge", async () => {
    const h = shop();
    h.originTags.mockRejectedValue(new Error("origin could not be read"));
    const merged = h.tasks.get("fix")?.closedAt ?? 0;
    vi.setSystemTime(merged + RELEASE_CHECK_FLOOR_MS - 60_000);
    await h.look();
    expect(h.checks()).toEqual([]);
    vi.setSystemTime(merged + RELEASE_CHECK_FLOOR_MS);
    await h.look();
    const [check] = h.checks();
    expect(check?.shape?.in_place).toEqual({ release: { tasks: ["fix"] } });
  });

  // Plan Part 2: "It declares what it verified through report.first_release ... Then 'Work
  // ships in a release' fires and Part 1 starts the waiting task."
  it("records the release its check declares, wakes no first mate, closes it, and the waiting task starts", async () => {
    const h = shop();
    await h.look();
    h.pushTag("tags-with-alpha-67");
    await h.look();
    const [check] = h.checks();
    if (!check) throw new Error("no release check was filed");
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(1));
    const fixKey = h.tasks.get("fix")?.key ?? "";

    await reportAndSettle(h, `${fixKey} first shipped in ${RELEASE.version}.`, {
      firstRelease: { ...RELEASE, tasks: [fixKey] },
    });
    expect(h.tasks.get("fix")?.delivery?.firstRelease).toMatchObject({
      version: RELEASE.version,
      url: RELEASE.url,
    });
    expect(h.sorts.filter((sort) => sort.taskId === check.id).map((sort) => sort.rule)).toEqual([
      "host-check",
    ]);
    expect(h.tasks.get(check.id)).toMatchObject({ status: "done", closedReason: "finished" });

    await h.supervisor.watch.sweepGates(Date.now());
    await tick();
    await vi.waitFor(() => expect(h.crewmate.promptCalls).toHaveLength(2));
    expect(h.crewmate.promptCalls[1]).toContain(
      `merged; first shipped in release ${RELEASE.version} (${RELEASE.url})`,
    );

    vi.advanceTimersByTime(2 * RELEASE_CHECK_FLOOR_MS);
    await h.look();
    expect(h.checks()).toHaveLength(1);
  });
});
