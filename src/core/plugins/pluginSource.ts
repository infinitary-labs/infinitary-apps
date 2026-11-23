import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { hostEnv } from "../hostEnv";
import { atUtilityQos } from "../utilityQos";
import { git } from "../workspace/git";
import type { PluginInstallSource } from "./pluginRecords";

const execFileAsync = promisify(execFile);

/**
 * Where an installed plugin's files come from (one plugin vehicle, Phase A
 * item 3; captain's A2a: npm, a git address, or a folder, pinned). Every
 * source ends the same way: its files are COPIED as plain files into a
 * directory the installer owns - a link, a device or a tree past the caps
 * is refused - and the copy is pinned to exactly what was fetched.
 *
 * Nothing a plugin ships runs here. npm is asked to pack with
 * `--ignore-scripts` (no lifecycle script, not even for a git or folder
 * dependency's `prepare`), git clones with hooks pointed at /dev/null and
 * checks out no submodule, and the folder source only reads. The copy is
 * data until the frame realm draws its panel, contained (Phase A item 4).
 */

/** A plugin tree bigger than this is refused: a panel is a few small files. */
export const PLUGIN_FILE_CAP = 400;
export const PLUGIN_BYTES_CAP = 8 * 1024 * 1024;
/** How long one fetch step may take before the install is refused. */
const FETCH_TIMEOUT_MS = 120_000;

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

export class PluginSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSourceError";
  }
}

export type FetchedPlugin = {
  /** The plugin's files, copied as plain files. */
  dir: string;
  /** What the install is pinned to (see `StagedPlugin.pinned`). */
  pinned: string;
  /** The id the source suggests: the folder's name, the repository's, or the package's. */
  suggestedId: string;
  /** What identifies the source across versions: the folder, the address, the package name. */
  identity: string;
};

export type PluginFetchRequest = {
  source: PluginInstallSource;
  spec: string;
  /** A fresh directory the fetch may fill; the caller removes it. */
  workDir: string;
};

export type PluginFetcher = (request: PluginFetchRequest) => Promise<FetchedPlugin>;

export const fetchPluginSource: PluginFetcher = async (request) => {
  const spec = request.spec.trim();
  if (!spec) throw new PluginSourceError("Name where it comes from.");
  if (spec.startsWith("-")) {
    throw new PluginSourceError(`"${spec}" is not a place it can come from.`);
  }
  await mkdir(request.workDir, { recursive: true });
  const dest = join(request.workDir, "files");
  switch (request.source) {
    case "path":
      return fetchFolder(spec, dest);
    case "git":
      return fetchGit(spec, request.workDir, dest);
    case "npm":
      return fetchNpm(spec, request.workDir, dest);
  }
};

/**
 * What names the same source across versions: the folder, the git address
 * without its version, the package name. An add from a different source
 * under an id already taken is refused rather than read as an update.
 */
export function sourceIdentity(source: PluginInstallSource, spec: string, pinned: string): string {
  const trimmed = spec.trim();
  if (source === "path") {
    const expanded =
      trimmed === "~" || trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(1)) : trimmed;
    return resolve(expanded);
  }
  if (source === "git") {
    const hash = trimmed.lastIndexOf("#");
    return hash > 0 ? trimmed.slice(0, hash) : trimmed;
  }
  const nameAtVersion = pinned.split(" ")[0] ?? pinned;
  return nameAtVersion.slice(0, Math.max(nameAtVersion.lastIndexOf("@"), 0)) || nameAtVersion;
}

async function fetchFolder(spec: string, dest: string): Promise<FetchedPlugin> {
  const expanded = spec === "~" || spec.startsWith("~/") ? join(homedir(), spec.slice(1)) : spec;
  if (!isAbsolute(expanded)) {
    throw new PluginSourceError(`"${spec}" is not a full folder path; name it from the top.`);
  }
  const folder = resolve(expanded);
  const info = await lstat(folder).catch(() => null);
  if (!info?.isDirectory()) throw new PluginSourceError(`There is no folder at ${folder}.`);
  const pinned = await copyPlainTree(folder, dest);
  return { dir: dest, pinned, suggestedId: basename(folder), identity: folder };
}

