import { expect, it } from "vitest";
import { freshDatabase, rowsRead } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { appPathsFor } from "../paths";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import { CardStore } from "../storage/cardStore";
import { InboxStore } from "../storage/inboxStore";
import { seedTask } from "../tasks/seedTask";
import { TaskService } from "../tasks/taskService";
import { RepoRegistry } from "../workspace/repoRegistry";
import type { WorkspaceService } from "../workspace/workspaceService";
import { CrewSupervisor } from "./crewSupervisor";

// INF-2342 (which carries INF-2457): the crew counts froze the captain's app
// for up to 0.6 seconds at a time. Each count read every running task's
// posture, and each posture read the whole record of every task linked in
// to block it - finished follow-ups included - again on every count. A
// finished blocker holds nothing, so a count may read its edge, once, and
// never its record.
it("reads a finished blocker's edge once and never its record when it counts the crew", async () => {
  const db = freshDatabase();
  let clock = Date.UTC(2026, 10, 3, 17, 0, 0);
  const now = () => clock;
  const paths = appPathsFor(scratchDir("infinitary-crew-counts-"));
  const repos = new RepoRegistry(db, paths.fleetDir);
  const tasks = new TaskService({ db, repos, strict: true, now });
  const supervisor = new CrewSupervisor({
    now,
    paths,
    repos,
    tasks,
    inbox: new InboxStore(db, { now }),
    cardStore: new CardStore(db),
    workspace: {} as WorkspaceService,
    sessions: {
      pi: {
        backend: "pi",
        controlProfile: PI_CONTROL_PROFILE,
        open: async () => {
          throw new Error("No conversation opens while the crew is counted.");
        },
      },
    },
    bind: async () => {
      throw new Error("No conversation binds while the crew is counted.");
    },
    broadcastEvent: () => {},
    broadcastCards: () => {},
  });
  try {
    seedTask(tasks, { id: "running", title: "Running work", status: "idle", worktreeDir: "/w" });
    // A follow-up it must merge after, still planned: the running task waits on it.
    seedTask(tasks, { id: "planned", title: "Planned follow-up", status: "queued" });
    tasks.link("planned", "running", "blocks", "crewmate", true);
    let finished = 0;
    // Follow-ups filed with blocks_me and recorded waits, each merged through its own pull request.
    const finishBlockers = (count: number) => {
      for (let n = 0; n < count; n += 1) {
        clock += 60_000;
        const id = `follow-up-${finished}`;
        seedTask(tasks, { id, title: `Follow-up ${finished}`, status: "idle", worktreeDir: "/f" });
        tasks.link(id, "running", "blocks", "crewmate", finished % 2 === 0);
        tasks.recordChangeEvidence(id, {
          prUrl: `https://github.com/acme/app/pull/${100 + finished}`,
          prNumber: 100 + finished,
          headSha: `${finished}`.padStart(40, "a"),
        });
        tasks.close(id, { status: "done", reason: "merged", actor: "host" });
        finished += 1;
      }
    };
    finishBlockers(4);
    const before = rowsRead(db, () => {
      expect(supervisor.crewCounts()).toMatchObject({ working: 0, idle: 1 });
    });
    finishBlockers(12);
    const after = rowsRead(db, () => {
      expect(supervisor.crewCounts()).toMatchObject({ working: 0, idle: 1 });
    });
    expect(after - before, "each finished blocker cost the count more than its edge").toBe(12);
  } finally {
    await supervisor.disposeAll();
    db.close();
  }
});
