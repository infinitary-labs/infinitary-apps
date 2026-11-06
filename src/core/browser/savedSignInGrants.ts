import { HERE } from "@shared/deviceNames";
import {
  type OfferedSignIn,
  SAVED_SIGN_IN_FAILED_WORDS,
  SAVED_SIGN_INS_PER_BROWSER,
  type SavedSignIn,
  type TaskBrowserCommandResult,
  type TaskBrowserFact,
  type TaskBrowserHandle,
} from "@shared/taskBrowser";
import { FORM_RESEND, type HostBrowserPage, type HostOriginStorage } from "../host";
import {
  addressOf,
  type Browser,
  type BrowsersCore,
  loadOwn,
  siteNamed,
  siteOf,
} from "./browserRecord";
import { browserCommand } from "./commandWords";
import {
  cookiesOfSite,
  type HeldSignIn,
  liveCookies,
  type SavedSignInRecord,
  signInSite,
  siteOrigins,
  storageOfSite,
  type WebSignIns,
} from "./webSignIns";

/**
 * Where a computer's task browsers keep the website sign-ins the captain
 * saved (docs/task-browser.md, "Saved sign-ins"): this Mac's own store
 * (`WebSignIns`), or, on a computer that runs work for this Mac, the one
 * save at a time the home lends a browser there and takes back
 * ("On another computer"), which keeps no mark and no permission of its own.
 */
export type SignInStore = Pick<
  WebSignIns,
  "list" | "get" | "save" | "refresh" | "remove" | "markFailed" | "allowAutomatic"
>;

