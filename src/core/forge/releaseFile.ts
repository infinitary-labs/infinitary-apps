import { lstatSync, realpathSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/**
 * A release file a crewmate names on `github_write` (`docs/forge.md`, "Release
 * files"). The path is relative to the task's working copy. A link anywhere
 * on the way is refused, and so is anything that is not a regular file.
 * The byte cap is GitHub's own release-asset limit, which also covers this
 * project's release files.
 */
export const RELEASE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;
/** A task on another computer cannot stream its working copy through the call the home sends. */
export const PLACED_RELEASE_FILE_REFUSAL =
  "A release file upload reads the working copy on the computer that sends it. This task runs on another computer, so the file was not sent.";
/** A release file is hundreds of megabytes; a JSON call stays at 30 seconds. */
export const RELEASE_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
/** Long enough for a nested build output, short of an unbounded string. */
const PATH_MAX = 1024;

const TYPES: Record<string, string> = {
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  xz: "application/x-xz",
  dmg: "application/x-apple-diskimage",
  pkg: "application/octet-stream",
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
  appimage: "application/vnd.appimage",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
};

export function contentTypeOf(filename: string): string {
  const lower = filename.toLowerCase();
  const ext = lower.endsWith(".tar.gz") ? "gz" : (lower.split(".").pop() ?? "");
  return TYPES[ext] ?? "application/octet-stream";
}

export function releaseUploadSizeRefusal(size: number): string | undefined {
  if (size > RELEASE_UPLOAD_MAX_BYTES) {
    return `The file is ${size} bytes, over the 2 GB release file cap.`;
  }
  return undefined;
}

export type LocatedReleaseFile = {
  /** Absolute path of the regular file, after the working copy is resolved. */
  path: string;
  /** The same file, relative to the working copy, as an ask keeps it. */
  rel: string;
  size: number;
  contentType: string;
  filename: string;
};

/**
 * The regular file `path` names inside the working copy, or why it cannot
 * be sent. `path` is the crewmate's, relative to the working copy.
 */
export function releaseFileIn(
  folder: string | null | undefined,
  path: string,
): LocatedReleaseFile | { refusal: string } {
  if (!folder) {
    return { refusal: "This task has no working copy on this computer, so the file was not sent." };
  }
  if (!isReleaseFilePath(path)) {
    return {
      refusal: "Give a regular file inside your working copy, relative to it, never a link.",
    };
  }
  let root: string;
  try {
    root = realpathSync(folder);
  } catch {
    return { refusal: "This task has no working copy on this computer, so the file was not sent." };
  }
  const parts = path.split("/");
  let at = root;
  for (const [index, part] of parts.entries()) {
    at = join(at, part);
    const last = index === parts.length - 1;
    const stat = lstatSync(at, { throwIfNoEntry: false });
    if (!stat) return { refusal: `There is no ${path} in your working copy.` };
    if (stat.isSymbolicLink()) {
      return { refusal: `${path} is a link. Name the file itself, never a link.` };
    }
    if (last ? !stat.isFile() : !stat.isDirectory()) {
      return { refusal: `${path} is not a file.` };
    }
    if (!last) continue;
    const over = releaseUploadSizeRefusal(stat.size);
    if (over) return { refusal: over };
    const inside = relative(root, at);
    if (!inside || inside.startsWith(`..${sep}`) || inside === "..") {
      return {
        refusal: "Give a regular file inside your working copy, relative to it, never a link.",
      };
    }
    const filename = basename(inside);
    return {
      path: at,
      rel: inside,
      size: stat.size,
      contentType: contentTypeOf(filename),
      filename,
    };
  }
  return { refusal: `${path} is not a file.` };
}

function isReleaseFilePath(path: string): boolean {
  if (!path || path.length > PATH_MAX) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return !path
    .split("/")
    .some((part) => part === "" || part === "." || part === ".." || part === ".git");
}
