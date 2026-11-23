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
import type { SavedSignIn } from "@shared/taskBrowser";
import { z } from "zod";
import type { HostCookie } from "../host";

/**
 * The signed-in sites a computer keeps (docs/task-browser.md, "Signed-in
 * sites"): the one writer over `userData/web-sign-ins/`, a 0700 folder with
 * one 0600 file per site.
 *
 * The sign-in itself stays where the browser engine put it, in the
 * computer's kept profile; this list holds none of it - no cookie, no page
 * storage. It holds which sites the captain signed in to there, when, the
 * captain's rule for each (`automatic`: later tasks use it without asking;
 * otherwise the captain is asked on a card each time), the sign-in pages passed through on
 * the way (`via`), which a task allowed the site may open too, and when a
 * crewmate last said the sign-in did not sign its page in.
 *
 * A file from before, a copy of a site's cookies and page storage (version
 * 1), retires: it is deleted unread the first time the list meets it.
 */

export type SignedInSite = {
  site: string;
  /** When the captain signed in there, last. */
  savedAt: number;
  id: string;
  /** Later tasks use it without asking; otherwise the captain is asked each time. */
  automatic?: boolean;
  /** The sign-in pages the captain passed through on the way, by site. */
  via?: string[];
  /**
   * Other names under the site that task browsers opened with this sign-in,
   * by site: Remove clears their page storage too, since page storage is
   * kept per origin and cannot be cleared for a whole site at once.
   */
  opened?: string[];
  /** When a crewmate last said this sign-in did not sign its page in; absent while none has. */
  failedAt?: number;
};

