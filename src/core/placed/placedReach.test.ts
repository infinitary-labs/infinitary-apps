import { existsSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@shared/ipc";
import type { PlacedEventRecord, PlacedSpec } from "@shared/work";
import { describe, expect, it, vi } from "vitest";
import {
  adoptHere,
  api,
  connectingNow,
  gate,
  gitProject,
  kinds,
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
import { PlacedTasks } from "../helper/placedTasks";
import { crewmateRenewedNote } from "../orchestrator/crewSession";
import { QUIET_CARD_MS, UNHEARD_END_NOTE } from "../orchestrator/crewSupervisor";
import { renderWake } from "../orchestrator/wakes";
import { crewmatePlacedDir } from "../paths";
import { CREWMATE_TOOLS } from "../pi/crewmateTaskTools";
import { answeredReadText } from "../session/openReads";

/**
 * A task that runs on a computer that runs work (`tests/helpers/placedWorld.ts`):
 * its computer going out of reach and coming back, restarts on either side, and the twenty-minute check.
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

describe("a task that runs on a computer that runs work", () => {
  it("keeps the captain's reply waiting after a still-working line from that computer, as it does here (INF-1623)", async () => {
    // INF-1595's exchange: the crewmate there said what it was checking,
    // marked as still working, and the mark was lost on the way home, so
    // that line ended the captain's wait.
    const at = await world();
    const home = at.home();
    model([
      {
        tools: [
          {
            name: "emit_card",
            args: {
              id: "retire-plan",
              title: "Retire a closed task's working copy",
              body: "<p>I retire the copy once its task closes.</p>",
            },
          },
        ],
      },
      { text: "The card is up." },
    ]);
    await at.start("t-interim");
    await expect.poll(() => home.cards().find((card) => card.taskId === "t-interim")).toBeTruthy();
    const card = home.cards().find((card) => card.taskId === "t-interim");
    if (!card) throw new Error("No card from t-interim");
    await expect.poll(() => home.tasks.get("t-interim")?.activity).toBe("idle");
    model([
      {
        tools: [
          {
            name: "reply",
            args: {
              card_id: card.id,
              text: "Checking how this change meets the warm pool of ready working copies before I answer.",
              interim: true,
            },
          },
        ],
      },
      { text: "Checking." },
    ]);
    const requests = api.requests.length;
    home.supervisor.replyToCard(
      card.id,
      "wait - do you mean worktrees? aren't we supposed to keep warm worktrees?",
    );
    await expect.poll(() => api.requests.length).toBe(requests + 2);
    await expect.poll(() => home.tasks.get("t-interim")?.activity).toBe("idle");
    expect(JSON.stringify(api.requests.at(-1)?.body)).toContain(
      "still waits for your answer when the work is done",
    );
    expect(home.cards().find((shown) => shown.id === card.id)?.awaiting).toBe("answer");
  });

  it("holds the task out of reach while the connection is gone, and catches up exactly once it is back", async () => {
    const at = await world();
    const slow = gate();
    model([
      { held: slow.held, text: "The footer is fixed after a wait." },
      { text: "The footer is blue now." },
    ]);
    const requests = api.requests.length;
    await at.start("t-drop");
    await expect.poll(() => api.openRequests()).toBe(1);
    const home = at.home();
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);

    // The Tasks row says it is out of reach; while its connection is being
    // made it says connecting instead, with no warn mark (INF-49).
    const dropped = home.tasks.get("t-drop");
    if (!dropped) throw new Error("no task");
    expect(home.supervisor.taskPlace(dropped)).toMatchObject({ reach: "out-of-reach" });
    connectingNow.add(at.deviceId);
    const connectingPlace = home.supervisor.taskPlace(dropped);
    connectingNow.clear();
    // Protocol 9 carries only the core reach reading.
    expect(connectingPlace).toMatchObject({ reach: "connecting" });

    // Out of reach: words wait on its lane, nothing calls it stuck, and after
    // a minute the feed says so once.
    expect(await home.supervisor.steerCrewmate("t-drop", "Make it blue too.")).toBe(
      "recorded-held",
    );
    const before = kinds(home, "t-drop").length;
    home.supervisor.checkQuietTasks(now() + 3 * 60 * 60 * 1000);
    expect(kinds(home, "t-drop").slice(before)).not.toContain("note");
    const lines = () =>
      home.events.flatMap((event) => (event.type === "firstmate_note" ? [event.text] : []));
    // While its connection is still being made the line is held, not said as out of reach.
    connectingNow.add(at.deviceId);
    home.placed.tick(now() + 61_000);
    expect(lines().filter((line) => line.includes("out of reach"))).toEqual([]);
    connectingNow.clear();
    home.placed.tick(now() + 61_000);
    home.placed.tick(now() + 120_000);
    expect(lines().filter((line) => line.includes("out of reach"))).toEqual([
      "Mac mini is out of reach. Its work on website catches up here when it is back.",
    ]);

    // The turn goes on there and ends while the home cannot hear it.
    slow.open();
    await expect.poll(() => api.openRequests()).toBe(0);
    expect(home.tasks.get("t-drop")?.activity).toBe("running");

    await home.listen();
    await expect.poll(() => home.tasks.get("t-drop")?.outcome).toBe("The footer is blue now.");
    // Caught up exactly: the first turn's end, then the held words as the next turn, each once.
    expect(api.requests.length - requests).toBe(2);
    expect(said(api.requests.at(-1))).toContain("Make it blue too.");
    expect(home.inbox.allFor("t-drop")).toEqual([]);
    expect(lines()).toContain("Mac mini is back. Its work on website caught up.");
  });

  it("never says the work of a computer that runs work for another Firstmate now catches up when it is back", async () => {
    let left = false;
    const at = await world(undefined, { runsForAnotherFirstmate: () => left });
    model([{ text: "Waiting for review." }]);
    await at.start("t-left");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-left")?.activity).toBe("idle");

    // It left this Firstmate for another one, and this Mac's SSH connection found that.
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    left = true;
    home.placed.tick(now() + 61_000);
    home.placed.tick(now() + 120_000);
    const lines = home.events.flatMap((event) =>
      event.type === "firstmate_note" && event.text.startsWith("Mac mini") ? [event.text] : [],
    );
    expect(lines).toEqual([
      "Mac mini runs work for another first mate now. Its work on website stops when you remove it here.",
    ]);
  });

  it("never nudges, wakes about or calls stuck an idle task whose computer is out of reach", async () => {
    const at = await world();
    model([{ text: "Waiting for review." }]);
    await at.start("t-idle");
    const home = at.home();
    await expect.poll(() => home.tasks.get("t-idle")?.activity).toBe("idle");
    await home.drop();
    await expect.poll(() => home.devices.inReach(at.deviceId)).toBe(false);
    const wakes = home.wakes.length;
    // Hours of its idle clock pass while that computer is gone.
    for (const hours of [1, 2, 3]) home.supervisor.reconcileIdle(now() + hours * 60 * 60 * 1000);
    expect(home.inbox.allFor("t-idle")).toEqual([]);
    expect(home.wakes.slice(wakes)).toEqual([]);
    expect(home.tasks.get("t-idle")?.recoveryRung ?? 0).toBe(0);
  });

  it("INF-2214 keeps a remote requested answer through a home restart and later progress, with one notification", async () => {
    const at = await world();
    const slow = gate();
    model([{ held: slow.held, text: "Still checking the remover." }, { text: "Checks finished." }]);
    const taskId = "t-path-response";
    await at.start(taskId, "Find the remover path.");
    await expect.poll(() => api.openRequests()).toBe(1);
    await at
      .home()
      .supervisor.steerCrewmate(
        taskId,
        "What is the full path to setup/shell-pc/shell-pc-job-host-remove.cmd?",
        "firstmate",
        { response: { mode: "expected" } },
      );
    const request = at.home().inbox.pendingResponses(taskId)[0]!;
    const text = "C:\\FleetCheckSetup\\shell-pc-job-host-remove.cmd";
    const submitted = {
      task: taskId,
      callId: "path-response",
      text,
      declared: {
        responses: [
          { requestId: request.id, responseId: "remote-path-answer", status: "answered" as const },
        ],
      },
    };
    await at.home().placed.answer(at.deviceId, "inf:work:report", submitted);
    const saved = at.home().inbox.savedResponse("remote-path-answer")!;
    expect(saved.text).toBe(text);
    expect(at.home().inbox.get(saved.wakeId)?.facts).toMatchObject({
      kind: "requested-response",
      contributorTask: taskId,
      excerpt: text,
    });
    await at.home().placed.answer(at.deviceId, "inf:work:report", {
      task: taskId,
      callId: "later-progress",
      text: "The checks are still running.",
    });
    await at.restartHome();
    await at.inReach(taskId);
    expect(at.home().inbox.savedResponse("remote-path-answer")).toEqual(saved);
    await at.home().placed.answer(at.deviceId, "inf:work:report", submitted);
    expect(
      at
        .home()
        .inbox.allFor("firstmate")
        .filter((row) => row.facts?.kind === "requested-response"),
    ).toHaveLength(1);
    slow.open();
    await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
    expect(at.home().inbox.savedResponse("remote-path-answer")?.text).toBe(text);
    expect(
      at
        .home()
        .inbox.allFor("firstmate")
        .filter((row) => row.facts?.kind === "response-missing"),
    ).toEqual([]);
  });

  it("follows a turn a home restart left running there, with no second prompt, and keeps the report it already gave", async () => {
    const at = await world();
    const slow = gate();
    model([
      { tools: [{ name: "report", args: { text: "Reported before the restart." } }] },
      { held: slow.held, text: "Still finishing." },
    ]);
    const requests = api.requests.length;
    await at.start("t-restart");
    // The report is answered here, and the turn goes on there.
    await expect
      .poll(() => existsSync(join(crewmatePlacedDir(at.home().paths, "t-restart"), "calls.jsonl")))
      .toBe(true);
    await expect.poll(() => api.openRequests()).toBe(1);

    await at.restartHome();
    const home = at.home();
    // The restart did not mark it interrupted: the turn there is followed here.
    await expect.poll(() => home.tasks.get("t-restart")?.activity).toBe("running");
    await expect.poll(() => home.placed.ready(at.deviceId, "t-restart")).toBe(true);

    slow.open();
    await expect.poll(() => home.tasks.get("t-restart")?.activity).toBe("idle");
    expect(home.tasks.get("t-restart")?.outcome).toBe("Reported before the restart.");
    // One brief, asked of the model once: no turn ran twice.
    expect(api.requests.length - requests).toBe(2);
    expect(home.inbox.inFlight("t-restart")).toEqual([]);
    expect(home.inbox.allFor("t-restart")).toEqual([]);
  });

  // Captain's INF-352 W1: the helper owns the ending of a continuation its restart cut off.
  it.each(["copy-loop", "home-turn"] as const)(
    "ends a Claude continuation after a helper restart: %s",
    async (check) => {
      const scheduled = new Set<{ due: number; run: () => void }>();
      const heldCall = gate();
      const claude = await scriptedClaudeWorld({ beforeToolRecord: () => heldCall.held });
      stops.push(scriptedClaudeCleanup);
      const at = await world(undefined, {
        claude,
        scheduleCopy: (ms, run) => {
          const timer = { due: now() + ms, run };
          scheduled.add(timer);
          return () => {
            scheduled.delete(timer);
          };
        },
      });
      const home = at.home();
      const ask = home.devices.ask.bind(home.devices);
      let copies = 0;
      let copying = 0;
      const sent = vi
        .spyOn(home.devices, "ask")
        .mockImplementation(async (device, channel, args) => {
          if (channel === "inf:session:copy") copying += 1;
          try {
            const answer = await ask(device, channel, args);
            if (channel === "inf:session:copy") copies += 1;
            return answer;
          } finally {
            if (channel === "inf:session:copy") copying -= 1;
          }
        });
      const fireNext = () => {
        const timer = scheduled.values().next().value;
        if (!timer) return;
        scheduled.delete(timer);
        ahead += Math.max(0, timer.due - now());
        timer.run();
      };
      const taskId = "t-continuation-restart";
      claude.answer({ text: "The background check started." });
      try {
        await at.start(taskId);
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        claude.answer({ tool: "note_progress", answer: "Not reached while held." });
        claude.continueTurn();
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("running");
        await expect
          .poll(() =>
            home.events.some((event) => event.type === "tool_start" && event.taskId === taskId),
          )
          .toBe(true);
        const before = copies;
        await expect
          .poll(() => {
            fireNext();
            return copies;
          })
          .toBeGreaterThan(before);
        await at.restartComputer();
        await at.inReach(taskId);
        if (check === "home-turn") {
          await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
          const failure = home.wakes.find((wake) => wake.facts?.kind === "turn-failed");
          const computer = at
            .pairing()
            .list()
            .find((device) => device.id === at.deviceId);
          expect(computer).toBeDefined();
          expect(failure?.facts).toMatchObject({
            error: `${computer?.name} quit before this turn finished.`,
          });
        } else {
          await expect
            .poll(async () => {
              fireNext();
              await new Promise<void>((resolve) => setImmediate(resolve));
              return scheduled.size === 0 && copying === 0;
            })
            .toBe(true);
        }
      } finally {
        claude.endClient();
        heldCall.open();
        sent.mockRestore();
      }
    },
  );

  // INF-2332, FIRS-6: a Claude crewmate carried on by itself on the Mac mini
  // while the home was away, and its report waited for the home. The home came
  // back with updated instructions, the Mac mini closed that conversation for
  // them, the report was lost and the task showed working for a day. Now the
  // computer keeps the turn - a carried-on one, or a prompt's - and the home
  // asks again once it ends, so the conversation starts over for the new
  // instructions as INF-296 carries one: the record names it, the timeline
  // says why, and the next turn hears its brief and earlier transcript.
  it.each(["carried-on", "prompt"] as const)(
    "keeps a %s turn through the home's return with new instructions, so its report arrives and the task leaves working with no stop, then starts over for them once it ends (INF-2332, FIRS-6)",
    async (turn) => {
      const claude = await scriptedClaudeWorld();
      stops.push(scriptedClaudeCleanup);
      const at = await world(undefined, { claude });
      const taskId = `t-firs6-${turn}`;
      const reported = "All 29 tests passed.";
      const told = (type: string, tool?: string) =>
        new PlacedTasks(at.dataDir)
          .outbox(taskId, 0)
          .some(
            ({ event }) =>
              event.type === type &&
              (tool === undefined || ("toolName" in event && event.toolName === tool)),
          );
      const report = { tool: "report" as const, args: { text: reported }, answer: "Reported." };
      try {
        // The home stops answering the report, as one out of reach does.
        let waiting: { mockRestore(): void; mock: { calls: unknown[][] } } | undefined;
        const holdReports = () => {
          const away = at.home();
          const answer = away.placed.answer.bind(away.placed);
          waiting = vi
            .spyOn(away.placed, "answer")
            .mockImplementation(((device, channel, request) =>
              channel === "inf:work:report"
                ? new Promise(() => {})
                : answer(device, channel, request)) as typeof away.placed.answer);
        };
        if (turn === "carried-on") {
          claude.answer({ text: "Running 29 tests; I will check back in 30 minutes." });
          await at.start(taskId);
          await expect.poll(() => at.home().tasks.get(taskId)?.activity).toBe("idle");
          // The tests finish, the crewmate carries on by itself there and
          // calls report, which waits.
          holdReports();
          claude.answer(report);
          claude.continueTurn();
        } else {
          holdReports();
          claude.answer(report);
          await at.start(taskId, "Run the 29 tests and report them.");
        }
        await expect.poll(() => told("tool_start", "report")).toBe(true);
        await expect
          .poll(() => waiting?.mock.calls.some(([, channel]) => channel === "inf:work:report"))
          .toBe(true);
        const earlier = at.home().tasks.get(taskId)?.sessionFile ?? "";
        expect(earlier).not.toBe("");
        const opens: PlacedSpec[] = [];
        await at.restartHome(
          () => {
            waiting?.mockRestore();
          },
          (home) => {
            // The home comes back updated: the instructions it opens with changed.
            const ask = home.devices.ask.bind(home.devices);
            vi.spyOn(home.devices, "ask").mockImplementation(async (device, channel, args) => {
              if (channel !== "inf:session:open") return ask(device, channel, args);
              const [open] = args as [{ spec: PlacedSpec }];
              const updated = open.spec.instructions.endsWith(" Updated.")
                ? open.spec.instructions
                : `${open.spec.instructions} Updated.`;
              const spec = { ...open.spec, instructions: updated };
              opens.push(spec);
              return ask(device, channel, [{ ...open, spec }]);
            });
          },
        );
        const home = at.home();
        await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe(reported);
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        if (turn === "carried-on") expect(told("continuation_ended")).toBe(true);
        expect(home.tasks.timeline(taskId).some((event) => event.kind === "failed")).toBe(false);
        expect(home.events.some((event) => event.type === "turn_failed")).toBe(false);

        // The turn over, the home asked again: the conversation started over
        // for the new instructions, and the home heard it.
        await expect.poll(() => opens.length).toBeGreaterThan(1);
        await expect.poll(() => home.tasks.get(taskId)?.sessionFile).not.toBe(earlier);
        const renewal = { from: earlier, changed: ["prompt" as const] };
        expect(
          home.tasks
            .timeline(taskId)
            .filter(
              (event) => event.kind === "note" && event.text === crewmateRenewedNote(renewal),
            ),
        ).toHaveLength(1);
        const asked = claude.served().length;
        claude.answer({ text: "Carrying on." });
        await home.supervisor.steerCrewmate(taskId, "Now the header.");
        await expect.poll(() => claude.served().length).toBeGreaterThan(asked);
        const said = claude.served().at(-1)?.said ?? "";
        expect(said).toContain(join(at.folders(taskId).sessions, `${earlier}.jsonl`));
        expect(said).toContain("Now the header.");
        expect(claude.served().at(-1)?.system).toContain("Updated.");
        // The open owed during the turn went again only once it ended, so no
        // answer read to the supervisor as its computer reopening mid-turn,
        // and the steer after it stopped no recovery.
        const recovery = home.tasks
          .timeline(taskId)
          .map((event) => (event.data?.restartOutcome as { outcome?: string } | undefined)?.outcome)
          .filter((outcome) => outcome !== undefined);
        expect(
          recovery.filter((outcome) => outcome === "waiting" || outcome === "stopped"),
        ).toEqual([]);
      } finally {
        claude.endClient();
      }
    },
  );

  // INF-2332: whether a turn is working comes from the live session on the
  // computer that runs it. A turn whose end never reaches the home ends here
  // as interrupted once that computer says it is not working with every event
  // in - when the computer comes back, after twenty quiet minutes, or right
  // after a stop - and the idle ladder takes the task from there.
  it.each(["return", "quiet", "stop"] as const)(
    "ends a turn whose end never arrived once its computer says it is not working: %s (INF-2332)",
    async (trigger) => {
      const claude = await scriptedClaudeWorld();
      stops.push(scriptedClaudeCleanup);
      const at = await world(undefined, { claude });
      const home = at.home();
      const taskId = `t-unheard-${trigger}`;
      // The end of the crewmate's carried-on turn is lost on its way home,
      // while every other event arrives, as FIRS-6's end never did.
      const answer = home.placed.answer.bind(home.placed);
      /** Whether the home has taken the events up to the one in place of the lost end. */
      let tookLostEnd = false;
      const lost = vi.spyOn(home.placed, "answer").mockImplementation(((
        device,
        channel,
        request,
      ) => {
        if (channel !== "inf:work:events") return answer(device, channel, request);
        const { events, ...rest } = request as { task: string; events: PlacedEventRecord[] };
        const losing = events.some(({ event }) => event.type === "continuation_ended");
        const taken = answer(device, channel, {
          ...rest,
          events: events.map((record) =>
            record.event.type === "continuation_ended"
              ? { ...record, event: { type: "request_started" } }
              : record,
          ),
        } as never);
        return losing
          ? taken.then((answered) => {
              tookLostEnd = true;
              return answered;
            })
          : taken;
      }) as typeof home.placed.answer);
      claude.answer({ text: "The background check started." });
      try {
        await at.start(taskId);
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        const wakes = home.wakes.length;
        claude.answer({ text: "The check is done." });
        claude.continueTurn();
        // The home took every event of the carried-on turn but its end: the
        // roster it read before the turn says nothing of these events.
        await expect.poll(() => tookLostEnd).toBe(true);
        // The computer is done, but the home never heard it.
        expect(home.tasks.get(taskId)?.activity).toBe("running");
        if (trigger === "return") {
          await at.stopComputer();
          await at.restartComputer();
          await at.inReach(taskId);
        } else if (trigger === "quiet") {
          home.supervisor.checkQuietTasks(now() + QUIET_CARD_MS);
        } else {
          await home.supervisor.interruptCrewmate(taskId, "interrupt");
        }
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        expect(home.tasks.timeline(taskId).map((event) => event.text)).toContain(UNHEARD_END_NOTE);
        // Ended as interrupted, never as a failure the first mate is woken for.
        expect(home.tasks.timeline(taskId).some((event) => event.kind === "failed")).toBe(false);
        expect(
          home.wakes
            .slice(wakes)
            .some(
              (wake) => wake.facts?.kind === "turn-failed" || wake.facts?.kind === "outage-failed",
            ),
        ).toBe(false);
        // The captain's "Ask first, then alert": an answer that the turn is
        // over raises no quiet alert.
        expect(home.wakes.slice(wakes).some((wake) => wake.facts?.kind === "quiet")).toBe(false);
        expect(
          home.tasks.timeline(taskId).some((event) => event.text?.includes("may be stuck")),
        ).toBe(false);
      } finally {
        lost.mockRestore();
        claude.endClient();
      }
    },
  );

  // INF-2332 leaves alone: a turn that is really running is never stopped.
  // The captain's "Ask first, then alert": the twenty-minute pass asks the
  // computer first, and raises the quiet alert only on its answer that the
  // turn still works, or on no answer.
  it.each(["working", "no answer"] as const)(
    "keeps a quiet turn its crewmate really carries on by itself, alerting only after the computer's answer (%s), and its words arrive when it ends (INF-2332)",
    async (answer) => {
      const heldCall = gate();
      const claude = await scriptedClaudeWorld({ beforeToolRecord: () => heldCall.held });
      stops.push(scriptedClaudeCleanup);
      const at = await world(undefined, { claude });
      const home = at.home();
      const taskId = "t-really-running";
      claude.answer({ text: "The background check started." });
      try {
        await at.start(taskId);
        await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
        claude.answer({
          tool: "note_progress",
          args: { text: "Reading the results." },
          answer: "The check passed.",
        });
        claude.continueTurn();
        await expect
          .poll(() =>
            home.events.some((event) => event.type === "tool_start" && event.taskId === taskId),
          )
          .toBe(true);
        const wakes = home.wakes.length;
        const alerted = () =>
          home.wakes.slice(wakes).some((wake) => wake.facts?.kind === "quiet") &&
          home.tasks.timeline(taskId).some((event) => event.text?.includes("may be stuck"));
        // The computer's answer is held until the home has looked.
        const roster = gate();
        const ask = home.devices.ask.bind(home.devices);
        const asked = vi
          .spyOn(home.devices, "ask")
          .mockImplementation(async (device, channel, args) => {
            if (channel !== "inf:session:roster") return ask(device, channel, args);
            await roster.held;
            if (answer === "no answer") throw new Error("The computer did not answer.");
            return ask(device, channel, args);
          });
        home.supervisor.checkQuietTasks(now() + QUIET_CARD_MS);
        await expect
          .poll(() => asked.mock.calls.some(([, channel]) => channel === "inf:session:roster"))
          .toBe(true);
        expect(alerted()).toBe(false);
        roster.open();
        await expect.poll(alerted).toBe(true);
        asked.mockRestore();
        expect(home.tasks.get(taskId)?.activity).toBe("running");
        heldCall.open();
        await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("The check passed.");
        expect(home.tasks.timeline(taskId).map((event) => event.text)).not.toContain(
          UNHEARD_END_NOTE,
        );
      } finally {
        claude.endClient();
        heldCall.open();
      }
    },
  );

  // INF-2603, the captain's approved direction B: "Name the wait and settle
  // the app's own calls". A read the crewmate there asked its home and the
  // home never answered (INF-2550's 13 hours inside one github_read) is
  // answered "ask again" at the twenty-minute check on the computer that runs
  // the turn, so the turn goes on and reads the steer queued behind it.
  it("answers a read the home never answered at the twenty-minute check, and the steer behind it reaches the carried-on turn (INF-2603)", async () => {
    const claude = await scriptedClaudeWorld();
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    const home = at.home();
    const taskId = "t-lost-read";
    // The home never answers the crewmate's task read: lost on the way.
    const answer = home.placed.answer.bind(home.placed);
    let readAsked = false;
    const lost = vi.spyOn(home.placed, "answer").mockImplementation(((device, channel, request) => {
      if (channel !== "inf:work:tasks") return answer(device, channel, request);
      readAsked = true;
      return new Promise(() => {});
    }) as typeof home.placed.answer);
    claude.answer({ text: "The background check started." });
    try {
      await at.start(taskId);
      await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
      claude.answer({ tool: "tasks", args: { status: "open" }, answer: "Done reading." });
      claude.continueTurn();
      await expect.poll(() => readAsked).toBe(true);
      // INF-2558: a steer reaches the turn the crewmate carries on by itself.
      await home.supervisor.steerCrewmate(taskId, "Check the header too.");
      const asked = claude.served().length;
      home.supervisor.checkQuietTasks(now() + QUIET_CARD_MS);
      await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Done reading.");
      // The turn goes on with the answer, and reads the steer in that same request.
      const answered = answeredReadText("tasks", QUIET_CARD_MS).split(":")[0] ?? "";
      const goesOn = claude
        .served()
        .slice(asked)
        .find((served) => served.said.includes(answered));
      expect(goesOn?.said).toContain("Check the header too.");
      // The home named what it did on the timeline, and raised no quiet alert for it.
      expect(home.tasks.timeline(taskId).map((event) => event.text)).toContainEqual(
        expect.stringContaining('answered tasks "ask again" for the crewmate'),
      );
      expect(
        home.tasks.timeline(taskId).some((event) => event.text?.includes("may be stuck")),
      ).toBe(false);
    } finally {
      lost.mockRestore();
      claude.endClient();
    }
  });

  // The captain's "Ask first, then alert": the alert is held back only when
  // the computer's answer ends the turn here. An answer that it is not
  // working while the home is still behind its events ends nothing yet, so
  // the twenty-minute alert goes as before.
  it("raises the quiet alert at twenty minutes when the computer's answer ends nothing here (INF-2332)", async () => {
    const heldCall = gate();
    const claude = await scriptedClaudeWorld({ beforeToolRecord: () => heldCall.held });
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    const home = at.home();
    const taskId = "t-answer-ends-nothing";
    claude.answer({ text: "The background check started." });
    const events = gate();
    let holding = false;
    const answer = home.placed.answer.bind(home.placed);
    const held = vi.spyOn(home.placed, "answer").mockImplementation((async (
      device,
      channel,
      request,
    ) => {
      if (holding && channel === "inf:work:events") await events.held;
      return answer(device, channel, request);
    }) as typeof home.placed.answer);
    try {
      await at.start(taskId);
      await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
      claude.answer({
        tool: "note_progress",
        args: { text: "Reading the results." },
        answer: "The check passed.",
      });
      claude.continueTurn();
      await expect
        .poll(() =>
          home.events.some((event) => event.type === "tool_start" && event.taskId === taskId),
        )
        .toBe(true);
      // The turn ends there, but its last events have not reached the home.
      holding = true;
      heldCall.open();
      await expect
        .poll(() =>
          new PlacedTasks(at.dataDir)
            .outbox(taskId, 0)
            .some(({ event }) => event.type === "continuation_ended"),
        )
        .toBe(true);
      expect(home.tasks.get(taskId)?.activity).toBe("running");
      const wakes = home.wakes.length;
      const asked = vi.spyOn(home.devices, "ask");
      home.supervisor.checkQuietTasks(now() + QUIET_CARD_MS);
      await expect
        .poll(() => asked.mock.calls.some(([, channel]) => channel === "inf:session:roster"))
        .toBe(true);
      asked.mockRestore();
      await expect
        .poll(
          () =>
            home.wakes.slice(wakes).some((wake) => wake.facts?.kind === "quiet") &&
            home.tasks.timeline(taskId).some((event) => event.text?.includes("may be stuck")),
        )
        .toBe(true);
      // Its events arrive, and the turn ends as it really did.
      events.open();
      await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("The check passed.");
      expect(home.tasks.timeline(taskId).map((event) => event.text)).not.toContain(
        UNHEARD_END_NOTE,
      );
    } finally {
      events.open();
      held.mockRestore();
      claude.endClient();
      heldCall.open();
    }
  });

  it("gives a crewmate prepare_change after its computer restarts with that tool available (INF-398, INF-416 L)", async () => {
    const project = await gitProject();
    const at = await world(() => project.forge(Buffer.alloc(0)), {
      tools: CREWMATE_TOOLS.filter((tool) => tool.name !== "prepare_change"),
    });
    const home = at.home();
    const { repo } = await adoptHere(home.repos, project.home);
    home.repos.configure(repo.id, { delivery: "direct-pr" });
    model([{ text: "Started on the footer." }, { text: "The header is next." }]);
    await at.start("t-contract", "Fix the footer.", repo.id);
    await expect.poll(() => home.tasks.get("t-contract")?.activity).toBe("idle");
    const opened = api.requests.at(-1)?.body.tools?.map((tool) => tool.name) ?? [];
    expect(opened).toContain("open_change");
    expect(opened).not.toContain("prepare_change");
    expect(home.placed.takesChangePresentations(at.deviceId)).toBe(true);

    await at.restartComputer({ tools: CREWMATE_TOOLS, protocolVersion: PROTOCOL_VERSION });
    // The old connection can still be in reach when the restart returns.
    await expect.poll(() => home.devices.version(at.deviceId)?.contract).toBe(PROTOCOL_VERSION);
    await at.inReach("t-contract");
    expect(home.placed.takesChangePresentations(at.deviceId)).toBe(true);
    const requests = api.requests.length;
    await home.supervisor.steerCrewmate("t-contract", "Fix the header too.");
    await expect.poll(() => home.tasks.get("t-contract")?.outcome).toBe("The header is next.");
    const served = api.requests.at(-1)?.body.tools?.map((tool) => tool.name) ?? [];
    expect(api.requests.length).toBeGreaterThan(requests);
    expect(served).toContain("prepare_change");
    expect(served).toContain("open_change");
    expect(said(api.requests.at(-1))).toContain("Fix the header too.");
  });

  it("fails a turn the computer's restart cut off, and its lane runs the words there again", async () => {
    const at = await world();
    const never = gate();
    model([{ held: never.held, text: "Never said." }, { text: "Picked the footer up again." }]);
    const requests = api.requests.length;
    await at.start("t-computer");
    await expect.poll(() => api.openRequests()).toBe(1);

    await at.restartComputer();
    const home = at.home();
    // That turn failed here, saying why; its brief waits on the lane for the honest retry.
    await expect.poll(() => home.tasks.get("t-computer")?.activity).toBe("idle");
    // The Firstmate hears it as the honest retry's first failure, in words a person reads.
    expect(home.wakes.map((wake) => wake.facts?.kind)).toContain("outage-failed");
    expect(JSON.stringify(home.wakes)).toContain("Mac mini quit before this turn finished");
    expect(home.inbox.allFor("t-computer")).toHaveLength(1);

    // The lane runs it again there, in the conversation reopened from its record.
    never.open();
    ahead = 10 * 60_000;
    await home.supervisor.sweepInbox(now());
    await expect
      .poll(() => home.tasks.get("t-computer")?.outcome)
      .toBe("Picked the footer up again.");
    expect(api.requests.length - requests).toBe(2);
    expect(said(api.requests.at(-1))).toContain("Fix the footer.");
  });

  // INF-721 friction 9: the captain asked three times to pause and resume
  // the crew around an update, and two turns still failed; the update now
  // pauses the crew on that computer and carries it on by itself.
  it("pauses a turn running on a computer for its update and carries it on once it is back, with no failed turn (INF-721 friction 9)", async () => {
    const at = await world();
    const never = gate();
    model([{ held: never.held, text: "Never said." }, { text: "Picked the footer up again." }]);
    const requests = api.requests.length;
    await at.start("t-update");
    await expect.poll(() => api.openRequests()).toBe(1);
    const home = at.home();
    const wakes = home.wakes.length;
    const computer = at
      .pairing()
      .list()
      .find((device) => device.id === at.deviceId)?.name;
    expect(computer).toBeDefined();

    // The update pauses its crew first: the turn there stops before it restarts.
    await home.supervisor.pauseForUpdate(at.deviceId);
    await expect.poll(() => home.tasks.get("t-update")?.activity).toBe("idle");
    expect(api.openRequests()).toBe(0);
    await at.restartComputer();
    await at.inReach("t-update");
    // Back and caught up, it waits for the update to be over.
    expect(api.requests.length - requests).toBe(1);
    home.supervisor.resumeAfterUpdate(at.deviceId);

    await expect
      .poll(() => home.tasks.get("t-update")?.outcome)
      .toBe("Picked the footer up again.");
    expect(api.requests.length - requests).toBe(2);
    expect(said(api.requests.at(-1))).toContain(
      renderWake({ facts: { kind: "turn-resumed", stopped: "update", computer } }),
    );
    // No turn failed, and the Firstmate heard only the crewmate's report.
    expect(home.tasks.timeline("t-update").some((event) => event.kind === "failed")).toBe(false);
    expect(home.events.some((event) => event.type === "turn_failed")).toBe(false);
    expect(home.wakes.slice(wakes).map((wake) => wake.facts?.kind)).not.toEqual(
      expect.arrayContaining(["turn-failed", "outage-failed"]),
    );
    expect(JSON.stringify(home.wakes)).not.toContain("quit before this turn finished");
    expect(home.inbox.allFor("t-update")).toEqual([]);
    never.open();
  });

  // INF-721 friction 9: a computer updated over Remote Login while out of
  // reach of its connection cannot be asked to stop its turn first; the
  // turn the update cut there is a pause too, and its words go again.
  it("reads a turn its computer's update cut out of reach as a pause, and sends its words again once the update is over (INF-721 friction 9)", async () => {
    const at = await world();
    const never = gate();
    model([{ held: never.held, text: "Never said." }, { text: "Picked the footer up again." }]);
    const requests = api.requests.length;
    await at.start("t-update-away");
    await expect.poll(() => api.openRequests()).toBe(1);
    const home = at.home();
    const wakes = home.wakes.length;

    await at.stopComputer();
    await home.supervisor.pauseForUpdate(at.deviceId);
    await at.restartComputer();
    await at.inReach("t-update-away");
    await expect.poll(() => home.tasks.get("t-update-away")?.activity).toBe("idle");
    // Its words wait on the lane for the update to be over.
    expect(home.inbox.allFor("t-update-away").map((row) => row.facts?.kind)).toContain(
      "turn-resumed",
    );
    expect(api.requests.length - requests).toBe(1);
    home.supervisor.resumeAfterUpdate(at.deviceId);

    await expect
      .poll(() => home.tasks.get("t-update-away")?.outcome)
      .toBe("Picked the footer up again.");
    expect(api.requests.length - requests).toBe(2);
    expect(said(api.requests.at(-1))).toContain("Fix the footer.");
    expect(home.tasks.timeline("t-update-away").some((event) => event.kind === "failed")).toBe(
      false,
    );
    expect(home.events.some((event) => event.type === "turn_failed")).toBe(false);
    expect(
      home.wakes
        .slice(wakes)
        .some((wake) => wake.facts?.kind === "turn-failed" || wake.facts?.kind === "outage-failed"),
    ).toBe(false);
    expect(home.inbox.allFor("t-update-away")).toEqual([]);
    never.open();
  });

  // INF-721 friction 9: the turns that failed were Claude clients' own
  // continuations, which a computer's restart cuts with no message to send
  // again; paused for the update, each is carried on once it is back.
  it("pauses a Claude continuation running on a computer for its update and carries it on after, with no failed turn (INF-721 friction 9)", async () => {
    const heldCall = gate();
    const claude = await scriptedClaudeWorld({ beforeToolRecord: () => heldCall.held });
    stops.push(scriptedClaudeCleanup);
    const at = await world(undefined, { claude });
    const home = at.home();
    const taskId = "t-continuation-update";
    const computer = at
      .pairing()
      .list()
      .find((device) => device.id === at.deviceId)?.name;
    claude.answer({ text: "The background check started." });
    try {
      await at.start(taskId);
      await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
      const wakes = home.wakes.length;
      claude.answer({ tool: "note_progress", answer: "Not reached while held." });
      claude.continueTurn();
      await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("running");
      await expect
        .poll(() =>
          home.events.some((event) => event.type === "tool_start" && event.taskId === taskId),
        )
        .toBe(true);

      await home.supervisor.pauseForUpdate(at.deviceId);
      await at.restartComputer();
      await at.inReach(taskId);
      await expect.poll(() => home.tasks.get(taskId)?.activity).toBe("idle");
      heldCall.open();
      claude.answer({ text: "Carried on after the update." });
      home.supervisor.resumeAfterUpdate(at.deviceId);

      await expect.poll(() => home.tasks.get(taskId)?.outcome).toBe("Carried on after the update.");
      expect(claude.served().at(-1)?.said).toContain(
        renderWake({ facts: { kind: "turn-resumed", stopped: "update", computer } }),
      );
      expect(home.tasks.timeline(taskId).some((event) => event.kind === "failed")).toBe(false);
      expect(home.events.some((event) => event.type === "turn_failed")).toBe(false);
      expect(
        home.wakes
          .slice(wakes)
          .some(
            (wake) => wake.facts?.kind === "turn-failed" || wake.facts?.kind === "outage-failed",
          ),
      ).toBe(false);
      expect(home.inbox.allFor(taskId)).toEqual([]);
    } finally {
      claude.endClient();
      heldCall.open();
    }
  });
});
