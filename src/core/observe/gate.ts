import { settingFrom } from "../../shared/envSettings.ts";
import { isAlphaVersion } from "../update/semver.ts";

export type DevObserveGateInput = {
  isPackaged: boolean;
  env?: Record<string, string | undefined>;
};

/**
 * Observe's development half (docs/dev-observe.md, "Hard gate"), which the
 * offline transcript tools reuse as their whole gate. Unpackaged builds
 * always get it; a packaged build needs an explicit INFINITARY_DEV_OBSERVE=1,
 * under either of its names (`settingFrom`).
 */
export function isDevObserveEnabled(input: DevObserveGateInput): boolean {
  if (!input.isPackaged) return true;
  return settingFrom(input.env ?? {}, "DEV_OBSERVE") === "1";
}

/**
 * The app's Observe gate (docs/dev-observe.md, "Hard gate"): development and
 * alpha builds, and a stable build only with INFINITARY_DEV_OBSERVE=1, so a
 * stable release cannot grow a transcript pane. It reads the running
 * build's own version, never the update channel it
 * follows, and a version that is not exactly `X.Y.Z-alpha.N` counts as
 * stable.
 */
export function isObserveEnabled(build: {
  packaged: boolean;
  version: string;
  env?: Record<string, string | undefined>;
}): boolean {
  return (
    isDevObserveEnabled({ isPackaged: build.packaged, env: build.env }) ||
    isAlphaVersion(build.version)
  );
}

export const OBSERVE_DISABLED_MESSAGE = "Observe is unavailable in this build";
