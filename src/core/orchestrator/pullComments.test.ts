import { PULL_REQUEST_COMMENTS_WAKE } from "@shared/pullComments";
import { describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import type { Forge, ForgePull, ForgePullComment } from "../forge";
import { openInMemoryDatabase } from "../storage/db";
import { InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import { seedProject } from "../workspace/seedProject";
import { createChangeDelivery } from "./changeDelivery";
import type { TypedWake } from "./wakes";

// Intent: INF-4445's approved plan with the captain's answers - while the
// Pull request comments runbook is on, new comments by others on a task's
// pull request wake its crewmate once per reading, naming who wrote each and
// where, never its words; its own replies, the app's story comment and a
// wordless review wake nobody; nothing is read while it is off, while the pull
// request has not changed, or once it merged; a batch's comment goes to the
// change it is about. Review INF-4479 (F1 and the captain's answer to F3): a
// reply the crewmate sends during a reading is still its own, and only a
// crewmate whose conversation was served the guidance is woken.

/** A teammate's line comment, an outside passer-by's comment and a review bot, as GitHub's lists name them. */
const TEAMMATE: ForgePullComment = {
  id: 2101,
  kind: "line",
  author: "maria-dev",
  relation: "can-write",
  path: "src/invite.ts",
  line: 42,
};
const PASSERBY: ForgePullComment = {
  id: 2102,
  kind: "comment",
  author: "drive-by",
  relation: "cannot-write",
};
const BOT: ForgePullComment = {
  id: 2103,
  kind: "review",
  author: "lint-bot[bot]",
  relation: "bot",
};

function fixture() {
  const db = openInMemoryDatabase();
  const tasks = new TaskService({ db, strict: true });
  const inbox = new InboxStore(db);
  const dir = scratchDir("inf-pull-comments-");
  seedProject(db, {
    id: "project",
    name: "Invites",
    path: dir,
    origin: "https://github.com/octo/invites.git",
    delivery: "direct-pr",
  });
  const repos = new RepoRegistry(db, scratchDir("inf-pull-comments-fleet-"));
  seedTask(tasks, {
    id: "invite",
    title: "Expire old invites",
    status: "idle",
    repoId: "project",
    repoDir: dir,
    worktreeDir: dir,
    branch: "inf/expire-invites",
  });
  seedDelivery(tasks, "invite", {
    prNumber: 12,
    headSha: "a".repeat(40),
    ci: "green",
    ciAt: 0,
    servedWakes: [PULL_REQUEST_COMMENTS_WAKE],
  });
  const state = {
    on: true,
    pull: {
      number: 12,
      state: "open",
      merged: false,
      headSha: "a".repeat(40),
      base: "main",
      readiness: "clean",
      updatedAt: "2026-11-15T17:00:00Z",
    } as ForgePull,
    comments: [] as ForgePullComment[],
    files: {} as Record<string, string[]>,
  };
  const pulls = vi.fn(async () => state.pull);
  const reads = vi.fn(async (_number: number, _since?: string) => state.comments);
  const forge = {
    kind: "github",
    host: "github.com",
    place: "GitHub",
    hasChecks: true,
    pull: pulls,
    pullComments: reads,
    commitFiles: async (sha: string) => state.files[sha] ?? [],
    label: (change: { number?: number }) => `#${change.number}`,
    url: () => null,
  } as unknown as Forge;
  // The app's steer: queued once per task and name (services.ts).
  const steer = (taskId: string, wake: TypedWake) => {
    if (wake.once === undefined) inbox.enqueue(taskId, wake);
    else if (!inbox.woken(taskId, wake.once))
      inbox.enqueueSteerOnce(taskId, { ...wake, once: wake.once });
  };
  const delivery = () =>
    createChangeDelivery({
      tasks,
      repos,
      forgeFor: () => forge,
      steer,
      commentsWatched: () => state.on,
    });
  const wakes = (taskId = "invite") =>
    inbox.allFor(taskId).flatMap((row) => (row.facts?.kind === "pull-comments" ? [row.facts] : []));
  return { db, tasks, state, pulls, reads, delivery, wakes, forge };
}

describe("comments on a pull request", () => {
  it("wakes the crewmate once for a round of others' comments, naming who and where without their words", async () => {
    const h = fixture();
    h.state.comments = [TEAMMATE, PASSERBY, BOT];
    await h.delivery().comments.readTask("invite");
    expect(h.wakes()).toEqual([
      {
        kind: "pull-comments",
        change: "#12",
        comments: [
          {
            id: 2101,
            kind: "line",
            author: "maria-dev",
            relation: "can-write",
            path: "src/invite.ts",
            line: 42,
          },
          { id: 2102, kind: "comment", author: "drive-by", relation: "cannot-write" },
          { id: 2103, kind: "review", author: "lint-bot[bot]", relation: "bot" },
        ],
      },
    ]);
    // Nothing moved on the pull request: no comment is asked for, no second wake.
    await h.delivery().comments.readTask("invite");
    expect(h.reads).toHaveBeenCalledTimes(1);
    expect(h.wakes()).toHaveLength(1);
    // It moved, with no new comment by others: still one wake.
    h.state.pull = { ...h.state.pull, updatedAt: "2026-11-15T17:05:00Z" };
    await h.delivery().comments.readTask("invite");
    expect(h.reads).toHaveBeenCalledTimes(2);
    expect(h.reads.mock.calls[1]?.[1]).toBe("2026-11-15T17:00:00Z");
    expect(h.wakes()).toHaveLength(1);
  });

  it("wakes nobody for the crewmate's own replies, the app's story comment or a review with no words", async () => {
    const h = fixture();
    seedDelivery(h.tasks, "invite", { sentComments: [3001, 3002] });
    h.state.comments = [
      { id: 3001, kind: "line", author: "captain", relation: "you", path: "src/invite.ts" },
      // A line comment sent inside a review the crewmate sent.
      { id: 3005, kind: "line", author: "captain", relation: "you", reviewId: 3002 },
      { id: 3003, kind: "comment", author: "captain", relation: "you", story: true },
      { id: 3004, kind: "review", author: "maria-dev", relation: "can-write", empty: true },
    ];
    await h.delivery().comments.readTask("invite");
    expect(h.wakes()).toEqual([]);
    // The captain's own comment on GitHub is theirs, not the crewmate's: it wakes.
    h.state.comments.push({ id: 3006, kind: "comment", author: "captain", relation: "you" });
    h.state.pull = { ...h.state.pull, updatedAt: "2026-11-15T17:10:00Z" };
    await h.delivery().comments.readTask("invite");
    expect(h.wakes().map((wake) => wake.comments)).toEqual([
      [{ id: 3006, kind: "comment", author: "captain", relation: "you" }],
    ]);
  });

  it("counts a reply the crewmate sent while the comments were being read as its own", async () => {
    const h = fixture();
    h.reads.mockImplementationOnce(async () => {
      // The gateway keeps the reply's id while GitHub is still answering the reading.
      seedDelivery(h.tasks, "invite", { sentComments: [3101] });
      return [{ id: 3101, kind: "comment", author: "captain", relation: "you" }, PASSERBY];
    });
    await h.delivery().comments.readTask("invite");
    expect(h.wakes().map((wake) => wake.comments.map((comment) => comment.id))).toEqual([[2102]]);
  });

  it("reads nothing for a crewmate whose conversation opened without the guidance", async () => {
    const h = fixture();
    h.state.comments = [TEAMMATE];
    // Its conversation opened before the switch was turned on.
    seedDelivery(h.tasks, "invite", { servedWakes: [] });
    await h.delivery().comments.readTask("invite");
    expect(h.pulls).not.toHaveBeenCalled();
    expect(h.wakes()).toEqual([]);
  });

  it("reads nothing while the runbook is off or once the pull request merged", async () => {
    const h = fixture();
    h.state.comments = [TEAMMATE];
    h.state.on = false;
    await h.delivery().comments.readTask("invite");
    expect(h.pulls).not.toHaveBeenCalled();
    expect(h.reads).not.toHaveBeenCalled();
    h.state.on = true;
    h.state.pull = { ...h.state.pull, state: "closed", merged: true };
    await h.delivery().comments.readTask("invite");
    expect(h.reads).not.toHaveBeenCalled();
    expect(h.wakes()).toEqual([]);
  });

  it("never wakes twice for the same comments across a restart, even one between the wake and the saved reading", async () => {
    const h = fixture();
    h.state.comments = [TEAMMATE];
    await h.delivery().comments.readTask("invite");
    // A stop after the wake went out but before its reading was saved.
    seedDelivery(h.tasks, "invite", { commentCursor: undefined });
    await h.delivery().comments.readTask("invite");
    expect(h.wakes()).toHaveLength(1);
    // A later comment is a new round.
    h.state.comments.push(PASSERBY);
    h.state.pull = { ...h.state.pull, updatedAt: "2026-11-15T17:20:00Z" };
    await h.delivery().comments.readTask("invite");
    expect(h.wakes().map((wake) => wake.comments.map((comment) => comment.id))).toEqual([
      [2101],
      [2102],
    ]);
  });

  it("hands a batch's line comment to the change whose commit touched its file, and any other comment to every change", async () => {
    const h = fixture();
    for (const id of ["first", "second", "third"]) {
      seedTask(h.tasks, {
        id,
        title: `Change ${id}`,
        status: "idle",
        repoId: "project",
        branch: `inf/${id}`,
      });
      // The third change's conversation opened without the guidance.
      if (id !== "third") seedDelivery(h.tasks, id, { servedWakes: [PULL_REQUEST_COMMENTS_WAKE] });
    }
    h.state.files = { c1: ["src/invite.ts"], c2: ["docs/invites.md"] };
    h.state.pull = { ...h.state.pull, number: 40 };
    h.state.comments = [TEAMMATE, PASSERBY];
    const member = (taskId: string, commit: string) => ({
      taskId,
      branch: `inf/${taskId}`,
      head: commit,
      title: taskId,
      body: "",
      at: 1,
      commit,
    });
    const open = {
      branch: "infinitary-batch/ab12",
      head: "c2",
      base: "b0",
      number: 40,
      members: [member("first", "c1"), member("second", "c2"), member("third", "c3")],
      since: 1,
    };
    const repo = { id: "project" } as never;
    await h.delivery().comments.readBatch({ repo, open, pull: h.state.pull, forge: h.forge });
    expect(h.wakes("first")).toEqual([
      {
        kind: "pull-comments",
        change: "#40",
        comments: [
          {
            id: 2101,
            kind: "line",
            author: "maria-dev",
            relation: "can-write",
            path: "src/invite.ts",
            line: 42,
          },
          { id: 2102, kind: "comment", author: "drive-by", relation: "cannot-write" },
        ],
        batch: { commit: "c1", changes: 3 },
      },
    ]);
    expect(h.wakes("second")).toEqual([
      {
        kind: "pull-comments",
        change: "#40",
        comments: [{ id: 2102, kind: "comment", author: "drive-by", relation: "cannot-write" }],
        batch: { commit: "c2", changes: 3 },
      },
    ]);
    expect(h.wakes("third")).toEqual([]);
    // The batch's reading is kept on its changes: the next pass reads nothing new.
    await h.delivery().comments.readBatch({ repo, open, pull: h.state.pull, forge: h.forge });
    expect(h.reads).toHaveBeenCalledTimes(1);
  });
});
