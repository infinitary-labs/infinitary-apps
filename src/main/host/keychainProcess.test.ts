import { EventEmitter } from "node:events";
import { KEYCHAIN_READ_INCOMPLETE_CODE } from "@shared/quota";
import { afterEach, expect, it, vi } from "vitest";
import {
  createProcessKeychain,
  createProcessKeychainFile,
  type KeychainProcess,
} from "./keychainProcess";
import { answerKeychainRequest } from "./keychainProcessRuntime";

const query = { service: "Claude Code-credentials", account: "kun" };
function fixture(allowInteraction = true) {
  const children: (EventEmitter & KeychainProcess)[] = [];
  const requests: { operation: string; query: typeof query & { interactive: boolean } }[] = [];
  const fork = vi.fn((_path: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    children.push(child);
    requests.push(JSON.parse(args[0]!));
    return child;
  });
  const reader = createProcessKeychain({
    helperPath: "/scratch/keychain.js",
    fork,
    allowInteraction,
    readTimeoutMs: 100,
    dialogTimeoutMs: 200,
  });
  const answer = (index: number, result: unknown, code = 0) => {
    children[index]!.emit("message", result);
    children[index]!.emit("exit", code);
  };
  return { reader, children, requests, fork, answer };
}
afterEach(() => vi.useRealTimers());

// INF-2321, approved slim step 5: all Keychain work leaves main, without losing
// silent reads, honest failures, explicit unlocks or cleanup of a stuck native call.
it("returns presence metadata and values only after their child exits", async () => {
  const f = fixture();
  const finding = f.reader.findGenericPassword(query);
  const found = { kind: "found", modifiedAt: "20261028120000Z", locked: false, account: "kun" };
  let settled = false;
  void finding.then(() => {
    settled = true;
  });
  f.children[0]!.emit("message", found);
  await Promise.resolve();
  expect(settled).toBe(false);
  f.children[0]!.emit("exit", 0);
  expect(await finding).toEqual(found);
  const reading = f.reader.readGenericPassword(query);
  f.answer(1, { kind: "value", value: "a-disposable-value" });
  expect(await reading).toEqual({ kind: "value", value: "a-disposable-value" });
  expect(f.requests.map((r) => r.operation)).toEqual(["find", "read"]);
});

it("coalesces concurrent requests but a later read starts fresh after an external change", async () => {
  const f = fixture();
  const first = f.reader.findGenericPassword(query);
  const second = f.reader.findGenericPassword(query);
  expect(f.fork).toHaveBeenCalledTimes(1);
  f.answer(0, { kind: "absent" });
  expect(await first).toEqual({ kind: "absent" });
  expect(await second).toEqual({ kind: "absent" });
  const later = f.reader.findGenericPassword(query);
  f.answer(1, { kind: "found", modifiedAt: "20261028120001Z" });
  expect(await later).toMatchObject({ kind: "found" });
  expect(f.fork).toHaveBeenCalledTimes(2);
});

it("keeps presence and every work-computer call silent, even when asked for interaction", async () => {
  for (const allowed of [false, true]) {
    const f = fixture(allowed);
    const presence = f.reader.findGenericPassword({ ...query, interactive: true });
    const read = f.reader.readGenericPassword({ ...query, interactive: true });
    expect(f.requests.map((r) => r.query.interactive)).toEqual([false, allowed]);
    f.answer(0, { kind: "found" });
    f.answer(1, { kind: "failed", code: -25308, message: "User interaction is not allowed." });
    await presence;
    expect(await read).toMatchObject({ kind: "failed", code: -25308 });
    if (!allowed) expect(f.reader.unlockKeychain).toBeUndefined();
  }
});

it("only starts an unlock after explicit interaction and preserves cancellation", async () => {
  const f = fixture();
  expect(await f.reader.unlockKeychain!(query)).toMatchObject({ kind: "failed", code: -25308 });
  expect(f.fork).not.toHaveBeenCalled();
  const unlock = f.reader.unlockKeychain!({ ...query, interactive: true });
  f.answer(0, { kind: "failed", code: -128, message: "User canceled the operation." });
  expect(await unlock).toMatchObject({ kind: "failed", code: -128 });
  expect(f.requests[0]).toEqual({ operation: "unlock", query: { ...query, interactive: true } });
});

it("keeps crashes, unanswered exits and malformed answers distinct from absence", async () => {
  for (const response of [undefined, { kind: "absent" }, { kind: "value", value: 42 }]) {
    const f = fixture();
    const reading = f.reader.readGenericPassword(query);
    f.answer(0, response, response && response.kind === "absent" ? 1 : 0);
    expect(await reading).toMatchObject({ kind: "failed", code: KEYCHAIN_READ_INCOMPLETE_CODE });
  }
  const reader = createProcessKeychain({
    helperPath: "unavailable",
    fork: () => {
      throw new Error("spawn failed");
    },
  });
  expect(await reader.findGenericPassword(query)).toMatchObject({
    kind: "failed",
    code: KEYCHAIN_READ_INCOMPLETE_CODE,
  });
});

