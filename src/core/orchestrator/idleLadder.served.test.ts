/**
 * The idle ladder's cut-offs and served text (`IdleLadder`;
 * docs/inbox.md): a started task in the backlog, the cut-off on crew lanes,
 * and the typed envelope of every idle and outage wake.
 * Each case drives a real CrewSupervisor through the crew harness
 * (tests/helpers/crewHarness.ts) and reads what it answers, the cards and the record.
 */

import type { CutOff } from "@shared/authFailure";
import type { Card } from "@shared/cards";
import { typedFailureOf } from "@shared/plainProblem";
import { CLAUDE_PROVIDER_ID } from "@shared/providers";
import { threadWait } from "@shared/threadWait";
import { describe, expect, it, vi } from "vitest";
import {
  askedOn,
  endTurn,
  type FakeCrewmate,
  fakeCrewmate,
  fakeCrewTimersEachTest,
  intentOf,
  reboot,
  type SetupExtras,
} from "../../../tests/helpers/crewHarness";
import {
  failTurn,
  idleLadderHarness,
  idleWakes,
  minutes,
  settle,
  wakesThroughInbox,
} from "../../../tests/helpers/idleLadderHarness";
import { seedDelivery } from "../../../tests/helpers/taskDelivery";
import { PI_CONTROL_PROFILE } from "../pi/controlProfile";
import {
  FIRSTMATE_RECIPIENT,
  INBOX_DEDUPE_WINDOW_MS,
  type InboxStore,
} from "../storage/inboxStore";
import type { CrewSupervisor } from "./crewSupervisor";
import type { AccountAttachment } from "./crewSupervisorOptions";
import { BACKLOG_STEER_LINE } from "./crewTurns";
import { backlogLeftLine } from "./hostOps";
import { type AccountServeability, JOB_BOUND_MS, STILL_DOWN_MS } from "./idleLadder";
import { IDLE_NUDGE_TEXT } from "./idleWakes";
import { renderWake } from "./wakes";

fakeCrewTimersEachTest();

function withConsentLabels(block: string): string {
  const read = JSON.parse(block.slice(block.indexOf("{"), block.lastIndexOf("}") + 1));
  // A stall's steer and its park in the backlog (INF-3143) keep work and need no consent.
  const free = (way: { tool: string }) =>
    read.held === "idle-stall" && (way.tool === "steer_crewmate" || way.tool === "update_task");
  read.ways = read.ways.map((way: { tool: string }) => ({
    ...way,
    hold: free(way) ? "waits" : "asks-first",
    basis: free(way) ? "record" : "consent",
    approach: free(way) ? "workaround" : "pass-hold",
    needsConsent: !free(way),
  }));
  return `\n\`\`\`json\n${JSON.stringify(read, null, 2)}\n\`\`\``;
}

