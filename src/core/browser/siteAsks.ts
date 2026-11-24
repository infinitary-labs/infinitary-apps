import type {
  TaskBrowserAskAnswer,
  TaskBrowserCommandResult,
  TaskBrowserHandle,
} from "@shared/taskBrowser";
import type { HostBrowserAsk } from "../host";
import {
  type Browser,
  type BrowsersCore,
  type PageAsk,
  type PageEntry,
  siteOf,
} from "./browserRecord";
import { refusalWords } from "./pageNotices";

/**
 * A site's asks of a task's pages (docs/task-browser.md, "A site's asks"):
 * a passkey, a device check, the camera, the microphone, notifications or
 * the clipboard. While the crewmate drives every ask is no; while the
 * captain holds the browser one waits at a time for the captain's answer,
 * and every permission allowed goes at Return control.
 */
export class SiteAsks {
  constructor(private readonly core: BrowsersCore) {}

  /**
   * Where the captain sits when taking, drives or answers the task's
   * browser (docs/task-browser.md, "A site's asks"): at the computer it runs
   * on, or away from it. Only there can Chrome show the captain a passkey's prompt.
   */
  captainAt(taskId: string, here: boolean): void {
    const browser = this.core.browsers.get(taskId);
    if (browser) browser.here = here;
  }

  /**
   * The captain's answer to what the page asks the captain now (docs/task-browser.md,
   * "A site's asks"): Allow once lets the page's call run, its permission
   * granted for that site until the captain returns control; Not now ends it as not
   * allowed. A passkey waits for Use passkey, which lets it run in Chrome and
   * brings Chrome's window forward for the system's prompt, or Not now; once
   * let run, Show Chrome window brings that window forward again. Refused in
   * words for an ask that is no longer there.
   */
  async answerAsk(
    taskId: string,
    handle: TaskBrowserHandle,
    id: number,
    answer: TaskBrowserAskAnswer,
  ): Promise<TaskBrowserCommandResult> {
    const browser = this.core.browsers.get(taskId);
    if (!browser || !this.core.isHandled(browser, handle)) {
      return { ok: false, text: "This browser is no longer running." };
    }
    if (browser.control !== "captain") {
      return { ok: false, text: "You do not have control of this browser." };
    }
    const asking = browser.asking;
    if (!asking || asking.id !== id) {
      return { ok: false, text: "The page no longer asks for that." };
    }
    if (asking.kind === "passkey") {
      if (answer === "not-now" && !asking.shown) {
        asking.answer?.(false);
        return { ok: true };
      }
      // Use passkey (sent as show, which a view without ask-first offers too), or Allow once.
      if (answer === "not-now" || !asking.entry.page.showWindow) {
        return { ok: false, text: "Answer the passkey's prompt in Chrome's own window." };
      }
      if (!asking.shown) {
        asking.shown = true;
        asking.answer?.(true);
        this.core.options.onChange?.(taskId);
      }
      await asking.entry.page.showWindow(true).catch(() => undefined);
      return { ok: true };
    }
    if (answer === "show") return { ok: false, text: "That page asks for no passkey." };
    asking.answer?.(answer === "allow");
    return { ok: true };
  }

  /**
   * One ask of a page (docs/task-browser.md, "A site's asks"). While the
   * crewmate drives, every ask is no, and a passkey's is told to it. While
   * the captain holds the browser, a permission waits for the captain's Allow once or
   * Not now, one ask at a time; a passkey is asked only in Chrome with the captain at
   * its computer, where Use passkey lets Chrome ask in its own window, and is otherwise told
   * no at once and told to the captain, so the site offers its other ways.
   * Chrome's window goes back to the Dock when the request ends, whatever
   * brought it out.
   */
  async pageAsked(
    taskId: string,
    browser: Browser,
    entry: PageEntry,
    ask: HostBrowserAsk,
  ): Promise<boolean> {
    if (this.core.browsers.get(taskId) !== browser) return false;
    const holds = browser.control === "captain";
    const chrome = entry.page.showWindow !== undefined;
    if (ask.kind === "platform") return holds && chrome && browser.here === true;
    if (!holds) {
      if (ask.kind === "passkey") {
        const words = refusalWords({ kind: "passkey", url: ask.url });
        if (!browser.notices.refusals.includes(words)) browser.notices.keep("refusals", words);
      }
      return false;
    }
    const site = siteOf(ask.url);
    if (ask.kind === "passkey" && !(chrome && browser.here === true)) {
      browser.told = { kind: "passkey", site, where: chrome ? "away" : "engine" };
      this.core.options.onChange?.(taskId);
      return false;
    }
    // One ask at a time: a second while the first waits is no.
    if (browser.asking) return false;
    browser.asks = (browser.asks ?? 0) + 1;
    const asking: PageAsk = { id: browser.asks, kind: ask.kind, site, entry };
    const settle = (): void => {
      if (browser.asking !== asking) return;
      browser.asking = undefined;
      if (this.core.browsers.get(taskId) === browser) this.core.options.onChange?.(taskId);
    };
    browser.asking = asking;
    browser.told = undefined;
    this.core.options.onChange?.(taskId);
    if (ask.kind === "passkey") {
      // Use passkey lets it run and Chrome's own prompt answers it; its window
      // goes back to the Dock when it ends, even one that came out by itself.
      return new Promise<boolean>((resolve) => {
        asking.answer = (allow) => {
          asking.answer = undefined;
          if (!allow) settle();
          resolve(allow);
        };
        void ask.ended.then(() => {
          asking.answer?.(false);
          settle();
          void entry.page.showWindow?.(false).catch(() => undefined);
        });
      });
    }
    return new Promise<boolean>((resolve) => {
      asking.answer = (allow) => {
        settle();
        resolve(allow);
      };
      void ask.ended.then(() => asking.answer?.(false));
    });
  }

  /**
   * The captain lets the browser go: an ask still waiting is no, every
   * Chrome window of its pages goes back to the Dock - a passkey's, or one
   * Chrome brought out by itself - and every permission a site was let use
   * is taken back.
   */
  async endAsks(browser: Browser): Promise<void> {
    const asking = browser.asking;
    browser.asking = undefined;
    browser.told = undefined;
    asking?.answer?.(false);
    await Promise.all(
      browser.pages.map((entry) =>
        Promise.all([
          entry.page.showWindow?.(false).catch(() => undefined),
          entry.page.revokeAsks().catch(() => undefined),
        ]),
      ),
    );
  }
}