async function fetchGit(spec: string, workDir: string, dest: string): Promise<FetchedPlugin> {
  const hash = spec.lastIndexOf("#");
  const address = hash > 0 ? spec.slice(0, hash) : spec;
  const ref = hash > 0 ? spec.slice(hash + 1) : "";
  if (address.startsWith("-") || /^ext::/i.test(address)) {
    throw new PluginSourceError(`"${address}" is not an address it can come from.`);
  }
  if (ref && (!/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith("-"))) {
    throw new PluginSourceError(`"${ref}" is not a version it can be pinned to.`);
  }
  const clone = join(workDir, "clone");
  try {
    await git(workDir, ["clone", "--quiet", "--no-recurse-submodules", "--", address, clone], {
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (ref) {
      await git(
        clone,
        ["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", ref],
        {
          timeoutMs: FETCH_TIMEOUT_MS,
        },
      );
    }
  } catch (error) {
    throw new PluginSourceError(
      `Could not fetch ${address}${ref ? ` at ${ref}` : ""}: ${firstLine(error)}`,
    );
  }
  const commit = await git(clone, ["rev-parse", "HEAD"]);
  await copyPlainTree(clone, dest);
  const name =
    address
      .replace(/[/\\]+$/, "")
      .split(/[/:\\]/)
      .pop() ?? "";
  return {
    dir: dest,
    pinned: commit,
    suggestedId: name.replace(/\.git$/, ""),
    identity: address,
  };
}

async function fetchNpm(spec: string, workDir: string, dest: string): Promise<FetchedPlugin> {
  const packed = join(workDir, "packed");
  await mkdir(packed, { recursive: true });
  let stdout: string;
  try {
    // A throwaway cache of its own: nothing this install fetches is read
    // back by any other, and nothing another left behind is trusted here.
    stdout = await run(
      "npm",
      [
        "pack",
        spec,
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        packed,
        "--cache",
        join(workDir, "npm-cache"),
      ],
      workDir,
    );
  } catch (error) {
    throw new PluginSourceError(`Could not fetch ${spec}: ${firstLine(error)}`);
  }
  const json = stdout.slice(stdout.indexOf("["));
  let entry:
    | { name?: unknown; version?: unknown; filename?: unknown; integrity?: unknown }
    | undefined;
  try {
    [entry] = JSON.parse(json) as NonNullable<typeof entry>[];
  } catch {
    throw new PluginSourceError(`Could not read what npm fetched for ${spec}.`);
  }
  const { name, version, filename, integrity } = entry ?? {};
  if (typeof name !== "string" || typeof version !== "string" || typeof filename !== "string") {
    throw new PluginSourceError(`Could not read what npm fetched for ${spec}.`);
  }
  const unpacked = join(workDir, "unpacked");
  await mkdir(unpacked, { recursive: true });
  try {
    await run("tar", ["-xzf", join(packed, basename(filename)), "-C", unpacked], workDir);
  } catch (error) {
    throw new PluginSourceError(`Could not unpack ${name}@${version}: ${firstLine(error)}`);
  }
  await copyPlainTree(join(unpacked, "package"), dest);
  return {
    dir: dest,
    pinned: `${name}@${version}${typeof integrity === "string" ? ` ${integrity}` : ""}`,
    suggestedId: name.replace(/^@[^/]+\//, ""),
    identity: name,
  };
}

async function run(file: string, args: string[], cwd: string): Promise<string> {
  const command = atUtilityQos(file, args);
  const { stdout } = await execFileAsync(command.file, command.args, {
    cwd,
    // npm checks the registry for a newer npm whenever its cache has no note
    // of a recent check, and each install's cache is new: without this, even
    // packing a folder asks the network about npm itself.
    env: hostEnv({
      npm_config_ignore_scripts: "true",
      npm_config_audit: "false",
      npm_config_update_notifier: "false",
    }),
    maxBuffer: 16 * 1024 * 1024,
    timeout: FETCH_TIMEOUT_MS,
  });
  return stdout;
}

/**
 * Copies a plugin tree as plain files and directories, and returns the
 * pin of what it copied: `sha256:` over every relative path and its bytes,
 * in order. A link anywhere is refused - it could point outside the tree -
 * as is a device, a socket, or a tree past the caps. Version control and
 * installed dependencies stay behind.
 */
export async function copyPlainTree(from: string, to: string): Promise<string> {
  const files: { rel: string; bytes: Buffer }[] = [];
  let total = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name), child);
      } else if (entry.isFile()) {
        const bytes = await readFile(join(dir, entry.name));
        total += bytes.byteLength;
        files.push({ rel: child, bytes });
        if (files.length > PLUGIN_FILE_CAP || total > PLUGIN_BYTES_CAP) {
          throw new PluginSourceError(
            `It is too big for a panel: at most ${PLUGIN_FILE_CAP} files and ${PLUGIN_BYTES_CAP / 1024 / 1024} MB.`,
          );
        }
      } else if (entry.isSymbolicLink()) {
        throw new PluginSourceError(`It holds a link (${child}); a panel is plain files.`);
      } else {
        throw new PluginSourceError(`It holds something that is not a file (${child}).`);
      }
    }
  };
  await walk(from, "");
  await rm(to, { recursive: true, force: true });
  const hash = createHash("sha256");
  for (const file of files) {
    const target = join(to, ...file.rel.split("/"));
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, file.bytes);
    hash.update(file.rel);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  await mkdir(to, { recursive: true });
  return `sha256:${hash.digest("hex")}`;
}

function firstLine(error: unknown): string {
  const text =
    (error as { stderr?: unknown })?.stderr && String((error as { stderr: unknown }).stderr).trim()
      ? String((error as { stderr: unknown }).stderr)
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "unknown error"
  );
}