describe("the idle ladder (idle crew recovery, docs/report-sort.md)", () => {
  const { clock, hostClock, stopped, sweepWhenDue } = idleLadderHarness();

  // INF-2062: the captain approved letting a started task go back to the backlog, keeping its work.
  describe("a started task in the backlog (INF-2062)", () => {
    /** Ticks across three hours, each past every rung's clock and backoff. */
    async function threeHours(harness: Awaited<ReturnType<typeof stopped>>) {
      for (let pass = 1; pass <= 9; pass += 1) {
        clock.now += minutes(20);
        harness.supervisor.watch.reconcileIdle(clock.now);
        await harness.supervisor.watch.sweepInbox(clock.now);
        await settle();
      }
    }

    it("stops its turn, wakes nothing for three hours, holds a job result and starts again with it", async () => {
      const h = await stopped();
      await h.supervisor.steer.steerCrewmate(h.taskId, "Carry on with step two.", "captain");
      await settle();
      expect(h.tasks.get(h.taskId)?.activity).toBe("running");
      const work = h.tasks.get(h.taskId);
      // The board's Back to backlog: the turn stops, the task stays started.
      expect(h.supervisor.hostOps.runTaskOp(h.taskId, "unqueue-task")).toBeUndefined();
      await settle();
      h.crewmate.failPrompt("aborted");
      await settle();
      const moved = h.tasks.get(h.taskId);
      expect(moved).toMatchObject({ status: "active", backlogSince: clock.now });
      // Its working copy, branch and conversation stay.
      expect([moved?.worktreeDir, moved?.branch, moved?.sessionFile]).toEqual([
        work?.worktreeDir,
        work?.branch,
        work?.sessionFile,
      ]);
      expect(
        h.tasks
          .timeline(h.taskId)
          .filter((event) => event.kind === "interrupted")
          .map((event) => event.actor),
      ).toContain("captain");
      expect(h.supervisor.facts.crewStatus(h.taskId)[0]).toMatchObject({
        status: "backlog",
        gate: expect.stringContaining("started, in the backlog"),
      });

      const prompts = h.crewmate.promptCalls.length;
      h.ops.length = 0;
      await threeHours(h);
      expect(idleWakes(h.ops)).toEqual([]);
      expect(h.ops).toEqual([]);
      expect(h.cards().filter((card) => card.taskId === h.taskId)).toEqual([]);
      expect(h.crewmate.promptCalls).toHaveLength(prompts);

      // A job that ends while it waits stays on its lane, and the first
      // mate hears once that news reached it (INF-3143, direction A).
      h.supervisor.watch.deliverJobResult(
        h.taskId,
        '[job] background job j1 finished: "make" exited 0',
      );
      await threeHours(h);
      expect(h.crewmate.promptCalls).toHaveLength(prompts);
      expect(h.ops).toEqual([
        `[fm-op] task ${h.taskId} "Job" has waited in the backlog for 3h, and news from the app reached it there; its crewmate hears it only once it starts again. If the news means it can move, start it with update_task start_now; otherwise leave it parked. You are told this once per stay in the backlog. The news: [job] background job j1 finished: "make" exited 0`,
      ]);

      // The captain's Start carries it on in the same conversation, the job result after one line.
      expect(h.supervisor.hostOps.runTaskOp(h.taskId, "start-task")).toBeUndefined();
      await settle();
      expect(h.crewmate.promptCalls).toHaveLength(prompts + 1);
      const resumed = h.crewmate.promptCalls.at(-1) ?? "";
      expect(resumed).toContain(backlogLeftLine("captain"));
      expect(resumed).toContain("exited 0");
      expect(h.tasks.get(h.taskId)?.backlogSince).toBeNull();
      // The first mate reads the two clicks as the captain made them, never as a Stop.
      expect(
        h.tasks
          .taskCardClicksSince(0)
          .filter((click) => click.taskId === h.taskId)
          .map((click) => click.op),
      ).toEqual(["start-task", "unqueue-task"]);
    });

    it("answers a steer the first mate sends, with the backlog line, and stays in the backlog", async () => {
      const h = await stopped();
      const moved = h.supervisor.hostOps.moveToBacklog(
        h.taskId,
        { actor: "firstmate", via: "tool", decision: null },
        "The captain asked to pause it.",
      );
      expect(moved).toMatchObject({
        ok: true,
        text: expect.stringContaining("back to the backlog"),
      });
      // The captain asked for the pause, so the first mate records their stop
      // with it (update_task captain_stop, INF-3846 piece 2): nothing alarms.
      expect(h.tasks.starts.declareCaptainStop(h.taskId, "firstmate")).toEqual({
        ok: true,
        changed: true,
      });
      await settle();
      expect(
        h.tasks
          .timeline(h.taskId)
          .some((event) => event.data?.reason === "The captain asked to pause it."),
      ).toBe(true);
      await h.supervisor.steer.steerCrewmate(h.taskId, "What is left to do?", "firstmate");
      await settle();
      const answered = h.crewmate.promptCalls.at(-1) ?? "";
      expect(answered.startsWith(BACKLOG_STEER_LINE)).toBe(true);
      expect(answered).toContain("What is left to do?");
      await endTurn(h.crewmate, h.taskId, "Step two is left.");
      expect(h.tasks.get(h.taskId)?.backlogSince).not.toBeNull();
      // A repeated report of the same wait wakes nobody.
      h.ops.length = 0;
      await threeHours(h);
      expect(h.ops).toEqual([]);
    });

    it("is not carried on after a restart, and its held job result waits", async () => {
      const h = await stopped();
      h.supervisor.hostOps.moveToBacklog(h.taskId, {
        actor: "captain",
        via: "task-card",
        decision: null,
      });
      await settle();
      // A job result that waits on its lane is not a reason to carry it on at boot.
      h.supervisor.watch.deliverJobResult(
        h.taskId,
        '[job] background job j1 finished: "make" exited 0',
      );
      await settle();
      await h.supervisor.disposeAll();
      const ops: string[] = [];
      const createCrewmate = vi.fn(async () => h.crewmate);
      const fresh = reboot({ paths: h.paths, db: h.db, workspace: h.workspace }, createCrewmate, {
        now: hostClock,
        recordSort: (input) => input.effect?.(),
      });
      wakesThroughInbox({ supervisor: fresh, inbox: h.inbox, ops });
      const prompts = h.crewmate.promptCalls.length;
      fresh.watch.announceCarryOn();
      for (let pass = 1; pass <= 9; pass += 1) {
        clock.now += minutes(20);
        fresh.watch.reconcileIdle(clock.now);
        await fresh.watch.sweepInbox(clock.now);
        await settle();
      }
      expect(createCrewmate).not.toHaveBeenCalled();
      expect(h.crewmate.promptCalls).toHaveLength(prompts);
      expect(ops).toEqual([]);
      expect(h.inbox.allFor(h.taskId).map((row) => row.text)).toContain(
        '[job] background job j1 finished: "make" exited 0',
      );
      fresh.disposeAll();
    });
  });

  describe("the cut-off on crew lanes (W1 S8, docs/inbox.md)", () => {
    const CLAUDE_ACCOUNT = "acct_claude";
    type Standing = { class: CutOff["class"]; since: number; resetsAt?: number };

    /**
     * The one Claude login as the vault answers for it (`cutOff`,
     * `noteCutOff`; AccountVault's own tests pin those): a cut-off stands
     * until a fact changes, a spent allowance until its reset, and a looser
     * cut-off never replaces one that stands.
     */
    function claudeLogin() {
      let standing: Standing | undefined;
      const current = () =>
        standing?.class === "no_headroom" && (standing.resetsAt ?? 0) <= clock.now
          ? undefined
          : standing;
      const serveability: AccountServeability = {
        cutOff: (accountId) => (accountId === CLAUDE_ACCOUNT ? current() : undefined),
        providerName: () => "Claude",
      };
      const noteCutOff = (accountId: string, cutOff: CutOff) => {
        if (accountId !== CLAUDE_ACCOUNT || current()) return;
        if (cutOff.class === "no_headroom") {
          if (cutOff.resetsAt === undefined || cutOff.resetsAt <= clock.now) return;
          standing = { class: cutOff.class, since: clock.now, resetsAt: cutOff.resetsAt };
          return;
        }
        standing = { class: cutOff.class, since: clock.now };
      };
      const accounts: AccountAttachment = {
        selectForSpawn: () => CLAUDE_ACCOUNT,
        // A resume keeps a withheld account: it is still connected.
        reselectForResume: (_taskId, accountId) => ({
          ...(accountId ? { accountId } : {}),
          changed: false,
        }),
        labelOf: () => "Personal",
      };
      return {
        extras: {
          accounts,
          routedModel: { provider: CLAUDE_PROVIDER_ID, id: "claude-opus" },
          serveability,
          noteCutOff,
        } satisfies SetupExtras,
        clear: () => {
          standing = undefined;
        },
      };
    }

    function claudeCrewmate(): FakeCrewmate {
      return {
        ...fakeCrewmate(),
        controlProfile: {
          ...PI_CONTROL_PROFILE,
          backgroundWork: "client",
          failureSignals: "typed",
        },
      };
    }

    async function cutOffTurn(crewmate: FakeCrewmate, taskId: string, cutOff: CutOff) {
      crewmate.emit({ type: "turn_failed", taskId, error: "Claude said no.", cutOff });
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await settle();
    }

    const cutOffWakes = (ops: string[]) => ops.filter((line) => line.includes("are paused:"));
    const backWakes = (ops: string[]) => ops.filter((line) => line.includes("is answering again"));
    const turnWakes = (ops: string[]) =>
      ops.filter((line) => line.includes("'s turn on task") || line.includes("failed at"));

    /** Ten ticks, each far past any backoff and every rung's clock. */
    async function tenTicks(supervisor: CrewSupervisor) {
      for (let pass = 1; pass <= 10; pass += 1) {
        clock.now += minutes(20);
        supervisor.watch.reconcileIdle(clock.now);
        await supervisor.watch.sweepInbox(clock.now);
        await settle();
      }
    }

    /** Ticks that stay short of `until`, each past any backoff that is not the hold's. */
    async function tenTicksUntil(supervisor: CrewSupervisor, until: number) {
      for (let pass = 1; pass <= 10; pass += 1) {
        clock.now = Math.min(clock.now + minutes(20), until);
        supervisor.watch.reconcileIdle(clock.now);
        await supervisor.watch.sweepInbox(clock.now);
        await settle();
      }
    }

    /**
     * A fresh supervisor over the same database, on the same login (an app
     * restart): no runtime survives, the rows and the durable once-names do.
     */
    function restart(
      harness: Awaited<ReturnType<typeof stopped>>,
      login: ReturnType<typeof claudeLogin>,
    ) {
      harness.supervisor.disposeAll();
      const ops: string[] = [];
      const createCrewmate = vi.fn(async () => harness.crewmate);
      const fresh = reboot(
        { paths: harness.paths, db: harness.db, workspace: harness.workspace },
        createCrewmate,
        {
          now: hostClock,
          accounts: login.extras.accounts,
          serveability: login.extras.serveability,
          noteCutOff: login.extras.noteCutOff,
          recordSort: (input) => input.effect?.(),
        },
      );
      return {
        ...wakesThroughInbox({ supervisor: fresh, inbox: harness.inbox, ops }),
        createCrewmate,
      };
    }

    it("a refused crewmate attempts nothing across ten ticks, the Firstmate hears it once, and it goes on when cleared", async () => {
      const login = claudeLogin();
      const harness = await stopped(login.extras, claudeCrewmate());
      const { supervisor, crewmate, taskId, inbox, ops, sorts, ledgerFacts, cards } = harness;
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      await cutOffTurn(crewmate, taskId, { class: "refused" });
      const prompts = crewmate.promptCalls.length;
      // One typed fact about the account, instead of the failed turn's own.
      // The wakes' whole words are the first mate words table's.
      expect(cutOffWakes(ops)).toEqual([
        expect.stringContaining(
          `[fm-op] Claude is refusing this sign-in, so the crewmates on it are paused: task ${taskId} "Job".`,
        ),
      ]);
      expect(turnWakes(ops)).toEqual([]);
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "provider-cut-off" });
      expect(ledgerFacts.at(-1)).toMatchObject({
        kind: "provider-cut-off",
        provider: "Claude",
        class: "refused",
        tasks: [{ id: taskId, title: "Job" }],
      });

      await tenTicks(supervisor);
      // Not one attempt: none spent, no backoff advanced, the row as it was.
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(inbox.allFor(taskId)).toEqual([
        expect.objectContaining({ attempts: 0, failures: 1, escalatedAt: null }),
      ]);
      // The account's wake speaks for the lane: no repeat, no still-down,
      // and the ladder reads the held guidance as the task moving.
      expect(cutOffWakes(ops)).toHaveLength(1);
      expect(ops.filter((line) => line.includes("still failing"))).toEqual([]);
      expect(idleWakes(ops)).toEqual([]);
      expect(cards().filter((card) => card.id.startsWith("card-stall-"))).toEqual([]);
      // Guidance given while it waits is kept, and says so.
      expect(await supervisor.steer.steerCrewmate(taskId, "and the tests")).toBe("recorded-held");
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts);

      // The refusal clears: the Firstmate hears it end, and the kept guidance
      // goes at once, in one turn, without waiting for any backoff.
      login.clear();
      supervisor.reconcileCutOffs();
      await settle();
      expect(backWakes(ops)).toEqual([
        expect.stringContaining(`so the crewmates paused on it go on: task ${taskId} "Job".`),
      ]);
      expect(sorts.at(-1)).toEqual({ taskId, verdict: "captain", rule: "provider-back" });
      expect(crewmate.promptCalls.slice(prompts)).toEqual([
        "use the other library\n\nand the tests",
      ]);
      await endTurn(crewmate, taskId);
      expect(inbox.allFor(taskId)).toEqual([]);
      await tenTicks(supervisor);
      expect(cutOffWakes(ops)).toHaveLength(1);
      expect(backWakes(ops)).toHaveLength(1);
    });

    // INF-759: the spark flies when the crewmate reads the message, not when it is kept.
    it("a message kept behind the hold sparks when it goes out, not when it is sent", async () => {
      const login = claudeLogin();
      const harness = await stopped(login.extras, claudeCrewmate());
      const { supervisor, crewmate, taskId, events } = harness;
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      await cutOffTurn(crewmate, taskId, { class: "refused" });
      const sparks = () =>
        events.filter(
          (event) => event.type === "task_event" && event.reached && event.taskId === taskId,
        ).length;
      const before = sparks();
      const prompts = crewmate.promptCalls.length;
      expect(await supervisor.steer.steerCrewmate(taskId, "and the tests")).toBe("recorded-held");
      await tenTicks(supervisor);
      expect(sparks()).toBe(before);
      login.clear();
      supervisor.reconcileCutOffs();
      await settle();
      expect(crewmate.promptCalls.slice(prompts)).toEqual([
        "use the other library\n\nand the tests",
      ]);
      expect(sparks()).toBe(before + 1);
    });

    it("a captain reply kept behind the hold reads as the held account on its thread, then as work once it goes out, then as the author's to answer", async () => {
      const login = claudeLogin();
      const harness = await stopped(login.extras, claudeCrewmate());
      const { supervisor, crewmate, specs, taskId, inbox, tasks, cards } = harness;
      specs[0]?.onCard?.({
        title: "Pick a course",
        body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
        actions: [
          { id: "hold", label: "Hold course" },
          { id: "change", label: "Plot new course", default: true },
        ],
      });
      await settle();
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      const resetsAt = clock.now + minutes(70);
      await cutOffTurn(crewmate, taskId, { class: "no_headroom", resetsAt });
      const prompts = crewmate.promptCalls.length;
      const card = cards().find((entry) => entry.title === "Pick a course") as Card;
      /** The thread's wait as the shell reads it: the shown card and the task's posture. */
      const wait = () => {
        const record = tasks.get(taskId);
        const shown = supervisor.cards.snapshot().find((entry) => entry.id === card.id);
        return record && shown
          ? threadWait(shown, supervisor.postures.workPosture(record))
          : undefined;
      };
      expect(wait()).toBeUndefined();

      clock.now += minutes(1);
      supervisor.cardActions.replyToCard(card.id, "what about the northern route?");
      await settle();
      // Saved, with no attempt spent: the wait names the hold's class,
      // provider and reset, and no turn claims to be working on it.
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(inbox.allFor(taskId).at(-1)).toMatchObject({ attempts: 0, failures: 0 });
      expect(wait()).toEqual({
        on: "account",
        hold: { class: "no_headroom", provider: "Claude", resetsAt },
      });

      // The reset: the kept reply goes out, and a running turn is work, not a wait.
      clock.now = resetsAt;
      supervisor.watch.reconcileIdle(clock.now);
      await settle();
      expect(crewmate.promptCalls.slice(prompts).join("\n")).toContain(
        "what about the northern route?",
      );
      expect(wait()).toBeUndefined();
      // Its turn ends without an answer: the reply is the author's to give.
      await endTurn(crewmate, taskId);
      expect(wait()).toEqual({ on: "author" });
      // Its answer ends the wait.
      specs[0]?.onReply?.({
        cardId: card.id,
        text: "The northern route adds a day.",
        answersMessage: askedOn(supervisor, card.id),
      });
      await settle();
      expect(wait()).toBeUndefined();
    });

    it("after a restart it neither repeats the cut-off nor resumes the crewmate, and still hears it end", async () => {
      const login = claudeLogin();
      const harness = await stopped(login.extras, claudeCrewmate());
      const { supervisor, crewmate, taskId, ops } = harness;
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      await cutOffTurn(crewmate, taskId, { class: "refused" });
      expect(cutOffWakes(ops)).toHaveLength(1);
      const prompts = crewmate.promptCalls.length;

      const fresh = restart(harness, login);
      await tenTicks(fresh.supervisor);
      // The resumed task keeps its withheld account, so its lane holds: no
      // session reopened, no turn, and nothing said again.
      expect(fresh.createCrewmate).not.toHaveBeenCalled();
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(fresh.ops).toEqual([]);

      login.clear();
      fresh.supervisor.reconcileCutOffs();
      await settle();
      await settle();
      expect(backWakes(fresh.ops)).toHaveLength(1);
      expect(fresh.createCrewmate).toHaveBeenCalledTimes(1);
      expect(crewmate.promptCalls.slice(prompts)).toEqual(["use the other library"]);
    });

    it("a spent allowance holds every lane on the account until its reset, then each goes on the first attempt", async () => {
      const login = claudeLogin();
      const other = claudeCrewmate();
      const harness = await stopped({ ...login.extras, crewmates: [other] }, claudeCrewmate());
      const { supervisor, crewmate, taskId, inbox, ops } = harness;
      // A second crewmate on the same login, idle before the allowance runs out.
      const { taskId: otherId } = await supervisor.intake.commission({
        title: "Other",
        intent: intentOf("Start"),
      });
      await settle();
      await endTurn(other, otherId, "Started on the other job.");
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      const resetsAt = clock.now + minutes(120);
      await cutOffTurn(crewmate, taskId, { class: "no_headroom", resetsAt });
      const prompts = crewmate.promptCalls.length;
      const otherPrompts = other.promptCalls.length;
      // New guidance is kept, not sent into the spent window - on this lane
      // and on every other lane of the account.
      clock.now += minutes(1);
      expect(await supervisor.steer.steerCrewmate(taskId, "and the tests")).toBe("recorded-held");
      expect(await supervisor.steer.steerCrewmate(otherId, "and the docs")).toBe("recorded-held");
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(other.promptCalls).toHaveLength(otherPrompts);
      expect(inbox.allFor(taskId)).toEqual([
        expect.objectContaining({ attempts: 0, failures: 1, nextAttemptAt: resetsAt }),
        expect.objectContaining({ attempts: 0, failures: 0 }),
      ]);
      // The wake's whole words are the first mate words table's.
      expect(cutOffWakes(ops)).toHaveLength(1);
      expect(cutOffWakes(ops)[0]).toContain(
        `paused: task ${taskId} "Job", task ${otherId} "Other".`,
      );
      expect(cutOffWakes(ops)[0]).toContain(
        `before it resets at ${new Date(resetsAt).toISOString()};`,
      );
      expect(turnWakes(ops)).toEqual([]);

      clock.now = resetsAt - 1;
      supervisor.watch.reconcileIdle(clock.now);
      await supervisor.watch.sweepInbox(clock.now);
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(other.promptCalls).toHaveLength(otherPrompts);
      expect(ops.filter((line) => line.includes("still failing"))).toEqual([]);

      clock.now = resetsAt;
      supervisor.watch.reconcileIdle(clock.now);
      await settle();
      expect(backWakes(ops)).toHaveLength(1);
      expect(crewmate.promptCalls.slice(prompts)).toEqual([
        "use the other library\n\nand the tests",
      ]);
      expect(other.promptCalls.slice(otherPrompts)).toEqual(["and the docs"]);
    });

    it("a spent allowance the vault clears on a swapped login frees the held lanes before its reset, with their kept guidance", async () => {
      const login = claudeLogin();
      const harness = await stopped(login.extras, claudeCrewmate());
      const { supervisor, crewmate, taskId, ops } = harness;
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      const resetsAt = clock.now + minutes(120);
      await cutOffTurn(crewmate, taskId, { class: "no_headroom", resetsAt });
      const prompts = crewmate.promptCalls.length;
      clock.now += minutes(1);
      expect(await supervisor.steer.steerCrewmate(taskId, "and the tests")).toBe("recorded-held");
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts);

      // The machine's login is swapped: the vault clears the hold long before
      // the old login's reset, and the next watch delivers what was kept.
      login.clear();
      expect(clock.now).toBeLessThan(resetsAt);
      supervisor.reconcileCutOffs();
      await settle();
      expect(backWakes(ops)).toHaveLength(1);
      expect(crewmate.promptCalls.slice(prompts)).toHaveLength(1);
      expect(crewmate.promptCalls.at(-1)).toContain("and the tests");
    });

    it("an account that serves nothing with no cut-off standing keeps the old path, and someone hears it", async () => {
      const login = claudeLogin();
      const harness = await stopped(login.extras, claudeCrewmate());
      const { supervisor, crewmate, taskId, ops } = harness;
      const prompts = crewmate.promptCalls.length;
      // No client, or a read that says not connected: no typed cut-off
      // stands, so the guidance is attempted and fails as it always has.
      expect(await supervisor.steer.steerCrewmate(taskId, "use the other library")).toBe(
        "mid-turn",
      );
      await settle();
      expect(crewmate.promptCalls.slice(prompts)).toEqual(["use the other library"]);
      crewmate.emit({ type: "turn_failed", taskId, error: "Claude Code is not installed." });
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await settle();
      expect(turnWakes(ops)).toEqual([expect.stringContaining("failed at the provider")]);
      expect(cutOffWakes(ops)).toEqual([]);
    });

    it("a card the Firstmate owes is still owed while a cut-off holds the crewmate", async () => {
      // The original outage intent survives retirement of its old count-cap fixture.
      const login = claudeLogin();
      const { supervisor, taskId, tasks, ops, idleSince, at } = await stopped(
        login.extras,
        claudeCrewmate(),
      );
      login.extras.noteCutOff(CLAUDE_ACCOUNT, { class: "refused" });
      supervisor.reconcileCutOffs();
      seedDelivery(tasks, taskId, {
        captainWait: { at: idleSince, reason: "choose the output format" },
      });
      await supervisor.watch.sweepGates(idleSince);
      await at(minutes(20));
      await at(minutes(50));
      const owed = ops.filter((line) => line.includes("is held for the captain"));
      expect(owed).toHaveLength(2);
      expect(owed[1]).toContain("This is the second time");
    });

    it("a cut-off's end is heard the moment it ends, and a failure after it speaks for itself", async () => {
      const login = claudeLogin();
      const harness = await stopped(login.extras, claudeCrewmate());
      const { supervisor, crewmate, taskId, ops } = harness;
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      await cutOffTurn(crewmate, taskId, { class: "refused" });
      const prompts = crewmate.promptCalls.length;
      // The refusal clears on a changed fact, while the account still
      // serves nothing (say a client update that reads as outdated).
      login.clear();
      supervisor.reconcileCutOffs();
      await settle();
      expect(backWakes(ops)).toHaveLength(1);
      expect(crewmate.promptCalls.slice(prompts)).toEqual(["use the other library"]);
      crewmate.emit({ type: "turn_failed", taskId, error: "Claude Code needs an update." });
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await settle();
      expect(turnWakes(ops)).toEqual([expect.stringContaining("Claude Code needs an update.")]);
      expect(backWakes(ops)).toHaveLength(1);
    });

    it("an idle crewmate on a cut-off account is not nudged, and nothing stale waits for it", async () => {
      const login = claudeLogin();
      const harness = await stopped(login.extras, claudeCrewmate());
      const { supervisor, crewmate, taskId, inbox, sorts, at } = harness;
      const prompts = crewmate.promptCalls.length;
      // Another task met the refusal; this crewmate is idle with nothing queued.
      login.extras.noteCutOff(CLAUDE_ACCOUNT, { class: "refused" });
      supervisor.reconcileCutOffs();
      await at(minutes(11));
      await at(minutes(25));
      await at(minutes(60));
      await at(minutes(120));
      expect(sorts.map((sort) => sort.rule)).not.toContain("idle-nudge");
      expect(inbox.allFor(taskId)).toEqual([]);
      expect(crewmate.promptCalls).toHaveLength(prompts);
      login.clear();
      supervisor.reconcileCutOffs();
      await settle();
      expect(crewmate.promptCalls).toHaveLength(prompts);
    });

    it("a lost sign-in keeps its sign-in card until it is signed in again, and the account's wake is the one the Firstmate hears", async () => {
      const login = claudeLogin();
      const harness = await stopped(login.extras, claudeCrewmate());
      const { supervisor, crewmate, taskId, inbox, ops, cards } = harness;
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      await cutOffTurn(crewmate, taskId, { class: "signed_out" });
      const prompts = crewmate.promptCalls.length;
      expect(cards().filter((card) => card.id === `card-auth-${taskId}`)).toHaveLength(1);
      expect(cutOffWakes(ops)).toEqual([
        expect.stringContaining(
          `Claude needs the captain to sign in again, so the crewmates on it are paused: task ${taskId} "Job".`,
        ),
      ]);
      expect(turnWakes(ops)).toEqual([]);
      // A sign-in failure spent its attempt as it always has; the hold spends no more.
      await tenTicks(supervisor);
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(inbox.allFor(taskId)).toEqual([expect.objectContaining({ attempts: 1 })]);

      // Signed in again: nothing is left to sign in to, so the card comes
      // down and the kept guidance goes on by itself.
      login.clear();
      supervisor.reconcileCutOffs();
      await settle();
      expect(cards().filter((card) => card.id === `card-auth-${taskId}`)).toEqual([]);
      expect(crewmate.promptCalls.slice(prompts)).toEqual(["use the other library"]);
    });

    it("a cut-off with nothing held behind it is still one failed turn, as before", async () => {
      const login = claudeLogin();
      const harness = await stopped(login.extras, claudeCrewmate());
      const { supervisor, crewmate, taskId, ops } = harness;
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      // A spent allowance with no reset to wait for stands nowhere.
      await cutOffTurn(crewmate, taskId, { class: "no_headroom" });
      expect(cutOffWakes(ops)).toEqual([]);
      expect(turnWakes(ops)).toEqual([expect.stringContaining("failed at the provider")]);
    });

    // INF-443 piece 1: xAI's 402 names no reset, so the host holds the
    // sign-in against its own reading's limiting window. The words are Pi's
    // (formatProviderError), the typed class is the session's.
    it("a Pi crewmate refused by xAI's 402 waits out the reset it was held against, and the feed line reads the class", async () => {
      const login = claudeLogin();
      const resetsAt = clock.now + minutes(600);
      // The composition root fills the reset from the sign-in's reading; the
      // supervisor reads it back from the standing hold.
      const noteCutOff = (accountId: string, cutOff: CutOff) =>
        login.extras.noteCutOff?.(
          accountId,
          cutOff.class === "no_headroom" && cutOff.resetsAt === undefined
            ? { ...cutOff, resetsAt }
            : cutOff,
        );
      const harness = await stopped({ ...login.extras, noteCutOff }, fakeCrewmate());
      const { supervisor, crewmate, taskId, inbox, ops, tasks } = harness;
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      crewmate.emit({
        type: "turn_failed",
        taskId,
        error:
          "xai API error (402): Your team has either used all available credits or reached its monthly spending limit.",
        cutOff: { class: "no_headroom" },
      });
      crewmate.emit({ type: "turn_end", taskId });
      crewmate.finishPrompt();
      await settle();
      const prompts = crewmate.promptCalls.length;

      // One wake for the account, no failed-turn wake, and the guidance waits for the reset.
      expect(cutOffWakes(ops)).toHaveLength(1);
      expect(turnWakes(ops)).toEqual([]);
      expect(inbox.allFor(taskId)).toEqual([
        expect.objectContaining({ attempts: 0, failures: 1, nextAttemptAt: resetsAt }),
      ]);
      const failed = tasks.timeline(taskId).find((event) => event.kind === "failed");
      expect(typedFailureOf(failed?.data)).toEqual({ cutOff: { class: "no_headroom", resetsAt } });

      await tenTicksUntil(supervisor, resetsAt - 1);
      expect(crewmate.promptCalls).toHaveLength(prompts);
      expect(cutOffWakes(ops)).toHaveLength(1);

      clock.now = resetsAt;
      supervisor.watch.reconcileIdle(clock.now);
      await settle();
      expect(backWakes(ops)).toHaveLength(1);
      expect(crewmate.promptCalls.slice(prompts)).toEqual(["use the other library"]);
    });
  });

  // The typed wake envelope (the primitives review's P3): the ladder's wakes
  // are typed facts rendered where they are served. Every literal below is
  // the text the prose templates served before the move, byte for byte.
  describe("the served text of every idle wake (the typed envelope, P3)", () => {
    const HEAD = "abc1234def5678";
    const stallBlock = (id: string) =>
      withConsentLabels(`
\`\`\`json
{
  "held": "idle-stall",
  "task": {
    "id": "${id}",
    "title": "Job"
  },
  "ways": [
    {
      "label": "Tell it what to do next",
      "tool": "steer_crewmate",
      "args": {
        "task_id": "${id}"
      }
    },
    {
      "label": "Park it in the backlog until something changes",
      "tool": "update_task",
      "args": {
        "task": "${id}",
        "start_policy": "on-request"
      }
    },
    {
      "label": "Drop task",
      "tool": "interrupt_crewmate",
      "args": {
        "task_id": "${id}",
        "mode": "cancel"
      }
    },
    {
      "label": "Discard the work",
      "tool": "settle_task",
      "args": {
        "task_id": "${id}",
        "mode": "discard"
      }
    }
  ]
}
\`\`\``);
    const heldBlock = (id: string, held: string) =>
      withConsentLabels(`
\`\`\`json
{
  "held": "${held}",
  "task": {
    "id": "${id}",
    "title": "Job"
  },
  "ways": [
    {
      "label": "Retry with the captain's guidance",
      "tool": "steer_crewmate",
      "args": {
        "task_id": "${id}"
      }
    },
    {
      "label": "Try a premium model",
      "tool": "spawn_crewmate",
      "args": {
        "shape": {
          "escalate_from": "${id}",
          "premium_ask": true
        }
      }
    },
    {
      "label": "Discard the work",
      "tool": "settle_task",
      "args": {
        "task_id": "${id}",
        "mode": "discard"
      }
    }
  ]
}
\`\`\``);
    const SECOND =
      " This is the second time: if nothing is done about it in 30 minutes, the host puts it to the captain on a card of its own.";

    it("the stall wake and its repeat, after a nudge that went out", async () => {
      const { crewmate, ops, taskId, at } = await stopped();
      await at(minutes(10));
      expect(crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
      await endTurn(crewmate, taskId);
      await at(minutes(20));
      await at(minutes(50));
      expect(idleWakes(ops)).toEqual([
        `[fm-op] crewmate 1 on task ${taskId} "Job" has been idle for 20m with nothing running, nothing queued and no card up; the host's nudge did not move it. Its last report: Done with step one.${stallBlock(taskId)}`,
        `[fm-op] crewmate 1 on task ${taskId} "Job" has been idle for 50m with nothing running, nothing queued and no card up; the host's nudge did not move it.${SECOND} Its last report: Done with step one.${stallBlock(taskId)}`,
      ]);
    });

    it("the stall wake while the captain's words in a thread go unanswered", async () => {
      const { supervisor, crewmate, specs, taskId, at, cards, ops } = await stopped();
      specs[0]?.onCard?.({
        title: "Pick a course",
        body: "<p>Pick the course to take.</p><p>Both keep the crew on schedule.</p>",
        actions: [
          { id: "hold", label: "Hold course" },
          { id: "change", label: "Plot new course", default: true },
        ],
      });
      await settle();
      const card = cards().find((entry) => entry.title === "Pick a course") as Card;
      supervisor.cardActions.replyToCard(card.id, "what about the northern route?");
      await settle();
      await endTurn(crewmate, taskId);
      await at(minutes(11));
      // INF-990 friction 4: the reminders name the card the captain wrote
      // under, so its crewmate answers that card and not another of its own.
      expect(crewmate.promptCalls.at(-1)).toBe(
        `The captain wrote under your card "Pick a course" (${card.id}) and you have not answered: answer in that card's thread with reply, naming its card_id, or pass your answer as the reply of that card's emit_card revision under the same id, naming their message in answers_message.`,
      );
      await endTurn(crewmate, taskId);
      await at(minutes(21));
      await at(minutes(51));
      const state = `since the captain wrote under card "Pick a course" (${card.id}), without answering them, and nothing queued will; the host's nudge did not move it.`;
      expect(idleWakes(ops)).toEqual([
        `[fm-op] crewmate 1 on task ${taskId} "Job" has been idle for 21m ${state} Its last report: Done with step one.${stallBlock(taskId)}`,
        `[fm-op] crewmate 1 on task ${taskId} "Job" has been idle for 51m ${state}${SECOND} Its last report: Done with step one.${stallBlock(taskId)}`,
      ]);
    });

    it("the stall wake after a failed turn, with no nudge to claim", async () => {
      const { crewmate, ops, at, taskId } = await stopped();
      crewmate.emit({ type: "continuation_started" });
      crewmate.emit({ type: "continuation_ended", error: "upstream 500" });
      await settle();
      await at(minutes(21));
      await at(minutes(51));
      expect(idleWakes(ops)).toEqual([
        `[fm-op] crewmate 1 on task ${taskId} "Job" has been idle for 21m with nothing running, nothing queued and no card up. Its last turn hit a problem: upstream 500${stallBlock(taskId)}`,
        `[fm-op] crewmate 1 on task ${taskId} "Job" has been idle for 51m with nothing running, nothing queued and no card up.${SECOND} Its last turn hit a problem: upstream 500${stallBlock(taskId)}`,
      ]);
    });

    it("the wake a captain gate with no reason owes", async () => {
      const { ops, taskId, tasks, at } = await stopped();
      tasks.placement.setGate(taskId, { kind: "captain", ref: HEAD });
      await at(minutes(20));
      expect(ops.filter((line) => line.includes("is held for the captain"))).toEqual([
        `[fm-op] task ${taskId} "Job" is held for the captain and has had no card up for 20m: its crewmate cannot move until the captain answers one.${heldBlock(taskId, "captain-gate")}`,
      ]);
    });

    it("the nudge rides its lane as typed facts, and each ledger row records the served text", async () => {
      const { crewmate, ops, ledger, taskId, at, db } = await stopped();
      const rows = ledger.length;
      await at(minutes(10));
      expect(crewmate.promptCalls.at(-1)).toBe(IDLE_NUDGE_TEXT);
      // In flight on the task's lane: the stored envelope (migration 48's
      // payload) names the nudge's facts, not its sentence.
      const stored = db.prepare("SELECT payload FROM inbox WHERE recipient = ?").all(taskId) as {
        payload: string;
      }[];
      expect(stored.map((row) => JSON.parse(row.payload))).toEqual([
        { v: 1, facts: { kind: "idle-nudge", thread: false } },
      ]);
      await endTurn(crewmate, taskId);
      await at(minutes(20));
      expect(ledger.slice(rows)).toEqual([IDLE_NUDGE_TEXT, idleWakes(ops)[0]]);
    });
  });

  // The outage wakes and the job bound on the typed envelope (the
  // primitives review's P3, third family). Every literal below is the text
  // the prose templates served before the move, byte for byte.
  describe("the served text of the outage wakes and the job bound (the typed envelope, P3)", () => {
    const outageWakes = (ops: string[]) => ops.filter((line) => line.includes("at the provider"));
    const boundWakes = (ops: string[]) =>
      ops.filter((line) => line.includes("background job running"));

    /** A stopped crewmate whose guidance the provider has failed `failures` times. */
    async function failing(failures: number) {
      const harness = await stopped();
      const { supervisor, crewmate, taskId } = harness;
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      await failTurn(crewmate, taskId);
      for (let failure = 2; failure <= failures; failure += 1) {
        await sweepWhenDue(harness, taskId);
        await failTurn(crewmate, taskId);
      }
      return harness;
    }

    /**
     * A fresh supervisor over the same database (an app restart): no runtime
     * and no in-memory state survive, the rows do.
     */
    function restart(harness: Awaited<ReturnType<typeof stopped>>, extras: SetupExtras = {}) {
      harness.supervisor.disposeAll();
      const ops: string[] = [];
      const sorts: { rule: string }[] = [];
      const fresh = reboot(
        { paths: harness.paths, db: harness.db, workspace: harness.workspace },
        vi.fn(async () => harness.crewmate),
        {
          now: hostClock,
          ...(extras.hasRunningJobs ? { hasRunningJobs: extras.hasRunningJobs } : {}),
          ...(extras.oldestRunningJob ? { oldestRunningJob: extras.oldestRunningJob } : {}),
          recordSort: (input) => {
            sorts.push({ rule: input.rule });
            input.effect?.();
          },
        },
      );
      return { ...wakesThroughInbox({ supervisor: fresh, inbox: harness.inbox, ops }), sorts };
    }

    it("one outage: its first failure, still down, and recovered", async () => {
      const harness = await failing(6);
      const { crewmate, ops, taskId } = harness;
      await sweepWhenDue(harness, taskId);
      await endTurn(crewmate, taskId);
      expect(outageWakes(ops)).toEqual([
        `[fm-op] crewmate 1's turn on task ${taskId} "Job" failed at the provider: upstream 529. Nothing was set aside: the host keeps its guidance and retries it on its own, backing off to every 15 minutes, so do not resend it. You will hear when it answers again, and if it is still failing in 15 minutes. You can still steer or interrupt it.`,
        `[fm-op] crewmate 1 on task ${taskId} "Job" is still failing at the provider after 20 minutes and 4 tries. Its guidance is kept and retried every 15 minutes until the provider answers; nothing is lost. You can steer or interrupt it, or wait.`,
        `[fm-op] crewmate 1 on task ${taskId} "Job" is answering again after 6 failed tries at the provider; its guidance went through.`,
      ]);
    });

    it("still down after a restart, named by the task's key", async () => {
      const harness = await failing(2);
      const fresh = restart(harness);
      clock.now = clock.now + STILL_DOWN_MS;
      fresh.supervisor.watch.reconcileIdle(clock.now);
      await settle();
      expect(fresh.ops).toEqual([
        `[fm-op] the crewmate on SCR-1 on task ${harness.taskId} "Job" is still failing at the provider after 17 minutes and 2 tries. Its guidance is kept and retried every 15 minutes until the provider answers; nothing is lost. You can steer or interrupt it, or wait.`,
      ]);
    });

    it("the job bound", async () => {
      let started = clock.now;
      const { ops, ledger, taskId, at, idleSince } = await stopped({
        hasRunningJobs: () => true,
        oldestRunningJob: () => ({ jobId: "poll-1", command: "gh run watch", startedAt: started }),
      });
      started = idleSince;
      await at(JOB_BOUND_MS + minutes(30));
      expect(boundWakes(ops)).toEqual([
        `[fm-op] task ${taskId} "Job" has had a background job running for 2.5 hours: "gh run watch". It no longer counts as the task moving, so the idle ladder now watches the task; the job itself keeps running.`,
      ]);
      // The ledger row records the text the Firstmate is served.
      expect(ledger).toContain(boundWakes(ops)[0]);
    });

    const stillDownWakes = (ops: string[]) =>
      ops.filter((line) => line.includes("is still failing at the provider"));

    /**
     * What stands between a once-wake and the next look at its task - the
     * three things the inbox's content dedupe cannot see past.
     */
    const DISTURBANCES = [
      "an app restart",
      "an intervening wake on the task",
      "its ack and more than five minutes",
    ] as const;

    function disturb(
      harness: Awaited<ReturnType<typeof stopped>>,
      how: (typeof DISTURBANCES)[number],
      extras: SetupExtras = {},
    ): {
      supervisor: CrewSupervisor;
      ops: string[];
      before: number;
      sorts: { rule: string }[];
      sortsBefore: number;
    } {
      if (how === "an app restart") {
        return { ...restart(harness, extras), before: 0, sortsBefore: 0 };
      }
      if (how === "an intervening wake on the task") {
        harness.inbox.enqueueWake(
          FIRSTMATE_RECIPIENT,
          `[fm-op] task ${harness.taskId} has news.`,
          "agent",
          harness.taskId,
        );
      } else {
        // The Firstmate's turn over the lane ended clean.
        harness.inbox.ack(harness.inbox.allFor(FIRSTMATE_RECIPIENT).map((row) => row.id));
        clock.now = clock.now + INBOX_DEDUPE_WINDOW_MS + minutes(1);
      }
      return {
        supervisor: harness.supervisor,
        ops: harness.ops,
        before: harness.ops.length,
        sorts: harness.sorts,
        sortsBefore: harness.sorts.length,
      };
    }

    /** A few more ticks, a minute apart, on whichever supervisor is live. */
    async function ticks(supervisor: CrewSupervisor, count = 3) {
      for (let n = 0; n < count; n += 1) {
        clock.now = clock.now + minutes(1);
        supervisor.watch.reconcileIdle(clock.now);
        await settle();
      }
    }

    /** A new outage on the lane, at the store: its rows fail at the provider again from now. */
    function newOutage(inbox: InboxStore, taskId: string) {
      inbox.endOutage(taskId);
      const ids = inbox.allFor(taskId).map((row) => row.id);
      inbox.markDelivered(ids);
      inbox.releaseAfterProviderFailure(ids);
    }

    it.each(DISTURBANCES)("still down goes out once per outage, past %s", async (how) => {
      const harness = await failing(2);
      const { supervisor, inbox, ops, taskId } = harness;
      const since = inbox.outage(taskId).since ?? 0;
      clock.now = since + STILL_DOWN_MS;
      supervisor.watch.reconcileIdle(clock.now);
      await settle();
      expect(stillDownWakes(ops)).toHaveLength(1);

      const after = disturb(harness, how);
      clock.now = clock.now + minutes(1);
      after.supervisor.watch.reconcileIdle(clock.now);
      await settle();
      await ticks(after.supervisor);
      expect(inbox.outage(taskId).since).toBe(since);
      expect(stillDownWakes(after.ops.slice(after.before))).toEqual([]);

      // A new outage on the same task is its own, and is woken for.
      newOutage(inbox, taskId);
      clock.now = clock.now + STILL_DOWN_MS;
      after.supervisor.watch.reconcileIdle(clock.now);
      await settle();
      expect(stillDownWakes(after.ops.slice(after.before))).toHaveLength(1);
    });

    it.each(DISTURBANCES)("the job bound goes out once per job, past %s", async (how) => {
      let job = { jobId: "poll-1", command: "gh run watch", startedAt: clock.now };
      const jobs: SetupExtras = { hasRunningJobs: () => true, oldestRunningJob: () => job };
      const harness = await stopped(jobs);
      const { crewmate, taskId, at, idleSince } = harness;
      job = { ...job, startedAt: idleSince };
      const boundRows = (sorts: { rule: string }[]) =>
        sorts.filter((sort) => sort.rule === "job-bound");
      await at(JOB_BOUND_MS);
      expect(boundWakes(harness.ops)).toHaveLength(1);
      expect(boundRows(harness.sorts)).toHaveLength(1);
      // The ladder climbs from its first rung once the job stops counting.
      await endTurn(crewmate, taskId);

      const after = disturb(harness, how, jobs);
      await ticks(after.supervisor);
      expect(boundWakes(after.ops.slice(after.before))).toEqual([]);
      // Nor does a repeat spend a ledger row.
      expect(boundRows(after.sorts.slice(after.sortsBefore))).toEqual([]);

      // A new job past its bound is its own, and is woken for.
      job = { jobId: "poll-2", command: "gh run watch", startedAt: clock.now - JOB_BOUND_MS };
      await ticks(after.supervisor);
      expect(boundWakes(after.ops.slice(after.before))).toHaveLength(1);
      expect(boundRows(after.sorts.slice(after.sortsBefore))).toHaveLength(1);
    });

    it("a new outage after the provider answered is woken for from its first failure", async () => {
      const harness = await failing(5);
      const { crewmate, ops, taskId } = harness;
      await sweepWhenDue(harness, taskId);
      await endTurn(crewmate, taskId);
      expect(stillDownWakes(ops)).toHaveLength(1);
      await harness.supervisor.steer.steerCrewmate(taskId, "now the tests");
      await settle();
      await failTurn(crewmate, taskId);
      for (let failure = 2; failure <= 5; failure += 1) {
        await sweepWhenDue(harness, taskId);
        await failTurn(crewmate, taskId);
      }
      expect(outageWakes(ops).map((line) => line.split(" on task ")[0])).toEqual([
        "[fm-op] crewmate 1's turn",
        "[fm-op] crewmate 1",
        "[fm-op] crewmate 1",
        "[fm-op] crewmate 1's turn",
        "[fm-op] crewmate 1",
      ]);
      expect(stillDownWakes(ops)).toHaveLength(2);
    });

    it("the outage wakes and the job bound ride the Firstmate's lane as typed facts", async () => {
      let job = { jobId: "poll-1", command: "gh run watch", startedAt: clock.now };
      const harness = await stopped({
        hasRunningJobs: () => true,
        oldestRunningJob: () => job,
      });
      // The stored rows are the claim: a Firstmate that takes none leaves them there.
      wakesThroughInbox(harness, "paused");
      const { supervisor, crewmate, inbox, db, taskId, idleSince } = harness;
      job = { ...job, startedAt: idleSince };
      await supervisor.steer.steerCrewmate(taskId, "use the other library");
      await settle();
      await failTurn(crewmate, taskId);
      const since = inbox.outage(taskId).since ?? 0;
      await sweepWhenDue(harness, taskId);
      await failTurn(crewmate, taskId);
      clock.now = since + STILL_DOWN_MS;
      supervisor.watch.reconcileIdle(clock.now);
      await settle();
      await sweepWhenDue(harness, taskId);
      await endTurn(crewmate, taskId);
      clock.now = idleSince + JOB_BOUND_MS;
      supervisor.watch.reconcileIdle(clock.now);
      await settle();

      const KINDS = ["outage-failed", "outage-still-down", "outage-recovered", "job-bound"];
      const stored = (
        db
          .prepare("SELECT payload FROM inbox WHERE recipient = ? ORDER BY id")
          .all(FIRSTMATE_RECIPIENT) as { payload: string }[]
      )
        .map((row) => JSON.parse(row.payload) as { facts?: { kind: string } })
        .filter((row) => KINDS.includes(row.facts?.kind ?? ""));
      const task = { id: taskId, title: "Job" };
      expect(stored).toEqual([
        {
          v: 1,
          facts: { kind: "outage-failed", task, crewmate: "crewmate 1", error: "upstream 529" },
        },
        {
          v: 1,
          facts: {
            kind: "outage-still-down",
            task,
            crewmate: "crewmate 1",
            key: "SCR-1",
            since,
            downMs: STILL_DOWN_MS,
            failures: 2,
          },
        },
        { v: 1, facts: { kind: "outage-recovered", task, crewmate: "crewmate 1", failures: 2 } },
        {
          v: 1,
          facts: {
            kind: "job-bound",
            task,
            jobId: "poll-1",
            command: "gh run watch",
            runMs: JOB_BOUND_MS,
          },
        },
      ]);
      const served = inbox
        .allFor(FIRSTMATE_RECIPIENT)
        .filter((row) => KINDS.includes(row.facts?.kind ?? ""))
        .map(renderWake);
      expect(served).toEqual([
        `[fm-op] crewmate 1's turn on task ${taskId} "Job" failed at the provider: upstream 529. Nothing was set aside: the host keeps its guidance and retries it on its own, backing off to every 15 minutes, so do not resend it. You will hear when it answers again, and if it is still failing in 15 minutes. You can still steer or interrupt it.`,
        `[fm-op] crewmate 1 on task ${taskId} "Job" is still failing at the provider after 15 minutes and 2 tries. Its guidance is kept and retried every 15 minutes until the provider answers; nothing is lost. You can steer or interrupt it, or wait.`,
        `[fm-op] crewmate 1 on task ${taskId} "Job" is answering again after 2 failed tries at the provider; its guidance went through.`,
        `[fm-op] task ${taskId} "Job" has had a background job running for 2 hours: "gh run watch". It no longer counts as the task moving, so the idle ladder now watches the task; the job itself keeps running.`,
      ]);
    });
  });
});
