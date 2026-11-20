import { type ChildProcess, fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { beforeAll, expect, it } from "vitest";
import { bundleKeychainProcess } from "../../../tests/helpers/keychainProcessBundle";
import { reachMark } from "../../../tests/helpers/reachMark";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createKeychainRequester, createProcessKeychain } from "./keychainProcess";

let helperPath: string;
beforeAll(async () => {
  helperPath = await bundleKeychainProcess(`
import { readFileSync } from "node:fs";
import { createDarwinKeychain } from "@keychain";
import { runKeychainCommand } from "@keychainCommand";
const blocked = process.env.TEST_BLOCKED_CALL;
function block(call) {
  if (call !== blocked) return;
  process.send({ blocked: call });
  // A synchronous native-call stand-in. Only the parent can release stdin.
  readFileSync(0);
}
const readStatus = () => { block("status"); return "unlocked"; };
const api = {
  setUserInteractionAllowed() {},
  findGenericPassword() { block("presence"); return { status: 0, modifiedAt: "20261028120000Z", locked: blocked === "unlock", keychainPath: "/scratch/store.keychain-db", account: "kun" }; },
  claudeItemTrustsAppleTool() { block("permission"); return blocked === "tool"; },
  readGenericPassword() { block("value"); return { status: 0, value: JSON.stringify({ claudeAiOauth: { accessToken: "disposable" } }) }; },
};
const reader = createDarwinKeychain(api, async () => { block("unlock"); return 0; }, async () => ({
  kind: "value", value: await runKeychainCommand(process.execPath, ["-e", \`
    require("node:fs").appendFileSync(process.env.TEST_PID_FILE, String(process.pid));
    process.stdin.resume();
  \`], { timeoutMs: 30000, maxBuffer: 1024 })
}));
`);
});

// INF-2321: a stalled Security.framework call must not freeze the host.
// Fixture: real fork/IPC and the real native-reader orchestration; only the
// OS calls are stand-ins. Completion is ordered, never a wall-clock assertion.
it.each(["status", "presence", "permission", "value", "unlock"])(
  "the host responds while %s is synchronously blocked in its child",
  async (blocked) => {
    let child: ChildProcess | undefined;
    let notifyBlocked!: () => void;
    let rejectStarted!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => {
      notifyBlocked = resolve;
      rejectStarted = reject;
    });
    const options = {
      helperPath,
      allowInteraction: true,
      fork: (path: string, args: string[]) => {
        child = fork(path, args, {
          execArgv: [],
          env: { ...hostEnv(), TEST_BLOCKED_CALL: blocked },
          stdio: ["pipe", "ignore", "pipe", "ipc"],
        });
        child.once("error", rejectStarted);
        child.once("exit", () =>
          rejectStarted(new Error("reader exited before reaching the blocked call")),
        );
        child.on("message", (message) => {
          if ((message as { blocked?: string }).blocked === blocked) notifyBlocked();
        });
        return child;
      },
    };
    const reader = createProcessKeychain(options);
    const query = {
      service: "Claude Code-credentials",
      account: "kun",
      interactive: blocked === "unlock",
    };
    const operation =
      blocked === "status"
        ? createKeychainRequester(options)({
            operation: "status",
            keychainPath: "/scratch/store.keychain-db",
          })
        : blocked === "presence"
          ? reader.findGenericPassword(query)
          : blocked === "unlock"
            ? reader.unlockKeychain!(query)
            : reader.readGenericPassword(query);
    let settled = false;
    void operation.then(() => {
      settled = true;
    });
    try {
      await started;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      console.info(
        JSON.stringify({ nativeCall: blocked, hostResponded: true, childStillBlocked: true }),
      );
      child!.stdin!.end("release");
      const result = await operation;
      expect(result.kind).toBe(
        blocked === "status"
          ? "status"
          : blocked === "presence"
            ? "found"
            : blocked === "unlock"
              ? "unlocked"
              : "value",
      );
      expect(child!.exitCode).toBe(0);
      console.info(
        JSON.stringify({ nativeCall: blocked, afterRelease: result.kind, childExited: true }),
      );
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
);

// INF-2321: killing a reader must not leave Apple's command waiting behind it.
it("terminating a reader also stops and reaps its unfinished external tool", async () => {
  const dir = scratchDir("infinitary-keychain-tool-");
  const pidFile = join(dir, "pid");
  let worker: ChildProcess | undefined;
  let notify!: (pid: number) => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<number>((resolve, reject) => {
    notify = resolve;
    rejectStarted = reject;
  });
  // The tool appends its process number to a mark made here, watched as a file,
  // never through the folder: on macOS a folder's watch is FSEvents, which held
  // or dropped a new file's event past the whole budget (INF-2578).
  void reachMark(pidFile).then(() => notify(Number(readFileSync(pidFile, "utf8"))));
  const reader = createProcessKeychain({
    helperPath,
    fork: (path, args) => {
      worker = fork(path, args, {
        execArgv: [],
        env: { ...hostEnv(), HOME: dir, TEST_BLOCKED_CALL: "tool", TEST_PID_FILE: pidFile },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      worker.once("error", rejectStarted);
      worker.once("exit", () => rejectStarted(new Error("reader exited before starting its tool")));
      return worker;
    },
  });
  const result = reader.readGenericPassword({ service: "Claude Code-credentials", account: "kun" });
  try {
    const pid = await started;
    worker!.kill("SIGTERM");
    expect(await result).toMatchObject({ kind: "failed" });
    expect(() => process.kill(pid, 0)).toThrow();
    console.info(
      JSON.stringify({ readerTerminated: true, toolReaped: true, outcome: "failed, not absent" }),
    );
  } finally {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const exited = new Promise<void>((resolve) => worker!.once("exit", () => resolve()));
      worker.kill("SIGTERM");
      await exited;
    }
  }
});
