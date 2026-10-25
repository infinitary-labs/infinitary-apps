import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** INF-1066: capture the missing blocking stack on the real UIKit fault, not after
 * the typing wait has expired. One capture per owned part; never another process,
 * a tap retry, or a new readiness condition. Cleanup joins the sampler.
 */
export function capturePhoneKeyboardTimeout({
  evidence,
  currentPid,
  sample,
}: {
  evidence: string;
  currentPid(): Promise<number>;
  sample(pid: number, destination: string): Promise<void>;
}) {
  let capture: Promise<void> | undefined;
  let closed = false;
  const status = join(evidence, "keyboard-timeout-capture.log");
  return {
    receive(line: string) {
      if (closed || capture) return;
      // The compact reading comes only from this part's simulator log stream.
      const fault =
        /\bInfinitary\[(\d+):[^\]]+\] \[com\.apple\.UIKit:KeyboardTaskQueue\].* Keyboard queue task timeout detected$/.exec(
          line,
        );
      if (!fault) return;
      const pid = Number(fault[1]);
      const observed = `Observed at ${new Date().toISOString()}\n${line}\n`;
      let started = "";
      writeFileSync(status, observed);
      capture = (async () => {
        if ((await currentPid()) !== pid)
          throw new Error(
            "The fault's app no longer owns that PID on this simulator; no process was sampled",
          );
        started = `Sampling began at ${new Date().toISOString()}\n`;
        writeFileSync(status, observed + started);
        await sample(pid, join(evidence, "keyboard-timeout-stack.log"));
        writeFileSync(
          status,
          `${observed}${started}Completed owned app stack capture at ${new Date().toISOString()}\n`,
        );
      })().catch((error: unknown) => {
        writeFileSync(
          status,
          `${observed}${started}Stack capture failed: ${String(error)}\nNo retry was made.\n`,
        );
      });
    },
    async close() {
      closed = true;
      await capture;
      if (!capture)
        writeFileSync(
          status,
          "No UIKit keyboard-queue timeout was observed; no stack capture or reproduction is claimed.\n",
        );
    },
  };
}
