import {
  type Browser,
  type BrowsersCore,
  bareAddress,
  loadOwn,
  pageAddress,
  siteOf,
} from "./browserRecord";
import { type AnswerTarget, answerTarget, probeLoopback } from "./pageAnswers";
import type { PageStart } from "./pageStarts";
import type { TaskBrowsersOptions } from "./taskBrowserOptions";

/**
 * A task page's outages (docs/task-browser.md, "When nothing answers" and
 * "Starting a page again"): one per task at a time while nothing answers at
 * a loopback address its crewmate opened, named for its crewmate's one wake,
 * and the saved start the host runs instead of waking it.
 */
export class PageOutages {
  /**
   * The loopback address nothing answered at, per task, until it answers
   * again: one outage, with the name its crewmate's one wake carries.
   */
  private readonly outages = new Map<string, { origin: string; once: string; failed?: true }>();
  /** How many outages this run has seen: each one's name follows. */
  private outageCount = 0;

  constructor(private readonly core: BrowsersCore) {}

  /** The task closed: an outage it had goes with it. */
  forget(taskId: string): void {
    this.outages.delete(taskId);
  }

  /**
   * Whether anything answers at the loopback address a task's page is on
   * (docs/task-browser.md, "When nothing answers"): only an address its
   * crewmate opened, never a project folder the host serves itself. A
   * refused connection starts an outage and, with `wake`, tells its
   * crewmate's wake; an answer ends it. Any other reading changes nothing.
   */
  async checkAnswers(taskId: string, browser: Browser, options: { wake: boolean }): Promise<void> {
    const address = pageAddress(browser);
    const target = answerTarget(address);
    if (!target || !browser.origins.has(target.origin)) return;
    if (browser.server && address.startsWith(`${browser.server.origin}/`)) return;
    const reading = await (this.core.options.probe ?? probeLoopback)(
      target.host,
      target.port,
    ).catch(() => "unknown" as const);
    if (this.core.browsers.get(taskId) !== browser) return;
    const outage = this.outages.get(taskId);
    if (reading === "answered") {
      if (outage) {
        this.outages.delete(taskId);
        this.core.options.onChange?.(taskId);
      }
      return;
    }
    if (reading !== "refused") return;
    let current: { origin: string; once: string; failed?: true } | undefined = outage;
    if (!current || current.origin !== target.origin) {
      this.outageCount += 1;
      current = {
        origin: target.origin,
        once: `page-unanswered:${this.core.session}:${taskId}:${this.outageCount}`,
      };
      this.outages.set(taskId, current);
      this.core.options.onChange?.(taskId);
    }
    if (!options.wake) return;
    // A saved start runs first; its crewmate is woken only once it failed.
    const start = current.failed
      ? undefined
      : this.core.options.starts?.kept(taskId, target.origin);
    if (start) this.startPage(taskId, browser, start, target, current);
    else {
      this.core.options.onUnanswered?.(taskId, {
        site: siteOf(address),
        url: bareAddress(address),
        once: current.once,
      });
    }
  }

  /**
   * Run a task's saved start while the captain waits at its page
   * (docs/task-browser.md, "Starting a page again"): the page loads again
   * once its address answers; when the program exits first or its wait
   * runs out, its crewmate gets the outage's one wake, with how it failed.
   */
  private startPage(
    taskId: string,
    browser: Browser,
    start: PageStart,
    target: AnswerTarget,
    outage: { origin: string; once: string; failed?: true },
  ): void {
    const starts = this.core.options.starts as NonNullable<TaskBrowsersOptions["starts"]>;
    const fresh = !starts.starting(taskId);
    const address = pageAddress(browser);
    void starts.run(taskId, start, target).then(async (outcome) => {
      if (this.core.browsers.get(taskId) !== browser || outcome.kind === "stopped") return;
      if (outcome.kind === "answered") {
        // Only the press that started it loads the page again, and only one still on its origin.
        if (!fresh) return;
        await this.core.serial(taskId, async () => {
          const now = pageAddress(browser);
          if (this.core.browsers.get(taskId) !== browser) return;
          if (answerTarget(now)?.origin !== outage.origin) return;
          const entry = browser.current;
          const loaded = await loadOwn(entry, entry.page.load(now));
          if (!loaded.ok) entry.moved = undefined;
        });
        await this.checkAnswers(taskId, browser, { wake: false });
        this.core.options.onChange?.(taskId);
        return;
      }
      outage.failed = true;
      this.core.options.onChange?.(taskId);
      this.core.options.onUnanswered?.(taskId, {
        site: siteOf(address),
        url: bareAddress(address),
        once: outage.once,
        start: {
          command: start.command,
          ...(outcome.ranOut ? { ranOut: true as const } : { exit: outcome.exit ?? null }),
          log: outcome.log,
        },
      });
    });
    if (fresh) this.core.options.onChange?.(taskId);
  }

  /** Whether the task's current page is on the origin of its running outage; no outage, no notice. */
  isUnanswered(taskId: string, browser: Browser): boolean {
    const outage = this.outages.get(taskId);
    return outage !== undefined && outage.origin === answerTarget(pageAddress(browser))?.origin;
  }

  /** A crewmate's command moved the page: an outage ends once its address answers again. */
  answeredAgain(taskId: string): void {
    const browser = this.core.browsers.get(taskId);
    if (!browser || !this.outages.has(taskId)) return;
    void this.checkAnswers(taskId, browser, { wake: false });
  }
}
