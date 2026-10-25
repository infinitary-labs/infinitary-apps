import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { budgetTimer } from "./budgets.ts";

/** INF-1122: keep the owned simulator's log before XCTest can tear its domain down.
 * A post-failure `simctl spawn log show` can no longer enter that domain. This live
 * stream retains everything it heard, including the reason it stopped, and joins
 * both pipes and its evidence writer before the simulator is deleted.
 */
export async function observePhoneLog({
  device,
  env,
  evidence,
  children,
  predicate,
  onLine,
}: {
  device: string;
  env: NodeJS.ProcessEnv;
  evidence: string;
  children: Set<ChildProcess>;
  predicate: string;
  onLine?: (line: string) => void;
}): Promise<{ close(): Promise<void> }> {
  const output = createWriteStream(join(evidence, "simulator-live.log"));
  const child = spawn(
    "xcrun",
    [
      "simctl",
      "spawn",
      device,
      "log",
      "stream",
      "--style",
      "compact",
      "--level",
      "info",
      "--predicate",
      predicate,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  const lines = onLine ? createInterface({ input: child.stdout }) : undefined;
  if (onLine) lines?.on("line", onLine);
  let stopped = false;
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => {
      stopped = true;
      children.delete(child);
      output.end();
      resolve();
    }),
  );
  const written = new Promise<void>((resolve, reject) => {
    output.once("finish", resolve);
    output.once("error", reject);
  });
  written.catch(() => {});
  const close = async () => {
    if (!stopped) child.kill("SIGTERM");
    await exited;
    lines?.close();
    await written;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let heard = "";
      let waiting = true;
      const deadline = budgetTimer(
        () => reject(new Error("The simulator log did not start")),
        15_000,
      );
      const ready = () => {
        deadline.cancel();
        resolve();
      };
      const failed = (error: Error) => {
        deadline.cancel();
        reject(error);
      };
      output.once("error", failed);
      child.once("error", failed);
      child.once("close", () => failed(new Error("The simulator log stopped before it started")));
      child.stdout.on("data", (data: Buffer) => {
        output.write(data);
        if (waiting) {
          heard += data.toString();
          if (heard.includes("Filtering the log data using ")) {
            waiting = false;
            heard = "";
            ready();
          }
        }
      });
      child.stderr.on("data", (data: Buffer) => output.write(data));
    });
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
