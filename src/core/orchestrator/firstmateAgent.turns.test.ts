import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { onStage } from "@shared/cards";
import * as checkReadings from "@shared/checkSnapshot";
import { HERE } from "@shared/deviceNames";
import { AUTOMATIC_WORD } from "@shared/placement";
import { describe, expect, it, vi } from "vitest";
import {
  crewCard,
  decodeContext,
  drained,
  fakeClockEachTest,
  setup,
  tick,
  toolsOf,
} from "../../../tests/helpers/firstmateHarness";
import { jpegImage, pngImage } from "../../../tests/helpers/images";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { sourceInstall } from "../../../tests/helpers/sourceInstall";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { ForgeSignInStore, ForgeSignIns, type ForgeWhoAmI } from "../forge/signIns";
import { parseTasksQueryText } from "../pi/taskTools";
import type { ModelRuntime } from "../pi/types";
import type { CrewMachines } from "../placed/crewMachines";
import { localTimeZoneName, timeZoneFact } from "../prompts/timeZone";
import { readSelfSource, readSelfSourceAsync } from "../selfSource/resolve";
import { CardStore } from "../storage/cardStore";
import { FIRSTMATE_RECIPIENT, InboxStore } from "../storage/inboxStore";
import { queueWaitOf } from "../tasks/queueWait";
import { seedTask } from "../tasks/seedTask";
import type { RepoRegistry } from "../workspace/repoRegistry";
import type { FirstmateAgent } from "./firstmateAgent";
import * as settleWords from "./settleService";

// This file chains real git and is not about the utility-QoS clamp, so what
// the product spawns runs at this run's own priority (tests/helpers/unclampedQos.ts).
vi.mock("../utilityQos", async (importOriginal) =>
  (await import("../../../tests/helpers/unclampedQos")).unclampedQos(importOriginal),
);

/** The first mate agent: turns: the input, its context block and steering (tests/helpers/firstmateHarness.ts). */
fakeClockEachTest();

