/**
 * A started task's hold that a connected source's event ends (INF-5145
 * part 2; docs/automation.md "A rule that ends a hold"), through the real
 * inbox integration and IntegrationsService: the hold is confirmed only
 * once the rule's first look answered and saved its place, so the first
 * event after the confirmation ends it even on a polling cadence; a rule
 * that cannot take its place refuses the hold; the crewmate reads what
 * arrived fenced as outside words, the task's timeline keeps a note in
 * their place, and the outside-data sweep replaces them in every place they
 * were saved once their days are past.
 * The inbox keeps its drops in files, so this file is an integration test.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fencedSpans } from "@shared/outsideData";
import { outsideDataDeletedNote } from "@shared/savedOutsideData";
import { describe, expect, it, vi } from "vitest";
import { endTurn, fakeCrewTimersEachTest } from "../../../tests/helpers/crewHarness";
import { freshDatabase } from "../../../tests/helpers/database";
import { idleLadderHarness, minutes, settle } from "../../../tests/helpers/idleLadderHarness";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { INFINITARY_COMMAND } from "../integrations/commandWords";
import { IntegrationSettingsStore, IntegrationsService } from "../integrations/index";
import { FIRSTMATE_READER, OutsideReads } from "../integrations/outsideReads";
import { INBOX_EVENT, INBOX_FENCE, INBOX_ID, Inbox } from "../integrations/providers/inbox";
import { SavedOutsideData } from "../integrations/savedOutsideData";
import { MESSAGE_EXCERPT_LIMIT } from "../overflow";
import { appPathsFor, crewmateSessionsDir } from "../paths";
import { createTaskTools } from "../pi/taskTools";
import { piToolsOf } from "../pi/toolSpec";
import { ScheduleStore } from "../storage/scheduleStore";
import { type FirstmateTaskToolsHost, firstmateTaskTools } from "./firstmateTaskTools";
import { Scheduler, type SchedulerEvents } from "./scheduler";
import { integrationEvents, withTaskEvents } from "./taskEvents";

fakeCrewTimersEachTest();

const BIN_DIR = resolve(__dirname, "../../../resources/axi-bin");
/** A polling source's cadence, in ticks: the rule's own looks come this often. */
const POLL_EVERY = 5;
/**
 * The inbox keeps its words until it is deleted; here it declares days as
 * Gmail does, so the sweep that cleans a kept kind's words reaches them.
 */
const KEPT = { days: 30, what: "notes dropped in the inbox" };
const DAY_MS = 24 * 60 * 60 * 1000;

