import { taskDetailSchema } from "@shared/tasks";
import type { WorkPosture } from "@shared/workPosture";
import { describe, expect, it, vi } from "vitest";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { taskProtocolFixture } from "../../../tests/helpers/taskProtocol";
import { DecisionStore } from "../storage/decisionStore";
import type { TaskRecord } from "../storage/taskRecords";
import { seedTask } from "./seedTask";
import { queryTasks } from "./taskQuery";

/**
 * The task protocol (task-system P3, design section 9): the fields each row's
 * view derives on read.
 */

describe("the task protocol (task-system P3)", () => {
  it("identifies a host-shaped review's builder on both the board and change stream", () => {
    const { tasks, protocol, events } = taskProtocolFixture();
    tasks.create({ id: "builder", title: "Build", prompt: "p", repoId: "r1" });
    tasks.create({
      id: "ordinary",
      title: "Other child",
      prompt: "p",
      repoId: "r1",
      parentId: "builder",
    });
    tasks.create({
      id: "independent",
      title: "Unrelated review",
      prompt: "p",
      repoId: "r1",
      parentId: "builder",
      shape: { kind: "review" },
    });
    tasks.create({
      id: "reviewer",
      title: "Review",
      prompt: "p",
      repoId: "r1",
      parentId: "builder",
      shape: { kind: "review", kind_source: "host:review", basis: "builder" },
    });
    expect(
      Object.fromEntries(protocol.board().tasks.map((task) => [task.id, task.reviewOf])),
    ).toEqual({
      builder: null,
      ordinary: null,
      independent: null,
      reviewer: "builder",
    });
    // Every change names its task's builder; a part's filing also changes
    // its parent's record, which reads it (docs/task-record.md).
    const changed = events.flatMap((event) =>
      event.type === "task_changed" ? [[event.taskId, event.reviewOf]] : [],
    );
    expect(new Set(changed.map(([taskId]) => taskId))).toEqual(
      new Set(["builder", "ordinary", "independent", "reviewer"]),
    );
    for (const [taskId, reviewOf] of changed) {
      expect(reviewOf).toBe(taskId === "reviewer" ? "builder" : null);
    }
  });

  it("publishes actual placement together on the board and task-change stream", () => {
    const { tasks, protocol, events } = taskProtocolFixture();
    tasks.create({ id: "placed", title: "Placed crew", prompt: "p", repoId: "r1" });
    expect(
      protocol.board().tasks.find((task) => task.id === "placed")?.executionDeviceId,
    ).toBeNull();
    tasks.placement.setDevice("placed", "computer-a");
    expect(protocol.board().tasks.find((task) => task.id === "placed")?.executionDeviceId).toBe(
      "computer-a",
    );
    expect(events.findLast((event) => event.type === "task_changed")).toMatchObject({
      taskId: "placed",
      executionDeviceId: "computer-a",
    });
    tasks.placement.setDevice("placed", null);
    expect(events.findLast((event) => event.type === "task_changed")).toMatchObject({
      taskId: "placed",
      executionDeviceId: null,
    });
  });

  it("shows a crew filing as found on its origin, new until the captain opens it", () => {
    const { tasks, protocol } = taskProtocolFixture();
    tasks.create({ id: "origin", title: "Origin", prompt: "p", repoId: "r1" });
    const origin = tasks.get("origin");
    const { record } = tasks.fileFollowup({
      id: "fu",
      originId: "origin",
      title: "Follow-up",
      goal: "g",
      why: "the meter test failed",
      prompt: "p",
    });
    expect(protocol.board().tasks.find((task) => task.id === record.id)).toMatchObject({
      foundOn: origin?.key,
      filingNew: true,
    });
    expect(protocol.detail(record.id).filing).toEqual({
      why: "the meter test failed",
      originKey: origin?.key,
      verdict: null,
    });
    tasks.markOpened(record.id);
    expect(protocol.board().tasks.find((task) => task.id === record.id)?.filingNew).toBe(false);
    expect(taskDetailSchema.safeParse(protocol.detail(record.id)).success).toBe(true);
  });

  // INF-2546 R5, under the captain's "close the task when its finishing
  // change merges; others merge as continuing": the record's Info tab says
  // merging closes the task only for the change the open finishing card was
  // shown for. Reading a continuing pull request, or its request_merge
  // card, claims nothing, and selecting another change never moves the claim.
  it("says merging closes the task only for the change the open finishing card was shown for (INF-2546)", () => {
    const { db, tasks, protocol, cards } = taskProtocolFixture();
    db.prepare(
      "UPDATE repos SET origin = 'https://github.com/octo/nimbus-api.git', forge_kind = 'github', forge_host = 'github.com' WHERE id = 'r1'",
    ).run();
    seedTask(tasks, {
      id: "work",
      title: "Ship the API and its release",
      status: "idle",
      repoId: "r1",
      branch: "fm/task-work",
    });
    const pull = (number: number) => `https://github.com/octo/nimbus-api/pull/${number}`;
    const own = "1".repeat(40);
    const theirs = "9".repeat(40);
    seedDelivery(tasks, "work", {
      mode: "direct-pr",
      prNumber: 7,
      prUrl: pull(7),
      changeLabel: "#7",
      headSha: own,
      ci: "green",
      checks: {
        headSha: own,
        prNumber: 7,
        items: [{ name: "unit-tests", state: "success" }],
        complete: true,
        absenceDeclared: false,
      },
    });
    const release = {
      id: "review-release",
      kind: "github" as const,
      host: "github.com",
      owner: "octo",
      name: "nimbus-api",
      number: 8,
      headSha: theirs,
      base: "main",
      branch: "release-please--branches--main",
      method: "squash" as const,
      title: "chore(main): release 1.2.0",
      at: 7_000,
    };
    // check_change(pull) reads the release pull request: the task's current change.
    seedDelivery(tasks, "work", {
      mergeReviews: [release],
      checkTarget: release,
      prNumber: 8,
      prUrl: pull(8),
      changeLabel: "#8",
      headSha: theirs,
      ci: "green",
      checks: {
        headSha: theirs,
        prNumber: 8,
        items: [{ name: "release", state: "success" }],
        complete: true,
        absenceDeclared: false,
      },
    });
    const closes = () =>
      (protocol.detail("work").delivery?.pullRequests ?? [])
        .filter((line) => line.closes)
        .map((line) => line.number);
    expect(protocol.detail("work").delivery?.pullRequests?.map((line) => line.number)).toEqual([
      7, 8,
    ]);
    expect(closes()).toEqual([]);
    // Its request_merge card is a continuing merge: still no claim.
    cards.push({
      id: "card-continue",
      taskId: "work",
      author: "crewmate",
      priority: 1,
      title: "Merge the release",
      meta: "",
      body: "",
      actions: [
        {
          id: "merge",
          label: "Merge",
          default: true,
          effect: { kind: "merge", review: release.id, after: "continue" },
        },
      ],
      status: "ready",
      offerId: "offer-continue",
      createdAt: 1,
    });
    expect(closes()).toEqual([]);
    // A finishing card shown for the release: merging the release closes the task.
    cards.push({
      id: "card-finish",
      taskId: "work",
      author: "crewmate",
      priority: 1,
      title: "Finish with the release",
      meta: "",
      body: "",
      actions: [
        {
          id: "merge",
          label: "Merge",
          default: true,
          effect: { kind: "merge", after: "close" },
        },
      ],
      status: "ready",
      offerId: "offer-finish",
      createdAt: 2,
    });
    seedDelivery(tasks, "work", {
      completionOffers: [
        {
          cardId: "card-finish",
          offerId: "offer-finish",
          headSha: theirs,
          prNumber: 8,
          shownFor: 8,
          at: 7_100,
        },
      ],
    });
    expect(closes()).toEqual([8]);
    // The own change is selected again: the card was shown for the release,
    // so its claim does not move to the own pull request.
    seedDelivery(tasks, "work", {
      checkTarget: undefined,
      prNumber: 7,
      prUrl: pull(7),
      changeLabel: "#7",
      headSha: own,
    });
    expect(closes()).toEqual([]);
    expect(taskDetailSchema.safeParse(protocol.detail("work")).success).toBe(true);
    // The board does not carry the list; only the record's read does.
    expect(protocol.board().tasks.find((task) => task.id === "work")?.delivery).not.toHaveProperty(
      "pullRequests",
    );
  });

  /** A task whose own pull request #7 the record reads at `head`, on GitHub. */
  const ownPullRequest = (head: string) => {
    const harness = taskProtocolFixture();
    harness.db
      .prepare(
        "UPDATE repos SET origin = 'https://github.com/octo/nimbus-api.git', forge_kind = 'github', forge_host = 'github.com' WHERE id = 'r1'",
      )
      .run();
    seedTask(harness.tasks, {
      id: "work",
      title: "Ship the API and its release",
      status: "idle",
      repoId: "r1",
      branch: "fm/task-work",
    });
    seedDelivery(harness.tasks, "work", {
      mode: "direct-pr",
      prNumber: 7,
      prUrl: "https://github.com/octo/nimbus-api/pull/7",
      changeLabel: "#7",
      headSha: head,
      ci: "green",
      ciAt: 1_000,
      checks: {
        headSha: head,
        prNumber: 7,
        items: [{ name: "unit-tests", state: "success" }],
        complete: true,
        absenceDeclared: false,
      },
    });
    const line = (number: number) =>
      harness.protocol
        .detail("work")
        .delivery?.pullRequests?.find((item) => item.number === number);
    return { ...harness, line };
  };

  // Re-review INF-2546 R6, under the captain's "every PR with its checks":
  // each pull request shows the checks read last, whichever of its versions
  // they were read at - here after its branch went back to an earlier one.
  it("shows each pull request's checks as read last, after its branch went back to an earlier version (INF-2546)", () => {
    const first = "1".repeat(40);
    const pushed = "2".repeat(40);
    const { tasks, line } = ownPullRequest(first);
    const reading = (head: string, ci: "green" | "red", at: number) =>
      seedDelivery(tasks, "work", {
        headSha: head,
        ci,
        ciAt: at,
        checks: {
          headSha: head,
          prNumber: 7,
          items: [{ name: "unit-tests", state: ci === "green" ? "success" : "failure" }],
          complete: true,
          absenceDeclared: false,
        },
      });
    reading(pushed, "red", 2_000);
    expect(line(7)?.ci).toBe("red");
    // The push is taken back: the branch is at its first version again, read green.
    reading(first, "green", 3_000);
    expect(line(7)?.ci).toBe("green");
  });

  // Re-review INF-2546 R7, under the captain's "every PR ... and whether it
  // closes the task": a pull request that merged stays merged on the list
  // once the record stops naming what showed it - here its review left the
  // capped list and another pull request became current.
  it("keeps a merged pull request merged once its review left the list and another pull request is current (INF-2546)", () => {
    const head = "1".repeat(40);
    const { tasks, line } = ownPullRequest(head);
    const review = (number: number, branch: string, sha: string) => ({
      id: `review-${number}`,
      kind: "github" as const,
      host: "github.com",
      owner: "octo",
      name: "nimbus-api",
      number,
      headSha: sha,
      base: "main",
      branch,
      method: "squash" as const,
      title: number === 7 ? "fix: ship the API" : "chore(main): release 1.2.0",
      at: 7_000 + number,
    });
    // The captain merged #7 on a continuing merge: its review keeps the receipt.
    seedDelivery(tasks, "work", {
      mergeReviews: [
        { ...review(7, "fm/task-work", head), receipt: { head, sha: "a".repeat(40), at: 8_000 } },
      ],
    });
    expect(line(7)?.merged).toBe(true);
    const release = review(8, "release-please--branches--main", "9".repeat(40));
    seedDelivery(tasks, "work", {
      mergeReviews: [release],
      checkTarget: release,
      prNumber: 8,
      prUrl: "https://github.com/octo/nimbus-api/pull/8",
      changeLabel: "#8",
      headSha: release.headSha,
      ci: "green",
      ciAt: 9_000,
      checks: {
        headSha: release.headSha,
        prNumber: 8,
        items: [{ name: "release", state: "success" }],
        complete: true,
        absenceDeclared: false,
      },
    });
    expect(line(7)?.merged).toBe(true);
    expect(line(8)?.merged).toBeUndefined();
  });

  it("reads each work row's tier off its newest routing decision, the way the orbit paints it", async () => {
    let working = false;
    const { db, tasks, protocol, events, settle, tick } = taskProtocolFixture({
      workPosture: () =>
        working ? { state: "active", reason: "turn" } : { state: "idle", reason: "inactive" },
    });
    for (const id of ["down", "legacy", "unserved", "never"]) {
      tasks.create({ id, title: id, prompt: "p", repoId: null });
    }
    tasks.create({ id: "q", title: "a question", prompt: "p", repoId: null, kind: "question" });
    const route = (
      taskId: string,
      at: number,
      provider: string | null,
      bucket: string,
      served: string | null,
    ) =>
      db
        .prepare(
          "INSERT INTO decisions (kind, task_id, provider, model, bucket, rule, served, reasons_json, at) VALUES ('routing', ?, ?, ?, ?, ?, ?, '[]', ?)",
        )
        .run(taskId, provider, provider ? "m" : null, bucket, "R8", served, at);
    // Routed high once, then re-routed and served a weaker slot than asked:
    // the newest decision's served slot wins.
    route("down", 1, "openai-codex", "high", "high");
    route("down", 2, "openai-codex", "high", "medium");
    // Recorded before `served` existed: the slot it asked for.
    route("legacy", 1, "openai-codex", "premium", null);
    // A decision that chose nothing never served anything.
    route("unserved", 1, null, "low", null);
    route("q", 1, "openai-codex", "high", "high");

    // INF-2255: the captain's routing/servedSlots board sample. A cold board
    // batches latest slots; unchanged boards read none and never load history.
    const latest = vi.spyOn(DecisionStore.prototype, "latestChosenSlots");
    const history = vi.spyOn(DecisionStore.prototype, "routing");
    try {
      const cold = protocol.board();
      const coldCalls = latest.mock.calls.map(([ids]) => [...ids]);
      latest.mockClear();
      for (let read = 0; read < 40; read++) expect(protocol.board()).toEqual(cold);
      const warmCalls = latest.mock.calls.length;
      latest.mockClear();
      protocol.refreshPresentation();
      protocol.board();
      const refreshCalls = latest.mock.calls.map(([ids]) => [...ids]);
      console.info(
        JSON.stringify({
          intent: "INF-2255 board tiers",
          coldCalls,
          warmCalls,
          refreshCalls,
          historicalCalls: history.mock.calls.length,
        }),
      );
      expect(coldCalls).toHaveLength(1);
      expect(new Set(coldCalls.flat())).toEqual(
        new Set(cold.tasks.filter((task) => task.kind === "work").map((task) => task.id)),
      );
      expect(warmCalls).toBe(0);
      expect(refreshCalls.length).toBeGreaterThan(0);
      for (const ids of refreshCalls) expect(new Set(ids)).toEqual(new Set(coldCalls[0]));
      expect(history).not.toHaveBeenCalled();
    } finally {
      latest.mockRestore();
      history.mockRestore();
    }
    const tierOf = (id: string) => protocol.board().tasks.find((task) => task.id === id)?.tier;
    expect(tierOf("down")).toBe("medium");
    expect(tierOf("legacy")).toBe("premium");
    expect(tierOf("unserved")).toBeNull();
    expect(tierOf("never")).toBeNull();
    // Only work has a crewmate; a question's routing never becomes a solid.
    expect(tierOf("q")).toBeNull();
    expect(protocol.detail("down").tier).toBe("medium");

    // The change event carries the same reading, so the orbit hears it live.
    events.length = 0;
    tick();
    tasks.turns.setSessionFile("down", "session-1");
    tasks.turns.setSessionFile("q", "session-2");
    await settle();
    const changed = events.flatMap((event) => (event.type === "task_changed" ? [event] : []));
    expect(changed.find((event) => event.taskId === "down")).toMatchObject({ tier: "medium" });
    expect(changed.find((event) => event.taskId === "q")).not.toHaveProperty("tier");
    // A routing commit is its own write, before the task's dispatch update.
    // A queued presentation must not hide that newer served slot.
    working = true;
    protocol.refreshPresentation();
    route("down", 3, "openai-codex", "high", "low");
    expect(tierOf("down")).toBe("low");
    tasks.turns.setSessionFile("down", "session-3");
    expect(tierOf("down")).toBe("low");
  });

  // INF-999: INF-778's summary read Blocked by INF-886 from a recorded wait
  // after the captain's words had released it, while the crewmate's own
  // reader named nothing. The captain chose "Blocked by only for a hold".
  it("names the same waits on the board and in the tasks reader: every live wait holds the task until that work closes", () => {
    // INF-3167, the captain's choice A: a recorded wait holds the waiter's
    // merge as a blocks_me filing does, so a crewmate working past it is
    // held by it all the same (INF-999 named it only while the crewmate
    // stood idle on it).
    let posture: WorkPosture = { state: "idle", reason: "dependency" };
    const { tasks, protocol } = taskProtocolFixture({ workPosture: () => posture });
    for (const id of ["recorded", "marked"])
      tasks.create({ id, title: id, prompt: "p", repoId: null });
    tasks.create({ id: "waiter", title: "waiter", prompt: "p", repoId: null, status: "active" });
    tasks.graph.link("recorded", "waiter", "blocks", "firstmate");
    tasks.graph.link("marked", "waiter", "blocks", "crewmate", true);
    const board = () => [...protocol.detail("waiter").blockedBy].sort();
    const reader = () =>
      [...(queryTasks(tasks, { key: "waiter" }).rows[0]?.blocked_by ?? [])].sort();
    const keys = (...ids: string[]) => ids.map((id) => tasks.get(id)?.key).sort();
    // Idle on its waits: both hold it.
    expect(board()).toEqual(keys("recorded", "marked"));
    expect(reader()).toEqual(board());
    // Working past them: both still hold its merge, so both are named.
    posture = { state: "active", reason: "turn" };
    expect(board()).toEqual(keys("recorded", "marked"));
    expect(reader()).toEqual(board());
    expect(protocol.detail("waiter").flags.blocked).toBe(true);
    // The captain's words pass the merge hold for the task: nothing holds it.
    seedDelivery(tasks, "waiter", {
      override: { words: "merge it, no need to wait", holds: ["waits"], until: "task", at: 1 },
    });
    expect(board()).toEqual([]);
    expect(reader()).toEqual([]);
    // The row's flag says the same as its Blocked by: the override passed
    // the hold, so the board, the reader and the crew summary read it free.
    expect(protocol.detail("waiter").flags.blocked).toBe(false);
    expect(tasks.graph.flagsOf(tasks.get("waiter") as TaskRecord).blocked).toBe(false);
  });

  it("shows only live blockers while retaining closed edges and the dropped-start gate", () => {
    // The crewmate stands idle on its waits, so its recorded waits hold it (INF-999).
    let posture: WorkPosture = { state: "idle", reason: "dependency" };
    const { tasks, protocol } = taskProtocolFixture({ workPosture: () => posture });
    for (const id of ["merged", "dropped", "discarded", "planned", "working"]) {
      tasks.create({ id, title: id, prompt: "p", repoId: null });
    }
    tasks.starts.dispatch("working", {
      workspace: { repoDir: "/repo", worktreeDir: "/wt/working", branch: "fm/working" },
      accountId: null,
      assignee: "crewmate",
    });
    tasks.close("merged", { status: "done", reason: "merged", actor: "captain" });
    tasks.close("dropped", { status: "dropped", reason: "cancelled", actor: "captain" });
    tasks.close("discarded", { status: "dropped", reason: "discarded", actor: "captain" });
    for (const id of ["active-dependent", "open-dependent"]) {
      tasks.create({
        id,
        title: id,
        prompt: "p",
        repoId: null,
        blockedBy: ["merged", "dropped", "discarded", "planned", "working"],
        ...(id === "active-dependent" ? { status: "active" as const } : {}),
      });
    }
    const shown = () => protocol.board().tasks.filter((task) => task.id.endsWith("-dependent"));
    expect(shown()).toHaveLength(2);
    for (const task of shown()) {
      expect(task.blockedBy).toEqual(["SCR-4", "SCR-5"]);
      expect(protocol.detail(task.id).blockedBy).toEqual(task.blockedBy);
    }
    // A recorded wait holds the start, and on work already under way the
    // same arrow holds its close until the live work closes (INF-3167).
    expect(protocol.detail("open-dependent").flags.blocked).toBe(true);
    expect(protocol.detail("active-dependent").flags.blocked).toBe(true);
    expect(tasks.graph.blockerRefusal("active-dependent")?.tasks.map((row) => row.key)).toEqual([
      "SCR-4",
      "SCR-5",
    ]);
    // A crewmate working past its waits is still held by them (INF-3167;
    // INF-999 had named them only while it stood idle on them).
    posture = { state: "active", reason: "turn" };
    expect(protocol.detail("active-dependent").blockedBy).toEqual(["SCR-4", "SCR-5"]);
    expect(protocol.detail("open-dependent").blockedBy).toEqual(["SCR-4", "SCR-5"]);
    posture = { state: "idle", reason: "dependency" };
    tasks.close("planned", { status: "done", reason: "landed", actor: "captain" });
    tasks.close("working", { status: "dropped", reason: "discarded", actor: "captain" });
    for (const task of shown()) {
      expect(task.blockedBy).toEqual([]);
      expect(protocol.detail(task.id).blockedBy).toEqual([]);
    }
    // Closed graph edges remain history; they no longer appear as live blockers.
    expect(tasks.graph.blockers("active-dependent")).toHaveLength(5);
    expect(protocol.detail("active-dependent").flags.blocked).toBe(false);
    expect(tasks.graph.blockerRefusal("active-dependent")).toBeUndefined();
    // A dropped dependency still needs an explicit graph decision before starting.
    expect(protocol.detail("open-dependent").flags).toMatchObject({
      blocked: true,
      ready: false,
      needsYou: true,
    });
    expect(tasks.graph.listReady()).toEqual([]);
  });

  it("names the live work an active task's standing baseline wait names among its blockers", () => {
    const { tasks, protocol } = taskProtocolFixture();
    seedTask(tasks, { id: "owner", title: "Fix main", status: "running", worktreeDir: "/wt/o" });
    seedTask(tasks, { id: "waiting", title: "Ship", status: "idle", worktreeDir: "/wt/w" });
    seedDelivery(tasks, "waiting", {
      headSha: "head-1",
      ci: "red",
      ciRepair: {
        failures: [{ headSha: "head-1", checks: ["linux-checks"] }],
        diagnoses: [
          {
            headSha: "head-1",
            check: "linux-checks",
            classification: "baseline-blocked",
            evidence: "fails on untouched main",
            dependencyTask: "owner",
            at: 1,
          },
        ],
        repairs: [],
      },
    });
    const view = () => protocol.board().tasks.find((task) => task.id === "waiting");
    const owner = tasks.get("owner")?.key;
    // No edge holds its close (FI3-671), but it waits on that work (FI3-250).
    expect(view()).toMatchObject({ blockedBy: [owner], flags: { blocked: false } });
    expect(protocol.detail("waiting").blockedBy).toEqual([owner]);
    // A new head ends the wait by itself; closed work is never named.
    seedDelivery(tasks, "waiting", { headSha: "head-2", ci: "pending" });
    expect(view()?.blockedBy).toEqual([]);
    seedDelivery(tasks, "waiting", { headSha: "head-1", ci: "red" });
    tasks.close("owner", { status: "done", reason: "merged", actor: "captain" });
    expect(view()?.blockedBy).toEqual([]);
  });

  // INF-38 (INF-1137 friction 5): the captain could not tell how long a
  // crewmate had waited. Each wait says when it was recorded, only from the
  // edge's own time or a dated declaration, and no time when one source has none.
  it("says when each wait that holds a started task was recorded, and never guesses one", () => {
    const { tasks, protocol, tick, clock } = taskProtocolFixture({
      workPosture: () => ({ state: "idle", reason: "dependency" }),
    });
    seedTask(tasks, { id: "owner", title: "Fix main", status: "running", worktreeDir: "/wt/o" });
    seedTask(tasks, { id: "other", title: "Fix docs", status: "running", worktreeDir: "/wt/d" });
    seedTask(tasks, { id: "waiting", title: "Ship", status: "idle", worktreeDir: "/wt/w" });
    tick(60_000);
    const linkedAt = clock();
    tasks.graph.link("owner", "waiting", "blocks", "crewmate");
    tick(60_000);
    tasks.graph.link("other", "waiting", "blocks", "crewmate");
    const view = () => protocol.board().tasks.find((task) => task.id === "waiting");
    const key = (id: string) => tasks.get(id)?.key ?? "";
    expect(view()?.blockedSince).toEqual({ [key("owner")]: linkedAt, [key("other")]: clock() });
    expect(protocol.detail("waiting").blockedSince).toEqual(view()?.blockedSince);
    // The same task named by an undated baseline wait loses its time; the
    // edge alone would have said one, so the earliest is not known.
    const baseline = (at?: number) =>
      seedDelivery(tasks, "waiting", {
        headSha: "head-1",
        ci: "red",
        ciRepair: {
          failures: [{ headSha: "head-1", checks: ["linux-checks"] }],
          diagnoses: [
            {
              headSha: "head-1",
              check: "linux-checks",
              classification: "baseline-blocked",
              evidence: "fails on untouched main",
              dependencyTask: "owner",
              ...(at === undefined ? {} : { at }),
            },
          ],
          repairs: [],
        },
      });
    baseline();
    expect(view()?.blockedSince).toEqual({ [key("other")]: clock() });
    // A dated declaration earlier than the edge is when that wait was recorded.
    baseline(linkedAt - 5_000);
    expect(view()?.blockedSince?.[key("owner")]).toBe(linkedAt - 5_000);
  });

  // INF-5578 finding 4: a passed review read "No continuing work" for a day
  // while its change waited on another task held for an app update, and no
  // row said where the wait stopped. The row's view names that task and its hold.
  it("names where a started task's wait stops: the last task in its line and that task's hold", () => {
    const { tasks, protocol, clock } = taskProtocolFixture({
      workPosture: () => ({ state: "idle", reason: "inactive" }),
    });
    seedTask(tasks, { id: "docs", title: "Docs site languages", status: "idle" });
    seedTask(tasks, { id: "landing", title: "Landing page, 10 languages", status: "idle" });
    seedTask(tasks, {
      id: "review",
      title: "Review of the landing page",
      status: "completed",
      parentId: "landing",
      shape: { kind: "review", kind_source: "host:review", basis: "landing" },
    });
    tasks.graph.link("docs", "landing", "blocks", "crewmate");
    const key = (id: string) => tasks.get(id)?.key ?? "";
    const chain = (id: string) => protocol.board().tasks.find((task) => task.id === id)?.waitChain;
    // Its change, and the task that change waits on, which nothing holds.
    expect(chain("review")).toEqual({ on: key("landing"), end: key("docs") });
    expect(chain("landing")).toEqual({ on: key("docs") });
    expect(chain("docs")).toBeUndefined();

    const until = clock() + 23 * 60 * 60_000;
    expect(tasks.turns.hold("docs", { until, reason: "an app update" }).ok).toBe(true);
    expect(chain("review")).toEqual({ on: key("landing"), end: key("docs"), until });
    expect(chain("landing")).toEqual({ on: key("docs"), until });
    tasks.turns.hold("docs", {
      until,
      reason: "an app update",
      update: { device: null, from: "1.2.0" },
    });
    expect(chain("review")).toEqual({ on: key("landing"), end: key("docs"), update: true });

    // A second wait at any step stops the line there: no one task stands for both.
    seedTask(tasks, { id: "api", title: "API change", status: "idle" });
    tasks.graph.link("api", "landing", "blocks", "crewmate");
    expect(chain("review")).toEqual({ on: key("landing") });
    // A review whose change merged waits on nothing.
    tasks.close("landing", { status: "done", reason: "merged", actor: "captain" });
    expect(chain("review")).toBeUndefined();
  });

  it("derives flags, blockers, children, the waiting card and repo facts on read", () => {
    const { tasks, protocol, cards } = taskProtocolFixture();
    tasks.create({ id: "a", title: "A", prompt: "p", repoId: "r1" });
    tasks.create({ id: "b", title: "B", prompt: "p", repoId: "r1", blockedBy: ["a"] });
    tasks.create({
      id: "held",
      title: "Held",
      prompt: "p",
      repoId: null,
      gate: { kind: "captain", ref: "reasoning-wait" },
    });
    tasks.create({ id: "dead-blocker", title: "Dead", prompt: "p", repoId: null });
    tasks.create({
      id: "dead-blocked",
      title: "Dead blocked",
      prompt: "p",
      repoId: null,
      blockedBy: ["dead-blocker"],
    });
    tasks.close("dead-blocker", { status: "dropped", reason: "cancelled", actor: "captain" });
    tasks.create({ id: "child", title: "Child", prompt: "p", repoId: null, parentId: "held" });
    tasks.close("child", { status: "done", reason: "settled", actor: "host" });
    tasks.create({ id: "child2", title: "Child 2", prompt: "p", repoId: null, parentId: "held" });
    tasks.starts.dispatch("a", {
      workspace: { repoDir: "/fleet/nimbus-api", worktreeDir: "/wt/a", branch: "fm/a" },
      accountId: null,
      assignee: "crewmate 1",
    });
    cards.push({
      id: "card-a",
      taskId: "a",
      author: "firstmate",
      priority: 1,
      title: "Land?",
      meta: "",
      body: "",
      actions: [
        { id: "land", label: "Land", default: true, effect: { kind: "merge", after: "close" } },
      ],
      status: "ready",
      createdAt: 1,
    });
    const board = protocol.board();
    const view = (id: string) => board.tasks.find((task) => task.id === id);
    expect(view("a")).toMatchObject({
      key: "NIA-1",
      status: "active",
      activity: "starting",
      flags: { blocked: false, held: false, needsYou: true, ready: false },
      blocks: ["NIA-2"],
      waitingCardId: "card-a",
      repo: { name: "nimbus-api", branch: "fm/a" },
      assignee: "crewmate 1",
    });
    expect(view("b")).toMatchObject({
      flags: { blocked: true, held: false, needsYou: false, ready: false },
      blockedBy: ["NIA-1"],
      waitingCardId: null,
      repo: { name: "nimbus-api", branch: "" },
    });
    expect(view("held")).toMatchObject({
      flags: { blocked: false, held: true, needsYou: true, ready: false },
      children: { total: 2, closed: 1 },
      repo: null,
    });
    expect(view("dead-blocked")).toMatchObject({
      flags: { blocked: true, held: false, needsYou: true, ready: false },
      blockedBy: [],
    });
    expect(view("child2")).toMatchObject({ flags: { ready: true }, parentId: "held" });
    expect(board.links).toEqual([
      { fromId: "a", toId: "b", type: "blocks" },
      { fromId: "dead-blocker", toId: "dead-blocked", type: "blocks" },
    ]);
    expect(board.projects).toEqual([
      {
        id: "scratch",
        key: "SCR",
        name: "Scratch",
        repo: null,
        archived: false,
        counts: { needsYou: 2, waitingOnYou: 0, open: 3, active: 0, doneRecent: 1 },
      },
      {
        id: "proj-r1",
        key: "NIA",
        name: "nimbus-api",
        repo: { id: "r1", name: "nimbus-api", delivery: "direct-pr", autonomy: true },
        repos: [{ id: "r1", name: "nimbus-api", delivery: "direct-pr", autonomy: true }],
        archived: false,
        counts: { needsYou: 1, waitingOnYou: 1, open: 1, active: 1, doneRecent: 0 },
      },
    ]);
    expect(protocol.projects()).toEqual(board.projects);
  });

  // INF-4147's plan, direction B: each finished segment of a collapsed
  // task's parts bar opens its own part, so the task names its closed parts
  // in the order they closed, oldest first, whatever order they were filed in.
  it("names a task's closed parts in the order they closed, on the board and in its record", () => {
    const { tasks, protocol, tick } = taskProtocolFixture();
    tasks.create({ id: "plan", title: "Plan", prompt: "p", repoId: null });
    for (const id of ["first", "second", "third", "open"])
      tasks.create({ id, title: id, prompt: "p", repoId: null, parentId: "plan" });
    tick(1_000);
    tasks.close("third", { status: "done", reason: "settled", actor: "host" });
    tick(1_000);
    tasks.close("first", { status: "dropped", reason: "cancelled", actor: "captain" });
    const children = { total: 4, closed: 2, closedIds: ["third", "first"] };
    expect(protocol.board().tasks.find((task) => task.id === "plan")?.children).toEqual(children);
    expect(protocol.detail("plan")?.children).toEqual(children);
  });
});
