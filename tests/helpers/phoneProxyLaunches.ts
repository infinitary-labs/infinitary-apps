import { phoneWebLaunchObservationMs } from "./phoneWebStacks.ts";

export type PhoneProxyLaunch = {
  app: number;
  kind: "WebContent" | "GPU";
  id: string;
  pid: number;
  at: string;
};

/** INF-1936: launcher-owned file records, not a guessed process name or PID search. */
export function phoneProxyLaunchReading(line: string) {
  const match =
    /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+) \(pid\/(\d+)\/com\.apple\.WebKit\.(WebContent|GPU)\.([0-9A-Fa-f-]{36})(?: \[(\d+)\])?\) <\w+>: (.+)$/.exec(
      line,
    );
  if (!match || !Number.isFinite(Date.parse(match[1]!))) return;
  const identity = {
    app: Number(match[2]),
    kind: match[3] as PhoneProxyLaunch["kind"],
    id: match[4]!,
  };
  const spawned = /^xpcproxy_sim spawned with pid (\d+)$/.exec(match[6]!);
  if (spawned && spawned[1] === match[5])
    return {
      event: "spawn" as const,
      launch: { ...identity, pid: Number(spawned[1]), at: match[1]! },
    };
  if (
    /^(?:service state: (?:running|exited|not running)|job state = (?:spawn failed|removed))$/.test(
      match[6]!,
    )
  )
    return { event: "end" as const, launch: identity };
}

/** The captain's INF-1936 proxy review: one capture per pending child after the
 * existing threshold. Completed, duplicate and out-of-order terminal readings
 * cannot rearm it. Capture checks isPending again after asynchronous ownership reads.
 */
export function observePhoneProxyLaunches(
  capture: (launch: PhoneProxyLaunch, isPending: () => boolean) => Promise<void>,
) {
  const launches = new Map<
    string,
    { ended: boolean; seen: boolean; timer?: ReturnType<typeof setTimeout> }
  >();
  const captures: Promise<void>[] = [];
  let stopped = false;
  const stop = () => {
    stopped = true;
    for (const state of launches.values()) clearTimeout(state.timer);
  };
  return {
    receive(line: string) {
      if (stopped) return;
      const reading = phoneProxyLaunchReading(line);
      if (!reading) return;
      const key = `${reading.launch.app}:${reading.launch.kind}:${reading.launch.id}`;
      const state = launches.get(key) ?? { ended: false, seen: false };
      launches.set(key, state);
      if (reading.event === "end") {
        state.ended = true;
        clearTimeout(state.timer);
      } else if (!state.seen && !state.ended) {
        state.seen = true;
        const launch = reading.launch;
        state.timer = setTimeout(() => {
          const work = capture(launch, () => !stopped && !state.ended);
          // close joins failures too; do not leave a rejection unobserved meanwhile.
          void work.catch(() => {});
          captures.push(work);
        }, phoneWebLaunchObservationMs);
      }
      return reading;
    },
    stop,
    async close() {
      stop();
      await Promise.all(captures);
    },
  };
}
