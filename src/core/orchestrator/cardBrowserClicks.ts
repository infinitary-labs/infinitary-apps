import { CARD_REPLY_MAX_CHARS, type Card, type ShellEffect } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import {
  attachmentStanding,
  type TaskBrowserCommandResult,
  type TaskBrowserHandle,
} from "@shared/taskBrowser";
import type { BrowserReturned, PageUnanswered } from "../browser/taskBrowsers";
import type { WakeChoice } from "./captainWakes";
import type { CrewCore } from "./crewCore";
import { SUPERVISOR_STEER } from "./crewRuntime";
import type { TypedWake } from "./wakes";

/** What a card's browser clicks reach of the card actions that compose them. */
export type CardBrowserClicksHost = {
  /** A task's title for a feed line (`CardActions.taskTitle`). */
  taskTitle(taskId: string): string;
  /** The captain's choice on a card, steered to its crewmate (`CardActions`' own steer). */
  steerChoice(
    taskId: string,
    card: Card,
    source: "chrome",
    choice: WakeChoice,
    browserGone: "stopped" | "quit",
  ): void;
};

/**
 * The captain's side of a request card's browser (docs/task-browser.md,
 * "Asking for help" and "Signed-in sites"): his open-browser and saved
 * sign-in clicks, his return of the browser, and nothing answering at the
 * page he opened. `CardActions` composes it, and the browser's events reach
 * it through `CardActions`, where the card stack's callers look.
 */
export class CardBrowserClicks {
  /** Words for a return's one wake, by task (`holdReturnWords`). */
  private readonly returnWords = new Map<string, string>();

  constructor(
    private readonly core: CrewCore,
    private readonly host: CardBrowserClicksHost,
  ) {}

  /**
   * Whether the captain holds the browser a request card asked about
   * (docs/task-browser.md, "Asking for help"): its reply comes from beside
   * the page, which its crewmate cannot see until he returns control.
   */
  browserHeldFor(card: Card): boolean {
    const attachment = card.attachment;
    if (!card.taskId || attachment?.kind !== "browser" || !attachment.handoff) return false;
    const fact = this.core.options.browsers?.fact(card.taskId);
    return (
      fact?.state === "open" &&
      attachmentStanding(attachment, fact) === "same" &&
      (fact.control === "captain" || fact.control === "taking")
    );
  }

  /**
   * Whether the browser a request card's attachment names is gone
   * (docs/task-browser.md, "Asking for help"), read off the task's browser
   * fact as the view reads it (`attachmentStanding`): ended by the app's
   * quit since, or stopped in this run, with or without a newer one after
   * it. Absent while that browser still runs.
   */
  cardBrowserGone(taskId: string, handle: TaskBrowserHandle): "stopped" | "quit" | undefined {
    const fact = this.core.options.browsers?.fact(taskId);
    const standing = attachmentStanding(handle, fact);
    if (standing === "restarted") return "quit";
    return standing === "replaced" || fact?.state !== "open" ? "stopped" : undefined;
  }

  /**
   * The captain's open-browser click reached no browser: the one his
   * request card names is gone. The card stays answered, its crewmate hears
   * his choice and that its browser was gone, so it can open the site again
   * and ask anew, and the feed says so.
   */
  private cardBrowserWasGone(
    card: Card,
    taskId: string,
    told: WakeChoice,
    gone: "stopped" | "quit",
  ): void {
    this.core.options.broadcastEvent({
      type: "firstmate_note",
      text: `The card's browser for "${this.host.taskTitle(taskId)}" had stopped${gone === "quit" ? " when Infinitary quit" : ""}, so its crewmate is told to open the site again and ask you anew.`,
      taskId,
    });
    this.host.steerChoice(taskId, card, "chrome", told, gone);
  }

