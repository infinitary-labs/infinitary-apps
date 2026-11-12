import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** The most compiled files one added panel's graph may bring to its mount. */
export const PANEL_FILE_CAP = 256;
/** The most bytes one added panel's compiled graph may bring to its mount. */
export const PANEL_BYTES_CAP = 8 * 1024 * 1024;

const PANEL_FILE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** A panel's built files are more than a panel may bring; the message says so. */
export class PanelGraphTooLarge extends Error {
  constructor() {
    super("this panel's code is larger than a panel may be");
    this.name = "PanelGraphTooLarge";
  }
}

/**
 * Reads a panel's compiled graph once, for the window that draws it (the
 * frame realm, docs/ui-plugins.md): every `.mjs` under its version
 * directory, by forward-slashed relative path. The first mate reads it
 * here, where the files are, and sends the bytes; what the window's mount
 * serves afterwards is exactly these bytes, hashed into the document's
 * import map - a file written to the cache later reaches no frame.
 */
export async function readPanelGraph(dir: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const walk = async (relative: string[]): Promise<void> => {
    const entries = await readdir(join(dir, ...relative), { withFileTypes: true });
    for (const entry of entries) {
      if (!PANEL_FILE_SEGMENT.test(entry.name) || entry.name === "." || entry.name === "..") {
        continue;
      }
      if (entry.isDirectory()) {
        if (relative.length >= 8) continue;
        await walk([...relative, entry.name]);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const bytes = new Uint8Array(await readFile(join(dir, ...relative, entry.name)));
      total += bytes.byteLength;
      if (files.size + 1 > PANEL_FILE_CAP || total > PANEL_BYTES_CAP)
        throw new PanelGraphTooLarge();
      files.set([...relative, entry.name].join("/"), bytes);
    }
  };
  await walk([]);
  return files;
}
