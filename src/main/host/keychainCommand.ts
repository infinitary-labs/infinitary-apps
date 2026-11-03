import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hostEnv } from "@core/hostEnv";

const execFileAsync = promisify(execFile);

/** The reader's external command must not outlive a timed-out reader process. */
export async function runKeychainCommand(
  file: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number },
): Promise<string> {
  const running = execFileAsync(file, args, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: options.maxBuffer,
    env: hostEnv(),
    windowsHide: true,
  });
  // utilityProcess.kill sends SIGTERM. While the asynchronous tool is alive,
  // kill it too, then restore SIGTERM's normal termination. Outside this
  // interval a stuck native call has no JS signal handler to delay its kill.
  const terminate = () => {
    running.child.once("close", () => {
      process.removeListener("SIGTERM", terminate);
      process.kill(process.pid, "SIGTERM");
    });
    running.child.kill("SIGKILL");
  };
  process.once("SIGTERM", terminate);
  try {
    const { stdout } = await running;
    return stdout;
  } finally {
    process.removeListener("SIGTERM", terminate);
  }
}
