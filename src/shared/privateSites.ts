import { z } from "zod";

/**
 * The private sites the captain lets task browsers reach (docs/task-browser.md,
 * "Private sites"): one list for every computer, kept at the home and lent to
 * each computer that runs work. An entry is a name (`wiki.corp.example`), or a
 * suffix of two or more parts (`.corp.example.com`) that covers every name
 * under it. It never names an IP address, `localhost` or a part alone.
 *
 * Pure: words in, a checked entry or a reason out.
 */

/** One entry as it is kept: lower case, no trailing dot, a suffix with its leading dot. */
export const privateSiteSchema = z.string().min(1).max(253);

/** The list as Settings reads it; `available` is false where this build keeps no task browsers. */
export const privateSitesViewSchema = z.object({
  available: z.boolean(),
  sites: z.array(privateSiteSchema),
});
export type PrivateSitesView = z.infer<typeof privateSitesViewSchema>;

/** What an add or a remove answers: the list as it now stands, or why nothing changed. */
export const privateSiteChangeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), sites: z.array(privateSiteSchema) }),
  z.object({ ok: z.literal(false), text: z.string() }),
]);
export type PrivateSiteChange = z.infer<typeof privateSiteChangeSchema>;

const LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

/** The entry a person typed, checked: a name or a suffix, or why it is not one. */
export function normalizePrivateSite(
  input: string,
): { ok: true; site: string } | { ok: false; text: string } {
  let text = input.trim().toLowerCase();
  // A pasted address names its host.
  if (text.includes("://")) {
    try {
      text = new URL(text).hostname;
    } catch {
      return { ok: false, text: `"${input.trim()}" is not a site name.` };
    }
  }
  if (text.startsWith("*.")) text = text.slice(1);
  text = text.replace(/\.$/, "");
  const suffix = text.startsWith(".");
  const labels = (suffix ? text.slice(1) : text).split(".");
  if (text.length === 0 || text.length > 253 || !labels.every((label) => LABEL.test(label))) {
    return {
      ok: false,
      text: `"${input.trim()}" is not a site name. Give a name such as wiki.corp.example, or a suffix such as .corp.example.com.`,
    };
  }
  if (labels.every((label) => /^\d+$/.test(label))) {
    return {
      ok: false,
      text: "A private site is named by its name, never by its address. Give the name the site has.",
    };
  }
  if (labels[labels.length - 1] === "localhost") {
    return {
      ok: false,
      text: "A page on this computer is opened by localhost already; it needs no private site.",
    };
  }
  if (suffix && labels.length < 2) {
    return {
      ok: false,
      text: "A suffix needs two or more parts, such as .corp.example.com, so it never covers a whole top-level domain.",
    };
  }
  return { ok: true, site: text };
}

/** Whether a host a page or the crewmate named is on the list: its name, or a name under a suffix. */
export function listsPrivateSite(sites: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return false;
  return sites.some((site) => (site.startsWith(".") ? host.endsWith(site) : host === site));
}

/** Settings' words for the list (`PrivateSitesSection`, in Settings › Integrations). */
export const PRIVATE_SITES_WORDS = {
  title: "Private sites",
  lead: "Sites on your office, home or VPN network that task browsers may open. The list applies on all your computers.",
  empty: "None listed. When a crewmate needs one, your first mate asks you first.",
  suffix: "and every name under it",
  open: "Site",
  openLabel: "Add a private site",
  field: "Private site",
  placeholder: "wiki.corp.example",
  hint: "A name, or a suffix such as .corp.example.com for every name under it.",
  add: "Add",
  cancel: "Cancel",
  remove: "Remove",
} as const;
