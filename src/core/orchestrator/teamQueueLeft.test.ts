import { join } from "node:path";
import type { RepoView } from "@shared/repos";
import { describe, expect, it } from "vitest";
import { freshDatabase } from "../../../tests/helpers/database";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { ForgeError, type TeamQueueLeftovers } from "../forge";
import { RepoRegistry } from "../workspace/repoRegistry";
import { seedProject } from "../workspace/seedProject";
import { QUEUE_SETUP_WITHDRAWN, queueSetupCardId, TeamQueueLeft } from "./teamQueueLeft";

// Intent: the approved plan for batches of your own, piece 4: "Each other project still
// carrying the queue's files gets one offer through the first mate to remove them with a
// pull request, naming any branch rule that still requires the queue's status."
//
// The look runs over a fresh project list; the stand-in is the host's answer for what the
// default branch still carries, as `GitHubForge.teamQueueLeftovers` reads it.

const METER = "repo-meter";
const FILES = [
  ".github/workflows/infinitary-queue.yml",
  ".github/workflows/infinitary-batch-checks.yml",
  ".github/infinitary/rules.mjs",
];

function home() {
  const db = freshDatabase();
  const repos = new RepoRegistry(db, join(scratchDir("infinitary-team-queue-left-"), "fleet"));
  seedProject(db, {
    id: METER,
    name: "meter",
    path: "/code/meter",
    origin: "https://github.com/acme/meter.git",
    delivery: "queue-pr",
  });
  /** What each project's host answers; an Error is a read that failed. */
  const hosts = new Map<string, TeamQueueLeftovers | Error | (() => Promise<TeamQueueLeftovers>)>();
  const heard = {
    reads: [] as string[],
    told: [] as unknown[],
    withdrawn: [] as { id: string; reason: string }[],
  };
  /** One run of the app: a new look over the same saved project list. */
  const start = () =>
    new TeamQueueLeft({
      repos,
      forgeFor: (repo: RepoView) => ({
        teamQueueLeftovers: async () => {
          heard.reads.push(repo.id);
          const answer = hosts.get(repo.id) ?? { files: [] };
          if (answer instanceof Error) throw answer;
          return typeof answer === "function" ? answer() : answer;
        },
      }),
      tell: (facts) => heard.told.push(facts),
      withdrawCard: (id, reason) => heard.withdrawn.push({ id, reason }),
    });
  return { db, repos, hosts, heard, start };
}

describe("a project that still carries the team queue's files", () => {
  it("is told to the first mate once, with the rule that still requires the queue's status", async () => {
    const at = home();
    at.hosts.set(METER, { files: FILES, rule: 'rule set "main checks"' });
    await at.start().lookAll();
    expect(at.heard.told).toEqual([
      {
        kind: "team-queue-left",
        project: { id: METER, name: "meter" },
        files: FILES,
        rule: 'rule set "main checks"',
      },
    ]);
    // A later look, after a merge in the project or in the app's next run, reads nothing again.
    const again = at.start();
    await again.look(METER);
    await again.lookAll();
    expect(at.heard.told).toHaveLength(1);
    expect(at.heard.reads).toEqual([METER]);
  });

  it("names no rule where none requires the status, and says nothing of a project that carries no file", async () => {
    const at = home();
    seedProject(at.db, {
      id: "repo-chart",
      name: "chart",
      path: "/code/chart",
      origin: "https://gitlab.com/acme/chart.git",
      delivery: "direct-pr",
    });
    at.hosts.set("repo-chart", { files: [".gitlab/infinitary-queue.yml"] });
    const look = at.start();
    await look.lookAll();
    expect(at.heard.told).toEqual([
      {
        kind: "team-queue-left",
        project: { id: "repo-chart", name: "chart" },
        files: [".gitlab/infinitary-queue.yml"],
      },
    ]);
    // The project with none is not read a second time either.
    await look.lookAll();
    expect(at.heard.reads.sort()).toEqual(["repo-chart", METER].sort());
  });

  it("reads again at the next look when the host could not be read, and tells then", async () => {
    const at = home();
    at.hosts.set(METER, new ForgeError("sign-in", "GitHub refused the sign-in."));
    const look = at.start();
    await look.lookAll();
    expect(at.heard.told).toEqual([]);
    at.hosts.set(METER, { files: FILES });
    await look.look(METER);
    expect(at.heard.told).toEqual([
      { kind: "team-queue-left", project: { id: METER, name: "meter" }, files: FILES },
    ]);
    expect(at.heard.reads).toEqual([METER, METER]);
  });

  it("tells once when two looks meet in one project", async () => {
    const at = home();
    let answer: (left: TeamQueueLeftovers) => void = () => {};
    at.hosts.set(
      METER,
      () =>
        new Promise<TeamQueueLeftovers>((resolve) => {
          answer = resolve;
        }),
    );
    const look = at.start();
    const first = look.look(METER);
    const second = look.look(METER);
    answer({ files: FILES });
    await Promise.all([first, second]);
    expect(at.heard.reads).toEqual([METER]);
    expect(at.heard.told).toHaveLength(1);
  });

  it("reads no host for a project kept on this computer, and takes down the card an earlier version left waiting for a queue", async () => {
    const at = home();
    seedProject(at.db, { id: "repo-notes", name: "notes", path: "/code/notes" });
    await at.start().lookAll();
    expect(at.heard.reads).toEqual([METER]);
    expect(at.heard.withdrawn).toEqual(
      expect.arrayContaining([
        { id: queueSetupCardId("repo-notes"), reason: QUEUE_SETUP_WITHDRAWN },
        { id: queueSetupCardId(METER), reason: QUEUE_SETUP_WITHDRAWN },
      ]),
    );
  });
});
