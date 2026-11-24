import { HERE } from "@shared/deviceNames";
import {
  type OfferedSignIn,
  SAVED_SIGN_IN_FAILED_WORDS,
  SAVED_SIGN_INS_PER_TASK,
  type SavedSignIn,
  type TaskBrowserCommandResult,
  type TaskBrowserFact,
  type TaskBrowserHandle,
} from "@shared/taskBrowser";
import { FORM_RESEND, type HostLoadOutcome } from "../host";
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
  namesPage,
  type SignedInSite,
  sameSignInSite,
  signedInSiteOf,
  signInSite,
  siteOrigins,
  type WebSignIns,
} from "./webSignIns";

/**
 * Where a computer's task browsers keep the list of signed-in sites
 * (docs/task-browser.md, "Signed-in sites"): its own `WebSignIns`, on the
 * home and on each computer that runs work alike.
 */
export type SignInStore = Pick<
  WebSignIns,
  | "list"
  | "records"
  | "get"
  | "find"
  | "record"
  | "opened"
  | "remove"
  | "markFailed"
  | "allowAutomatic"
>;

/** Whether an address is a web page's, whose site an allowance names. */
function isWebAddress(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/**
 * The signed-in site a request card may offer for the browser a fact reads
 * (docs/task-browser.md, "Signed-in sites"): the one the fact offers while
 * its request waits, when the card names the site the browser is on. The
 * same rule wherever the browser runs: the fact is all it reads.
 */
export function offeredSignIn(
  fact: TaskBrowserFact | undefined,
  site: string,
): OfferedSignIn | undefined {
  if (fact?.state !== "open" || !fact.offer) return undefined;
  return siteNamed(site) === fact.site.toLowerCase() ? fact.offer : undefined;
}

/** The task's timeline line once its crewmate said a signed-in site did not sign its page in. */
export function failedSignInNote(site: string): string {
  return `said your sign-in at ${site} did not sign its page in`;
}

/**
 * The signed-in sites a computer keeps, as its task browsers use them
 * (docs/task-browser.md, "Signed-in sites"). The sign-ins themselves stay
 * in the computer's kept profile, one per engine, and nothing of them is
 * copied anywhere. A browser starts in its own empty context; it opens in
 * the kept profile when the captain takes it to sign in, when the captain
 * lets it use a site on its request card, or when its crewmate opens a site whose
 * rule lets tasks use it without asking. There its pages open only the
 * sites it may use and the sign-in pages passed through on the way; any
 * other site opens in an empty context again. Remove signs the site out
 * of the kept profile.
 */
export class SavedSignInGrants {
  constructor(private readonly core: BrowsersCore) {}

  /** The signed-in sites this computer keeps, by site, as Settings lists them. */
  list(): SavedSignIn[] {
    return this.core.options.signIns?.list() ?? [];
  }

  /**
   * The signed-in site a request card may offer, as the browser's fact
   * carries it while its crewmate holds it: the one kept for the page's site,
   * unless the browser may use it already - then the kept sign-in has ended
   * and the captain signs in - or the captain's own click opened it.
   */
  offerOf(browser: Browser): { offer?: OfferedSignIn } {
    if (browser.captains) return {};
    const address = addressOf(browser, browser.current);
    if (!isWebAddress(address)) return {};
    const record = this.find(browser, siteOf(address));
    if (!record || [...browser.saved.values()].includes(record.id)) return {};
    return {
      offer: {
        site: record.site,
        savedAt: record.savedAt,
        ...(record.failedAt !== undefined ? { failedAt: record.failedAt } : {}),
      },
    };
  }

  /**
   * The captain's rule for the page's site, as the browser's fact carries it
   * while the captain holds it in the kept profile: the entry this computer
   * keeps, so the Return control question starts from the rule chosen on the
   * computer the browser runs on. Absent while this computer lists none.
   * With it, the wider site the question names when the page's cookies
   * cover a name above the page's (`keepAs`, read by `readKeepAs`).
   */
  ruleOf(browser: Browser): { rule?: "ask" | "automatic"; keepAs?: string } {
    if (!browser.kept || browser.control !== "captain") return {};
    const address = addressOf(browser, browser.current);
    if (!isWebAddress(address)) return {};
    const site = signInSite(siteOf(address));
    const keepAs =
      browser.keepAs && browser.keepAs !== site && namesPage(browser.keepAs, site)
        ? browser.keepAs
        : undefined;
    const record = this.find(browser, site);
    return {
      ...(record ? { rule: record.automatic ? ("automatic" as const) : ("ask" as const) } : {}),
      ...(keepAs ? { keepAs } : {}),
    };
  }

  /**
   * The site the captain's page would keep its sign-in under, read from the
   * cookies it sends now, for the Return control question to name; the
   * browser's fact moves when it changes.
   */
  async readKeepAs(taskId: string, browser: Browser): Promise<void> {
    if (!browser.kept || browser.control !== "captain") return;
    const address = addressOf(browser, browser.current);
    if (!isWebAddress(address)) return;
    const pageSite = signInSite(siteOf(address));
    const cookies = await browser.current.page.cookies.all().catch(() => undefined);
    if (!cookies || this.core.browsers.get(taskId) !== browser) return;
    const keepAs = signedInSiteOf(pageSite, cookiesOfSite(cookies, pageSite));
    if (keepAs === browser.keepAs) return;
    browser.keepAs = keepAs;
    this.core.options.onChange?.(taskId);
  }

  /**
   * The entry a page at `site` may be signed in by (`WebSignIns.find`), the
   * one covering the browser's first address first; nothing when this
   * computer keeps none or its list cannot be read.
   */
  private find(browser: Browser, site: string): SignedInSite | undefined {
    try {
      return this.core.options.signIns?.find(site, siteOf(browser.firstUrl));
    } catch {
      return undefined;
    }
  }

  offerFor(taskId: string, site: string): OfferedSignIn | undefined {
    const browser = this.core.browsers.get(taskId);
    const offer = browser ? this.offerOf(browser).offer : undefined;
    if (!browser || !offer) return undefined;
    return siteNamed(site) === siteOf(addressOf(browser, browser.current)).toLowerCase()
      ? offer
      : undefined;
  }

  /**
   * The crewmate said on its request card that the signed-in site its
   * browser was given did not sign the page in: that entry keeps the mark,
   * and the task's timeline says so. False when the browser uses none for
   * the site, or that entry was removed or replaced since.
   */
  markFailed(taskId: string, site: string): boolean {
    const key = siteNamed(site);
    const saved = [...(this.core.browsers.get(taskId)?.saved ?? [])];
    const id = saved.find(([allowed]) => sameSignInSite(allowed, key))?.[1];
    const store = this.core.options.signIns;
    const record = id ? store?.records().find((one) => one.id === id) : undefined;
    if (!id || !record || !store?.markFailed(record.site, id)) return false;
    this.core.options.note?.(taskId, failedSignInNote(key));
    return true;
  }

  /** Whether the browser may open this address in the kept profile. */
  allows(browser: Browser, url: string): boolean {
    if (browser.control === "captain" || browser.control === "taking") return true;
    if (!isWebAddress(url)) return true;
    const site = siteOf(url);
    return [...browser.saved.keys(), ...(browser.passed ?? [])].some((allowed) =>
      sameSignInSite(allowed, site),
    );
  }

  /**
   * A kept page's own navigation, checked as it starts: one to a site the
   * browser may not use there is refused, and the browser opens it in an
   * empty context of its own once the command running ends.
   */
  keptMayOpen(taskId: string, browser: Browser, url: string): boolean {
    if (this.allows(browser, url)) return true;
    void this.core.serial(taskId, () => this.leaveKept(taskId, browser, url));
    return false;
  }

  /** The captain went to a page while signing in, in the kept profile: the task may open its site too. */
  passedThrough(browser: Browser, url: string): void {
    if (!isWebAddress(url)) return;
    browser.passed ??= new Set();
    browser.passed.add(signInSite(siteOf(url)));
  }

  /**
   * A page the crewmate's browser opened in the kept profile: a name under
   * a signed-in site it may use joins that entry's opened names, so the
   * captain's Remove clears its page storage too.
   */
  openedKept(browser: Browser, url: string): void {
    const store = this.core.options.signIns;
    if (!store || !isWebAddress(url) || browser.saved.size === 0) return;
    const site = signInSite(siteOf(url));
    const id = [...browser.saved].find(([saved]) => sameSignInSite(saved, site))?.[1];
    if (!id) return;
    try {
      store.opened(id, site);
    } catch {
      // A list that cannot be written now leaves the name for the next page it opens.
    }
  }

  /**
   * Where the crewmate's own open of `url` loads (docs/task-browser.md,
   * "Signed-in sites"): out of the kept profile for a site its task may not
   * use there, into it for one it may - one it was given, or one whose rule
   * lets tasks use it without asking - and otherwise where it is. The
   * outcome of a load in the other profile, or nothing to load it here.
   */
  async openIn(
    taskId: string,
    browser: Browser,
    url: string,
  ): Promise<HostLoadOutcome | undefined> {
    if (browser.control !== "crewmate") return undefined;
    if (browser.kept) {
      if (this.allows(browser, url)) return undefined;
      return this.move(taskId, browser, false, url);
    }
    if (!isWebAddress(url) || browser.captains) return undefined;
    const site = signInSite(siteOf(url));
    if ([...browser.saved.keys()].some((allowed) => sameSignInSite(allowed, site))) {
      browser.passed = new Set([...(browser.passed ?? []), ...this.viaOf(browser)]);
      return this.move(taskId, browser, true, url);
    }
    if (browser.saved.size >= SAVED_SIGN_INS_PER_TASK || browser.automaticTried?.has(site)) {
      return undefined;
    }
    browser.automaticTried ??= new Set();
    browser.automaticTried.add(site);
    const record = this.find(browser, site);
    if (!record?.automatic) return undefined;
    browser.saved.set(record.site, record.id);
    browser.passed = new Set(record.via ?? []);
    const outcome = await this.move(taskId, browser, true, url);
    if (!outcome) {
      browser.saved.delete(record.site);
      browser.passed = undefined;
      return undefined;
    }
    browser.notices.notice = `The captain lets tasks use the sign-in kept for ${record.site} on ${HERE.this} without asking, so this browser opened it in the kept profile. Take a fresh look; this never authorizes a payment or final submission. ${SAVED_SIGN_IN_FAILED_WORDS}`;
    this.core.options.note?.(
      taskId,
      `used your sign-in at ${record.site}, as your rule for it allows`,
    );
    this.core.options.onChange?.(taskId);
    return outcome;
  }

  /** The sign-in pages the entries a browser was given passed through, which its pages may open beside them. */
  private viaOf(browser: Browser): string[] {
    let records: SignedInSite[];
    try {
      records = this.core.options.signIns?.records() ?? [];
    } catch {
      return [];
    }
    const ids = new Set(browser.saved.values());
    return records.filter((record) => ids.has(record.id)).flatMap((record) => record.via ?? []);
  }

  /** The captain's rule for a signed-in site, bound to the entry Settings showed. */
  allowAutomatic(site: string, id: string, automatic: boolean): TaskBrowserCommandResult {
    return this.core.options.signIns?.allowAutomatic(site, id, automatic)
      ? { ok: true }
      : { ok: false, text: "That signed-in site changed. Open Website sign-ins again." };
  }

  /**
   * The captain took a browser whose crewmate asked for a sign-in: its
   * page reopens in the kept profile, at the same address, so what the
   * captain signs in to stays (docs/task-browser.md, "Signed-in sites").
   */
  async openForSignIn(taskId: string, browser: Browser): Promise<void> {
    const url = addressOf(browser, browser.current);
    if (!isWebAddress(url) || browser.captains || !this.core.options.signIns) return;
    if (!(await this.move(taskId, browser, true, url))) {
      this.core.options.note?.(
        taskId,
        "its browser could not open the kept profile, so this sign-in will not stay for later tasks",
      );
    }
  }

  /**
   * The captain's Return control from the kept profile: the site signed in
   * to stays on the list, with the captain's rule, and this browser may use it.
   * A site whose cookies and page storage hold nothing keeps no entry.
   */
  async keep(browser: Browser, shownSite: string, automatic: boolean): Promise<string | undefined> {
    const store = this.core.options.signIns;
    if (!store) return "Control returned, but this computer keeps no sign-ins.";
    const pageSite = signInSite(siteOf(addressOf(browser, browser.current)));
    const shown = signInSite(shownSite);
    if (!namesPage(shown, pageSite))
      return "Control returned, but the page changed sites. Its sign-in was not added to the list.";
    try {
      const page = browser.current.page;
      const cookies = cookiesOfSite(await page.cookies.all(), pageSite);
      const storage = await page.storage.read().catch(() => undefined);
      if (cookies.length === 0 && (storage?.items.length ?? 0) === 0) {
        return "Control returned. This site holds no sign-in, so nothing was added for later tasks.";
      }
      // Kept for the whole site its cookies cover, but never wider than the
      // name the captain's question showed: a session cookie set after the
      // question last read them keeps the page's own name, as he agreed to.
      // The page's own name stays among the pages passed through, so Remove
      // clears its page storage too.
      const wide = signedInSiteOf(pageSite, cookies);
      const site = wide === shown ? wide : pageSite;
      const via = [...(browser.passed ?? []), pageSite].filter((one) => signInSite(one) !== site);
      const record = store.record(site, { automatic, via });
      browser.saved.set(record.site, record.id);
      return undefined;
    } catch {
      return "Control returned, but the sign-in could not be added to the list. It was not retried.";
    }
  }

  /**
   * The captain's click on a request card's signed-in site: the browser the
   * card names opens its page in the kept profile, signed in, and goes back
   * to its crewmate, woken once to take a fresh look. It grants the task
   * that site, never authority to spend. Refused in words unless that
   * browser still waits for the captain on a site the computer keeps.
   */
  async grant(taskId: string, handle: TaskBrowserHandle): Promise<TaskBrowserCommandResult> {
    const browser = this.core.browsers.get(taskId);
    if (!browser || !this.core.isHandled(browser, handle)) {
      return {
        ok: false,
        text: "This browser is no longer running, so it cannot use your sign-in.",
      };
    }
    return this.core.serial(taskId, async () => {
      if (this.core.browsers.get(taskId) !== browser || browser.control !== "waiting") {
        return { ok: false, text: "This browser is no longer waiting for your sign-in." };
      }
      const address = addressOf(browser, browser.current);
      const site = siteOf(address);
      const record = this.find(browser, site);
      if (!record) return { ok: false, text: `No sign-in for ${site} is kept on ${HERE.this}.` };
      const request = browser.request;
      const after = request?.after;
      browser.saved.set(record.site, record.id);
      browser.passed = new Set([...(browser.passed ?? []), ...(record.via ?? [])]);
      browser.control = "crewmate";
      browser.request = undefined;
      // The site reads its sign-in on the next load: in the kept profile, or
      // a reload there, unless the page answers a form a reload would resend.
      const outcome = browser.kept
        ? await loadOwn(browser.current, browser.current.page.reload()).catch(() => undefined)
        : await this.move(taskId, browser, true, address);
      if (this.core.browsers.get(taskId) !== browser) {
        return { ok: false, text: "This browser stopped before it could use your sign-in." };
      }
      if (!outcome && !browser.kept) {
        browser.saved.delete(record.site);
        browser.control = "waiting";
        browser.request = request;
        return { ok: false, text: `${HERE.This} could not open its kept profile right now.` };
      }
      const resent = outcome?.ok === false && outcome.code === FORM_RESEND;
      this.core.handBack(taskId, browser, {
        notice: resent
          ? `The captain let this task use the sign-in kept for ${site} on ${HERE.this}. The page answers a form that was sent, so it was not reloaded and may not show the sign-in yet: open the site's address with ${browserCommand("open <url>")} to see it signed in. Refs from before are gone.`
          : `The captain let this task use the sign-in kept for ${site} on ${HERE.this}, and the page opened with it: this is a fresh look at the page as it is now, and refs from before are gone. ${SAVED_SIGN_IN_FAILED_WORDS}`,
        note: `you let it use your sign-in at ${site}`,
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
   * The captain's Remove in Settings: the site's entry goes from this
   * computer, the kept profile signs out of it - its cookies, and its own
   * origins' page storage, with those of the sign-in pages it passed
   * through and the names under it task browsers opened, where no other
   * entry names them - and every browser that could use it no longer may; its
   * crewmate is told on its next command.
   */
  async remove(site: string): Promise<TaskBrowserCommandResult> {
    const key = signInSite(site);
    const store = this.core.options.signIns;
    const removed = store?.remove(key);
    // By id too: a browser may hold an entry by a narrower name it had before it folded into this one.
    const using = [...this.core.browsers].filter(
      ([, browser]) =>
        browser.saved.has(key) || (removed && [...browser.saved.values()].includes(removed.id)),
    );
    if (!removed && using.length === 0) {
      return { ok: false, text: `${HERE.This} keeps no sign-in for ${key}.` };
    }
    const others = new Set(
      (store?.records() ?? []).flatMap((record) => [
        record.site,
        ...(record.via ?? []),
        ...(record.opened ?? []),
      ]),
    );
    const sites = [
      key,
      ...[...(removed?.via ?? []), ...(removed?.opened ?? [])].filter((one) => !others.has(one)),
    ];
    try {
      await this.core.options.host.kept?.forget(
        (cookies) => sites.flatMap((one) => cookiesOfSite(cookies, one)),
        sites.flatMap(siteOrigins),
      );
    } catch {
      return {
        ok: false,
        text: `${HERE.This} removed ${key} from the list, but could not sign the kept profile out of it. Remove it again.`,
      };
    }
    for (const [taskId, browser] of using) {
      for (const [site, id] of browser.saved) {
        if (site === key || id === removed?.id) browser.saved.delete(site);
      }
      if (this.core.browsers.get(taskId) !== browser) continue;
      const notices = browser.notices;
      notices.notice = `${notices.notice ? `${notices.notice} ` : ""}The captain removed the sign-in kept for ${key} from ${HERE.this}, so this browser is no longer signed in there. Reload the page to see it signed out, and ask on a card if the task still needs that site.`;
      this.core.options.note?.(
        taskId,
        `your sign-in at ${key} was removed, and its browser signed out of it`,
      );
      this.core.options.onChange?.(taskId);
    }
    return { ok: true };
  }

  /**
   * The captain's Remove all in Settings: every entry goes from this
   * computer, every browser in the kept profile reopens its page out of it,
   * signed out, and the kept profile signs out of every site - those on the
   * list and any it holds that never reached it. Each crewmate whose browser
   * could use a sign-in is told on its next command.
   */
  async removeAll(): Promise<TaskBrowserCommandResult> {
    const store = this.core.options.signIns;
    for (const record of store?.records() ?? []) store?.remove(record.site);
    // Every grant goes before anything waits, so no open while the kept
    // profile empties - and none after a failed try - finds its way back in.
    const touched = [...this.core.browsers].filter(
      ([, browser]) => browser.kept || browser.saved.size > 0,
    );
    for (const [, browser] of this.core.browsers) {
      browser.saved.clear();
      browser.passed = undefined;
      browser.automaticTried = undefined;
    }
    // The kept profile empties only once no browser draws from it.
    await Promise.all(
      touched.map(([taskId, browser]) =>
        this.core.serial(taskId, async () => {
          if (this.core.browsers.get(taskId) !== browser || !browser.kept) return;
          await this.move(taskId, browser, false, addressOf(browser, browser.current));
        }),
      ),
    );
    let failed = false;
    try {
      await this.core.options.host.kept?.forgetAll();
    } catch {
      failed = true;
    }
    for (const [taskId, browser] of touched) {
      if (this.core.browsers.get(taskId) !== browser) continue;
      const notices = browser.notices;
      notices.notice = `${notices.notice ? `${notices.notice} ` : ""}The captain removed every sign-in kept on ${HERE.this}, so this browser is no longer signed in anywhere. Ask on a card if the task still needs a site signed in.`;
      this.core.options.note?.(
        taskId,
        "your sign-ins were removed, and its browser signed out of them",
      );
      this.core.options.onChange?.(taskId);
    }
    return failed
      ? {
          ok: false,
          text: `${HERE.This} removed every site from the list, but could not sign the kept profile out of them all. Remove all again.`,
        }
      : { ok: true };
  }

  /**
   * The crewmate's browser leaves the kept profile for a site it may not
   * use there: the site opens in an empty context of its own, signed out,
   * and its next answer says so.
   */
  private async leaveKept(taskId: string, browser: Browser, url: string): Promise<void> {
    if (this.core.browsers.get(taskId) !== browser || !browser.kept) return;
    if (this.allows(browser, url)) return;
    await this.move(taskId, browser, false, url);
  }

  /**
   * The browser's pages reopen at `url` in the kept profile or out of it,
   * and its crewmate's next answer says which. The load's outcome, or
   * nothing when they could not.
   */
  private async move(
    taskId: string,
    browser: Browser,
    kept: boolean,
    url: string,
  ): Promise<HostLoadOutcome | undefined> {
    const outcome = await this.core.moveProfile(taskId, browser, kept, url);
    if (!outcome || this.core.browsers.get(taskId) !== browser) return undefined;
    const site = siteOf(url);
    browser.notices.keep(
      "pageNotes",
      kept
        ? `This browser opened ${site} in the kept profile, where the captain's sign-in for it stays; refs from before are gone.`
        : `This task may not use the captain's sign-ins at ${site}, so the browser opened it in an empty context of its own, signed out; refs from before are gone.`,
    );
    return outcome;
  }
}
