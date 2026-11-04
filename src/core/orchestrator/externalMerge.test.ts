import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { Forge, ForgePull } from "../forge";
import { appPathsFor } from "../paths";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import { REPORT_TOOL } from "../pi/crewmateTaskTools";
import { CardStore } from "../storage/cardStore";
import { openInMemoryDatabase } from "../storage/db";
import { InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { askEndingOf } from "./askEnding";
import type { CardService } from "./cardService";
import { armWatch, CHECK_REFRESH_MS, CheckWatcher } from "./checkWatch";
import { CrewSupervisor } from "./crewSupervisor";
import { PrCiService } from "./prCi";
import { SettleService, type SettleServiceHost } from "./settleService";

/** INF-458 and the captain’s safety correction: only an explicitly finished task closes on merge. */
function fixture() {
  let now = CHECK_REFRESH_MS;
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true, now: () => now });
  const inbox = new InboxStore(db, { now: () => now });
  db.prepare(
    "INSERT INTO repos (id, path, name, added_at, origin, delivery, autonomy) VALUES (?, ?, ?, ?, ?, 'direct-pr', 0)",
  ).run("project", "/not-mounted/project", "Meter", 1, "https://github.com/o/meter.git");
  const repos = new RepoRegistry(db, "/not-mounted/fleet");
  seedTask(tasks, {
    id: "meter",
    title: "Correct the meter",
    status: "idle",
    repoId: "project",
    repoDir: "/not-mounted/project",
    worktreeDir: "/not-mounted/worktree",
    branch: "fm/task-meter",
  });
  seedDelivery(tasks, "meter", { prNumber: 71, headSha: "a".repeat(40), ci: "green", ciAt: 0 });
  const declare = () =>
    tasks.recordReport("meter", {
      text: "The meter fix is complete; only its merge remains.",
      declared: { mergeCompletesTask: { prNumber: 71, headSha: "a".repeat(40) } },
    });
  declare();
  let pull: ForgePull | undefined = {
    number: 71,
    state: "open",
    merged: false,
    headSha: "a".repeat(40),
    branch: "fm/task-meter",
    base: "main",
    readiness: "clean",
  };
  const readPull = vi.fn(async () => pull);
  const forge = { pull: readPull } as unknown as Forge;
  const prCi = new PrCiService({ tasks, repos, forgeFor: () => forge });
  const retire = vi.fn(async () => ({ outcome: "removed" as const, kept: null }));
  const stop = vi.fn(async () => {});
  const merge = vi.fn();
  const cards = {
    retireTaskCards: vi.fn(),
    withdrawHostCard: vi.fn(),
    values: () => [],
    stored: () => undefined,
    shownAt: () => 0,
    scheduleBroadcast: vi.fn(),
  } as unknown as CardService;
  const host: SettleServiceHost = {
    tasks,
    inbox,
    repos,
    cards,
    askEnding: askEndingOf(tasks, cards),
    now: () => now,
    workspace: { retireTaskWorktree: retire } as unknown as SettleServiceHost["workspace"],
    readPull: (id, number) => prCi.pullState(id, number),
    mergePullRequest: merge,
    runtimeState: () => "idle",
    stopRuntime: stop,
    endLiveTask: () => {},
    isPersonalTask: () => false,
    deliverableOf: () => "change",
    taskDelivery: () => "direct-pr",
    taskAutonomy: () => false,
    resolveTaskRef: () => tasks.get("meter")!,
    notifyOp: () => {},
    pokeInbox: () => {},
    sweepGates: async () => {},
    broadcastCrewCounts: () => {},
    broadcastEvent: () => {},
  };
  const settle = new SettleService(host);
  let blocked = false;
  const readChecks = vi.fn(async () => ({ kind: "gone" as const }));
  const steer = vi.fn();
  const watcher = () =>
    new CheckWatcher({
      tasks,
      inbox,
      read: readChecks,
      steer,
      idleBehindOtherWork: () => blocked,
      reconcileMerged: (id) => settle.reconcileExternalMerge(id),
    });
  return {
    tasks,
    inbox,
    host,
    declare,
    retire,
    stop,
    merge,
    cards,
    readPull,
    readChecks,
    steer,
    settle,
    watcher,
    sweep: async () => {
      const supervisor = new CrewSupervisor({
        now: () => now,
        paths: appPathsFor(scratchDir("infinitary-merge-inbox-")),
        tasks,
        inbox,
        repos,
        cardStore: new CardStore(db),
        workspace: host.workspace,
        sessions: {
          pi: {
            backend: "pi",
            controlProfile: PI_CONTROL_PROFILE,
            open: async () => {
              throw new Error("No saved conversation is available to open.");
            },
          },
        },
        bind: async () => {
          throw new Error("No saved conversation is available to bind.");
        },
        broadcastEvent: () => {},
        broadcastCards: () => {},
      });
      await supervisor.sweepInbox(now);
      await supervisor.disposeAll();
    },
    now: () => now,
    advance: () => {
      now += CHECK_REFRESH_MS;
    },
    merged: () => {
      pull = { ...pull!, state: "closed", merged: true, mergedSha: "b".repeat(40) };
    },
    answer: (value: ForgePull | undefined) => {
      pull = value;
    },
    pull: () => pull!,
    blocked: () => {
      blocked = true;
    },
  };
}

