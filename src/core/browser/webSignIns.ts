import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { originStorageSchema, type SavedSignIn, webCookieSchema } from "@shared/taskBrowser";
import { z } from "zod";
import type { HostCookie, HostOriginStorage } from "../host";

/**
 * The website sign-ins saved on this Mac (docs/task-browser.md, "Saved
 * sign-ins"): the one writer over `userData/web-sign-ins/`, a 0700 folder
 * with one 0600 file per site.
 *
 * A saved sign-in is what a task's browser held of one site when the
 * captain handed it back with "Remember my <site> sign-in on this Mac"
 * ticked: the site's cookies, and the page storage of its own origins,
 * where a site that keeps its sign-in in the page rather than in a cookie
 * keeps it - the site's own signed-in state, the way a browser keeps it -
 * and never anything he typed, the person's own Safari or Chrome profile,
 * or the app's subscription sign-ins, which live in their own stores. A
 * task's browser uses one after its request-card grant or the captain's
 * separate, lasting permission for future tasks on that site. The browser
 * copies it back on human return and when it stops, so a refreshed session stays
 * current. Each save mints a new `id`, so a browser copies back only into
 * the save it was given, never into one the captain removed and saved anew.
 */

/** One saved sign-in's file: its site, when it was saved, which save it is, its cookies and page storage. */
export type SavedSignInRecord = {
  site: string;
  savedAt: number;
  id: string;
  automatic?: boolean;
  cookies: HostCookie[];
  storage: HostOriginStorage[];
};

/** What a browser holds of one site's sign-in: its cookies and its own origins' page storage. */
export type HeldSignIn = {
  cookies: readonly HostCookie[];
  storage: readonly HostOriginStorage[];
};

const recordSchema = z.object({
  version: z.literal(1),
  automatic: z.boolean().optional(),
  site: z.string().min(1),
  savedAt: z.number(),
  id: z.string().min(1),
  cookies: z.array(webCookieSchema),
  // A save made before page storage was kept has none.
  storage: z.array(originStorageSchema).default([]),
});

/** A site as the store keys it: the page's host and port, lower case. */
export function signInSite(site: string): string {
  return site.trim().toLowerCase();
}

/** A name without the brackets an IPv6 address carries in a URL. */
function bare(name: string): string {
  const lower = name.toLowerCase().replace(/^\./, "");
  return lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
}

/** The name a site is served under (`aurora.example` for `aurora.example:8443`). */
export function siteHostname(site: string): string {
  try {
    return bare(new URL(`http://${site}`).hostname);
  } catch {
    return bare(site.replace(/:\d+$/, ""));
  }
}

/**
 * The cookies that make up one site's signed-in state: those the browser
 * sends to the site's own name - its own, and those its parent shares with
 * every name under it - and those of the names under it, where a sign-in
 * often starts. Cookies of a sibling or another site are not its.
 */
export function cookiesOfSite(cookies: readonly HostCookie[], site: string): HostCookie[] {
  const name = siteHostname(site);
  return cookies.filter((cookie) => {
    const domain = bare(cookie.domain);
    if (!domain) return false;
    if (domain === name) return true;
    // A cookie under the site's own name.
    if (domain.endsWith(`.${name}`)) return true;
    // A cookie the site's parent shares with every name under it.
    return !cookie.hostOnly && name.endsWith(`.${domain}`);
  });
}

/**
 * The page storage that is one site's own: that of the site's own origins
 * (`http://` or `https://` and exactly the site's host and port), holding
 * something. A page reads only its own origin's storage, so a name under
 * the site, its parent, or another site holds none of the site's.
 */
export function storageOfSite(
  storage: readonly HostOriginStorage[],
  site: string,
): HostOriginStorage[] {
  const key = signInSite(site);
  return storage.filter((held) => {
    if (held.items.length === 0) return false;
    try {
      const url = new URL(held.origin);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin === held.origin &&
        url.host === key
      );
    } catch {
      return false;
    }
  });
}

