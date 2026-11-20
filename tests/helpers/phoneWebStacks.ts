import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PhoneWebProcess } from "./phoneStacks";

// Existing diagnostic trigger, shared with the prestarted guest observer; not a test wait.
export const phoneWebLaunchObservationMs = 10_000;

/** The same extension identity appears in RunningBoard replies and both native
 * running-state readings. Logs may arrive out of order or omit the reply itself.
 */
function runningProcess(line: string) {
  if (
    !/ (?:runningboardd|SpringBoard)\[\d+:[^\]]+\] \[com\.apple\.runningboard:(?:process|monitor)\]/.test(
      line,
    )
  )
    return;
  const extension =
    /extension<com\.apple\.WebKit\.(WebContent|GPU)\[config:[^\]]+\]\(\(null\):(\d+)\)>\[uuid:([^\]]+)\](?::(\d+))?/.exec(
      line,
    );
  if (!extension) return;
  const reply = /\] with pid: (\d+); launch assertion:/.exec(line);
  const received = /Received state update for (\d+) \(extension</.exec(line);
  const running = /, running-active(?:-|$)/.test(line);
  const calculated = /Calculated state for extension<.*: running-active(?: |$)/.test(line);
  const pid =
    reply && reply[1] === extension[4]
      ? Number(reply[1])
      : received && running
        ? Number(received[1])
        : undefined;
  if (!pid && !calculated) return;
  return {
    app: Number(extension[2]),
    kind: extension[1] as PhoneWebProcess["kind"],
    request: extension[3]!,
    pid,
    observedAt: line.slice(0, 23),
  };
}

/** INF-1936 investigation: sample the owned simulator while a launch is pending,
 * not after XCTest's failure has released it. A missing log reply is not a verdict;
 * the stacks say what was actually running. No test wait or result changes.
 */
export function capturePhoneWebStacks({
  evidence,
  capture,
}: {
  evidence: string;
  capture(app: number, destination: string, extensions: PhoneWebProcess[]): Promise<void>;
}) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const extensions = new Map<number, PhoneWebProcess>();
  const captures = new Map<string, Promise<void>>();
  let closed = false;
  const start = (
    kind: string,
    app: number,
    line: string,
    receivedAt: string,
    targets: PhoneWebProcess[] = [],
  ) => {
    if (closed || captures.has(kind)) return;
    const destination = join(evidence, `web-${kind}`);
    const observed = `Log received at ${receivedAt}\nCapture triggered at ${new Date().toISOString()}\n${line}\n`;
    writeFileSync(`${destination}-capture.log`, observed);
    captures.set(
      kind,
      capture(app, destination, targets).then(
        () => writeFileSync(`${destination}-capture.log`, `${observed}Capture completed.\n`),
        (error: unknown) =>
          writeFileSync(
            `${destination}-capture.log`,
            `${observed}Capture failed: ${String(error)}\nNo retry was made.\n`,
          ),
      ),
    );
  };
  return {
    receive(line: string) {
      if (closed) return;
      const state = runningProcess(line);
      if (state) {
        const key = `${state.app}:${state.request}`;
        running.add(key);
        clearTimeout(pending.get(key));
        pending.delete(key);
        if (state.pid) extensions.set(state.pid, { ...state, pid: state.pid });
      }
      const request =
        / Infinitary\[(\d+):[^\]]+\] \[com\.apple\.runningboard:general\] Sending launch request: <RBSLaunchRequest\| extension<com\.apple\.WebKit\.(?:WebContent|GPU)\[config:[^\]]+\]\(\(null\):(\d+)\)>\[uuid:([^\]]+)\]/.exec(
          line,
        );
      const id = request?.[3];
      const key = `${request?.[1]}:${id}`;
      if (id && request?.[1] === request?.[2] && !pending.has(key) && !running.has(key)) {
        const receivedAt = new Date().toISOString();
        // Diagnostic sampling only: ten seconds leaves time to sample before the
        // existing 200-second reveal cap. It neither extends nor grades that cap.
        pending.set(
          key,
          setTimeout(() => {
            pending.delete(key);
            start("launch", Number(request?.[1]), line, receivedAt);
          }, phoneWebLaunchObservationMs),
        );
      }
      const render =
        / Infinitary\[(\d+):[^\]]+\] \[com\.apple\.WebKit:RemoteLayerBuffers\] WebContent\[(\d+)\] \[renderingBackend=\d+\] RemoteRenderingBackendProxy::didBecomeUnresponsive$/.exec(
          line,
        );
      if (render) {
        const app = Number(render[1]);
        const web: PhoneWebProcess = {
          app,
          pid: Number(render[2]),
          kind: "WebContent",
          observedAt: line.slice(0, 23),
        };
        // The fault identifies its WebContent PID directly. GPU candidates must
        // also have a running-state or launch-reply witness naming this same app.
        const gpu = [...extensions.values()].filter(
          (process) => process.app === app && process.kind === "GPU",
        );
        start("render", app, line, new Date().toISOString(), [web, ...gpu]);
      }
    },
    async close() {
      closed = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      await Promise.all(captures.values());
    },
  };
}
