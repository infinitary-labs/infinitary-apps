import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { describe, expect, it, vi } from "vitest";
import {
  adoptHere,
  api,
  gitProject,
  model,
  placedWorldHooks,
  said,
  stops,
  world,
} from "../../../tests/helpers/placedWorld";
import {
  scriptedClaudeCleanup,
  scriptedClaudeWorld,
} from "../../../tests/helpers/scriptedClaudeContract";
import { renderDirections } from "../knowledge/directions";
import { crewmateRenewedNote, crewmateRestartText } from "../orchestrator/crewSession";
import { JOB_BOUND_MS } from "../orchestrator/idleLadder";
import { unnamedBackgroundWork } from "../orchestrator/jobWakes";
import { crewmateSessionsDir } from "../paths";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import type { CrewmateTool } from "../session/tools";

/**
 * A task that runs on a computer that runs work (`tests/helpers/placedWorld.ts`):
 * background jobs there, renewal and the record moved by an update.
 */

// Integration budget (docs/test-cohorts.md): real git on the computer and
// here, the slowest test 1.28 s at its fastest of nineteen runs on an Apple
// silicon Mac, with git unclamped as below. A poll waits for work that
// crosses the connection and runs git on both sides - a closed task's
// working copy kept, brought home and deleted took 0.46 s alone and 1.7 s
// with sixteen copies of this file running at once - so it waits for the
// rest of the test's budget, never Vitest's 1 s (tests/helpers/waitWindow.ts).
vi.setConfig({ testTimeout: 10_000 });

// On a Mac the product runs every git below the UI (`taskpolicy -c
// utility`, utilityQos.ts), where it yields to every busier process. A case
// here runs up to about a hundred gits one after another, so on a Mac
// loaded by other runs it waited on that load rather than its own work and
// ran past its budget. This file is about placed tasks, not that clamp
// (utilityQos.test.ts holds it), so its git runs as on a Mac without
// taskpolicy, at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The home's one clock: the wall clock, moved on when a case waits out a backoff. */
let ahead = 0;
const now = () => Date.now() + ahead;
placedWorldHooks({
  now,
  reset: () => {
    ahead = 0;
  },
});

/** The crewmate tools a newer version binds, with one of them described in other words. */
function reworded(name: string): CrewmateTool[] {
  return CREWMATE_TOOLS.map((tool: CrewmateTool): CrewmateTool => {
    if (tool.name !== name) return tool;
    const description = `${tool.description} Updated.`;
    return {
      ...tool,
      description,
      bind: (delegate) => {
        const bound = tool.bind(delegate);
        return bound && { ...bound, description };
      },
    };
  });
}

