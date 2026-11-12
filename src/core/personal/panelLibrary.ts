import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILTIN_FRAME_PANELS,
  builtinPanelDir,
  type FrameLibPins,
  isFrameLibPath,
} from "@shared/plugins/frameLib";

/**
 * Where the lib keeps the app's own panels, which a phone either draws
 * natively (Tasks, Activity) or does not show (Knowledge, Automation).
 */
const APP_PANEL_DIRS = BUILTIN_FRAME_PANELS.map((id) => `${builtinPanelDir(id)}/`);

/** One library file as the computer answers it. */
export type PanelLibraryFile = { path: string; integrity: string; data: string };

/** A library file whose bytes no longer match the pin its build baked in. */
export class PanelLibraryChanged extends Error {
  constructor(path: string) {
    super(`the panel library's ${path} is not the file this build made`);
    this.name = "PanelLibraryChanged";
  }
}

/**
 * Reads the frame realm's library this build made (docs/ui-plugins.md, "The
 * frame realm") for a view that carries no copy of this build, as a phone
 * never does (docs/view.md, "Panels on the phone"): every pinned file but
 * the app's own panels, each with its pin. A file whose bytes no longer
 * match its pin is refused, as the shell never serves one to its own frames
 * (`frameProtocol.ts`), so a view runs only what this build made.
 */
export async function readPanelLibrary(lib: {
  dir: string;
  pins: FrameLibPins;
}): Promise<PanelLibraryFile[]> {
  const paths = Object.keys(lib.pins)
    .filter((path) => isFrameLibPath(path) && !APP_PANEL_DIRS.some((dir) => path.startsWith(dir)))
    .sort();
  return Promise.all(
    paths.map(async (path) => {
      const integrity = lib.pins[path] as string;
      const bytes = await readFile(join(lib.dir, ...path.split("/")));
      const hash = `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
      if (hash !== integrity) throw new PanelLibraryChanged(path);
      return { path, integrity, data: bytes.toString("base64") };
    }),
  );
}