/** A site's own origins, whose page storage is the site's: plain and secure, at its host and port. */
export function siteOrigins(site: string): string[] {
  const key = signInSite(site);
  return [`http://${key}`, `https://${key}`];
}

/** The cookies still alive at `now`: an expired one would be thrown away by the browser anyway. */
export function liveCookies(cookies: readonly HostCookie[], now: number): HostCookie[] {
  return cookies.filter(
    (cookie) => cookie.expirationDate === undefined || cookie.expirationDate * 1000 > now,
  );
}

export class WebSignIns {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every saved sign-in, by site, as Settings lists them. */
  list(): SavedSignIn[] {
    return this.records()
      .map(({ site, savedAt, id, automatic }) => ({
        site,
        savedAt,
        id,
        ...(automatic ? { automatic } : {}),
      }))
      .sort((a, b) => a.site.localeCompare(b.site));
  }

  /** The sign-in saved for a site, or nothing (an unreadable file is nothing). */
  get(site: string): SavedSignInRecord | undefined {
    return this.read(this.fileFor(signInSite(site)));
  }

  /**
   * Save a site's sign-in: the captain's tick as he handed a browser back.
   * It replaces any earlier one for the site, as a new save, and keeps only
   * the page storage that is the site's own. `id` names the save when a
   * browser on another computer was told it before its sign-in arrived
   * (docs/task-browser.md, "On another computer"); a new one otherwise.
   */
  save(site: string, held: HeldSignIn, id: string = randomUUID()): SavedSignInRecord {
    const key = signInSite(site);
    const record: SavedSignInRecord = {
      site: key,
      savedAt: this.now(),
      id,
      cookies: [...held.cookies],
      storage: storageOfSite(held.storage, key),
    };
    this.write(record);
    return record;
  }

  /**
   * Copy what a browser holds of a site's sign-in back into the save it was
   * given, so a session the site refreshed stays current: its cookies, when
   * it holds any, and each of the site's own origins' page storage it could
   * read, origin by origin; what it holds nothing of stays as it was saved.
   * Nothing is written when that save was removed or replaced since; when
   * it was, false.
   */
  refresh(site: string, id: string, held: HeldSignIn): boolean {
    const record = this.get(site);
    if (!record || record.id !== id) return false;
    const storage = storageOfSite(held.storage, record.site);
    const read = new Set(storage.map((origin) => origin.origin));
    this.write({
      ...record,
      cookies: held.cookies.length > 0 ? [...held.cookies] : record.cookies,
      storage: [...record.storage.filter((origin) => !read.has(origin.origin)), ...storage],
    });
    return true;
  }

  /** Separate site permission, bound to the save shown in Settings; legacy saves stay off. */
  allowAutomatic(site: string, id: string, automatic: boolean): boolean {
    const record = this.get(site);
    if (!record || record.id !== id) return false;
    this.write({ ...record, automatic });
    return true;
  }

  /** Remove a site's saved sign-in; false when none was saved. */
  remove(site: string): boolean {
    const file = this.fileFor(signInSite(site));
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  }

  private records(): SavedSignInRecord[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.read(join(this.root, name)))
      .filter((record): record is SavedSignInRecord => record !== undefined);
  }

  private read(file: string): SavedSignInRecord | undefined {
    if (!existsSync(file)) return undefined;
    try {
      const parsed = recordSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) return undefined;
      const { version: _version, ...record } = parsed.data;
      return record;
    } catch {
      return undefined;
    }
  }

  /** Write one site's file, whole, never readable by anyone else even mid-write. */
  private write(record: SavedSignInRecord): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = this.fileFor(record.site);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, ...record })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }

  /** A site's file: named by a digest, since a site's own name may hold a colon or brackets. */
  private fileFor(site: string): string {
    return join(this.root, `${createHash("sha256").update(site).digest("hex").slice(0, 32)}.json`);
  }
}
