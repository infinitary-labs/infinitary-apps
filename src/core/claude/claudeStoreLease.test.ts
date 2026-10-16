import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codingSpec } from "../../../tests/helpers/codingSession";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  scriptedClaudeFactory,
  scriptedClaudeQuery,
  scriptedRecordsFlushed,
} from "../../../tests/helpers/scriptedClaudeQuery";
import { renewClaudeQuotaAuth } from "./claudeQuota";
import {
  acquireSessionLease,
  hasActiveSession,
  resetStoreLeasesForTest,
  runExclusiveStoreTask,
  runRenewalStoreTask,
  tryExclusiveStoreTask,
} from "./claudeStoreLease";

/**
 * The three paths that can rewrite one Claude account's credential store -
 * a session's client, a one-shot client run, and the quota sensor's
 * delegated renewal - share one owner. These exercise the REAL coordination
 * through the real session, not a stand-in for it: the refresh token behind
 * that store is single use, so "who may spawn the client right now" has to
 * be one question with one answer.
 */

const credentialJson = (accessToken: string, expiresAt?: number) =>
  JSON.stringify({ claudeAiOauth: { accessToken, ...(expiresAt ? { expiresAt } : {}) } });

function storeDir(): string {
  const dir = scratchDir("infinitary-lease-");
  writeFileSync(join(dir, ".credentials.json"), credentialJson("stale", 1000));
  return dir;
}

/**
 * A crewmate session on a store, opened the way its owner opens one, over a
 * client that answers each prompt in one turn and then stays attached, idle.
 * `spawned` hears each client start.
 */
function crewmateOn(dir: string, owner: string, spawned: () => void = () => {}) {
  const { factory } = scriptedClaudeQuery({
    onInput: (message, emit) => {
      emit({ type: "system", subtype: "session_state_changed", state: "running" });
      emit({ type: "user", isReplay: true, uuid: message.uuid, message: message.message });
      emit({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        total_cost_usd: 0,
        modelUsage: {},
      });
      emit({ type: "system", subtype: "session_state_changed", state: "idle" });
    },
  });
  return scriptedClaudeFactory({
    configDir: dir,
    query: (params) => {
      spawned();
      return factory(params);
    },
  }).open(
    codingSpec({
      binding: { backend: "claude", accountId: "acct_claude" },
      cwd: "/tmp/worktree",
      owner,
      instructions: "crew",
    }),
  );
}

describe("the Claude store lease", () => {
  beforeEach(() => {
    resetStoreLeasesForTest();
  });

  afterEach(scriptedRecordsFlushed);

  it("a live crewmate session makes a delegated renewal stand down", async () => {
    const dir = storeDir();
    const run = vi.fn(async () => {});
    const session = await crewmateOn(dir, "task-1");
    try {
      // Its client stays attached after the turn, for the work it does on its own.
      await session.prompt("go");
      expect(hasActiveSession(dir)).toBe(true);
      // The session owns the store. Renewing now is how one holder ends up
      // presenting a spent single-use refresh token.
      await expect(renewClaudeQuotaAuth(dir, { run, now: () => 2000 })).resolves.toEqual({
        outcome: "deferred_session",
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
    // The session ended and its client exited: the store is free and renewal may proceed.
    await session.closed();
    expect(hasActiveSession(dir)).toBe(false);
    await renewClaudeQuotaAuth(dir, { run, now: () => 2000 });
    expect(run).toHaveBeenCalled();
  });

  it("a client started while a store task runs waits it out - they never overlap", async () => {
    const dir = storeDir();
    const order: string[] = [];
    let releaseTask: (() => void) | undefined;
    const task = runExclusiveStoreTask(dir, async () => {
      order.push("task:start");
      await new Promise<void>((resolve) => {
        releaseTask = resolve;
      });
      order.push("task:end");
    });
    // Give the task a tick to claim the store, then race a client against it.
    await Promise.resolve();
    const session = await crewmateOn(dir, "task-2", () => order.push("client:start"));
    const turn = session.prompt("go");
    await vi.waitFor(() => expect(order).toEqual(["task:start"]));
    releaseTask?.();
    await task;
    await turn;
    session.dispose();
    await session.closed();
    expect(order).toEqual(["task:start", "task:end", "client:start"]);
  });

  it("claims the store in the same tick it checks it - there is no window to lose", async () => {
    const dir = storeDir();
    // Both callers ask at once. Whichever wins holds the store from the moment
    // it decided, so the loser can only ever be refused - never overlap.
    const [first, second] = await Promise.all([
      tryExclusiveStoreTask(dir, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "ran";
      }),
      tryExclusiveStoreTask(dir, async () => "ran"),
    ]);
    expect([first.ran, second.ran].filter(Boolean)).toHaveLength(1);
    const refused = [first, second].find((result) => !result.ran);
    expect(refused).toMatchObject({ ran: false, refusal: "store_busy" });
  });

  it("a renewal waits out an ordinary one-shot run instead of standing down", async () => {
    const dir = storeDir();
    const order: string[] = [];
    let releaseProbe: (() => void) | undefined;
    // The status probe, exactly as claudeAuth makes it.
    const probe = tryExclusiveStoreTask(dir, async () => {
      order.push("probe:start");
      await new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      order.push("probe:end");
    });
    await Promise.resolve();
    const renewal = runRenewalStoreTask(dir, async () => {
      order.push("renewal:ran");
      return "ok";
    });
    // The renewal is waiting, not refused: nothing has run yet.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["probe:start"]);
    releaseProbe?.();
    await probe;
    await expect(renewal).resolves.toEqual({ ran: true, value: "ok" });
    expect(order).toEqual(["probe:start", "probe:end", "renewal:ran"]);
  });

  it("a renewal gives up waiting rather than stalling a refresh behind a sign-in", async () => {
    const dir = storeDir();
    let releaseLogin: (() => void) | undefined;
    const login = runExclusiveStoreTask(dir, async () => {
      await new Promise<void>((resolve) => {
        releaseLogin = resolve;
      });
    });
    await Promise.resolve();
    const refused = await runRenewalStoreTask(dir, async () => "ran", 10);
    expect(refused).toEqual({ ran: false, refusal: "store_busy" });
    releaseLogin?.();
    await login;
  });

  it("a renewal still stands down for a live session, however long it waits", async () => {
    const dir = storeDir();
    const release = await acquireSessionLease(dir);
    const refused = await runRenewalStoreTask(dir, async () => "ran");
    release();
    expect(refused).toEqual({ ran: false, refusal: "session_active" });
    // ...and the very next attempt proceeds: standing down is transient.
    await expect(runRenewalStoreTask(dir, async () => "ran")).resolves.toEqual({
      ran: true,
      value: "ran",
    });
  });

  it("refuses a one-shot task while a session holds the store, by session and not by guess", async () => {
    const dir = storeDir();
    const release = await acquireSessionLease(dir);
    const refused = await tryExclusiveStoreTask(dir, async () => "ran");
    release();
    const allowed = await tryExclusiveStoreTask(dir, async () => "ran");
    expect(refused).toEqual({ ran: false, refusal: "session_active" });
    expect(allowed).toEqual({ ran: true, value: "ran" });
  });
});