  /**
   * The captain's click on a request card's open-browser action
   * (docs/task-browser.md, "Asking for help"): the browser the card's
   * attachment names passes to him - its crewmate's command finishing first
   * - and the shell opens its view. A newer or older browser is never taken:
   * the view opens on whatever the task's browser is now, saying so. Only a
   * click on the card's own controls reaches here (`CardActions.act`
   * refuses an effect from a frame), and the crewmate is told nothing until
   * he returns it - unless that browser is gone, when it hears his choice
   * (`told`) at once.
   */
  openBrowserFromCard(card: Card, told?: WakeChoice): { effect?: ShellEffect } {
    const attachment = card.attachment;
    const taskId = card.taskId;
    if (!taskId || attachment?.kind !== "browser" || attachment.taskId !== taskId) return {};
    const handle = { session: attachment.session, generation: attachment.generation };
    const taken: Promise<TaskBrowserCommandResult | undefined> =
      this.core.options.browsers?.takeControl(taskId, handle) ?? Promise.resolve(undefined);
    void taken
      .catch(() => undefined)
      .then((result) => {
        if (result?.ok || !told) return;
        const gone = this.cardBrowserGone(taskId, handle);
        if (gone) this.cardBrowserWasGone(card, taskId, told, gone);
      });
    return {
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId, ...handle, cardId: card.id },
      },
    };
  }

  /**
   * The captain's open-browser click on a request card whose browser still
   * runs (docs/task-browser.md, "Asking for help"): that browser passes to
   * him and the shell opens its view, as `openBrowserFromCard` does, but the
   * card stays up unanswered, docked beside the page. His Return control
   * takes it down (`takeDownAnsweredRequests`). Should the browser turn out
   * gone before he holds it, the card leaves and its crewmate hears his
   * choice (`told`) and that the browser was gone.
   */
  openBrowserBesideCard(card: Card, told: WakeChoice): { effect?: ShellEffect } {
    const attachment = card.attachment;
    const taskId = card.taskId;
    if (!taskId || attachment?.kind !== "browser") return {};
    const handle = { session: attachment.session, generation: attachment.generation };
    const taken: Promise<TaskBrowserCommandResult | undefined> =
      this.core.options.browsers?.takeControl(taskId, handle) ?? Promise.resolve(undefined);
    void taken
      .catch(() => undefined)
      .then((result) => {
        if (result?.ok) return;
        const gone = this.cardBrowserGone(taskId, handle);
        if (!gone || !this.core.cards.get(card.id)) return;
        this.core.cards.takeDown(card.id, "browser-gone");
        this.cardBrowserWasGone(card, taskId, told, gone);
      });
    return {
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId, ...handle, cardId: card.id, docked: true },
      },
    };
  }

  /**
   * The captain's click on a request card's saved sign-in
   * (docs/task-browser.md, "Signed-in sites"): the browser the card's
   * attachment names gets the site's saved sign-in and goes back to its
   * crewmate, and the shell opens its view, where the captain watches it
   * carry on. When the saved sign-in cannot be used the browser stays paused
   * for the captain, and the feed says why; when that browser is gone, its
   * crewmate hears his choice (`told`) at once, as an open-browser click's
   * does.
   */
  grantSavedSignInFromCard(card: Card, told?: WakeChoice): { effect?: ShellEffect } {
    const attachment = card.attachment;
    const taskId = card.taskId;
    if (!taskId || attachment?.kind !== "browser" || attachment.taskId !== taskId) return {};
    const handle = { session: attachment.session, generation: attachment.generation };
    const refused = (text: string) => {
      const gone = this.cardBrowserGone(taskId, handle);
      if (gone) {
        if (told) this.cardBrowserWasGone(card, taskId, told, gone);
        return;
      }
      this.core.options.broadcastEvent({
        type: "firstmate_note",
        text: `Your sign-in was not used for "${this.host.taskTitle(taskId)}": ${text} Its browser is still paused for you.`,
        taskId,
      });
    };
    const browsers = this.core.options.browsers;
    if (!browsers?.grantSavedSignIn) refused(`${HERE.this} keeps no sign-ins.`);
    else {
      void browsers
        .grantSavedSignIn(taskId, handle)
        .then((result) => {
          if (!result.ok) refused(result.text);
        })
        .catch(() => refused(`${HERE.this} could not use it right now.`));
    }
    return {
      effect: {
        kind: "open",
        target: "browser",
        browser: { taskId, ...handle, cardId: card.id },
      },
    };
  }

  /**
   * The captain handed a task's browser back (docs/task-browser.md, "Taking
   * control"): its crewmate's one steer, named by the return so the inbox
   * queues it once, through the task's durable lane like any other. A
   * request card still up for that browser goes first.
   */
  browserReturned(taskId: string, returned: BrowserReturned): void {
    this.takeDownAnsweredRequests(taskId);
    // Words the captain left in the docked request's field ride this one wake.
    const words = this.returnWords.get(taskId);
    this.returnWords.delete(taskId);
    if (this.core.options.inbox.woken(taskId, returned.once)) return;
    this.core.options.tasks.turns.endIdle(taskId);
    const wake: TypedWake = {
      facts: {
        kind: "browser-returned",
        site: returned.site,
        ...(returned.after ? { after: returned.after } : {}),
        ...(returned.saved ? { saved: true as const } : {}),
        ...(words ? { words } : {}),
      },
      once: returned.once,
    };
    void this.core.steer.steerInternal(taskId, wake, SUPERVISOR_STEER).catch((caught: unknown) => {
      // No conversation to resume: the ladder reads the task on its own clock.
      console.warn("[crew] browser return's steer not delivered:", caught);
    });
  }

  /**
   * Nothing answers at the page the captain opened in a task's browser
   * (docs/task-browser.md, "When nothing answers"): its crewmate's one
   * steer for that outage, through the task's durable lane. While a turn of
   * its crewmate runs the steer still goes, and the lane hands it to the
   * crewmate at its next chance, so a view that says it was asked is true.
   */
  pageUnanswered(taskId: string, unanswered: PageUnanswered): void {
    const tasks = this.core.options.tasks;
    const record = tasks.get(taskId);
    if (!record || record.status === "done" || record.status === "dropped") return;
    if (this.core.options.inbox.woken(taskId, unanswered.once)) return;
    tasks.turns.endIdle(taskId);
    const wake: TypedWake = {
      facts: {
        kind: "page-unanswered",
        site: unanswered.site,
        url: unanswered.url,
        ...(unanswered.start ? { start: unanswered.start } : {}),
      },
      once: unanswered.once,
    };
    void this.core.steer.steerInternal(taskId, wake, SUPERVISOR_STEER).catch((caught: unknown) => {
      // No conversation to resume: the ladder reads the task on its own clock.
      console.warn("[crew] page-unanswered steer not delivered:", caught);
    });
  }

  /**
   * The words the captain left in a docked request's reply field as he
   * pressed Return control (docs/task-browser.md, "Asking for help"): kept
   * for the return's one wake, which may arrive from another computer after
   * the press answers. A refused return lets them go (`null`).
   */
  holdReturnWords(taskId: string, words: string | null): void {
    const typed = words?.trim();
    if (typed) this.returnWords.set(taskId, typed.slice(0, CARD_REPLY_MAX_CHARS));
    else this.returnWords.delete(taskId);
  }

  /**
   * A request card whose browser the captain just handed back asked for
   * what he has done (docs/task-browser.md, "Asking for help"): his
   * open-browser click left it docked beside the page, or he took that
   * browser from the record. The card leaves on his return, so he comes back
   * to no card, and its crewmate hears only the return's one wake, which
   * carries any words he left in its field. A card naming an older browser
   * stays, since its click tells its crewmate that browser is gone.
   */
  private takeDownAnsweredRequests(taskId: string): void {
    const fact = this.core.options.browsers?.fact(taskId);
    for (const open of [...this.core.cards.values()]) {
      const card = this.core.cards.shown(open.id);
      const attachment = card?.attachment;
      if (!card || card.taskId !== taskId || attachment?.kind !== "browser") continue;
      if (!attachment.handoff || attachmentStanding(attachment, fact) !== "same") continue;
      this.core.cards.takeDown(card.id, "browser-returned");
    }
  }
}
