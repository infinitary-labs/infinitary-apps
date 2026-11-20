/** INF-1888: a failed card wait can be a simulator WebContent launch delay.
 * Keep Apple's own launch readings, not a guessed cause or another readiness
 * gate. A missing completion is unknown: the live stream can drop readings.
 * The part supplies only its owned simulator's live and kept logs.
 */
export function phoneWebContentStartup() {
  const witnesses = new Map<string, string>();
  return {
    receive(line: string) {
      const app =
        /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+\w+\s+Infinitary\[(\d+):[^\]]+\] (.*)$/.exec(
          line,
        );
      if (!app) return;
      const [, at, pid, message = ""] = app;
      // These are the app's direct WebKit readings, never messages forwarded
      // from a page, Photos, a test runner or another simulator.
      const requested =
        /^\[com\.apple\.runningboard:general\] Sending launch request: <RBSLaunchRequest\| extension<com\.apple\.WebKit\.WebContent\[config:[^\]]+\]\(\(null\):(\d+)\)>\[uuid:([^\]]+)\]/.exec(
          message,
        );
      const launched =
        /^\[com\.apple\.WebKit:Process\] WebContent process \(0x[\da-f]+\) took (\d+(?:\.\d+)?) seconds to launch$/.exec(
          message,
        );
      let reading: string | undefined;
      if (requested && requested[1] === pid)
        reading = `Simulator WebContent launch requested at ${at} by Infinitary PID ${pid} (request ${requested[2]}).`;
      if (launched)
        reading = `Simulator WebContent startup: WebKit reported ${launched[1]} seconds to launch at ${at} for Infinitary PID ${pid}.`;
      if (reading) witnesses.set(line, reading);
    },
    report() {
      const ordered = [...witnesses].sort(([a], [b]) => a.localeCompare(b));
      return [
        "Simulator WebContent startup evidence for this failed phone part:",
        ...(ordered.length
          ? ordered.map(([, reading]) => reading)
          : ["No app-owned WebContent launch readings were captured; startup is unknown."]),
        "Compare these timestamps and launch durations with the failed wait in the XCTest log; an earlier launch alone does not explain a later card failure.",
        "A request without a captured completion is unknown, not proof the process never started.",
        "These readings do not establish CPU load, concurrent simulators or a runtime defect as the cause. The check remains failed; no retry or longer wait was added.",
        ...(ordered.length
          ? ["", "Apple's launch readings:", ...ordered.map(([line]) => line)]
          : []),
      ].join("\n");
    },
  };
}
