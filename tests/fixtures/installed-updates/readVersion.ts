import assert from "node:assert/strict";
import { linkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { extractFile, uncache } = require(
  require.resolve("@electron/asar", { paths: [require.resolve("electron-builder")] }),
) as {
  extractFile: (archive: string, name: string) => Buffer;
  uncache: (archive: string) => void;
};

/**
 * INF-643: observe one complete installed archive while native replacement
 * changes its path. ASAR opens the header and payload separately; a private
 * hard link pins both reads to one file without copying the whole application.
 * The disposable probe owns snapshot, on the same volume as Applications.
 */
export function readInstalledVersion(app: string, snapshot: string): string | undefined {
  try {
    linkSync(join(app, "Contents/Resources/app.asar"), snapshot);
  } catch (error) {
    // The bundle may be between its old and new names. The existing bounded
    // replacement wait observes this as not installed yet, never as success.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    uncache(snapshot);
    const manifest: unknown = JSON.parse(extractFile(snapshot, "package.json").toString());
    assert(manifest && typeof manifest === "object" && "version" in manifest);
    assert.equal(typeof manifest.version, "string");
    return manifest.version as string;
  } finally {
    uncache(snapshot);
    unlinkSync(snapshot);
  }
}