describe("FirstmateAgent", () => {
  it.each([true, false])(
    "keeps the no-answer guard on the served seat when local=%s changes mid-turn",
    async (local) => {
      // The local seat's own guard needs a silent model; the other seat's turn
      // reacts, since a silent one would meet the answer-delivery retry instead.
      const f = setup({ silent: local });
      const seat = {
        model: { provider: "local", id: "fixture" },
        runtime: {} as ModelRuntime,
        host: "localhost",
        source: "setting" as const,
      };
      if (local) await f.agent.setLocalOrchestrator(seat);
      await f.agent.converse("what is two plus two?");
      await f.agent.setLocalOrchestrator(local ? undefined : seat);
      f.session.emitTurnEnd("Four.");
      f.session.resolveNextPrompt();
      await vi.waitFor(() => expect(f.agent.isBusy()).toBe(false));
      expect(Boolean(new CardStore(f.db).get("card-fm-turn-failure"))).toBe(local);
      f.agent.dispose();
      f.db.close();
    },
  );

  it("uses the latest local choice when Settings changes during endpoint preparation", async () => {
    vi.useRealTimers();
    const f = setup();
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = vi.fn(() => ready);
    const first = {
      model: { provider: "local", id: "first" },
      runtime: {} as ModelRuntime,
      host: "localhost",
      source: "setting" as const,
      prepare,
    };
    await f.agent.setLocalOrchestrator(first);
    const asking = f.agent.converse("use the selected model");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
    await f.agent.setLocalOrchestrator({
      ...first,
      model: { provider: "local", id: "second" },
      prepare: async () => {},
    });
    release();
    await asking;
    expect(f.specs.at(-1)?.model?.id).toBe("second");
    expect(f.session.prompts).toHaveLength(1);
    f.session.resolveNextPrompt();
    await vi.waitFor(() => expect(f.agent.isBusy()).toBe(false));
    f.agent.dispose();
    f.db.close();
  });

  it("reads running computer versions and a crewmate’s persisted first-release report without another worker (INF-1607)", async () => {
    const versions = [
      { id: "this-mac", name: "Home", role: "home", connected: true, version: "0.1.30" },
      {
        id: "mini",
        name: "Mini",
        role: "work",
        connected: true,
        version: "0.1.12" as string | null,
      },
    ];
    const f = setup({ computerVersions: () => versions });
    expect(decodeContext(f.agent.buildContextBlock()).computer_versions).toEqual(versions);
    versions[1] = { ...versions[1]!, connected: false, version: null };
    expect(decodeContext(f.agent.buildContextBlock()).computer_versions).toEqual(versions);
    const { repo } = await f.repos.setup({ kind: "adopt", path: process.cwd() });
    const merged = seedTask(f.tasks, {
      repoId: repo.id,
      id: "version-fix",
      title: "Show running version",
      status: "idle",
    });
    f.tasks.close(merged.id, { status: "done", reason: "merged", actor: "captain" });
    await f.agent.converse("which release carries the version fix?");
    const spawn = f.specs[0]?.tools.find((tool) => tool.name === "spawn_crewmate");
    if (!spawn) throw new Error("Missing spawn_crewmate");
    await spawn.run({
      title: "Verify released changes",
      goal: "Record the first release containing the version fix",
      user_words: "which release carries the version fix?",
      repo_id: repo.id,
    });
    await vi.waitFor(() => expect(f.crewSpecs).toHaveLength(1));
    const report = f.crewSpecs[0]?.tools?.find((tool) => tool.name === "report");
    if (!report) throw new Error("Missing report");
    const release = {
      version: "0.1.30",
      url: "https://github.com/infinitary-labs/infinitary/releases/tag/v0.1.30",
      evidence: "The published source contains this task's merge; the preceding release does not.",
    };
    const answer = await report.run({
      text: "Verified the published source contains the merged version fix.",
      summary: "The version fix has its first verified release.",
      first_release: { ...release, tasks: [merged.key] },
    });
    expect(answer.text).toContain("Recorded 1 first-release");
    expect(f.tasks.get(merged.id)?.delivery?.firstRelease).toEqual(release);
    const query = f.specs[0]?.tools.find((tool) => tool.name === "tasks");
    if (!query) throw new Error("Missing tasks");
    const read = await query.run({ key: merged.key });
    expect(parseTasksQueryText(read.text ?? "").rows[0]?.first_release).toEqual(release);
    expect(f.crewSpecs).toHaveLength(1);
    const evidenceDir = process.env.INFINITARY_VERSION_EVIDENCE_DIR;
    if (evidenceDir)
      writeFileSync(
        join(evidenceDir, "firstmate-version-facts.json"),
        JSON.stringify(
          {
            context: decodeContext(f.agent.buildContextBlock()).computer_versions,
            mutation: answer.text,
            saved: f.tasks.get(merged.id)?.delivery?.firstRelease,
            history: f.tasks.timeline(merged.id).map(({ text, data }) => ({ text, data })),
          },
          null,
          2,
        ),
      );
    f.session.resolveNextPrompt();
    await vi.waitFor(() => expect(f.agent.isBusy()).toBe(false));
    f.agent.dispose();
    await f.supervisor.disposeAll();
    f.db.close();
  });

  it("prefixes every user turn with the context block and does not scrape final text into the feed", async () => {
    // INF-1977 A: the home context distinguishes identity from its local path,
    // and reads fresh facts rather than treating an earlier build as current.
    const installed = sourceInstall(scratchDir("firstmate-source-"));
    // INF-2186: turn context awaits fresh asynchronous filesystem validation.
    const selfSourceFacts = vi.fn(() => readSelfSource(installed.location));
    const { agent, session, events, repos, usages, selfSourceDir } = setup({
      selfSourceFacts,
      selfSourceFactsAsync: () => readSelfSourceAsync(installed.location),
    });
    await repos.setup({ kind: "adopt", path: process.cwd() });
    await agent.converse("how are we doing on quota?");
    expect(session.prompts).toHaveLength(1);
    const turn = session.prompts[0] as string;
    expect(turn).toContain("[fm-op] context (not the user)");
    const context = decodeContext(turn);
    expect(context.repos[0]).toMatchObject({ repo_id: expect.any(String) });
    expect(context.quota).toBe("codex 62% weekly on_pace");
    expect(context.self_source).toBe(selfSourceDir);
    expect(selfSourceFacts).not.toHaveBeenCalled();
    expect(context.self_source_facts).toEqual(selfSourceFacts());
    installed.location.version = "a different running version";
    expect(decodeContext(agent.buildContextBlock()).self_source_facts).toMatchObject({
      availability: "unavailable",
      commit: null,
    });
    expect(turn).toContain("[user]\nhow are we doing on quota?");
    expect(events).toContainEqual({ type: "firstmate_state", busy: true });

    session.emitTurnEnd("Quota looks healthy.", { input: 12, output: 4 });
    session.resolveNextPrompt();
    await tick();
    expect(events.find((event) => event.type === "firstmate_note")).toBeUndefined();
    expect(events.at(-1)).toEqual({ type: "firstmate_state", busy: false });
    expect(usages).toHaveLength(1);
    await agent.converse("read the source facts again");
    expect(decodeContext(session.prompts[1] as string).self_source_facts).toMatchObject({
      availability: "unavailable",
      commit: null,
    });
    session.emitTurnEnd("The installed source does not match.");
    session.resolveNextPrompt();
    await tick();
  });

  // INF-2186, captain's 832 ms crew-status check-summary sample.
  it("summarises a crew check snapshot once per projection and refreshes it after a new reading", async () => {
    const f = setup({
      seedTasks: [{ id: "checked", title: "Verify Tasks responsiveness", status: "idle" }],
    });
    const headSha = "93355db9d04e964513879db74d068a7789cb4c16";
    const checks = {
      headSha,
      complete: true,
      absenceDeclared: false,
      items: [{ name: "unit-tests", state: "failure" as const }],
    };
    seedDelivery(f.tasks, "checked", { headSha, ci: "red", ciAt: Date.now(), checks });
    const summary = vi.spyOn(checkReadings, "currentCheckSummary");
    try {
      f.tasks.readProjection(() => {
        for (let reader = 0; reader < 20; reader += 1)
          expect(f.supervisor.crewStatus("checked")[0]?.ci?.overall).toBe("red");
        console.info(
          JSON.stringify({
            intent: "INF-2186 crew check summaries",
            summaries: summary.mock.calls.length,
          }),
        );
        expect(summary).toHaveBeenCalledTimes(1);
        f.tasks.delivery.recordChangeEvidence("checked", {
          ci: "green",
          checks: { ...checks, items: [{ name: "unit-tests", state: "success" }] },
        });
        expect(f.supervisor.crewStatus("checked")[0]?.ci?.overall).toBe("green");
        expect(summary).toHaveBeenCalledTimes(2);
      });
      expect(f.supervisor.crewStatus("checked")[0]?.ci?.overall).toBe("green");
      expect(summary).toHaveBeenCalledTimes(3);
    } finally {
      summary.mockRestore();
      f.agent.dispose();
      await f.supervisor.disposeAll();
      f.db.close();
    }
  });

  // INF-2255: the captain's children and threadStat/crewStatus context samples.
  // Started work needs no queue inputs; its thread facts need no per-card message hydration.
  it("builds a started roster without unused children or per-card thread hydration", async () => {
    const started = Array.from({ length: 20 }, (_, index) => `started-${index}`);
    const f = setup({
      seedTasks: started.map((id) => ({
        id,
        title: `Review active work ${id}`,
        status: "idle" as const,
      })),
      seedCards: started.map((id) =>
        crewCard(`card-${id}`, id, "Review the result", "<p>The work is ready.</p>"),
      ),
    });
    const store = new CardStore(f.db);
    for (const id of started) {
      store.appendMessage({ cardId: `card-${id}`, who: "crewmate", text: "The checks passed." });
      seedTask(f.tasks, {
        id: `${id}-part`,
        title: "Finished earlier part",
        status: "idle",
        parentId: id,
      });
      f.tasks.close(`${id}-part`, { status: "done", reason: "settled", actor: "host" });
    }
    seedTask(f.tasks, { id: "queued-parent", title: "Wait for its part", status: "queued" });
    seedTask(f.tasks, {
      id: "queued-part",
      title: "Build the part",
      status: "queued",
      parentId: "queued-parent",
    });
    const children = vi.spyOn(f.tasks.graph, "children");
    const threadStats = vi.spyOn(CardStore.prototype, "threadStat");
    const threadBatch = vi.spyOn(CardStore.prototype, "threadStats");
    const messages = vi.spyOn(CardStore.prototype, "messageById");
    const recentThreads = vi.spyOn(CardStore.prototype, "threadSummaries");
    try {
      const context = decodeContext(f.agent.buildContextBlock());
      expect(new Set(context.crew.map((row) => row.task_id))).toEqual(new Set(started));
      console.info(
        JSON.stringify({
          intent: "INF-2255 combined roster reads",
          started: started.length,
          childReads: children.mock.calls.length,
          perCardThreadReads: threadStats.mock.calls.length,
          threadBatches: threadBatch.mock.calls.length,
          hydratedMessages: messages.mock.calls.length,
          firstThread: context.crew[0]?.thread,
        }),
      );
      expect(children).not.toHaveBeenCalled();
      for (const row of context.crew)
        expect(row.thread).toBe("thread: 1 message, last from crewmate");
      expect(threadStats).not.toHaveBeenCalled();
      expect(threadBatch).toHaveBeenCalledTimes(1);
      expect(new Set(threadBatch.mock.calls[0]?.[0])).toEqual(
        new Set(started.map((id) => `card-${id}`)),
      );
      const recentMessages = recentThreads.mock.results.reduce(
        (count, result) => count + (result.type === "return" ? result.value.length : 0),
        0,
      );
      expect(messages).toHaveBeenCalledTimes(recentMessages);
      store.appendMessage({
        cardId: `card-${started[0]}`,
        who: "captain",
        text: "What did the checks cover?",
      });
      const afterReply = f.supervisor.crewStatus(started[0])[0]?.thread;
      expect(afterReply).toBe("thread: 2 messages, last from captain");
      console.info(JSON.stringify({ intent: "INF-2255 roster reply freshness", afterReply }));
      const queued = f.supervisor.crewStatus("queued-parent")[0];
      expect(children).toHaveBeenCalledWith("queued-parent");
      const expected = queueWaitOf(
        f.tasks.get("queued-parent")!,
        [],
        [],
        f.tasks.graph.children("queued-parent"),
      );
      expect(queued?.gate).toBe(expected?.line);
      f.tasks.close("queued-part", { status: "done", reason: "settled", actor: "host" });
      expect(f.supervisor.crewStatus("queued-parent")[0]?.gate).not.toBe(queued?.gate);
    } finally {
      recentThreads.mockRestore();
      messages.mockRestore();
      threadStats.mockRestore();
      threadBatch.mockRestore();
      children.mockRestore();
      f.agent.dispose();
      await f.supervisor.disposeAll();
      f.db.close();
    }
  });

  // INF-2186, captain's 952 ms moveRefusal/describeStatus board sample.
  it("derives bulk move eligibility without formatting a refusal for each row", async () => {
    const f = setup({
      seedTasks: Array.from({ length: 40 }, (_, index) => ({
        id: `queued-${index}`,
        title: `Planned work ${index}`,
        status: "queued" as const,
      })),
    });
    const words = vi.spyOn(settleWords, "describeStatus");
    try {
      f.tasks.readProjection(() => {
        for (const record of f.tasks.listLive()) {
          expect(f.supervisor.moves.computerMoveFacts(record)).toEqual({});
          expect(f.supervisor.moves.computerMoveFacts(record)).toEqual({});
        }
      });
      console.info(
        JSON.stringify({
          intent: "INF-2186 bulk move facts",
          formattedRefusals: words.mock.calls.length,
        }),
      );
      expect(words).not.toHaveBeenCalled();
      const refused = await f.supervisor.moves.requestComputerMove(
        "queued-0",
        "Studio Mac",
        "captain",
      );
      expect(refused.ok).toBe(false);
      expect(refused.text.length).toBeGreaterThan(0);
      expect(words).toHaveBeenCalledTimes(1);
    } finally {
      words.mockRestore();
      f.agent.dispose();
      await f.supervisor.disposeAll();
      f.db.close();
    }
  });

  // INF-2186, captain's 715 ms taskPlace/taskComputer sample: backlog counts
  // do not need a queued task's place; only rostered work does.
  it("computes each rostered task's place once without computing the backlog's places", async () => {
    const name = "Studio Mac";
    const machines = {
      computers: () => ["studio"],
      nameOf: () => name,
      placeOf: () => ({ label: name, where: `on ${name}`, who: name }),
      ready: () => true,
      accountOf: () => undefined,
      signInWait: () => undefined,
      factories: () => undefined,
      folders: () => undefined,
    } as unknown as CrewMachines;
    const f = setup({
      machines,
      seedTasks: [
        { id: "started", title: "Verify Tasks refreshes", status: "idle", deviceId: "studio" },
        ...Array.from({ length: 40 }, (_, index) => ({
          id: `queued-${index}`,
          title: `Prepare follow-up ${index}`,
          status: "queued" as const,
          deviceId: "studio",
        })),
      ],
    });
    const place = vi.spyOn(f.supervisor.placement, "taskPlace");
    try {
      const context = decodeContext(f.agent.buildContextBlock());
      expect(context.crew).toMatchObject([{ task_id: "started", runs_on: name }]);
      const placed = place.mock.calls.map(([record]) => record.id);
      console.info(JSON.stringify({ intent: "INF-2186 roster places", placed }));
      expect(placed).toEqual(["started"]);
    } finally {
      place.mockRestore();
      f.agent.dispose();
      await f.supervisor.disposeAll();
      f.db.close();
    }
  });

  // INF-2186: the local crew's new async source boundary must respect shutdown too.
  it("does not open a local crewmate after shutdown during source validation", async () => {
    const installed = sourceInstall(scratchDir("crew-stop-source-"));
    const facts = readSelfSource(installed.location);
    let release = (_facts: typeof facts) => {};
    const pending = new Promise<typeof facts>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const f = setup({
      crewSource: () => {
        reached();
        return pending;
      },
    });
    const commissioning = f.supervisor.intake.commission({
      title: "Plan the Tasks refresh check",
      intent: {
        goal: "Plan how to verify Tasks refreshes",
        userWords: "Plan how to verify Tasks refreshes",
      },
      shape: { kind: "plan" },
    });
    const settled = commissioning.then(
      () => undefined,
      () => undefined,
    );
    try {
      await Promise.race([
        reading,
        commissioning.then(() => {
          throw new Error("The task did not request its source facts");
        }),
      ]);
      const stopping = f.supervisor.disposeAll();
      release(facts);
      await Promise.all([settled, stopping]);
      console.info(
        JSON.stringify({
          intent: "INF-2186 local source shutdown",
          openedSessions: f.crewSpecs.length,
        }),
      );
      expect(f.crewSpecs).toHaveLength(0);
    } finally {
      release(facts);
      await settled;
      f.agent.dispose();
      await f.supervisor.disposeAll();
      f.db.close();
    }
  });

  // INF-2186: an asynchronous source read must not reattach a disposed first mate.
  it("does not reopen the first mate after shutdown during source validation", async () => {
    const installed = sourceInstall(scratchDir("firstmate-stop-source-"));
    const facts = readSelfSource(installed.location);
    let release = (_facts: typeof facts) => {};
    const pending = new Promise<typeof facts>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const f = setup({
      selfSourceFactsAsync: () => {
        reached();
        return pending;
      },
    });
    const inbox = new InboxStore(f.db);
    inbox.enqueueWake(FIRSTMATE_RECIPIENT, "The task reported its checks.", "crewmate-report");
    const drain = f.agent as unknown as { drainInbox(): Promise<void> };
    const draining = drain.drainInbox();
    try {
      await reading;
      f.agent.dispose();
      release(facts);
      await draining;
      expect(f.specs).toHaveLength(0);
      expect(f.session.prompts).toHaveLength(0);
      expect(inbox.pending(FIRSTMATE_RECIPIENT)).toHaveLength(1);
    } finally {
      release(facts);
      await draining;
      f.agent.dispose();
      await f.supervisor.disposeAll();
      f.db.close();
    }
  });

  it("records model-powered tool usage without settling the captain's turn", async () => {
    const { agent, session, usages } = setup();
    await agent.converse("check usage");
    session.emit({
      type: "tool_end",
      taskId: "firstmate",
      callId: "firstmate:compaction",
      toolName: "compact_context",
      isError: false,
      usage: { input: 100, output: 20, cost: 0.37 },
    });
    expect(usages).toContainEqual(
      expect.objectContaining({ usage: { input: 100, output: 20, cost: 0.37 } }),
    );
    expect(agent.isBusy()).toBe(true);
    session.emitTurnEnd("checked", { input: 10, output: 2, cost: 0.01 });
    session.resolveNextPrompt();
    await tick();
    expect(usages).toHaveLength(2);
  });

  it("names the captain's time zone with its offset on the host's clock in every turn's context (FI3-1006)", async () => {
    // A January afternoon: the offset is winter's wherever the Mac is.
    const january = Date.parse("2026-01-15T19:11:00Z");
    const { agent, session } = setup({ now: () => january });
    await agent.converse("when did the incident start?");
    const context = decodeContext(session.prompts[0] as string);
    expect(context.captain_time_zone).toBe(timeZoneFact(january, localTimeZoneName()));
    expect(context.captain_time_zone).toMatch(/^\S+ \(UTC[+-]\d{2}:\d{2}\)$/);
  });

  it("tells the Firstmate who the app is signed in as where a project's changes go, and nothing where they never leave this Mac (git integration PR 1.3)", async () => {
    // The real sign-in service over a real store; only the host's answer
    // to "who is this?" is scripted.
    let answer: ForgeWhoAmI = { state: "ok", login: "octo" };
    const store = new ForgeSignInStore(scratchDir("infinitary-lives-signins-"));
    const signIns = new ForgeSignIns({
      store,
      providers: [
        {
          host: "github.com",
          name: "GitHub",
          start: async () => {
            throw new Error("no sign-in flow in this test");
          },
          wait: async () => ({ outcome: "cancelled" }),
          whoAmI: async () => answer,
        },
      ],
      projectsOn: () => 0,
      push: () => {},
    });
    const { agent, repos } = setup({
      forges: {
        remoteProjects: async () => "",
        signInOn: (host) => signIns.signInOn(host),
      },
    });
    const folder = (name: string, origin: string) => {
      const dir = scratchDir(`infinitary-lives-${name}-`);
      execFileSync("git", ["init", "--initial-branch=main", dir], { stdio: "pipe" });
      execFileSync("git", ["-C", dir, "remote", "add", "origin", origin], { stdio: "pipe" });
      return dir;
    };
    await repos.setup({
      kind: "adopt",
      path: folder("meter", "https://github.com/octo/meter.git"),
      name: "meter",
    });
    const kept = await repos.setup({
      kind: "adopt",
      path: folder("notes", "git@github.com:octo/notes.git"),
      name: "notes",
    });
    repos.configure(kept.repo.id, { delivery: "local-only" });
    await repos.setup({
      kind: "adopt",
      path: folder("ledger", "https://git.example.com/octo/ledger.git"),
      name: "ledger",
    });
    await repos.setup({ kind: "init", name: "kept-here" });
    const lives = () =>
      Object.fromEntries(
        decodeContext(agent.buildContextBlock()).repos.map((repo) => [repo.name, repo.lives]),
      );

    // Nothing signed in: said as a fact where a change would go there, and
    // not at all where the captain keeps the work on this Mac.
    expect(lives()).toMatchObject({
      meter: "github (not signed in)",
      notes: "github",
      ledger: "git (git.example.com)",
      "kept-here": "none",
    });

    store.write("github.com", { token: "gho_test", scopes: ["repo"], login: null, createdAt: 1 });
    expect(lives().meter).toBe("github (signed in)");
    await signIns.checkHealth();
    expect(lives()).toMatchObject({ meter: "github (signed in as octo)", notes: "github" });

    answer = { state: "unavailable", reason: "no network" };
    await signIns.checkHealth();
    expect(lives().meter).toBe("github (signed in as octo; not reachable just now)");

    answer = { state: "rejected" };
    await signIns.checkHealth();
    expect(lives().meter).toBe("github (GitHub no longer accepts the sign-in)");
    // The sign-in never rides the context.
    expect(agent.buildContextBlock()).not.toContain("gho_test");
  });

  // INF-567, the captain's words: "hmm this is because we set this up on my
  // macbook? pass this evidence back to first mate and ask it to figure out
  // how to handle this kind of local inconsistencies". His approved plan: the
  // first mate's context names, for each project, the computer keeping its
  // folder and where its tasks run.
  it("names the computer keeping each project's folder and where its tasks run, once another computer runs work (INF-567)", async () => {
    const machines = {
      computers: () => ["mini"],
      nameOf: (id: string) => (id === "mini" ? "Kun's Mac mini" : id),
    } as unknown as CrewMachines;
    const adopt = async (repos: RepoRegistry, name: string) => {
      const dir = scratchDir(`infinitary-places-${name}-`);
      execFileSync("git", ["init", "--initial-branch=main", dir], { stdio: "pipe" });
      execFileSync(
        "git",
        ["-C", dir, "remote", "add", "origin", `https://github.com/octo/${name}.git`],
        {
          stdio: "pipe",
        },
      );
      return (await repos.setup({ kind: "adopt", path: dir, name })).repo;
    };
    const places = (agent: FirstmateAgent) =>
      Object.fromEntries(
        decodeContext(agent.buildContextBlock()).repos.map((repo) => [
          repo.name,
          { folder_on: repo.folder_on, tasks_run_on: repo.tasks_run_on },
        ]),
      );

    const { agent, repos } = setup({ machines });
    const business = await adopt(repos, "business");
    repos.setRunsOn(business.id, "mini");
    await adopt(repos, "meter");
    await repos.setup({ kind: "init", name: "kept-here" });
    expect(places(agent)).toEqual({
      business: { folder_on: HERE.this, tasks_run_on: "Kun's Mac mini" },
      meter: { folder_on: HERE.this, tasks_run_on: AUTOMATIC_WORD },
      "kept-here": { folder_on: HERE.this, tasks_run_on: HERE.this },
    });

    // With no other computer, where its tasks run cannot differ: nothing is said.
    const alone = setup();
    await adopt(alone.repos, "business");
    expect(places(alone.agent)).toEqual({
      business: { folder_on: undefined, tasks_run_on: undefined },
    });
  });

  it("fans orchestrator deltas out so Observe can follow Firstmate live", async () => {
    const { agent, session, events } = setup();
    await agent.converse("status?");
    session.emitDelta("Hel");
    expect(events).toContainEqual({
      type: "assistant_delta",
      taskId: "firstmate",
      text: "Hel",
    });
    session.emitTurnEnd("Hello.");
    session.resolveNextPrompt();
    await tick();
    expect(events).toContainEqual({ type: "turn_end", taskId: "firstmate" });
  });

  it("steers the session when the user speaks mid-turn", async () => {
    const { agent, session } = setup();
    await agent.converse("first");
    await agent.converse("actually, second");
    expect(session.prompts).toHaveLength(1);
    expect(session.steers).toHaveLength(1);
    expect(session.steers[0]).toContain("actually, second");
    session.resolveNextPrompt();
    await tick();
  });

  it("mentions the on-screen card as a maybe in the context block", async () => {
    const { agent, session, supervisor, events } = setup();
    supervisor.addFirstmateCard({
      title: "Quota",
      body: "You are on pace this week.",
      actions: [],
    });
    const card = supervisor.cards.snapshot()[0];
    expect(card).toBeDefined();
    await agent.converse({ text: "hello there", visibleCardId: card?.id });
    expect(session.prompts).toHaveLength(1);
    const turn = session.prompts[0] as string;
    expect(decodeContext(turn).visible_card_hint).toBe(
      `maybe on screen, a hint only, not necessarily the topic: card ${card?.id} (note) "Quota": You are on pace this week.`,
    );
    expect(turn).toContain("[user]\nhello there");
    const userPart = turn.split("[user]\n")[1];
    expect(userPart).toBe("hello there");
    expect(events).toContainEqual({ type: "user_turn", text: "hello there" });
  });

  it("does not reject an already accepted ask when its introductory witness cannot be saved", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = setup({
      onCaptainTurnAccepted: () => {
        throw new Error("stamp storage failed");
      },
    });
    await f.agent.converse("Do the task");
    expect(f.tasks.capture.listAsks()).toHaveLength(1);
    expect(f.session.prompts).toHaveLength(1);
    f.session.emitTurnEnd("Ready.");
    f.session.resolveNextPrompt();
    await vi.waitFor(() => expect(f.agent.isBusy()).toBe(false));
    f.agent.dispose();
    f.db.close();
  });

  it("preflights the initial Auto model without opening a session and preserves a missing explicit pin", async () => {
    const f = setup();
    const initial = f.agent.preflightModel();
    expect(initial).toEqual({ provider: "fm-mock", id: "mock-1" });
    expect(f.settings.getFirstmateModel()).toEqual(initial);
    f.settings.setFirstmateModel({ provider: "openrouter", id: "unavailable-pin" });
    expect(f.agent.preflightModel()).toEqual({ provider: "openrouter", id: "unavailable-pin" });
    expect(f.specs).toEqual([]);
    // Await the supervisor's boot microtask before retiring its database.
    await Promise.resolve();
    f.agent.dispose();
    f.db.close();
  });

  it("accepts main input and recorded Firstmate-note replies before session work, serving the note's identity/content", async () => {
    const accepted = vi.fn();
    const f = setup({ onCaptainTurnAccepted: accepted });
    const body = "<p>An approved introduction.</p>";
    const id = f.supervisor.cards.addRecordedFirstmateNote(
      { title: "Welcome aboard", body },
      (cardId) => {
        f.settings.setFirstRun({
          welcomedAt: 1000,
          firstTurnAt: null,
          welcomeState: "consumed",
          welcomeCardId: cardId,
        });
      },
    );
    expect(f.specs).toEqual([]);
    expect(decodeContext(f.agent.buildContextBlock()).introduction).toEqual({
      card_id: id,
      title: "Welcome aboard",
      body,
      already_created: true,
    });
    await f.agent.converse("   ");
    expect(accepted).not.toHaveBeenCalled();
    const main = f.agent.converse("Start here");
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(f.tasks.capture.listAsks()).toHaveLength(1);
    await main;
    f.session.emitTurnEnd("Ready.");
    f.session.resolveNextPrompt();
    await vi.waitFor(() => expect(f.agent.isBusy()).toBe(false));
    f.supervisor.replyToCard(id, "Where should I begin?");
    expect(accepted).toHaveBeenCalledTimes(2);
    await drained(f.session, 2);
    expect(decodeContext(f.session.prompts[1] as string).about).toContain(id);
    f.session.emitTurnEnd("Choose a project.");
    f.session.resolveNextPrompt();
    await vi.waitFor(() =>
      expect(f.supervisor.cards.thread(id).messages.at(-1)?.text).toBe("Choose a project."),
    );
    f.agent.dispose();
    f.db.close();
  });

  it("refuses a reply to a recorded note that takes none, the welcome, before any turn", async () => {
    const accepted = vi.fn();
    const f = setup({ onCaptainTurnAccepted: accepted });
    const id = f.supervisor.cards.addRecordedFirstmateNote(
      { title: "Welcome aboard", body: "<p>An approved introduction.</p>" },
      () => {},
      { replies: false },
    );
    expect(f.supervisor.cards.snapshot().find((card) => card.id === id)?.replies).toBe(false);
    expect(() => f.supervisor.replyToCard(id, "Where should I begin?")).toThrow("takes no reply");
    expect(accepted).not.toHaveBeenCalled();
    expect(f.supervisor.cards.thread(id).messages).toEqual([]);
    expect(f.tasks.capture.listAsks()).toEqual([]);
    expect(f.specs).toEqual([]);
    // Await the supervisor's boot microtask before retiring its database.
    await Promise.resolve();
    f.agent.dispose();
    f.db.close();
  });

  it("tells the turn which project the captain's window is focused on, as a hint (INF-1091)", async () => {
    const { agent, session, tasks } = setup();
    const scratch = tasks.projects.scratch();
    void agent.converse({ text: "fix the typo on the pricing page", focusedProjectId: scratch.id });
    await drained(session, 1);
    expect(decodeContext(session.prompts[0] as string).focused_project).toBe(
      `${scratch.key} "${scratch.name}" - the captain's window is focused on this project, so new work they ask for belongs to it unless they name another; a hint, never a limit`,
    );
  });

  it("INF-1137 serves required-action repair guidance only on that card's reply turn", async () => {
    const f = setup();
    seedTask(f.tasks, { id: "action-source", title: "Update setup", status: "completed" });
    f.tasks.delivery.declareRequiredActions(
      "action-source",
      {
        cardId: "card-source",
        offerId: "offer-source",
        actions: [
          {
            id: "rebuild",
            title: "Rebuild the setup",
            target: "the computer",
            consequence: "The old setup is still running.",
            instructions: ["Rebuild the updated setup."],
            criterion: "The rebuild succeeds.",
            prerequisites: [],
            completion: { kind: "manual", label: "It succeeded" },
          },
        ],
      },
      true,
    );
    const action = f.tasks.listOpen().find((task) => task.delivery?.captainAction);
    expect(action).toBeDefined();
    f.supervisor.cards.presentRequiredAction(action?.id ?? "missing");
    const cardId = action?.delivery?.captainAction?.cardId;
    const about = decodeContext(f.agent.buildContextBlock(undefined, undefined, cardId)).about;
    expect(about).toContain(`required captain action task_id ${action?.id}`);
    expect(about).toContain("Answer with emit_card using this same id, task_id and reply");
    expect(decodeContext(f.agent.buildContextBlock()).about).toBeUndefined();
    await Promise.resolve();
    f.agent.dispose();
    f.db.close();
  });

  it("treats a reply on its own card as a captain turn about that card", async () => {
    const { session, supervisor } = setup();
    supervisor.addFirstmateCard({
      title: "Pick one",
      body: "<p>A or B.</p>",
      actions: [{ id: "a", label: "A", default: true }],
    });
    const card = supervisor.cards.snapshot()[0];
    expect(card).toBeDefined();
    supervisor.replyToCard(card?.id ?? "", "the second option is wrong");
    await drained(session, 1);
    const turn = session.prompts[0] as string;
    const asked = supervisor.cards.thread(card?.id ?? "").messages[0]?.id;
    expect(decodeContext(turn).about).toBe(
      `about: card ${card?.id} (decision) "Pick one" - the captain replied in its thread as message ${asked}; answer it with an emit_card reply on this id naming answers_message ${asked}, since your closing words alone leave it open`,
    );
    expect(turn).not.toContain("maybe on screen");
    expect(turn).toContain("[user]\nthe second option is wrong");
    session.emitTurnEnd("Kept the retry.");
    session.resolveNextPrompt();
    await vi.waitFor(() =>
      expect(
        supervisor.cards.thread(card?.id ?? "").messages.map((message) => ({
          who: message.who,
          text: message.text,
        })),
      ).toEqual([
        { who: "captain", text: "the second option is wrong" },
        { who: "firstmate", text: "Kept the retry." },
      ]),
    );
    // The closing words name no message: the captain's question stays open
    // (the captain's "Only a line that says it answers it; a handoff stays open").
    expect(supervisor.cards.snapshot().find((one) => one.id === card?.id)?.awaiting).toBe("answer");
  });

  /**
   * The design's case D (`card-fm-6-84f4c7`, "What Default means for Care",
   * 24 Sep), replayed against the one rule: a captain reply on the
   * Firstmate's own card holds it, still shown in its place, until the
   * Firstmate's turn ends having answered (INF-770). A write mid-turn - here the
   * delegation the persona now asks for, said on the card - does not redraw
   * it, and as a handoff it answers nothing, so the card stays held past that
   * turn's end (the captain's "Only a line that says it answers it; a handoff
   * stays open"). The answer the crewmate's research brings names the
   * question and revises the same card in place instead of arriving as a new
   * one.
   */
  it("D: a reply on its own card stays held through the handoff, and the delegated answer redraws it in place", async () => {
    const { session, supervisor, specs } = setup();
    const cardId = supervisor.addFirstmateCard({
      title: "What Default means for Care",
      body: "<p>Default is the care every project starts with.</p>",
      actions: [],
    });
    // The card as the stage draws it once its author has answered.
    const shown = () =>
      supervisor.cards
        .snapshot()
        .find((card) => card.id === cardId && onStage(card) && !card.awaiting);
    expect(shown()).toBeDefined();

    supervisor.replyToCard(cardId, "what are the rules?");
    await drained(session, 1);
    expect(shown()).toBeUndefined();
    const waiting = supervisor.cards.snapshot().find((card) => card.id === cardId);
    expect(waiting?.awaiting).toBe("answer");
    // Still on the stage, in its place, showing what it showed.
    expect(waiting && onStage(waiting)).toBe(true);
    expect(waiting?.body).toContain("Default is the care every project starts with");

    const emit = toolsOf(specs).get("emit_card");
    const revision = {
      id: cardId,
      title: "What Default means for Care",
      body: "<p>A crewmate is checking the exact rules that choose Default.</p><p>This card changes when it answers.</p>",
      standalone: true,
    };
    // An update alone does not answer him: refused, thread unchanged.
    await expect(emit?.execute("c0", revision)).rejects.toThrow(/waits on your answer/);
    expect(supervisor.cards.thread(cardId).messages.map((message) => message.who)).toEqual([
      "captain",
    ]);
    await emit?.execute("c1", { ...revision, reply: "A crewmate is checking the exact rules." });
    expect(shown()).toBeUndefined();

    session.emitTurnEnd("Asked a crewmate for the exact rules.");
    session.resolveNextPrompt();
    // Its own reply after the revised line is its line, so the closing words
    // are not a second one, and the handoff left the question open.
    await vi.waitFor(() =>
      expect(supervisor.cards.thread(cardId).messages.map((message) => message.who)).toEqual([
        "captain",
        "host",
        "firstmate",
      ]),
    );
    const held = supervisor.cards.snapshot().find((card) => card.id === cardId);
    expect(held?.awaiting).toBe("answer");
    expect(held?.body).toContain("Default is the care every project starts with");

    // The research lands and the same card carries it, naming the question,
    // and the turn's end redraws it on the stage.
    const asked = supervisor.cards.thread(cardId).messages[0]?.id;
    await emit?.execute("c2", {
      id: cardId,
      title: "How Default Care is chosen",
      body: "<p>Default is standard care unless the project sets its own.</p><p>A task's own words can ask for more.</p>",
      standalone: true,
      reply: "Default is standard care unless the project sets its own.",
      answers_message: asked,
    });
    expect(shown()).toBeUndefined();
    // The turn that carried the research ends: its close-out.
    supervisor.cards.closeOut({ kind: "firstmate" }, "turn-end");
    expect(shown()?.title).toBe("How Default Care is chosen");
    expect(supervisor.cards.snapshot().filter((card) => card.author === "firstmate")).toHaveLength(
      1,
    );
  });

  it("takes its closing words as its line under a card reply it read mid-turn", async () => {
    const { agent, session, supervisor } = setup();
    const cardId = supervisor.addFirstmateCard({
      title: "Pick one",
      body: "<p>A or B.</p>",
      actions: [{ id: "a", label: "A", default: true }],
    });
    await agent.converse("status?");
    supervisor.replyToCard(cardId, "why A?");
    await vi.waitFor(() => expect(session.steers).toHaveLength(1));
    expect(supervisor.cards.snapshot().find((card) => card.id === cardId)?.awaiting).toBe("answer");

    session.emitTurnEnd("A keeps the queue in order.");
    session.resolveNextPrompt();
    await vi.waitFor(() =>
      expect(supervisor.cards.thread(cardId).messages.map((message) => message.text)).toEqual([
        "why A?",
        "A keeps the queue in order.",
      ]),
    );
    expect(
      supervisor.cards.snapshot().find((card) => card.id === cardId && onStage(card)),
    ).toBeDefined();
  });

  it("labels thread activity by what each card waits on now, never by who wrote last (FI3-359)", async () => {
    const { agent, session, supervisor, crewSpecs } = setup({
      seedTasks: [
        { id: "t1", title: "Explain the queue", status: "idle" },
        { id: "t2", title: "Plan the move", status: "idle" },
      ],
      seedCards: [
        crewCard("card-t1-1", "t1", "Queue order", "<p>a</p>"),
        crewCard("card-t2-1", "t2", "Old plan", "<p>b</p>"),
      ],
    });
    const { taskId } = await supervisor.intake.commission({
      title: "Preview the layout",
      intent: { goal: "preview the layout", userWords: "preview the layout" },
    });
    await vi.waitFor(() => expect(crewSpecs).toHaveLength(1));
    const preview = { title: "Preview", body: "<p>A or B.</p>", actions: [] };
    await crewSpecs[0]?.callbacks?.onCard?.(preview);
    const cardId = supervisor.cards.openCardsFor(taskId)[0]?.id ?? "";
    // FI3-347's path: the captain's words, then the card withdrawn and raised
    // again under its id - a new lifecycle that owes them nothing.
    supervisor.replyToCard(cardId, "build it");
    supervisor.closeCard(cardId, { kind: "crewmate", taskId }, "recover the settings");
    await crewSpecs[0]?.callbacks?.onCard?.({ ...preview, id: cardId, title: "Settings kept" });
    // The newest line on each of these threads is the captain's too.
    supervisor.replyToCard("card-t1-1", "what about X?");
    supervisor.replyToCard("card-t2-1", "never mind");
    // INF-1879: a pending note stays owed when put away; its author explicitly withdraws this closed-history fixture.
    supervisor.closeCard(
      "card-t2-1",
      { kind: "crewmate", taskId: "t2" },
      "The old plan is withdrawn",
    );

    await agent.converse("anything new?");
    const lines = decodeContext(session.prompts.at(-1) as string).thread_activity ?? [];
    expect(lines[0]).toMatch(/^thread activity since your last turn/);
    const line = (id: string) => lines.find((entry) => entry.startsWith(`- card ${id} `));
    expect(line(cardId)).toMatch(/last from captain .* - "build it" \(no answer owed\)$/);
    expect(line("card-t1-1")).toMatch(
      /last from captain .* - "what about X\?" \(awaiting the author\)$/,
    );
    expect(line("card-t2-1")).toMatch(
      /last from captain .* - "never mind" \(card closed, no answer owed\)$/,
    );
  });

  it("labels a reply the Firstmate itself owes as its own, on a done task's note and its own card", async () => {
    const { session, supervisor, tasks } = setup({
      seedTasks: [{ id: "t58", title: "Ship the release", status: "idle" }],
      seedCards: [crewCard("card-t58-1", "t58", "Release shipped", "It is out.")],
    });
    const line = (prompt: number, id: string) =>
      (decodeContext(session.prompts[prompt] as string).thread_activity ?? []).find((entry) =>
        entry.startsWith(`- card ${id} `),
      );
    tasks.close("t58", { status: "done", reason: "merged", actor: "host" });
    supervisor.replyToCard("card-t58-1", "which version?");
    await drained(session, 1);
    expect(line(0, "card-t58-1")).toMatch(/"which version\?" \(awaiting your answer\)$/);
    session.emitTurnEnd("It shipped as 0.2.");
    session.resolveNextPrompt();

    const own = supervisor.addFirstmateCard({
      title: "Pick one",
      body: "<p>A or B.</p>",
      actions: [{ id: "a", label: "A", default: true }],
    });
    supervisor.replyToCard(own, "why A?");
    await drained(session, 2);
    expect(line(1, own)).toMatch(/"why A\?" \(awaiting your answer\)$/);
    // Its closing words name no message: the note's question is still its own to answer.
    expect(line(1, "card-t58-1")).toMatch(
      /last from firstmate .* - "It shipped as 0\.2\." \(awaiting your answer\)$/,
    );
  });

  it("tells the turn which closed card the captain is reading, as history", async () => {
    const { agent, session, supervisor, tasks } = setup();
    supervisor.addFirstmateCard({
      title: "Old plan",
      body: "<p>The plan.</p>",
      actions: [{ id: "go", label: "Go", default: true }],
    });
    const card = supervisor.cards.snapshot()[0];
    expect(card).toBeDefined();
    // INF-1879: only the question's explicit Dismiss creates dismissed history.
    const question = seedTask(tasks, {
      id: "old-plan-question",
      title: "Old plan",
      kind: "decision",
      status: "queued",
      gate: { kind: "captain", reason: "Choose the plan", ref: card!.id },
    });
    expect(supervisor.runTaskOp(question.id, "dismiss-question")).toBeUndefined();
    expect(supervisor.cards.snapshot()).toHaveLength(0);
    await agent.converse({ text: "build this plan again", pastCardId: card?.id });
    const turn = session.prompts[0] as string;
    expect(decodeContext(turn).about).toBe(
      `past card ${card?.id} "Old plan" (Closed without choosing) - the captain is reading it as history; it is closed and nothing on it can be clicked, so any change comes through your tools`,
    );
    expect(turn.split("[user]\n")[1]).toBe("build this plan again");
  });

  // INF-500: a body script's choice read as the captain's in the turn context.
  it("tells the turn a closed card's script choice was its author's, never the captain's", async () => {
    const { agent, session, supervisor } = setup();
    const id = supervisor.addFirstmateCard({
      title: "Read the harbour chart",
      body: "<p>The survey is ready.</p>",
      actions: [{ id: "keep", label: "Keep this chart", default: true }],
    });
    supervisor.act(id, "keep", "frame");
    await drained(session, 1);
    session.emitTurnEnd("Kept the chart.");
    session.resolveNextPrompt();
    expect(supervisor.cards.past(id)?.ending).toMatchObject({ how: "chose", by: "frame" });
    await agent.converse({ text: "why was this kept?", pastCardId: id });
    expect(decodeContext(session.prompts.at(-1) as string).about).toMatch(
      new RegExp(
        `^past card ${id} "Read the harbour chart" \\(Your first mate chose Keep this chart\\) - `,
      ),
    );
  });

  it("ignores a pastCardId that was never saved", async () => {
    const { agent, session } = setup();
    await agent.converse({ text: "hello there", pastCardId: "card-gone" });
    expect(decodeContext(session.prompts[0] as string).about).toBeUndefined();
  });

  it("ignores a visibleCardId that is not on the stack", async () => {
    const { agent, session } = setup();
    await agent.converse({ text: "hello there", visibleCardId: "card-gone" });
    const turn = session.prompts[0] as string;
    expect(turn).not.toContain("maybe on screen");
    expect(turn.split("[user]\n")[1]).toBe("hello there");
  });

  it("omits a preview body from the maybe-card line", async () => {
    const { agent, session, supervisor } = setup();
    // A preview is markup, not copy, so the line stops at the title - keyed
    // off the body's shape now that the live-prototype kind is retired.
    supervisor.addFirstmateCard({
      title: "Preview",
      body: '<div class="inf-row">secret markup</div><script>draw();</script>',
      actions: [{ id: "hold", label: "Hold", default: true }],
    });
    const card = supervisor.cards.snapshot()[0];
    await agent.converse({ text: "looks good", visibleCardId: card?.id });
    const turn = session.prompts[0] as string;
    expect(decodeContext(turn).visible_card_hint).toBe(
      `maybe on screen, a hint only, not necessarily the topic: card ${card?.id} (decision) "Preview"`,
    );
    expect(turn).not.toContain("secret markup");
    expect(turn).not.toContain("<div");
    expect(turn.split("[user]\n")[1]).toBe("looks good");
  });

  it("broadcasts user_turn when steering a busy session", async () => {
    const { agent, events } = setup();
    await agent.converse("first");
    await agent.converse("actually, second");
    expect(events.filter((event) => event.type === "user_turn")).toEqual([
      { type: "user_turn", text: "first" },
      { type: "user_turn", text: "actually, second" },
    ]);
  });

  it("does not broadcast user_turn on empty submit", async () => {
    const { agent, events } = setup();
    await agent.converse("   ");
    await agent.converse({ text: "" });
    expect(events.filter((event) => event.type === "user_turn")).toHaveLength(0);
  });

  it("broadcasts user_turn for an image-only submit", async () => {
    const { agent, events } = setup();
    await agent.converse({ images: [pngImage] });
    expect(events).toContainEqual({ type: "user_turn", text: "" });
  });

  it("carries pasted images beside the turn text, on prompts and steers alike", async () => {
    const { agent, session } = setup();
    const shot = jpegImage;
    await agent.converse({ text: "what is this dialog?", images: [shot] });
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain("[user]\nwhat is this dialog?");
    expect(session.promptImages[0]).toEqual([shot]);

    // Mid-turn, an image-only paste steers with its attachment intact.
    const followUp = pngImage;
    await agent.converse({ images: [followUp] });
    expect(session.steers).toHaveLength(1);
    expect(session.steers[0]).toContain("[user]");
    expect(session.steerImages[0]).toEqual([followUp]);
    session.resolveNextPrompt();
    await tick();
  });
});
