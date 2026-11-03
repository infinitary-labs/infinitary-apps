import { PHONE_JOURNEY, PHONE_PARTS } from "../../scripts/phone-test-plan.ts";
import { phoneWebLaunchObservationMs } from "./phoneWebStacks.ts";

type Reading = { at: string; nativeLine: string };
type Launch = {
  id: string;
  app: number;
  request?: Reading;
  creation?: Reading;
  response?: Reading;
  reported?: boolean;
};

/** INF-1936: keep the prestarted samples through a delayed launch's response,
 * including a later launch after healthy ones. Creation is not a reply. Native
 * readings can arrive in either order; an absent reply remains unknown.
 */
export function phoneGuestLaunches(manager: number) {
  const launches = new Map<string, Launch>();
  return {
    receive(line: string) {
      const header =
        /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+)\s+\w+\s+(Infinitary|runningboardd)\[(\d+):[^\]]+\] /.exec(
          line,
        );
      const extension =
        /extension<com\.apple\.WebKit\.WebContent\[config:[^\]]+\]\(\(null\):(\d+)\)>\[uuid:([^\]]+)\](?::(\d+))?/.exec(
          line,
        );
      if (!header || !extension) return;
      const app = Number(extension[1]);
      let kind: "request" | "creation" | "response";
      if (
        header[2] === "Infinitary" &&
        Number(header[3]) === app &&
        line.includes("[com.apple.runningboard:general] Sending launch request:")
      )
        kind = "request";
      else if (header[2] === "runningboardd" && Number(header[3]) === manager) {
        if (line.includes("Creating and launching job for:")) kind = "creation";
        else {
          const pid = /\] with pid: (\d+); launch assertion:/.exec(line)?.[1];
          if (!pid || pid !== extension[3]) return;
          kind = "response";
        }
      } else return;
      const id = extension[2]!;
      const key = `${app}:${id}`;
      const launch: Launch = launches.get(key) ?? { id, app };
      launches.set(key, launch);
      launch[kind] ??= { at: header[1]!, nativeLine: line };
      let completed: { elapsedMs: number; delayed: boolean } | undefined;
      if (!launch.reported && launch.request && launch.response) {
        const elapsedMs = Date.parse(launch.response.at) - Date.parse(launch.request.at);
        // Do not classify a missing or reversed native clock reading as a delay.
        if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
          launch.reported = true;
          completed = { elapsedMs, delayed: elapsedMs >= phoneWebLaunchObservationMs };
        }
      }
      return { kind, launch: { ...launch }, completed };
    },
  };
}

/** Stop at the observed cards part's native result, before xcodebuild's post-failure diagnostics.
 * This observes XCTest's existing result; it changes neither that result nor its wait.
 * INF-2125 split the cards part into short ones; each launches its own app, so the observer watches whichever one runs.
 */
export function phoneGuestJourneyFinished(line: string, part: string) {
  const test = PHONE_PARTS.find((candidate) => candidate.name === part)?.test;
  if (!test) throw new Error(`No phone journey part is named ${part}`);
  const prefix = `Test Case '-[${PHONE_JOURNEY.replace("/", ".")} ${test}]' `;
  return (
    line.startsWith(prefix) &&
    /^(?:passed|failed) \([\d.]+ seconds\)\.$/.test(line.slice(prefix.length))
  );
}
