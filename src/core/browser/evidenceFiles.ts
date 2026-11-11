import { chmodSync, closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { cutText } from "@shared/textCut";
import type { HostDownloadOffer, HostDownloadTarget } from "../host";
import { quoted, siteOf } from "./browserRecord";
import { clip, type PageNotices } from "./pageNotices";

/**
 * The files a task's browser writes into its task's evidence folder
 * (docs/task-browser.md, "A download" and "What a crewmate reads"): a page's
 * downloads under `downloads/`, and the pictures its crewmate takes. Each
 * is kept for the owner only, never over another file.
 */

/** The folder inside a task's evidence folder that its browser's downloads go to. */
const DOWNLOADS_DIR = "downloads";

/** Where a download came from, as the crewmate reads it: a blob's own site, or the page itself. */
function downloadSiteOf(url: string): string {
  if (url.startsWith("blob:")) return siteOf(url.slice("blob:".length));
  if (url.startsWith("data:")) return "the page itself";
  return siteOf(url);
}

/**
 * A downloaded file's name: the site's own, as a single name in the folder
 * (no folder parts, no control characters, not hidden), or `download`.
 */
function downloadFileName(suggested: string): string {
  const name = basename(suggested.replace(/\\/g, "/"))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: a site's name may carry them; the file's never does
    .replace(/[\u0000-\u001f\u007f/:]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim();
  return cutText(name, 200) || "download";
}

/** Claim the first free name for a download: `name`, then `name-2`, `name-3`... before its extension. */
function reserveDownload(dir: string, name: string): string {
  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 1; n < 10_000; n += 1) {
    const path = join(dir, n === 1 ? name : `${stem}-${n}${ext}`);
    try {
      closeSync(openSync(path, "wx", 0o600));
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("the downloads folder has no free name left");
}

/** A file's size in words: bytes, KB or MB. */
function bytesWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A page started a download (docs/task-browser.md, "A download"): it is
 * saved in the task's evidence folder under `downloads/`, by the name the
 * site gave or the first free one beside it, never over another file, and
 * the crewmate's next answer (`notices`) and the task's timeline (`saved`)
 * say where. A file may hold whatever the site put in it, so it is kept for
 * the owner only. `ended` runs once it finished or failed.
 */
export function saveDownload(
  evidenceDir: string,
  offer: HostDownloadOffer,
  notices: PageNotices,
  told: { saved: (line: string) => void; ended: () => void },
): HostDownloadTarget | undefined {
  const site = downloadSiteOf(offer.url);
  const dir = join(evidenceDir, DOWNLOADS_DIR);
  let path: string;
  try {
    mkdirSync(dir, { recursive: true });
    path = reserveDownload(dir, downloadFileName(offer.name));
  } catch {
    notices.keepDownload(
      `${quoted(clip(offer.name))} from ${site} was not saved: the evidence folder could not take it.`,
    );
    return undefined;
  }
  notices.downloading.set(path, offer.name);
  notices.downloaded = true;
  return {
    path,
    done: (outcome) => {
      notices.downloading.delete(path);
      if (outcome.state === "completed") {
        try {
          chmodSync(path, 0o600);
        } catch {
          // A file the host could not finish is not there to keep private.
        }
        notices.keepDownload(`${path} (${bytesWords(outcome.bytes)}, from ${site})`);
        told.saved(`its browser downloaded ${basename(path)} from ${site}`);
      } else {
        try {
          rmSync(path, { force: true });
        } catch {
          // Nothing is left to remove.
        }
        notices.keepDownload(
          `${quoted(clip(offer.name))} from ${site} did not finish downloading (${outcome.state}); nothing was kept.`,
        );
      }
      told.ended();
    },
  };
}

/** A picture's file name from the crewmate's own: letters, digits and dashes. */
export function captureFileName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const base = name
    .trim()
    .toLowerCase()
    .replace(/\.png$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base ? `${base}.png` : undefined;
}

/** Write a picture: under its own name, or the first free `page-N.png`. */
export async function writePicture(
  dir: string,
  name: string | undefined,
  png: Uint8Array,
): Promise<string> {
  if (name) {
    const path = join(dir, name);
    await writeFile(path, png);
    return path;
  }
  for (let n = 1; n < 10_000; n += 1) {
    const path = join(dir, `page-${n}.png`);
    try {
      await writeFile(path, png, { flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("the evidence folder has no free picture name left");
}
