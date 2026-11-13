import type { SourceIdentity } from "@shared/selfSource";
import type { HostCapabilities } from "../host";
import type { TypedWake } from "../orchestrator/wakes";
import type { AppPaths } from "../paths";
import { FreezeRecorder, freezeWake, infinitaryProject } from "./freezeRecorder";
import { FreezeTally } from "./freezeTally";
import type { PassSteps } from "./passSteps";
import { isFreezeRecorderEnabled } from "./watchdog";

/**
 * The freeze recorder the app's core starts (docs/freeze-recorder.md), in
 * alpha builds only: each main thread stall goes to its record and to the
 * per-version tally, tagged with the minute pass's step running, and each
 * pass's step timing goes to the pass record. When the app first starts on a
 * new version each earlier version's whole tally goes to the first mate,
 * only when the captain's projects hold Infinitary's own source, where a fix
 * goes (INF-3044). Null in every other build.
 */
export function startHomeFreezeRecorder(options: {
  host: Pick<HostCapabilities, "app" | "processFootprint" | "windowState">;
  paths: Pick<
    AppPaths,
    "freezeRecordPath" | "freezeTallyPath" | "memoryRecordPath" | "passRecordPath"
  >;
  build: () => SourceIdentity;
  steps: Pick<PassSteps, "listen">;
  projects: () => readonly { id: string; name: string; origin: string | null }[];
  notify: (wake: TypedWake) => void;
}): FreezeRecorder | null {
  const { host, paths } = options;
  if (
    !isFreezeRecorderEnabled({
      packaged: host.app.packaged,
      version: host.app.version,
      env: process.env,
    })
  )
    return null;
  const build = options.build();
  const recorder = new FreezeRecorder({
    recordPath: paths.freezeRecordPath,
    build,
    memory: {
      recordPath: paths.memoryRecordPath,
      ...(host.processFootprint ? { footprint: host.processFootprint } : {}),
    },
    ...(host.windowState ? { windowState: host.windowState } : {}),
    onFreeze: () => {},
    steps: { source: options.steps, recordPath: paths.passRecordPath },
    tally: new FreezeTally(paths.freezeTallyPath, host.app.version, build),
    // One summary per ended version (the inbox's once-identity); a
    // version that ends with no such project is never summarized.
    onVersionsEnded: (summaries) => {
      const project = infinitaryProject(options.projects());
      if (!project) return;
      for (const summary of summaries) options.notify(freezeWake(summary, project));
    },
  });
  recorder.start();
  return recorder;
}
