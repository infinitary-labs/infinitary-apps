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
import { ClaudeAuthBackend } from "./claudeAuth";
import {
  acquireSessionLease,
  hasActiveSession,
  resetStoreLeasesForTest,
  runExclusiveStoreTask,
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
    const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    const backend = new ClaudeAuthBackend({ run, available: () => true, configDir: () => dir });
    const ref = { providerId: "anthropic-claude", accountId: "acct_claude", dir };
    const session = await crewmateOn(dir, "task-1");
    try {
      // Its client stays attached after the turn, for the work it does on its own.
      await session.prompt("go");
      expect(hasActiveSession(dir)).toBe(true);
      // The session owns the store. Renewing now is how one holder ends up
      // presenting a spent single-use refresh token.
      await expect(backend.renew(ref, "vendor_rejected")).resolves.toEqual({
        outcome: "deferred_session",
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
    await session.closed();
    expect(hasActiveSession(dir)).toBe(false);
    await backend.renew(ref, "vendor_rejected");
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
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = tryExclusiveStoreTask(dir, async () => {
      await wait;
      return "ran";
    });
    try {
      expect(await tryExclusiveStoreTask(dir, async () => "ran")).toEqual({
        ran: false,
        refusal: "store_busy",
      });
    } finally {
      release();
    }
    expect(await first).toEqual({ ran: true, value: "ran" });
  });

  // INF-2320 removes the renewal queue and its timeout. Immediate deferral
  // while a login owns the slot is exercised through the quota sensor in
  // renewalScheduling.test.ts; the same-tick claim and live-client lifetime
  // remain this owner's facts.

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
