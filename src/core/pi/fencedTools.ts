import { access, readdir, readFile, stat } from "node:fs/promises";
import {
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { outsideWorkingCopy } from "../session/fencedReads";

/** Throws the refusal when `path` leaves the working copy at `cwd`. */
function fence(cwd: string, path: string): void {
  const refused = outsideWorkingCopy(cwd, path);
  if (refused) throw new Error(refused);
}

/**
 * A fenced session's whole file reach (`SessionSpec.fenced`): Pi's read,
 * grep and ls, each checking every path it opens against the working copy.
 * Pi's find is left out: it runs its own search program on the path it is
 * given, with nothing of ours asked first.
 */
export function fencedPiReadTools(cwd: string): ToolDefinition[] {
  const read = createReadToolDefinition(cwd, {
    operations: {
      readFile: async (path) => {
        fence(cwd, path);
        return readFile(path);
      },
      access: async (path) => {
        fence(cwd, path);
        await access(path);
      },
    },
  });
  // A thrown isDirectory reads as "Path not found", so the refusal is
  // never shown; the search simply does not run.
  const grep = createGrepToolDefinition(cwd, {
    operations: {
      isDirectory: async (path) => {
        fence(cwd, path);
        return (await stat(path)).isDirectory();
      },
      readFile: async (path) => {
        fence(cwd, path);
        return readFile(path, "utf8");
      },
    },
  });
  const ls = createLsToolDefinition(cwd, {
    operations: {
      exists: async (path) => {
        fence(cwd, path);
        return stat(path).then(
          () => true,
          () => false,
        );
      },
      stat: async (path) => {
        fence(cwd, path);
        return stat(path);
      },
      readdir: async (path) => {
        fence(cwd, path);
        return readdir(path);
      },
    },
  });
  return [read, grep, ls] as ToolDefinition[];
}
