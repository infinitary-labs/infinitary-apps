import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fork: vi.fn(), platform: vi.fn() }));
vi.mock("electron", () => ({ utilityProcess: { fork: mocks.fork } }));
vi.mock("@core/platform", () => ({ hostPlatform: mocks.platform }));
vi.mock("@core/hostEnv", () => ({ hostEnv: () => ({ PATH: "/scratch/bin" }) }));

import {
  createDesktopKeychain,
  createElectronKeychain,
  readElectronKeychainStatus,
} from "./electronKeychain";

beforeEach(() => {
  mocks.platform.mockReturnValue("darwin");
  mocks.fork.mockReset();
});

// INF-2321's new transport must remain hermetic in the app's test launcher;
// INF-2355 records the real service-only lookup that escaped a scratch USER.
it("an isolated Mac never starts a saved-password process for any lookup", async () => {
  mocks.fork.mockImplementation(() => {
    throw new Error("must never reach the real store");
  });
  const reader = createDesktopKeychain("/app/keychainProcessMain.js", true);
  for (const query of [
    { service: "Claude Code-credentials" },
    { service: "Claude Code-credentials", account: "kunchen", interactive: true },
  ]) {
    expect(await reader.findGenericPassword(query)).toEqual({ kind: "absent" });
    expect(await reader.readGenericPassword(query)).toEqual({ kind: "absent" });
  }
  expect(reader.unlockKeychain).toBeUndefined();
  expect(mocks.fork).not.toHaveBeenCalled();
});

it("the desktop and work host fork their reader with private output and different interaction reach", async () => {
  for (const desktop of [true, false]) {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    mocks.fork.mockReturnValueOnce(child);
    const reader = desktop
      ? createDesktopKeychain("/app/keychainProcessMain.js", false)
      : createElectronKeychain("/app/keychainProcessMain.js");
    const reading = reader.readGenericPassword({
      service: "Claude Code-credentials",
      account: "kun",
      interactive: true,
    });
    const [path, args, options] = mocks.fork.mock.calls.at(-1)!;
    expect(path).toBe("/app/keychainProcessMain.js");
    expect(JSON.parse(args[0])).toEqual({
      operation: "read",
      query: { service: "Claude Code-credentials", account: "kun", interactive: desktop },
    });
    expect(options).toMatchObject({ stdio: "ignore", env: { PATH: "/scratch/bin" } });
    child.emit("message", {
      kind: "failed",
      code: -25308,
      message: "User interaction is not allowed.",
    });
    child.emit("exit", 0);
    expect(await reading).toMatchObject({ kind: "failed", code: -25308 });
  }
});

it("a missing Mac reader reports failure, while a non-Mac host remains absent", async () => {
  expect(
    await createDesktopKeychain(undefined, false).findGenericPassword({
      service: "Claude Code-credentials",
    }),
  ).toMatchObject({ kind: "failed" });
  mocks.platform.mockReturnValue("linux");
  expect(
    await createDesktopKeychain(undefined, false).findGenericPassword({
      service: "Claude Code-credentials",
    }),
  ).toEqual({ kind: "absent" });
  expect(mocks.fork).not.toHaveBeenCalled();
});

// INF-2321: startup's native metadata probe must leave main too.
it("startup reads the account store status through a silent process and preserves unknown", async () => {
  for (const answer of [
    { kind: "status", state: "locked" },
    { kind: "failed", message: "unavailable" },
  ]) {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    mocks.fork.mockReturnValueOnce(child);
    const reading = readElectronKeychainStatus(
      "/app/keychainProcessMain.js",
      "/scratch/login.keychain-db",
    );
    const [, args] = mocks.fork.mock.calls.at(-1)!;
    expect(JSON.parse(args[0])).toEqual({
      operation: "status",
      keychainPath: "/scratch/login.keychain-db",
    });
    child.emit("message", answer);
    child.emit("exit", 0);
    expect(await reading).toBe(answer.kind === "status" ? "locked" : "unknown");
  }
});