const recordSchema = z.object({
  version: z.literal(2),
  site: z.string().min(1),
  savedAt: z.number(),
  id: z.string().min(1),
  automatic: z.boolean().optional(),
  via: z.array(z.string().min(1)).optional(),
  opened: z.array(z.string().min(1)).optional(),
  failedAt: z.number().optional(),
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

/** A site's own origins, whose page storage is the site's: plain and secure, at its host and port. */
export function siteOrigins(site: string): string[] {
  const key = signInSite(site);
  return [`http://${key}`, `https://${key}`];
}

/**
 * Whether two sites are one for a task's allowance: the same name, or one
 * served under the other (`www.example.com` and `example.com`), whatever
 * their ports - a site's cookies reach both.
 */
export function sameSignInSite(a: string, b: string): boolean {
  const one = siteHostname(a);
  const two = siteHostname(b);
  return one === two || one.endsWith(`.${two}`) || two.endsWith(`.${one}`);
}

/**
 * The site a sign-in made at `site` covers, as the store keys its entry: the
 * widest name among the cookies the browser sends to the page that its
 * parent shares with every name under it (`apple.com` for a sign-in at
 * `idmsa.apple.com`), otherwise the page's own host and port. The engine
 * never accepts a cookie on a public suffix, so this stops at the
 * registrable domain with no list of suffixes.
 */
export function signedInSiteOf(site: string, cookies: readonly HostCookie[]): string {
  const name = siteHostname(site);
  let widest: string | undefined;
  for (const cookie of cookies) {
    const domain = bare(cookie.domain);
    if (cookie.hostOnly || !domain.includes(".")) continue;
    if (domain !== name && !name.endsWith(`.${domain}`)) continue;
    if (!widest || domain.length < widest.length) widest = domain;
  }
  return widest && widest !== name ? widest : signInSite(site);
}

/** Whether a page at `site` lies at an entry's site or under it (`idmsa.apple.com` under `apple.com`). */
function atOrUnder(site: string, entry: string): boolean {
  const name = siteHostname(site);
  const above = siteHostname(entry);
  return name === above || name.endsWith(`.${above}`);
}

export class WebSignIns {
  constructor(
    private readonly root: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Every signed-in site, by site, as Settings lists them. */
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

  /** Every signed-in site, whole. */
  records(): SignedInSite[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.read(join(this.root, name)))
      .filter((record): record is SignedInSite => record !== undefined);
  }

  /** The entry keyed by exactly this site, or nothing (an unreadable or retired file is nothing). */
  get(site: string): SignedInSite | undefined {
    return this.read(this.fileFor(signInSite(site)));
  }

  /**
   * The entry a page at `site` may be signed in by: one whose site is the
   * page's or a name above it, or whose sign-in pages passed through hold
   * the page's site. One that also covers `prefer` (the browser's first
   * address) comes first, then one the page lies under, then the newest.
   */
  find(site: string, prefer?: string): SignedInSite | undefined {
    const covers = (record: SignedInSite, one: string): boolean =>
      atOrUnder(one, record.site) || (record.via ?? []).some((via) => sameSignInSite(via, one));
    const rank = (record: SignedInSite): number =>
      (prefer && covers(record, prefer) ? 2 : 0) + (atOrUnder(site, record.site) ? 1 : 0);
    return this.records()
      .filter((record) => covers(record, site))
      .sort((a, b) => rank(b) - rank(a) || b.savedAt - a.savedAt)[0];
  }

  /**
   * The captain signed in to a site in the kept profile and handed the
   * browser back: its entry, with the captain's rule and the sign-in pages
   * passed through. An entry already there keeps its id and the pages it named;
   * a crewmate's mark that it failed goes, since the captain signed in again.
   * Entries for names under the site (an older `developer.apple.com` once
   * `apple.com` is kept) fold into it, their id, pages and opened names with them, so a
   * task allowed the narrower one keeps its allowance.
   */
  record(site: string, rule: { automatic: boolean; via?: readonly string[] }): SignedInSite {
    const key = signInSite(site);
    const before = this.get(key);
    const under = this.records().filter(
      (record) => record.site !== key && atOrUnder(record.site, key),
    );
    const via = [
      ...new Set(
        [
          ...(before?.via ?? []),
          ...under.flatMap((one) => [one.site, ...(one.via ?? [])]),
          ...(rule.via ?? []),
        ].map(signInSite),
      ),
    ].filter((one) => one !== key);
    const opened = [
      ...new Set([...(before?.opened ?? []), ...under.flatMap((one) => one.opened ?? [])]),
    ].filter((one) => one !== key && !via.includes(one));
    const record: SignedInSite = {
      site: key,
      savedAt: this.now(),
      id: before?.id ?? under[0]?.id ?? randomUUID(),
      ...(rule.automatic ? { automatic: true } : {}),
      ...(via.length > 0 ? { via } : {}),
      ...(opened.length > 0 ? { opened } : {}),
    };
    this.write(record);
    for (const one of under) rmSync(this.fileFor(one.site), { force: true });
    return record;
  }

  /**
   * A task browser opened `site` with the entry `id`: a name under the
   * entry's own that neither it nor its pages passed through name yet joins
   * its opened names. False when that entry was removed or replaced since.
   */
  opened(id: string, site: string): boolean {
    const key = signInSite(site);
    const record = this.records().find((one) => one.id === id);
    if (!record) return false;
    if (key === record.site || !atOrUnder(key, record.site)) return true;
    if ([...(record.via ?? []), ...(record.opened ?? [])].includes(key)) return true;
    this.write({ ...record, opened: [...(record.opened ?? []), key] });
    return true;
  }

  /**
   * A crewmate said the sign-in it was given did not sign its page in: the
   * entry keeps the mark, with when, until the captain signs in again.
   * False when that entry was removed or replaced since.
   */
  markFailed(site: string, id: string): boolean {
    const record = this.get(site);
    if (!record || record.id !== id) return false;
    this.write({ ...record, failedAt: this.now() });
    return true;
  }

  /** The captain's rule for a site, bound to the entry shown in Settings. */
  allowAutomatic(site: string, id: string, automatic: boolean): boolean {
    const record = this.get(site);
    if (!record || record.id !== id) return false;
    const { automatic: _was, ...rest } = record;
    this.write(automatic ? { ...rest, automatic: true } : rest);
    return true;
  }

  remove(site: string): SignedInSite | undefined {
    const record = this.get(site);
    rmSync(this.fileFor(signInSite(site)), { force: true });
    return record;
  }

  private read(file: string): SignedInSite | undefined {
    if (!existsSync(file)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
    // A copy from before retires unread.
    if ((raw as { version?: unknown } | null)?.version === 1) {
      rmSync(file, { force: true });
      return undefined;
    }
    const parsed = recordSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const { version: _version, ...record } = parsed.data;
    return record;
  }

  /** Write one site's file, whole, never readable by anyone else even mid-write. */
  private write(record: SignedInSite): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = this.fileFor(record.site);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 2, ...record })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }

  /** A site's file: named by a digest, since a site's own name may hold a colon or brackets. */
  private fileFor(site: string): string {
    return join(this.root, `${createHash("sha256").update(site).digest("hex").slice(0, 32)}.json`);
  }
}