it("an asynchronous launch error cannot become an absent store or leave a live timer", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const reading = f.reader.findGenericPassword(query);
  f.children[0]!.emit("error", new Error("could not start"));
  expect(await reading).toMatchObject({ kind: "failed", code: KEYCHAIN_READ_INCOMPLETE_CODE });
  expect(f.children[0]!.kill).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("kills a hung read, waits for exit, and allows the next attempt", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const reading = f.reader.readGenericPassword(query);
  let settled = false;
  void reading.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.children[0]!.kill).toHaveBeenCalledOnce();
  expect(settled).toBe(false);
  f.children[0]!.emit("exit", null);
  expect(await reading).toMatchObject({ kind: "failed", code: KEYCHAIN_READ_INCOMPLETE_CODE });
  const next = f.reader.readGenericPassword(query);
  f.answer(1, { kind: "value", value: "new value" });
  expect(await next).toMatchObject({ kind: "value" });
});

it("retains the unlock dialog's longer allowance and reports its unanswered timeout", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const unlocking = f.reader.unlockKeychain!({ ...query, interactive: true });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.children[0]!.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(f.children[0]!.kill).toHaveBeenCalledOnce();
  f.children[0]!.emit("exit", null);
  expect(await unlocking).toEqual({
    kind: "failed",
    message: "The password dialog timed out without an answer.",
  });
});

it("the child rejects malformed or unapproved unlock requests without invoking native code", async () => {
  const reader = {
    findGenericPassword: vi.fn(),
    readGenericPassword: vi.fn(),
    unlockKeychain: vi.fn(),
  };
  for (const request of ["not json", JSON.stringify({ operation: "unlock", query })]) {
    expect(await answerKeychainRequest(reader, request)).toMatchObject({ kind: "failed" });
  }
  expect(reader.unlockKeychain).not.toHaveBeenCalled();
  expect(reader.findGenericPassword).not.toHaveBeenCalled();
});

// Intent: INF-3869's second review of INF-1659 - the Mac's Secrets Unlock
// opens the custody's own keychain file by its path, never whichever store an
// item search finds, and only an explicitly interactive child may unlock it.
it("unlocks a keychain file by its path only in an interactive child of its own", async () => {
  const keychainPath = "/scratch/login.keychain-db";
  const children: (EventEmitter & KeychainProcess)[] = [];
  const sent: unknown[] = [];
  const fork = vi.fn((_path: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    children.push(child);
    sent.push(JSON.parse(args[0] ?? ""));
    return child;
  });
  const options = { helperPath: "/scratch/keychain.js", fork, readTimeoutMs: 100 };
  const answer = (index: number, message: unknown) => {
    children[index]?.emit("message", message);
    children[index]?.emit("exit", 0);
  };
  // A process that may not interact never starts an unlock child.
  expect(await createProcessKeychainFile(options).unlock(keychainPath)).toMatchObject({
    kind: "failed",
    code: -25308,
  });
  expect(fork).not.toHaveBeenCalled();
  const file = createProcessKeychainFile({ ...options, allowInteraction: true });
  const status = file.status(keychainPath);
  answer(0, { kind: "status", state: "locked" });
  expect(await status).toBe("locked");
  const unlock = file.unlock(keychainPath);
  answer(1, { kind: "unlocked" });
  expect(await unlock).toEqual({ kind: "unlocked" });
  // Two children: the silent status read never touches the unlock's process.
  expect(sent).toEqual([
    { operation: "status", keychainPath },
    { operation: "unlock-store", keychainPath, interactive: true },
  ]);

  // The child unlocks only a request marked interactive, and only that path.
  const reader = { findGenericPassword: vi.fn(), readGenericPassword: vi.fn() };
  const unlockStore = vi.fn(async () => ({ kind: "unlocked" as const }));
  for (const request of [
    { operation: "unlock-store", keychainPath },
    { operation: "unlock-store", keychainPath, interactive: false },
  ])
    expect(
      await answerKeychainRequest(reader, JSON.stringify(request), undefined, unlockStore),
    ).toMatchObject({ kind: "failed", code: -25308 });
  expect(unlockStore).not.toHaveBeenCalled();
  expect(
    await answerKeychainRequest(
      reader,
      JSON.stringify({ operation: "unlock-store", keychainPath, interactive: true }),
      undefined,
      unlockStore,
    ),
  ).toEqual({ kind: "unlocked" });
  expect(unlockStore).toHaveBeenCalledWith(keychainPath);
  expect(reader.findGenericPassword).not.toHaveBeenCalled();
});