describe("a task that runs on a computer that runs work", () => {
  // INF-1536: INF-1534's Pi crewmate there, whose Gmail read became a
  // background job, was asked when it would look again at "background work
  // in the Claude client".
  describe("words about a Pi crewmate's background job there (INF-1536)", () => {
    async function endTurnWithJob(at: Awaited<ReturnType<typeof world>>, taskId: string) {
      const answered = "I pick up its result when it ends.";
      model([
        {
          tools: [
            {
              name: "bash",
              args: { command: "sleep 600", background: true, description: "Run the long suite" },
            },
          ],
        },
        { text: "The suite runs as a background job; I will pick up its result." },
        { text: answered },
      ]);
      const requests = api.requests.length;
      await at.start(taskId);
      await expect.poll(() => at.home().tasks.get(taskId)?.outcome).toBe(answered);
      // The check-back ask is the newest thing its turn after the job's receipt was told.
      const ask = JSON.stringify(api.requests[requests + 2]?.body.messages?.at(-1) ?? null);
      expect(ask).toContain("Report again with check_back");
      return ask;
    }

    /** The words of a job's command in a steer, as its JSON request carries them. */
    const quoted = (command: string) => JSON.stringify(`: "${command}".`).slice(1, -1);

    it("names the job's command in the check-back ask, the crew line and the job bound's wake", async () => {
      const at = await world(undefined, { jobs: true });
      const ask = await endTurnWithJob(at, "t-job-named");
      const home = at.home();
      expect(ask).toContain(quoted("sleep 600"));
      expect(home.supervisor.facts.crewStatus("t-job-named")[0]?.job).toMatch(/: sleep 600$/);
      const wakes = home.wakes.length;
      home.supervisor.watch.reconcileIdle(now() + JOB_BOUND_MS);
      expect(
        home.wakes.slice(wakes).find((wake) => wake.facts?.kind === "job-bound")?.facts,
      ).toMatchObject({ kind: "job-bound", command: "sleep 600" });
    });

    it("names the computer, never the Claude client, when that computer counts its jobs but names none", async () => {
      const at = await world(undefined, { jobs: "counted" });
      const computer = at
        .pairing()
        .list()
        .find((device) => device.id === at.deviceId)?.name;
      expect(computer).toBeDefined();
      const ask = await endTurnWithJob(at, "t-job-counted");
      expect(ask).toContain(quoted(unnamedBackgroundWork(computer)));
      expect(ask).not.toContain(unnamedBackgroundWork());
    });
  });

  // INF-367: a computer's restart reports each background job it cut off
  // once to its task, so an idle crewmate never waits for an exit that
  // cannot arrive.
  it("tells a crewmate waiting on a background job, as its next turn and once, that its computer's restart stopped the job (INF-367)", async () => {
    const at = await world(undefined, { jobs: true });
    const waiting = "The suite runs as a background job; I will pick up its result.";
    const answered = "I pick up its result when it ends.";
    model([
      {
        tools: [
          {
            name: "bash",
            args: { command: "sleep 600", background: true, description: "Run the long suite" },
          },
        ],
      },
      { text: waiting },
      // Its turn ended with the job running: the one check-back ask (INF-1244).
      { text: answered },
      { text: "Running the suite again." },
    ]);
    const requests = api.requests.length;
    await at.start("t-job");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-job")?.outcome).toBe(answered);
    const job = /background job ([0-9a-f]{8})/.exec(said(api.requests[requests + 1]))?.[1];
    expect(job).toBeDefined();
    expect(said(api.requests[requests + 2])).toContain("Report again with check_back");

    await at.restartComputer();
    await expect.poll(() => home.tasks.get("t-job")?.outcome).toBe("Running the suite again.");
    const heard = said(api.requests.at(-1));
    expect(heard).toContain(`background job ${job} did not finish`);
    expect(heard).toContain(JSON.stringify('"sleep 600" was stopped').slice(1, -1));
    expect(api.requests.length - requests).toBe(4);
    // Once: nothing is left there to tell again, and its lane is empty.
    expect(existsSync(join(at.folders("t-job").root, "jobs.json"))).toBe(false);
    expect(home.inbox.allFor("t-job")).toEqual([]);
    await at.restartComputer();
    await at.inReach("t-job");
    expect(api.requests.length - requests).toBe(4);
  });

  // INF-379: a Claude crewmate's background work runs inside its client,
  // which the computer's restart ends; as for a background job, the next
  // start tells its task once, so the crewmate never waits on work that ended.
  it("tells a Claude crewmate waiting on its background work, as its next turn and once, that its computer's restart stopped it (INF-379)", async () => {
    const claude = await scriptedClaudeWorld();
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    const waiting = "The suite runs in the background; I will pick up its result.";
    claude.answer({ text: waiting });
    await at.start("t-claude-job");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-claude-job")?.outcome).toBe(waiting);
    // The client lists what it runs in the background, as the real one
    // does, and the home shows the task at work on it.
    claude.listBackgroundTasks([{ id: "bybac1mss", description: "Run the long suite" }]);
    const posture = () => {
      const record = home.tasks.get("t-claude-job");
      if (!record) throw new Error("No task t-claude-job.");
      return home.supervisor.postures.workPosture(record);
    };
    await expect.poll(posture).toEqual({ state: "active", reason: "job" });
    const asked = claude.served().length;

    claude.answer({ text: "Running the suite again." });
    await at.restartComputer();
    await expect
      .poll(() => home.tasks.get("t-claude-job")?.outcome)
      .toBe("Running the suite again.");
    expect(claude.served().length - asked).toBe(1);
    const heard = claude.served().at(-1)?.said ?? "";
    expect(heard).toContain(
      '[job] background job bybac1mss did not finish: "Run the long suite" was stopped',
    );
    // Once: nothing is left there to tell again, and its lane is empty.
    expect(existsSync(join(at.folders("t-claude-job").root, "jobs.json"))).toBe(false);
    expect(home.inbox.allFor("t-claude-job")).toEqual([]);
    await at.restartComputer();
    await at.inReach("t-claude-job");
    expect(claude.served().length - asked).toBe(1);
  });

  // INF-405: the home's quit lets go of each conversation it holds there,
  // and an idle Claude client ends with its background work while that
  // computer runs on; the crewmate is told once, as its next turn, when the
  // home is back.
  it("tells a Claude crewmate once, as its next turn, that its background work there ended when the home's restart let go of its client (INF-405)", async () => {
    const claude = await scriptedClaudeWorld();
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    const waiting = "The suite runs in the background; I will pick up its result.";
    claude.answer({ text: waiting });
    await at.start("t-claude-let-go");
    const before = at.home();
    await expect.poll(() => before.tasks.get("t-claude-let-go")?.outcome).toBe(waiting);
    claude.listBackgroundTasks([{ id: "bybac1mss", description: "Run the long suite" }]);
    await expect
      .poll(() => {
        const record = before.tasks.get("t-claude-let-go");
        return record && before.supervisor.postures.workPosture(record);
      })
      .toEqual({ state: "active", reason: "job" });
    const asked = claude.served().length;

    claude.answer({ text: "Running the suite again." });
    await at.restartHome();
    const home = at.home();
    await expect
      .poll(() => home.tasks.get("t-claude-let-go")?.outcome)
      .toBe("Running the suite again.");
    expect(claude.served().length - asked).toBe(1);
    expect(claude.served().at(-1)?.said).toContain(
      '[job] background job bybac1mss did not finish: "Run the long suite" was stopped',
    );
    // Once: nothing is left there to tell again, its lane is empty, and
    // another restart of either tells it nothing more.
    expect(existsSync(join(at.folders("t-claude-let-go").root, "jobs.json"))).toBe(false);
    expect(home.inbox.allFor("t-claude-let-go")).toEqual([]);
    await at.restartHome();
    await at.inReach("t-claude-let-go");
    await at.restartComputer();
    await at.inReach("t-claude-let-go");
    expect(claude.served().length - asked).toBe(1);
  });

  it("tells a Claude crewmate its brief and where its earlier conversation is when that computer's update starts it over, and only once (INF-296)", async () => {
    const claude = await scriptedClaudeWorld();
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    claude.answer({ text: "Looking at the footer." });
    await at.start("t-renew");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-renew")?.activity).toBe("idle");
    const earlier = home.tasks.get("t-renew")?.sessionFile ?? "";
    expect(earlier).not.toBe("");
    // INF-1295/F1: identity follows the resume token, not a placed proxy's construction id.
    const initialSessions = home.tasks.archive.sessions("t-renew");
    expect(initialSessions).toMatchObject([
      { conversation: earlier, device_id: at.deviceId, began: "start", current: true },
    ]);
    const briefed = home.tasks
      .timeline("t-renew")
      .filter((event) => event.kind === "briefed")
      .at(-1);
    const brief = briefed ? home.tasks.servedBrief(briefed) : "";
    expect(brief).toContain("Fix the footer.");

    // Its update describes a tool the conversation had in other words, which
    // Claude's client would serve in the old ones: reopened there, it starts over.
    await at.restartComputer({ tools: reworded("report") });
    // The record names the new conversation before any turn of it, and the timeline says why.
    await expect.poll(() => home.tasks.get("t-renew")?.sessionFile).not.toBe(earlier);
    const renewed = home.tasks.get("t-renew")?.sessionFile;
    const renewedSessions = home.tasks.archive.sessions("t-renew");
    expect(renewedSessions).toHaveLength(2);
    expect(renewedSessions).toMatchObject([
      {
        conversation: earlier,
        file: join(at.folders("t-renew").sessions, `${earlier}.jsonl`),
        device_id: at.deviceId,
        began: "start",
        current: false,
      },
      {
        conversation: renewed,
        file: join(at.folders("t-renew").sessions, `${renewed}.jsonl`),
        device_id: at.deviceId,
        began: "renewal",
        current: true,
      },
    ]);
    const renewal = { from: earlier, changed: ["prompt" as const] };
    const moved = () =>
      home.tasks
        .timeline("t-renew")
        .filter((event) => event.kind === "note" && event.text === crewmateRenewedNote(renewal));
    expect(moved()).toHaveLength(1);
    expect(moved()[0]?.data).toMatchObject({ conversation: renewal });

    // Its next prompt says why, its brief, and where the transcript of its
    // earlier conversation is saved on that computer, which holds it there.
    const transcript = join(at.folders("t-renew").sessions, `${earlier}.jsonl`);
    expect(readFileSync(transcript, "utf8")).toContain("Fix the footer.");
    const told = crewmateRestartText({
      restart: renewal,
      taskKey: home.tasks.get("t-renew")?.key ?? "",
      brief,
      earlier: transcript,
    });
    const asked = claude.served().length;
    await home.supervisor.steer.steerCrewmate("t-renew", "Make it blue too.");
    await expect.poll(() => claude.served().length).toBe(asked + 1);
    expect(claude.served().at(-1)?.said).toBe(`${told}\n\nMake it blue too.`);
    await expect.poll(() => home.tasks.get("t-renew")?.activity).toBe("idle");

    const completedSessions = home.tasks.archive.sessions("t-renew");
    // The serving model becomes known on its first completed turn, before the home restarts.
    expect(completedSessions[1]?.provider).toBe(CLAUDE_PROVIDER_ID);
    // A home restart while that computer still holds it: the same conversation, said nothing again.
    await at.restartHome();
    const after = at.home();
    await after.supervisor.steer.steerCrewmate("t-renew", "And the header.");
    await expect.poll(() => claude.served().length).toBe(asked + 2);
    const since = claude.served().at(-1)?.said ?? "";
    expect(since).toContain("And the header.");
    // What it was told stands once, in the conversation it goes on with.
    expect(since.split(told)).toHaveLength(2);
    expect(after.tasks.get("t-renew")?.sessionFile).toBe(renewed);
    const restartedSessions = after.tasks.archive.sessions("t-renew");
    expect(restartedSessions).toHaveLength(2);
    expect(restartedSessions.filter((session) => session.current)).toHaveLength(1);
    expect(restartedSessions.map(({ last_at: _last, ...row }) => row)).toEqual(
      completedSessions.map(({ last_at: _last, ...row }) => row),
    );
    console.info(
      "INF-1295 remote Claude association lifecycle",
      JSON.stringify({ initialSessions, renewedSessions, completedSessions, restartedSessions }),
    );
    expect(
      after.tasks
        .timeline("t-renew")
        .filter((event) => event.kind === "note" && event.text === crewmateRenewedNote(renewal)),
    ).toHaveLength(1);
  });

  // INF-2599, the captain: "Send a crewmate its directions once, and again
  // only when they change". The home holds what a placed conversation was
  // told by the session it holds, which a computer's restart keeps while the
  // conversation there starts over (INF-2842's finding).
  it("tells a Claude crewmate its project's directions again when that computer's update starts its conversation over (INF-2599)", async () => {
    const project = await gitProject();
    const claude = await scriptedClaudeWorld();
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude, knowledge: true });
    const home = at.home();
    const knowledge = home.knowledge;
    if (!knowledge) throw new Error("the home has no knowledge");
    const { repo } = await adoptHere(home.repos, project.home);
    knowledge.directions.change({
      op: "add",
      id: "review-once",
      scope: repo.id,
      text: "Do not re-review a task only because main moved.",
      reason: "the captain said so",
    });
    const directions =
      renderDirections(
        knowledge.directions.standing({ kind: "crewmate", taskId: "t-told", repoId: repo.id }),
      ) ?? "";
    expect(directions).toContain("Do not re-review a task only because main moved.");
    claude.answer({ text: "Looking at the footer." });
    // The conversation there as its newest request showed it, and the copies of the set it holds.
    const said = () => claude.served().at(-1)?.said ?? "";
    const copies = () => said().split(directions).length - 1;
    await at.start("t-told", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-told")?.activity).toBe("idle");
    expect(copies()).toBe(1);
    const steer = async (text: string) => {
      const asked = claude.served().length;
      await home.supervisor.steer.steerCrewmate("t-told", text);
      await expect.poll(() => claude.served().length).toBe(asked + 1);
      await expect.poll(() => home.tasks.get("t-told")?.activity).toBe("idle");
    };
    await steer("Make it blue too.");
    expect(said()).toContain("Make it blue too.");
    expect(copies()).toBe(1);

    // Its update starts the conversation over there, under the session the home holds.
    const earlier = home.tasks.get("t-told")?.sessionFile;
    await at.restartComputer({ tools: reworded("report") });
    await expect.poll(() => home.tasks.get("t-told")?.sessionFile).not.toBe(earlier);
    await steer("And the header.");
    expect(said()).toContain("Fix the footer.");
    expect(said()).not.toContain("Make it blue too.");
    expect(copies()).toBe(1);
    await steer("And the links.");
    expect(copies()).toBe(1);
  });

  // INF-284: after its update moves Firstmate 3000's folder into
  // Infinitary's, a conversation held there must go on in the new folder,
  // never in the older one the move keeps as its recovery copy.
  // Protocol 9 requires the home and work computer to update together.
  it("goes on from the migrated record after both computers update (INF-416 L)", async () => {
    const at = await world(undefined, { inOlderFolder: true });
    model([
      { text: "Started on the footer." },
      {
        tools: [{ name: "report", args: { text: "The header is fixed too.", summary: "Fixed." } }],
      },
      { text: "Reported." },
      {
        tools: [{ name: "report", args: { text: "The footer still holds.", summary: "Held." } }],
      },
      { text: "Reported." },
    ]);
    await at.start("t-moved");
    await expect.poll(() => at.home().tasks.get("t-moved")?.activity).toBe("idle");
    const older = at.folders("t-moved");
    const before = at.home().tasks.get("t-moved")?.sessionFile ?? "";
    expect(before.startsWith(`${older.sessions}/`)).toBe(true);
    const kept = readFileSync(before, "utf8");
    const initialSessions = at.home().tasks.archive.sessions("t-moved");
    expect(initialSessions).toHaveLength(1);

    await at.stopComputer();
    await at.restartHome(() => at.moveComputer());
    await at.inReach("t-moved");
    const requests = api.requests.length;
    await at.home().supervisor.steer.steerCrewmate("t-moved", "Fix the header too.");
    await expect
      .poll(() => at.home().tasks.get("t-moved")?.outcome)
      .toBe("The header is fixed too.");

    const moved = at.folders("t-moved");
    const file = join(moved.sessions, relative(older.sessions, before));
    const now = readFileSync(file, "utf8");
    expect(now.startsWith(kept)).toBe(true);
    expect(now).toContain("Fix the header too.");
    expect(readFileSync(before, "utf8")).toBe(kept);
    await expect.poll(() => at.home().tasks.get("t-moved")?.sessionFile).toBe(file);
    const copy = join(
      crewmateSessionsDir(at.home().paths, "t-moved"),
      relative(moved.sessions, file),
    );
    await expect.poll(() => readFileSync(copy, "utf8")).toBe(readFileSync(file, "utf8"));
    const system = JSON.stringify(api.requests[requests]?.body.system);
    expect(system).toContain(moved.evidence);
    expect(system).toContain(moved.cardBodies);
    expect(system).toContain(moved.temp);
    expect(system).not.toContain(`${join(older.root, "..", "..", "..")}/`);
    expect(said(api.requests[requests])).not.toContain("Your working copy was");

    // That computer restarts again: its conversation opens there with the
    // same paths mapped, and its crewmate is not told a second time.
    await at.restartComputer();
    await at.inReach("t-moved");
    await at.home().supervisor.steer.steerCrewmate("t-moved", "Check the footer again.");
    await expect
      .poll(() => at.home().tasks.get("t-moved")?.outcome)
      .toBe("The footer still holds.");
    const asked = ["Fix the footer.", "Fix the header too.", "Check the footer again."];
    for (const text of asked) {
      expect(said(api.requests.at(-1))).toContain(text);
      expect(readFileSync(file, "utf8")).toContain(text);
    }
    expect(readFileSync(before, "utf8")).toBe(kept);
    const restartedSessions = at.home().tasks.archive.sessions("t-moved");
    expect(restartedSessions).toHaveLength(1);
    expect(restartedSessions[0]).toMatchObject({
      conversation: initialSessions[0]?.conversation,
      file,
      device_id: at.deviceId,
      began: "start",
      current: true,
    });
    console.info(
      "INF-1295 remote Pi association continuity",
      JSON.stringify({ initialSessions, restartedSessions }),
    );
  });
});
