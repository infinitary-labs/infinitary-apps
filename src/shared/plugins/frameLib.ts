import { APP_FRAME_SCHEME } from "../csp";
import type { HostModuleKey } from "../personal/manifest";
import { panelCardViewModule } from "./panelCards";

/**
 * The frame realm's library (one plugin vehicle, Phase A item 4; captain's
 * A1a and A4a; docs/ui-plugins.md "The frame realm"). A panel that does not
 * run in the app's own window - one the captain added from elsewhere, and
 * the app's own Tasks and Activity panels - runs in a sandboxed frame, and
 * the frame needs what the app's window gives a panel in-process: React,
 * the JSX runtime, the design library (`@infinitary/ui`), and a runtime that
 * turns the bridge into `PanelProps`.
 *
 * The shell serves those as ES modules from ONE host, `app-frame://lib/`,
 * built with the app (electron.vite.config.ts builds `out/frame-lib/` and
 * bakes every file's SHA-256 into the main bundle). The host answers only a
 * file whose bytes still match its baked pin, and every panel document
 * carries the same pins as its import map's `integrity`, so a lib module is
 * pinned twice: by the server that will not serve anything else, and by the
 * frame that will not run anything else.
 *
 * The file names are the contract between the build, the compiler (which
 * rewrites an added panel's host imports to these URLs) and the shell.
 */

/** The host the lib is served from: `app-frame://lib/<file>`. */
export const FRAME_LIB_HOST = "lib";

/** The module every panel document boots from. */
export const FRAME_LIB_BOOT = "boot.mjs";

/**
 * The host modules a panel may import, as the frame realm serves them. Each
 * default-exports the module's namespace, the one shape the compiler's
 * rewritten host imports destructure.
 */
export const FRAME_LIB_HOST_MODULES: Readonly<Record<HostModuleKey, string>> = {
  react: "react.mjs",
  jsxRuntime: "jsx-runtime.mjs",
  jsxDevRuntime: "jsx-dev-runtime.mjs",
  ui: "ui.mjs",
};

/**
 * The app's own panels (docs/ui-plugins.md, "The app's own panels are
 * ordinary folders"): each an ordinary panel folder, `src/panels/<id>/`,
 * which the panel compiler builds for the frame realm into the lib under
 * `builtin/<id>/` - its `panel.mjs`, its card views and every file they
 * reach - pinned like the rest. The ids are the folders' names.
 */
export const BUILTIN_FRAME_PANELS = [
  "activity",
  "automation",
  "knowledge",
  "now",
  "batches-panel",
] as const;
export type BuiltinFramePanel = (typeof BUILTIN_FRAME_PANELS)[number];

/**
 * The app's own panels that a built-in runbook shows (docs/runbooks.md,
 * "Panels"): each one a folder of its runbook, `resources/runbooks/<runbook>/<folder>/`,
 * compiled with the app like the folders under `src/panels/`, under the id
 * `runbookPanelId` gives it, `<runbook>-<folder>`.
 */
export const RUNBOOK_FRAME_PANELS: Readonly<
  Partial<Record<BuiltinFramePanel, { runbook: string; folder: string }>>
> = {
  "batches-panel": { runbook: "batches", folder: "panel" },
};

/** Where an app panel's folder is in the project: `src/panels/<id>/`, or its runbook's folder. */
export function builtinPanelSource(id: BuiltinFramePanel): string {
  const runbook = RUNBOOK_FRAME_PANELS[id];
  return runbook ? `resources/runbooks/${runbook.runbook}/${runbook.folder}` : `src/panels/${id}`;
}

/** Where an app panel's folder is compiled to in the lib. */
export function builtinPanelDir(id: BuiltinFramePanel): string {
  return `builtin/${id}`;
}

/** An app panel's compiled module in the lib: its panel, or one of its card views. */
export function builtinPanelFile(id: BuiltinFramePanel, view?: string): string {
  return `${builtinPanelDir(id)}/${view === undefined ? "panel.mjs" : panelCardViewModule(view)}`;
}

/** File -> `sha256-<base64>`, every file the lib serves and nothing else. */
export type FrameLibPins = Readonly<Record<string, string>>;

/** A lib file's URL. */
export function frameLibUrl(file: string): string {
  return `${APP_FRAME_SCHEME}://${FRAME_LIB_HOST}/${file}`;
}

/** The URL an added panel's host import is rewritten to for the frame realm. */
export function frameLibHostModuleUrl(key: HostModuleKey): string {
  return frameLibUrl(FRAME_LIB_HOST_MODULES[key]);
}

/**
 * A lib path the shell may answer: forward-slashed segments of plain file
 * characters ending in `.mjs`, never `.` or `..`. Whether it is served is
 * the pins' call; this only refuses what no build could have produced.
 */
export function isFrameLibPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.length === 0 || segments.length > 6) return false;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_.-]+$/.test(segment) || segment === "." || segment === "..") return false;
  }
  return path.endsWith(".mjs");
}