describe("a hold a connected source's event ends (INF-5145 part 2)", () => {
  const { clock, stopped } = idleLadderHarness();
  const reason = "the Windows run installing the alpha";

  /**
   * A stopped crewmate, the inbox signed in as a polling source whose next
   * look can be held back until the test answers it, or fail, and
   * Automation bound as at home.
   */
  async function inboxHold() {
    const h = await stopped();
    const { supervisor, tasks } = h;
    const root = scratchDir("infinitary-hold-inbox-");
    const paths = appPathsFor(join(root, "userData"));
    const inbox = new Inbox({
      dir: join(paths.integrationsDir, INBOX_ID),
      dataDir: root,
      command: join(BIN_DIR, INFINITARY_COMMAND),
      defaultDataDir: join(root, "elsewhere"),
      linkDir: join(root, "bin"),
    });
    const settings = new IntegrationSettingsStore(join(root, "integrations-settings"));
    inbox.pausedThrough(() => settings.read()[INBOX_ID]?.paused === true);
    const reads = new OutsideReads(paths.integrationsDir);
    const integrations = new IntegrationsService({
      bindings: [{ ...inbox.binding(), kept: KEPT }],
      store: settings,
      reads,
      now: () => clock.now,
    });
    await integrations.signIn(INBOX_ID);
    // The inbox as a polling source whose look crosses a slow network.
    const connected = integrationEvents(integrations);
    let slow: { answered: Promise<void>; fails: boolean } | undefined;
    /** The next look waits until the returned call, then answers or fails. */
    const holdBackNextLook = (fails = false) => {
      let answer: () => void = () => {};
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      slow = { answered, fails };
      return answer;
    };
    const polling: SchedulerEvents = {
      ...connected,
      find: (integration, event) => {
        const found = connected.find(integration, event);
        return found ? { ...found, atOnce: false, every: POLL_EVERY } : undefined;
      },
      look: async (...args) => {
        const held = slow;
        slow = undefined;
        if (held) {
          await held.answered;
          if (held.fails) throw new Error("The inbox could not be reached.");
        }
        return connected.look(...args);
      },
    };
    const notify = vi.fn();
    const store = new ScheduleStore(freshDatabase());
    const scheduler = new Scheduler({
      store,
      notify,
      broadcastEvent: () => {},
      now: () => clock.now,
      events: withTaskEvents(tasks, polling),
      endHold: (task, rule, events) => supervisor.holdRules.ran(task, rule, events),
    });
    supervisor.holdRules.bindRules(scheduler);
    const note = (text: string) => inbox.door.note({ text, source: "windows-pc" });
    const delegate = firstmateTaskTools({
      options: { supervisor, tasks },
      turn: { replyFacts: {}, origin: "captain-turn" },
      asks: { attach: () => {} },
      noteDelivery: () => {},
    } as unknown as FirstmateTaskToolsHost);
    const update = piToolsOf(createTaskTools(delegate)).find(
      (entry) => entry.name === "update_task",
    ) as unknown as {
      execute(id: string, params: unknown): Promise<{ content: { text: string }[] }>;
    };
    /** The first mate's hold, on the inbox's note unless `onEvent` is false, answered once update_task answers. */
    const hold = (holdReason = reason, onEvent = true) => {
      let text: string | undefined;
      const answer = update
        .execute("hold", {
          task: h.taskId,
          hold: {
            until: new Date(h.idleSince + minutes(6 * 60)).toISOString(),
            reason: holdReason,
            ...(onEvent ? { on_event: { integration: INBOX_ID, event: INBOX_EVENT.name } } : {}),
          },
        })
        .then((result) => {
          text = result.content[0]?.text;
          return text;
        });
      return { answer, now: () => text };
    };
    const poll = async () => {
      for (let tick = 0; tick < POLL_EVERY; tick++) scheduler.tick(clock.now);
      await scheduler.settled();
      await settle();
    };
    const sweeper = new SavedOutsideData({
      paths,
      reads,
      task: (id) => tasks.get(id),
      tasks: () => tasks.list(),
      kept: () => integrations.kept(),
      legacy: () => integrations.legacyCalls(),
      claudeConfigDir: () => join(root, "claude"),
      firstmateClaudeSessions: () => [],
      conversations: { busy: () => false, release: async () => true, held: () => false },
      placed: async () => "gone",
      runs: { rewrite: (scrub) => store.rewriteRuns(scrub) },
      inbox: { rewrite: () => 0 },
      now: () => clock.now,
      log: () => {},
    });
    return {
      ...h,
      paths,
      reads,
      scheduler,
      notify,
      note,
      hold,
      update: async (params: unknown) => (await update.execute("hold", params)).content[0]?.text,
      poll,
      holdBackNextLook,
      sweeper,
      store,
      dispose: () => integrations.dispose(),
    };
  }

  it("writes and confirms the hold once its place is saved, and the first event after ends it once, fenced, read by the task", async () => {
    const h = await inboxHold();
    h.note("The Windows test PC started installing the alpha.");
    const answerLook = h.holdBackNextLook();
    const held = h.hold();
    await settle();
    // The rule's first look is still out: nothing is held or confirmed yet.
    expect(held.now()).toBeUndefined();
    expect(h.tasks.get(h.taskId)?.gate).toBeNull();
    // A change to the task meanwhile leaves the rule taking its place alone.
    h.tasks.setPinned(h.taskId, true, { actor: "captain" });
    answerLook();
    expect(await held.answer).toContain("ends it sooner");
    expect(h.tasks.get(h.taskId)?.gate).toMatchObject({ kind: "at-time", reason });

    // The first event after the confirmation, before the source's next poll.
    h.note("The Windows alpha finished installing; the app opened.");
    const prompts = h.crewmate.promptCalls.length;
    await h.poll();

    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    const steer = h.crewmate.promptCalls.at(-1) ?? "";
    expect(steer).toContain(`The event this task was waiting for came (${reason}):`);
    expect(fencedSpans(steer).map((span) => span.label)).toEqual([INBOX_FENCE]);
    expect(steer).toContain("The Windows alpha finished installing; the app opened.");
    expect(steer).not.toContain("started installing");
    expect(h.tasks.get(h.taskId)?.gate).toBeNull();
    expect(h.notify).not.toHaveBeenCalled();
    // The task's conversation holds the words, and Automation's history a copy.
    expect(h.reads.due(Number.MAX_SAFE_INTEGER).sort()).toEqual(
      [FIRSTMATE_READER, h.taskId].sort(),
    );

    // The rule ran once: a later event ends nothing.
    h.note("The Windows alpha was uninstalled.");
    await h.poll();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    h.dispose();
  });

  it("refuses a hold whose first look cannot take its place, leaving the hold the task had and its rule", async () => {
    const h = await inboxHold();
    const waiting = () => h.scheduler.rules().filter((rule) => rule.state !== "completed");
    const failing = async (holdReason: string) => {
      const answerLook = h.holdBackNextLook(true);
      const held = h.hold(holdReason);
      await settle();
      expect(held.now()).toBeUndefined();
      answerLook();
      expect(await held.answer).toContain(`could not start watching for ${INBOX_EVENT.name}`);
    };

    // A time-only hold stands through a refused event hold.
    expect(await h.hold("the logs", false).answer).toContain("Held");
    const timeOnly = h.tasks.get(h.taskId)?.gate;
    await failing("the logs, or the run's note");
    expect(h.tasks.get(h.taskId)?.gate).toEqual(timeOnly);
    expect(waiting()).toEqual([]);

    // An event hold stands through a refused replacement, and its rule still ends it.
    expect(await h.hold().answer).toContain("ends it sooner");
    const onEvent = h.tasks.get(h.taskId)?.gate;
    const [rule] = waiting();
    await failing("the run's second note");
    expect(h.tasks.get(h.taskId)?.gate).toEqual(onEvent);
    expect(waiting().map((entry) => entry.id)).toEqual([rule?.id]);
    h.note("The Windows alpha finished installing; the app opened.");
    const prompts = h.crewmate.promptCalls.length;
    await h.poll();
    expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
    expect(h.crewmate.promptCalls.at(-1)).toContain(
      `The event this task was waiting for came (${reason}):`,
    );
    expect(h.tasks.get(h.taskId)?.gate).toBeNull();
    h.dispose();
  });

  it.each([
    ["a newer time-only hold", "newer-hold"],
    ["a lift", "lift"],
    ["a turn that ended", "turn"],
  ] as const)(
    "a slow first look that answers after %s writes nothing over it",
    async (_move, move) => {
      const h = await inboxHold();
      expect(await h.hold("the logs", false).answer).toContain("Held");
      const answerLook = h.holdBackNextLook();
      const held = h.hold();
      await settle();
      expect(held.now()).toBeUndefined();
      if (move === "newer-hold")
        expect(await h.hold("the second run's logs", false).answer).toContain("Held");
      else if (move === "lift") await h.update({ task: h.taskId, hold: null });
      else {
        await h.supervisor.steer.steerCrewmate(h.taskId, "the run printed a warning; look at it");
        await settle();
        await endTurn(h.crewmate, h.taskId, "The warning is harmless.");
      }
      const after = h.tasks.get(h.taskId)?.gate ?? null;
      answerLook();
      expect(await held.answer).toContain("moved on while the event's watch started");
      expect(h.tasks.get(h.taskId)?.gate ?? null).toEqual(after);
      expect(h.scheduler.rules().filter((rule) => rule.state !== "completed")).toEqual([]);
      h.dispose();
    },
  );

  it("Settings answers a placed hold rule without waiting for its ordinary look, and a deleted one as gone", async () => {
    const h = await inboxHold();
    expect(await h.hold().answer).toContain("ends it sooner");
    const [rule] = h.scheduler.rules();
    if (!rule) throw new Error("The hold made no rule.");
    const answerLook = h.holdBackNextLook();
    h.scheduler.lookNow(INBOX_ID);
    // An ordinary look is out: the rule already holds its place, so nothing waits on it.
    expect(await h.scheduler.armed(rule)).toMatchObject({ id: rule.id, state: "enabled" });
    h.scheduler.cancel(rule.id);
    await expect(h.scheduler.armed(rule)).rejects.toThrow("may already be deleted");
    answerLook();
    await h.scheduler.settled();
    h.dispose();
  });

  it("keeps a long event's words out of the first mate's notice when the held task is in the backlog", async () => {
    const h = await inboxHold();
    expect(await h.hold().answer).toContain("ends it sooner");
    h.tasks.starts.setQueued(h.taskId, "unqueue-task", { actor: "captain" });
    expect(h.tasks.get(h.taskId)?.backlogSince).not.toBeNull();
    const marker = "installer-log-line";
    const words = Array.from({ length: 800 }, (_, n) => `${marker}-${n}`).join(" ");
    expect(words.length).toBeGreaterThan(MESSAGE_EXCERPT_LIMIT);
    const ops = h.ops.length;
    h.note(words);
    await h.poll();

    // The crewmate's steer waits on its lane with the words; the first mate hears of it without them.
    const notices = h.ops
      .slice(ops)
      .filter((line) => line.includes(h.tasks.get(h.taskId)?.title ?? h.taskId));
    expect(notices).not.toEqual([]);
    for (const notice of notices) {
      expect(notice).not.toContain(marker);
      expect(notice).not.toContain("full text:");
    }
    expect(h.tasks.get(h.taskId)?.gate).toBeNull();
    h.dispose();
  });

  it("keeps what arrived out of the timeline, and the sweep replaces it wherever it was saved", async () => {
    const h = await inboxHold();
    await h.hold().answer;
    const words = "The Windows alpha finished installing; the app opened.";
    h.note(words);
    await h.poll();
    const steer = h.crewmate.promptCalls.at(-1) ?? "";
    expect(steer).toContain(words);
    // The crewmate's conversation saves the steer as its session writes it.
    const sessions = crewmateSessionsDir(h.paths, h.taskId);
    mkdirSync(sessions, { recursive: true });
    const session = join(sessions, "session.jsonl");
    writeFileSync(
      session,
      `${JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: steer }] } })}\n`,
    );
    const [rule] = h.scheduler.rules();
    expect(JSON.stringify(h.scheduler.history(rule?.id ?? ""))).toContain(words);

    // The timeline keeps the steer, with a note where the outside words were.
    const steered = h.tasks.timeline(h.taskId).filter((event) => event.kind === "steered");
    const line = steered.at(-1)?.text ?? "";
    expect(line).toContain(`The event this task was waiting for came (${reason}):`);
    expect(line).toContain(`[${INBOX_FENCE} words from outside`);
    expect(line).not.toContain(words);
    expect(fencedSpans(line)).toEqual([]);

    // Past the kind's days, the sweep replaces them in the conversation and the history.
    clock.now += (KEPT.days + 1) * DAY_MS;
    await h.sweeper.sweep();
    const saved = readFileSync(session, "utf8");
    expect(saved).not.toContain(words);
    expect(saved).toContain(outsideDataDeletedNote(KEPT.what));
    expect(JSON.stringify(h.scheduler.history(rule?.id ?? ""))).not.toContain(words);
    h.dispose();
  });
});