describe("external merge reconciliation", () => {
  it("closes once on the shared watch without a merge request or captain consent, even with a missing project folder", async () => {
    const h = fixture();
    const watcher = h.watcher();
    await watcher.poll(h.now());
    expect(h.tasks.get("meter")?.status).toBe("active");
    h.merged();
    h.advance();
    await watcher.poll(h.now());
    expect(h.tasks.get("meter")).toMatchObject({
      status: "done",
      closedReason: "merged",
      workspaceState: "removed",
      delivery: { ci: "merged", landedMode: "pr" },
    });
    expect(h.retire).toHaveBeenCalledOnce();
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.cards.retireTaskCards).toHaveBeenCalledWith("meter", "merged", { keepNotes: true });
    expect(h.inbox.pending("meter")).toEqual([]);
    expect(h.merge).not.toHaveBeenCalled();
    expect(h.steer).not.toHaveBeenCalled();
    h.advance();
    await h.watcher().poll(h.now());
    expect(h.retire).toHaveBeenCalledOnce();
  });

  it.each(["merged", "no-pr", "green"] as const)(
    "resumes monitoring a declared completion after restart from %s and a manual-merge choice",
    async (ci) => {
      const h = fixture();
      seedDelivery(h.tasks, "meter", { ci });
      h.blocked();
      h.merged();
      await h.watcher().poll(h.now());
      expect(h.tasks.get("meter")).toMatchObject({ status: "done", closedReason: "merged" });
      expect(h.readChecks).not.toHaveBeenCalled();
      expect(h.merge).not.toHaveBeenCalled();
    },
  );

  it("records a prerequisite merge without closing, then closes after the remaining work explicitly finishes", async () => {
    const h = fixture();
    h.tasks.recordReport("meter", {
      text: "Deployment verification still remains after this merge.",
    });
    h.merged();
    await h.watcher().poll(h.now());
    expect(h.tasks.get("meter")).toMatchObject({
      status: "active",
      delivery: { ci: "merged" },
      workspaceState: "present",
    });
    expect(h.stop).not.toHaveBeenCalled();
    expect(h.retire).not.toHaveBeenCalled();
    const wake = h.inbox.allFor("meter");
    expect(wake).toHaveLength(1);
    expect(wake[0]).toMatchObject({ facts: { kind: "external-merge", head: h.pull().headSha } });
    h.advance();
    await h.watcher().poll(h.now());
    expect(h.inbox.allFor("meter")).toHaveLength(1);
    h.inbox.ack([wake[0]!.id]);
    h.declare();
    h.advance();
    await h.watcher().poll(h.now());
    expect(h.tasks.get("meter")?.closedReason).toBe("merged");
    expect(h.retire).toHaveBeenCalledOnce();
  });

  // INF-1391: the external-merge journey found a tick deleting escalated
  // guidance when the new merge wake reached a task without a saved session.
  it.each(["before", "after"] as const)(
    "keeps unfinished guidance when the inbox sweeps %s a prerequisite merge",
    async (order) => {
      const h = fixture();
      h.tasks.recordReport("meter", { text: "Deployment verification remains." });
      seedTask(h.tasks, {
        id: "verify",
        title: "Verify deployment",
        status: "queued",
        startPolicy: "on-request",
        parentId: "meter",
      });
      const guidance = h.inbox.enqueue("meter", "Verify deployment before finishing this task.");
      h.inbox.markEscalated(guidance);
      const kept = h.inbox.get(guidance);
      expect(h.tasks.get("meter")?.sessionFile).toBeNull();
      if (order === "before") await h.sweep();
      h.merged();
      await h.watcher().poll(h.now());
      // Force the order that the journey's asynchronous tick only sometimes reached.
      await h.sweep();
      expect(h.inbox.get(guidance)).toEqual(kept);
      expect(h.inbox.pending("meter")).toEqual([
        expect.objectContaining({
          facts: expect.objectContaining({ kind: "external-merge", head: h.pull().headSha }),
        }),
      ]);
      expect(h.tasks.get("meter")).toMatchObject({
        status: "active",
        closedReason: null,
        workspaceState: "present",
        delivery: { ci: "merged" },
      });
      expect(h.tasks.get("verify")?.status).toBe("open");
      expect(h.retire).not.toHaveBeenCalled();
      h.advance();
      await h.watcher().poll(h.now());
      await h.sweep();
      expect(h.inbox.get(guidance)).toEqual(kept);
      expect(h.inbox.allFor("meter")).toHaveLength(2);
    },
  );

  it.each([
    "turn",
    "queued",
    "in-flight",
    "job",
    "child",
    "dependency",
    "interrupted",
    "question",
  ] as const)(
    "keeps %s work intact even if an earlier report declared completion",
    async (remaining) => {
      const h = fixture();
      let guidance: number | undefined;
      if (remaining === "turn") h.host.runtimeState = () => "streaming";
      if (remaining === "interrupted") h.tasks.setActivity("meter", "interrupted");
      if (remaining === "job") h.host.hasRunningJobs = () => true;
      if (remaining === "question") {
        h.host.cards.values = function* () {
          yield {
            id: "card-meter-question",
            taskId: "meter",
            author: "crewmate",
            title: "Choose the deployment target",
            body: "<p>Which deployment target should I verify?</p>",
            meta: "",
            createdAt: 1,
            status: "ready",
            priority: 30,
            actions: [{ id: "staging", label: "Staging", default: true, variant: "primary" }],
          };
        };
      }
      if (remaining === "queued" || remaining === "in-flight") {
        guidance = h.inbox.enqueue("meter", "Verify deployment before closing this task.");
        if (remaining === "in-flight") h.inbox.markDelivered([guidance]);
      }
      if (remaining === "child") {
        seedTask(h.tasks, {
          id: "verify",
          title: "Verify deployment",
          status: "queued",
          parentId: "meter",
        });
        expect(h.tasks.closeRefusal("meter")?.refused).toBe("children-open");
      }
      if (remaining === "dependency") {
        seedTask(h.tasks, { id: "verify", title: "Verify deployment", status: "queued" });
        h.tasks.link("verify", "meter", "blocks", "crewmate", true);
      }
      h.merged();
      await h.watcher().poll(h.now());
      expect(h.tasks.get("meter")).toMatchObject({
        status: "active",
        workspaceState: "present",
        delivery: { ci: "merged" },
      });
      expect(h.stop).not.toHaveBeenCalled();
      expect(h.retire).not.toHaveBeenCalled();
      expect(h.cards.retireTaskCards).not.toHaveBeenCalled();
      if (guidance !== undefined)
        expect(
          [...h.inbox.allFor("meter"), ...h.inbox.inFlight("meter")].map((row) => row.id),
        ).toContain(guidance);
      if (remaining === "child" || remaining === "dependency")
        expect(h.tasks.get("verify")?.status).toBe("open");
    },
  );

  it("binds the declaration to the report's exact PR/version and clears it on the next turn or report", async () => {
    const h = fixture();
    const tool = REPORT_TOOL.bind({
      onReport: (text, summary, declared) => {
        h.tasks.recordReport("meter", { text, summary, declared });
        return "Reported.";
      },
    })!;
    const report = () =>
      tool.run({
        text: "No work remains after the merge.",
        merge_completes_task: { pr_number: 71, head_sha: h.pull().headSha },
      });
    await report();
    expect(h.tasks.get("meter")?.delivery?.mergeCompletion).toMatchObject({
      prNumber: 71,
      headSha: h.pull().headSha,
    });
    h.tasks.clearDeclaration("meter");
    expect(h.tasks.get("meter")?.delivery?.mergeCompletion).toBeUndefined();
    await report();
    h.tasks.recordReport("meter", { text: "More work now remains." });
    expect(h.tasks.get("meter")?.delivery?.mergeCompletion).toBeUndefined();
    h.declare();
    h.answer({ ...h.pull(), headSha: "c".repeat(40), merged: true });
    await h.watcher().poll(h.now());
    expect(h.tasks.get("meter")?.status).toBe("active");
    expect(h.retire).not.toHaveBeenCalled();
    expect(h.tasks.get("meter")?.delivery?.headSha).toBe(h.pull().headSha);
    h.inbox.ack(h.inbox.allFor("meter").map((row) => row.id));
    await report();
    h.advance();
    await h.watcher().poll(h.now());
    expect(h.tasks.get("meter")?.closedReason).toBe("merged");
  });

  it("closes the record before an idle runtime shutdown can yield to new guidance", async () => {
    const h = fixture();
    let stopped!: () => void;
    h.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          stopped = resolve;
        }),
    );
    h.merged();
    const reading = h.watcher().poll(h.now());
    await vi.waitFor(() => expect(h.stop).toHaveBeenCalledOnce());
    expect(h.tasks.get("meter")?.closedReason).toBe("merged");
    expect(h.retire).not.toHaveBeenCalled();
    stopped();
    await reading;
    expect(h.retire).toHaveBeenCalledOnce();
  });

  it("keeps an unreachable working copy pending for its existing owner instead of touching its path here", async () => {
    const h = fixture();
    h.tasks.setDevice("meter", "mini");
    h.merged();
    await h.watcher().poll(h.now());
    expect(h.tasks.get("meter")).toMatchObject({
      status: "done",
      closedReason: "merged",
      deviceId: "mini",
      workspaceState: "present",
    });
    expect(h.retire).not.toHaveBeenCalled();
    expect(h.merge).not.toHaveBeenCalled();
  });

  // INF-2546 R11, under the captain's "close the task when its finishing
  // change merges": the finishing change may be another branch's pull
  // request the task made current. Merged outside the app with the
  // crewmate's declaration, it closes the task as merged, and the merge is
  // that pull request's own, never the task's own pull request's.
  it("closes on the outside merge of the current change on another branch, and records the merge on that change alone (INF-2546)", async () => {
    const h = fixture();
    const theirs = "9".repeat(40);
    const release = {
      id: "mrrelease94",
      kind: "github" as const,
      host: "github.com",
      owner: "o",
      name: "meter",
      number: 94,
      headSha: theirs,
      base: "main",
      branch: "release-please--branches--main",
      method: "squash" as const,
      title: "chore(main): release 0.2.0",
      at: 1,
    };
    seedDelivery(h.tasks, "meter", {
      mergeReviews: [release],
      checkTarget: release,
      prNumber: 94,
      headSha: theirs,
      ci: "green",
    });
    h.tasks.recordReport("meter", {
      text: "The release is the finishing change; only its merge remains.",
      declared: { mergeCompletesTask: { prNumber: 94, headSha: theirs } },
    });
    h.answer({
      number: 94,
      state: "closed",
      merged: true,
      mergedSha: "b".repeat(40),
      headSha: theirs,
      branch: release.branch,
      base: "main",
      readiness: "clean",
    });
    await h.watcher().poll(h.now());
    expect(h.tasks.get("meter")).toMatchObject({ status: "done", closedReason: "merged" });
    expect(h.merge).not.toHaveBeenCalled();
    const changes = h.tasks.changesFor("meter");
    expect(changes.map((change) => change.handle?.number).sort()).toEqual([71, 94]);
    expect(changes.find((change) => change.handle?.number === 94)?.receipt).toMatchObject({
      outcome: "merged",
      reason: "merged",
    });
    expect(changes.find((change) => change.handle?.number === 71)?.receipt?.outcome).not.toBe(
      "merged",
    );
  });

  it("does not confuse closed, missing, unreadable or another numbered PR with a merge", async () => {
    const h = fixture();
    for (const answer of [
      undefined,
      { ...h.pull(), state: "closed" as const },
      { ...h.pull(), number: 72, merged: true },
    ]) {
      h.answer(answer);
      await h.watcher().poll(h.now());
      expect(h.tasks.get("meter")?.status).toBe("active");
      h.advance();
    }
    h.readPull.mockRejectedValueOnce(new Error("sign-in unavailable"));
    await h.watcher().poll(h.now());
    expect(h.tasks.get("meter")?.status).toBe("active");
    expect(h.retire).not.toHaveBeenCalled();
  });

  it("serializes a slow read and rejects a PR identity changed while it was out", async () => {
    const h = fixture();
    let answer!: (value: ForgePull) => void;
    h.readPull.mockImplementationOnce(
      () =>
        new Promise<ForgePull>((resolve) => {
          answer = resolve;
        }),
    );
    const watcher = h.watcher();
    const reading = watcher.poll(h.now());
    await watcher.poll(h.now());
    expect(h.readPull).toHaveBeenCalledOnce();
    seedDelivery(h.tasks, "meter", { prNumber: 72 });
    answer({ ...h.pull(), merged: true, state: "closed" });
    await reading;
    expect(h.tasks.get("meter")?.status).toBe("active");
    expect(h.retire).not.toHaveBeenCalled();
  });

  it("ends a running check watch by closing, without a gone-check wake", async () => {
    const h = fixture();
    seedDelivery(h.tasks, "meter", { ciWatch: armWatch(undefined, h.pull().headSha, 0) });
    h.merged();
    await h.watcher().poll(h.now());
    expect(h.tasks.get("meter")?.delivery?.ciWatch).toBeUndefined();
    expect(h.tasks.get("meter")?.closedReason).toBe("merged");
    expect(h.steer).not.toHaveBeenCalled();
  });
});
