import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BUILTIN_FRAME_PANELS,
  type BuiltinFramePanel,
  builtinPanelDir,
  type FrameLibPins,
  isFrameLibPath,
} from "@shared/plugins/frameLib";

/**
 * Where the lib keeps the app's own panels, which a phone asks for one by
 * one (`readAppPanelFiles`), never with the library.
 */
const APP_PANEL_DIRS = BUILTIN_FRAME_PANELS.map((id) => `${builtinPanelDir(id)}/`);

/** One library file as the computer answers it. */
export type PanelLibraryFile = { path: string; integrity: string; data: string };

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
  return Promise.all(paths.map((path) => readPinned(lib, path, path)));
}

async function readPinned(
  lib: { dir: string; pins: FrameLibPins },
  path: string,
  as: string,
): Promise<PanelLibraryFile> {
  const integrity = lib.pins[path] as string;
  const bytes = await readFile(join(lib.dir, ...path.split("/")));
  const hash = `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
  if (hash !== integrity) throw new PanelLibraryChanged(path);
  return { path: as, integrity, data: bytes.toString("base64") };
}

/** An app panel's own pins, by each file's path inside its folder of the lib. */
export function appPanelFilePins(pins: FrameLibPins, id: string): Record<string, string> {
  const dir = `${builtinPanelDir(id as BuiltinFramePanel)}/`;
  return Object.fromEntries(
    Object.entries(pins)
      .filter(([path]) => path.startsWith(dir) && isFrameLibPath(path))
      .map(([path, pin]) => [path.slice(dir.length), pin]),
  );
}

/**
 * Reads one of the app's own panels from the library this build made, for
 * a view that carries no copy of this build (docs/view.md, "The app's own
 * panels on the phone"): every pinned file under its folder, by its path
 * inside that folder, each with its pin, so the view mounts it as it mounts
 * one of the captain's panels. A file whose bytes no longer match its pin is
 * refused, as the library is.
 */
export async function readAppPanelFiles(
  lib: { dir: string; pins: FrameLibPins },
  id: string,
): Promise<PanelLibraryFile[]> {
  const dir = `${builtinPanelDir(id as BuiltinFramePanel)}/`;
  const paths = Object.keys(appPanelFilePins(lib.pins, id)).sort();
  return Promise.all(paths.map((path) => readPinned(lib, `${dir}${path}`, path)));
}
