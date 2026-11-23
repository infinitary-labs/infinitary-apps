import { spawn } from "node:child_process";
import { hostPlatform } from "../platform";

/**
 * One git process the host runs (`git.ts`), and its output: the whole of
 * stdout, at most `maxBuffer` bytes a stream. A failure carries `stdout`,
 * `stderr`, `cmd`, the exit `code`, the `signal` that ended it and
 * `killed` once the time limit stopped it, as `execFile`'s did; an abort
 * rejects with an `AbortError`.
 *
 * A run that can be stopped - a time limit or an abort signal - leads a
 * process group of its own, and a stop ends the whole group. Git starts
 * its remote helpers as its own children: `git remote-http` and the
 * `git-remote-http` under it for an http origin, `ssh` for an ssh one.
 * Stopping git alone left them running with no parent, holding the host's
 * connection until the host dropped it, two more for every stopped attempt
 * (INF-3158). A program that put itself in a session of its own, as git's
 * detached maintenance does, is not stopped. Windows has no process group
 * to signal: there a stop ends git alone, as before.
 */
export function runGitProcess(
  file: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    maxBuffer: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  const { maxBuffer, timeoutMs, signal } = options;
  const cmd = [file, ...args].join(" ");
  const ownGroup = (Boolean(timeoutMs) || signal !== undefined) && hostPlatform() !== "win32";
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(abortError(signal), { cmd, stdout: "", stderr: "" }));
      return;
    }
    const child = spawn(file, args, { env: options.env, detached: ownGroup });
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const bytes = { stdout: 0, stderr: 0 };
    let failure: Error | undefined;
    let killed = false;
    let settled = false;
    const stop = (why?: Error): void => {
      if (killed || child.exitCode !== null || child.signalCode !== null) return;
      killed = true;
      failure ??= why;
      // Its helpers hold these pipes too: the run ends when git does.
      child.stdout.destroy();
      child.stderr.destroy();
      try {
        if (ownGroup && child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const timer = timeoutMs ? setTimeout(() => stop(), timeoutMs) : undefined;
    const onAbort = () => stop(signal ? abortError(signal) : undefined);
    signal?.addEventListener("abort", onAbort, { once: true });
    const settle = (code: number | null, ended: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(output.stdout).toString("utf8");
      const stderr = Buffer.concat(output.stderr).toString("utf8");
      if (!failure && code === 0 && ended === null) {
        resolve(stdout);
        return;
      }
      const error =
        failure ??
        Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
          code,
          killed,
          signal: ended,
        });
      reject(Object.assign(error, { cmd, stdout, stderr }));
    };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].on("data", (chunk: Buffer) => {
        const room = maxBuffer - bytes[stream];
        bytes[stream] += chunk.length;
        output[stream].push(chunk.length > room ? chunk.subarray(0, Math.max(room, 0)) : chunk);
        if (bytes[stream] > maxBuffer) {
          const overflow = new RangeError(`${stream} maxBuffer length exceeded`);
          failure ??= Object.assign(overflow, { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
          stop();
        }
      });
    }
    child.on("error", (caught) => {
      failure ??= caught;
      child.stdout.destroy();
      child.stderr.destroy();
      settle(null, null);
    });
    child.once("close", settle);
  });
}

function abortError(signal: AbortSignal): Error {
  return Object.assign(new Error("The operation was aborted", { cause: signal.reason }), {
    name: "AbortError",
    code: "ABORT_ERR",
  });
}
