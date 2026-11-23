import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  normalizePrivateSite,
  type PrivateSiteChange,
  type PrivateSitesView,
  privateSiteSchema,
} from "@shared/privateSites";
import { z } from "zod";

/**
 * The captain's private sites list (docs/task-browser.md, "Private sites"):
 * the names and suffixes task browsers on every computer may reach on a
 * private network. The home keeps it in one file and is its one writer; a
 * computer that runs work reads it from the home as a browser opens
 * (`inf:work:private-sites`) and keeps no copy. Only the captain adds an
 * entry - in Settings, or by the captain's click on the app's Allow card.
 */

const fileSchema = z.object({ version: z.literal(1), sites: z.array(privateSiteSchema) });

export class PrivateSites {
  private readonly listeners = new Set<(sites: string[]) => void>();

  constructor(private readonly file: string) {}

  onChange(listener: (sites: string[]) => void): void {
    this.listeners.add(listener);
  }

  /** Every entry, in the order the captain added them; an unreadable file lists none. */
  list(): string[] {
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      return parsed.success ? parsed.data.sites : [];
    } catch {
      return [];
    }
  }

  /** Add a name or suffix the captain typed or allowed; one already listed stays once. */
  add(input: string): PrivateSiteChange {
    const checked = normalizePrivateSite(input);
    if (!checked.ok) return checked;
    const sites = this.list();
    if (!sites.includes(checked.site)) {
      sites.push(checked.site);
      this.write(sites);
      this.changed(sites);
    }
    return { ok: true, sites };
  }

  remove(site: string): PrivateSiteChange {
    const sites = this.list();
    const kept = sites.filter((listed) => listed !== site);
    if (kept.length !== sites.length) {
      this.write(kept);
      this.changed(kept);
    }
    return { ok: true, sites: kept };
  }

  private changed(sites: string[]): void {
    for (const listener of this.listeners) listener([...sites]);
  }

  private write(sites: string[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: 1, sites })}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
  }
}

/** The entry an add saved, from the list read before it and after (the Activity line names it). */
export function addedPrivateSite(before: unknown, after: unknown): string | undefined {
  const was = (before as PrivateSitesView | null)?.sites ?? [];
  return (after as PrivateSitesView | null)?.sites.find((site) => !was.includes(site));
}

/**
 * Settings' channels over the list: what it reads, and the captain's add and
 * Remove; where this build keeps no task browsers, none is `available` and
 * a change is refused with `none`.
 */
export function privateSiteChannels(store: () => PrivateSites | undefined, none: string) {
  return {
    "inf:browser:private-sites": (): PrivateSitesView => {
      const sites = store();
      return { available: Boolean(sites), sites: sites?.list() ?? [] };
    },
    "inf:browser:private-sites:add": (site: string): PrivateSiteChange =>
      store()?.add(site) ?? { ok: false, text: none },
    "inf:browser:private-sites:remove": (site: string): PrivateSiteChange =>
      store()?.remove(site) ?? { ok: false, text: none },
  };
}
