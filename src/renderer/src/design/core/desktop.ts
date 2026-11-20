import { systemRunsWork } from "@shared/devices";
import {
  type DesktopConventions,
  desktopConventions,
  PLATFORM_ATTRIBUTE,
  platformProfile,
} from "@shared/platform";

/**
 * This computer's desktop, as its preload marked it on the document before
 * the first render (src/shared/platform.ts, `PLATFORM_ATTRIBUTE`): the keys,
 * window controls, closing and Settings rows the design skill's "Linux
 * desktop conventions" name. A page with no mark - a test's, a design
 * gallery's - reads as a Mac's, so today's window is the default.
 */
export type Desktop = DesktopConventions & {
  mac: boolean;
  windows: boolean;
  /** Whether this computer may run its home's work: a phone never does. */
  runsWork: boolean;
};

export function thisDesktop(): Desktop {
  const platform =
    globalThis.document?.documentElement?.getAttribute(PLATFORM_ATTRIBUTE) ?? "darwin";
  return {
    mac: platform === "darwin",
    windows: platform === "win32",
    runsWork: systemRunsWork(platformProfile(platform).system ?? undefined),
    ...desktopConventions(platform),
  };
}

/** Where the app draws the window's buttons: three 32 px buttons 6 px apart, 16 px in from the right edge. */
export const WINDOW_CONTROLS = { width: 3 * 32 + 2 * 6, inset: 16 } as const;

/**
 * How far a surface that covers the top bar keeps its contents from the
 * window's right edge, px, where the app draws the window's buttons: their
 * width, their inset, and `--space-3` before them (design skill readme,
 * "Linux desktop conventions").
 */
export const WINDOW_CONTROLS_CLEARANCE = WINDOW_CONTROLS.inset + WINDOW_CONTROLS.width + 12;