/** An address's origin (`http://127.0.0.1:5173`), or nothing for one with none of its own. */
function originOf(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/**
 * What of a saved sign-in a browser's page can use now: its cookies still
 * alive, and the local and session storage of the very origin the page is
 * on, since a page takes its own origin's storage alone.
 */
function usableSignIn(record: SavedSignInRecord, address: string, now: number): HeldSignIn {
  const origin = originOf(address);
  return {
    cookies: liveCookies(record.cookies, now),
    storage: storageOfSite(record.storage, record.site).filter((held) => held.origin === origin),
    session: storageOfSite(record.session, record.site).filter((held) => held.origin === origin),
  };
}

/** Whether a browser holds anything of a site's sign-in: a cookie, or local or session storage. */
function holds(held: HeldSignIn): boolean {
  return held.cookies.length > 0 || held.storage.length > 0 || (held.session?.length ?? 0) > 0;
}

/** Write what a page can use of a saved sign-in into it: its cookies, and its own origin's local and session storage. */
async function writeSignIn(page: HostBrowserPage, usable: HeldSignIn): Promise<void> {
  await page.cookies.set(usable.cookies);
  // The page takes its own origin's storage alone, and refuses once it moved on.
  for (const storage of usable.storage) await page.storage.write(storage);
  for (const storage of usable.session ?? []) await page.session.write(storage);
}

/**
 * The saved sign-in a request card may offer for the browser a fact reads
 * (docs/task-browser.md, "Saved sign-ins"): the one for the site that
 * browser is on, while it is open and holds nothing of the captain's yet -
 * neither a page the captain handed back nor a saved sign-in already in
 * use - and something of it is still usable there. Otherwise nothing, so a
 * site that turned a copied sign-in away leaves the captain to sign in.
 * The same rule wherever the browser runs: the fact is all it reads.
 */
export function offeredSignIn(
  fact: TaskBrowserFact | undefined,
  site: string,
  store: SignInStore | undefined,
  now: number,
): { record: SavedSignInRecord; usable: HeldSignIn } | undefined {
  if (fact?.state !== "open" || fact.returned || fact.saved) return undefined;
  if (siteNamed(site) !== fact.site.toLowerCase()) return undefined;
  const record = store?.get(fact.site);
  if (!record) return undefined;
  const usable = usableSignIn(record, fact.url, now);
  return holds(usable) ? { record, usable } : undefined;
}

/** A saved sign-in as a request card offers it. */
export function offeredOf(record: SavedSignInRecord): OfferedSignIn {
  return {
    site: record.site,
    savedAt: record.savedAt,
    ...(record.failedAt !== undefined ? { failedAt: record.failedAt } : {}),
  };
}

/** The task's timeline line once its crewmate said a saved sign-in did not sign its page in. */
export function failedSignInNote(site: string): string {
  return `said your saved sign-in at ${site} did not sign its page in`;
}

/**
 * The website sign-ins the captain saved, as task browsers use them
 * (docs/task-browser.md, "Saved sign-ins"). A browser starts with none: the
 * captain's one click on a request card copies that one site's cookies and
 * page storage in and hands the page back, a site he allowed for future
 * tasks is used on an explicit visit, and the browser copies them back into
 * the save when it stops. Removing a saved sign-in signs out every browser
 * using it.
 */
export class SavedSignInGrants {
  constructor(private readonly core: BrowsersCore) {}

  /** The website sign-ins saved on this Mac, by site, as Settings lists them. */
  list(): SavedSignIn[] {
    return this.core.options.signIns?.list() ?? [];
  }

  /**
   * The saved sign-in a request card may offer (docs/task-browser.md, "Saved
   * sign-ins"): the one for the site the task's browser is on, while that
   * browser holds nothing of the captain's yet - neither a page the captain
   * handed back nor a saved sign-in already in use. Otherwise nothing, so a
   * site that turned a copied sign-in away leaves the captain to sign in.
   */
  offerFor(taskId: string, site: string): OfferedSignIn | undefined {
    const offer = offeredSignIn(
      this.core.fact(taskId),
      site,
      this.core.options.signIns,
      this.now(),
    );
    return offer ? offeredOf(offer.record) : undefined;
  }

  /**
   * The crewmate said on its request card that the saved sign-in its
   * browser was given did not sign the page in (docs/task-browser.md,
   * "Saved sign-ins"): that exact save keeps the mark, and the task's
   * timeline says so. False when the browser uses no save for the site, or
   * that save was removed or replaced since.
   */
  markFailed(taskId: string, site: string): boolean {
    const key = siteNamed(site);
    const id = this.core.browsers.get(taskId)?.saved.get(key);
    const store = this.core.options.signIns;
    if (!id || !store?.markFailed(key, id)) return false;
    this.core.options.note?.(taskId, failedSignInNote(key));
    return true;
  }

  /** Use separately permitted sites on an explicit visit, never instead of a captain handoff or final-submission review. */
  async applyAutomatic(taskId: string, browser: Browser): Promise<void> {
    if (browser.control !== "crewmate" || browser.captains || browser.returns > 0) return;
    const entry = browser.current;
    const address = addressOf(browser, entry);
    const site = signInSite(siteOf(address));
    if (
      browser.saved.size >= SAVED_SIGN_INS_PER_BROWSER ||
      browser.saved.has(site) ||
      browser.automaticTried?.has(site)
    )
      return;
    browser.automaticTried ??= new Set();
    browser.automaticTried.add(site);
    const local = this.core.options.signIns?.get(site);
    const record = local?.automatic
      ? local
      : await this.core.options.automaticSignIn?.(taskId, site).catch(() => undefined);
    if (!record?.automatic || record.site !== site) return;
    const usable = this.usable(record, address);
    if (
      !holds(usable) ||
      this.core.browsers.get(taskId) !== browser ||
      browser.control !== "crewmate" ||
      addressOf(browser, entry) !== address
    )
      return;
    try {
      // Mark the grant before asynchronous page writes, so Remove can sign it out.
      browser.saved.set(site, record.id);
      await writeSignIn(entry.page, usable);
      if (this.core.browsers.get(taskId) !== browser) return;
      if (browser.saved.get(site) !== record.id) {
        // Remove may have cleared the grant while asynchronous writes were in flight.
        await this.signOut(browser, site);
        return;
      }
      await loadOwn(entry, entry.page.reload());
      this.core.handBackBooks(taskId, browser);
      browser.notices.notice = `The captain allowed future tasks to use the sign-in saved for ${site}. This browser used it automatically. Take a fresh look; this never authorizes a payment or final submission. ${SAVED_SIGN_IN_FAILED_WORDS}`;
      this.core.options.note?.(
        taskId,
        `used your saved sign-in at ${site}, as you allowed for future tasks`,
      );
      this.core.options.onChange?.(taskId);
    } catch {
      browser.notices.notice =
        "The saved sign-in could not be used. It was not retried; ask the captain to sign in if needed.";
    }
  }

  allowAutomatic(site: string, id: string, automatic: boolean): TaskBrowserCommandResult {
    return this.core.options.signIns?.allowAutomatic(site, id, automatic)
      ? { ok: true }
      : { ok: false, text: "That saved sign-in changed. Open Website sign-ins again." };
  }

  /**
   * The captain's click on a request card's saved sign-in: the site's saved
   * cookies and its page's own storage are copied into the browser the card
   * names, its page reloads with them, and the browser goes back to its
   * crewmate, woken once to take a fresh look. It grants the task that one
   * site, never authority to spend. Refused in words unless that browser still waits for the
   * captain on a site with a saved sign-in.
   */
  async grant(taskId: string, handle: TaskBrowserHandle): Promise<TaskBrowserCommandResult> {
    const browser = this.core.browsers.get(taskId);
    if (!browser || !this.core.isHandled(browser, handle)) {
      return {
        ok: false,
        text: "This browser is no longer running, so it cannot use your saved sign-in.",
      };
    }
    return this.core.serial(taskId, async () => {
      if (this.core.browsers.get(taskId) !== browser || browser.control !== "waiting") {
        return { ok: false, text: "This browser is no longer waiting for your sign-in." };
      }
      const entry = browser.current;
      const site = siteOf(addressOf(browser, entry));
      const record = this.core.options.signIns?.get(site);
      const usable = record ? this.usable(record, addressOf(browser, entry)) : undefined;
      if (!record || !usable || !holds(usable)) {
        return { ok: false, text: `No sign-in for ${site} is saved on ${HERE.this}.` };
      }
      try {
        await writeSignIn(entry.page, usable);
      } catch {
        return { ok: false, text: `${HERE.This} could not use your saved sign-in right now.` };
      }
      if (this.core.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before it could use your saved sign-in." };
      }
      const after = browser.request?.after;
      browser.saved.set(signInSite(site), record.id);
      browser.control = "crewmate";
      browser.request = undefined;
      // The site reads its sign-in on the next load: the page reloads with
      // it, unless it answers a form, which a reload would send again.
      const reloaded = await loadOwn(entry, entry.page.reload()).catch(() => undefined);
      const resent = reloaded?.ok === false && reloaded.code === FORM_RESEND;
      if (this.core.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before it could use your saved sign-in." };
      }
      this.core.handBack(taskId, browser, {
        notice: resent
          ? `The captain let this task use the sign-in saved for ${site} on ${HERE.this}. The page answers a form that was sent, so it was not reloaded and may not show the sign-in yet: open the site's address with ${browserCommand("open <url>")} to see it signed in. Refs from before are gone.`
          : `The captain let this task use the sign-in saved for ${site} on ${HERE.this}, and the page reloaded with it: this is a fresh look at the page as it is now, and refs from before are gone.`,
        note: `you let it use your saved sign-in at ${site}`,
        returned: {
          site,
          ...(after ? { after } : {}),
          saved: true,
          once: `browser-saved-sign-in:${this.core.session}:${browser.generation}:${signInSite(site)}`,
        },
      });
      return { ok: true };
    });
  }

  /**
   * The captain's Remove in Settings: the site's saved sign-in goes from
   * this Mac, and every browser using it is signed out of that site at
   * once - its cookies there, its own origins' local storage, and their
   * session storage in each of its pages go, and nothing is copied back -
   * and its crewmate is told on its next command.
   */
  async remove(site: string): Promise<TaskBrowserCommandResult> {
    const key = signInSite(site);
    const removed = this.core.options.signIns?.remove(key) ?? false;
    const using = [...this.core.browsers].filter(([, browser]) => browser.saved.has(key));
    for (const [taskId, browser] of using) {
      browser.saved.delete(key);
      try {
        await this.signOut(browser, key);
      } catch {
        // A browser that stopped meanwhile has nothing left to sign out.
      }
      if (this.core.browsers.get(taskId) === browser) {
        const notices = browser.notices;
        notices.notice = `${notices.notice ? `${notices.notice} ` : ""}The captain removed the sign-in saved for ${key} from ${HERE.this}, so this browser is no longer signed in there. Reload the page to see it signed out, and ask on a card if the task still needs that site.`;
        this.core.options.note?.(
          taskId,
          `your saved sign-in at ${key} was removed, and its browser signed out of it`,
        );
        this.core.options.onChange?.(taskId);
      }
    }
    if (!removed && using.length === 0) {
      return { ok: false, text: `No sign-in for ${key} is saved on ${HERE.this}.` };
    }
    return { ok: true };
  }

  /**
   * Save the current page's site's sign-in from this browser: the captain's
   * tick on Return control. The browser uses that save from then on, and
   * copies back into it when it stops. A site that holds neither cookies
   * nor local or session storage saves nothing.
   */
  async remember(
    browser: Browser,
    shownSite: string,
    savedId?: string,
  ): Promise<string | undefined> {
    const store = this.core.options.signIns;
    if (!store) return "Control returned, but this computer cannot save that sign-in.";
    const site = signInSite(siteOf(addressOf(browser, browser.current)));
    if (site !== signInSite(shownSite))
      return "Control returned, but the page changed sites. No sign-in was saved.";
    try {
      const held: HeldSignIn = {
        cookies: cookiesOfSite(await browser.current.page.cookies.all(), site),
        storage: storageOfSite(await this.storageOn(browser, new Set([site]), "storage"), site),
        session: storageOfSite(await this.storageOn(browser, new Set([site]), "session"), site),
      };
      if (signInSite(siteOf(addressOf(browser, browser.current))) !== site)
        return "Control returned, but the page changed sites. No sign-in was saved.";
      if (!holds(held)) return "Control returned, but this site has no supported sign-in to save.";
      if (savedId) {
        if (!store.refresh(site, savedId, held))
          return "Control returned, but that saved sign-in was removed or replaced. It was not changed.";
        browser.saved.set(site, savedId);
      } else {
        // An unsaved-site choice cannot overwrite a save made in another view meanwhile.
        if (store.get(site))
          return "Control returned, but this site's saved sign-in changed. It was not replaced.";
        const record = store.save(site, held);
        browser.saved.set(site, record.id);
      }
      return undefined;
    } catch {
      return "Control returned, but the sign-in could not be saved. It was not retried.";
    }
  }

  /**
   * Copy each saved sign-in a stopping browser uses back into its save, so
   * a session the site refreshed stays current: the site's cookies, and the
   * local storage of each of its origins a page is on now. Its session
   * storage stays as the captain's hand-back saved it: a site may have
   * cleared it while the browser sat idle before it stopped. A save the
   * captain removed or replaced since is left alone, and what the site
   * holds nothing of now copies nothing back over the save it came from.
   */
  async copyBack(browser: Browser): Promise<void> {
    const store = this.core.options.signIns;
    if (!store || browser.saved.size === 0) return;
    const first = browser.pages[0]?.page;
    if (!first) return;
    const cookies = await first.cookies.all();
    const storage = await this.storageOn(browser, new Set(browser.saved.keys()), "storage");
    for (const [site, id] of browser.saved) {
      const held = { cookies: cookiesOfSite(cookies, site), storage: storageOfSite(storage, site) };
      if (holds(held)) store.refresh(site, id, held);
    }
  }

  /**
   * What of a saved sign-in a browser's page can use now: its cookies still
   * alive, and the local and session storage of the very origin the page is
   * on, since a page takes its own origin's storage alone.
   */
  private usable(record: SavedSignInRecord, address: string): HeldSignIn {
    return usableSignIn(record, address, this.now());
  }

  /**
   * Sign a browser out of a site: its cookies there, its own origins' local
   * storage, and their session storage in each of its pages, which keep
   * their own.
   */
  private async signOut(browser: Browser, site: string): Promise<void> {
    const first = browser.pages[0]?.page;
    const cookies = await first?.cookies.all();
    if (cookies) await first?.cookies.remove(cookiesOfSite(cookies, site));
    for (const origin of siteOrigins(site)) await first?.storage.clear(origin);
    for (const entry of new Set([browser.current, ...browser.pages])) {
      for (const origin of siteOrigins(site)) await entry.page.session.clear(origin);
    }
  }

  /**
   * The local or session storage a browser's pages on these sites hold for
   * their own origins, one per origin, the current page's first. A page on
   * any other site is never read.
   */
  private async storageOn(
    browser: Browser,
    sites: Set<string>,
    area: "storage" | "session",
  ): Promise<HostOriginStorage[]> {
    const held = new Map<string, HostOriginStorage>();
    for (const entry of new Set([browser.current, ...browser.pages])) {
      if (!sites.has(signInSite(siteOf(addressOf(browser, entry))))) continue;
      const storage = await entry.page[area].read().catch(() => undefined);
      if (storage && !held.has(storage.origin)) held.set(storage.origin, storage);
    }
    return [...held.values()];
  }

  private now(): number {
    return (this.core.options.now ?? Date.now)();
  }
}
