import {
  type Card,
  LIVE_ATTACHMENT_LABEL_MAX,
  type LiveAttachment,
  settleEffectOf,
} from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import { projectPagePathRefusal } from "@shared/projectPage";
import {
  attachmentStanding,
  BROWSER_DOOR_LABEL,
  type OfferedSignIn,
  SAVED_SIGN_IN_FAILED_LABEL,
  SIGN_IN_MYSELF_LABEL,
  savedSignInLabel,
  TASK_BROWSER_REQUEST_MAX,
  USE_SAVED_SIGN_IN_ACTION,
} from "@shared/taskBrowser";
import { browserCommand } from "../browser/commandWords";
import { startWords } from "../browser/pageStartSteps";
import type { DeclaredAction, EmittedAction, EmittedCardInput } from "../session/tools";
import { projectPageFile } from "../workspace/projectPage";
import type { CrewSupervisorOptions } from "./crewSupervisorOptions";

/**
 * A crewmate card's browser door (docs/task-browser.md, "From a card", "A
 * page from the project", "Asking for help" and "Signed-in sites"): the
 * button that opens the task's browser, the page from the project it may
 * open instead, a request that the captain take over the browser, and the
 * saved sign-in the host offers beside it. A crewmate's cards compose it
 * (`CrewmateCards`).
 */
export class CardBrowserActions {
  constructor(
    private readonly options: CrewSupervisorOptions,
    /** A card still up on the stack, by id. */
    private readonly openCard: (id: string) => Card | undefined,
  ) {}

  /**
   * A crewmate's request that the captain take over its browser, as its
   * card declares it (`browser_handoff`, docs/task-browser.md "Asking for
   * help"): the site, why, and what it does after, each in its own words,
   * and exactly one action that opens the browser for him. An action that
   * opens it with no request is refused, and so is a request on a
   * completion card. The host reads none of the words.
   */
  browserHandoffOf(
    actions: readonly DeclaredAction[],
    declared: EmittedCardInput["browserHandoff"],
  ):
    | { site: string; reason: string; after: string; savedFailed?: true; signIn?: true }
    | undefined {
    if (actions.some((action) => action.effect?.kind === "open" && action.effect.savedSignIn)) {
      throw new Error(
        `Card refused: the saved sign-in choice is the host's to add, never a crewmate's. Declare only your own open-browser action; the host offers a saved sign-in beside it when ${HERE.this} has one for the site.`,
      );
    }
    const opens = actions.filter(
      (action) => action.effect?.kind === "open" && action.effect.target === "browser",
    );
    if (declared === undefined) {
      if (opens.length > 0) {
        throw new Error(
          "Card refused: an action that opens this task's browser for the captain needs browser_handoff - the site it is on, why you need the captain, and what you will do once control comes back.",
        );
      }
      return undefined;
    }
    const words = (text: unknown) =>
      typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
    const handoff = {
      site: words(declared.site),
      reason: words(declared.reason),
      after: words(declared.after),
    };
    if (
      !handoff.site ||
      !handoff.reason ||
      !handoff.after ||
      handoff.reason.length > TASK_BROWSER_REQUEST_MAX ||
      handoff.after.length > TASK_BROWSER_REQUEST_MAX
    ) {
      throw new Error(
        `Card refused: browser_handoff needs site, reason and after, each a short sentence of at most ${TASK_BROWSER_REQUEST_MAX} characters.`,
      );
    }
    if (opens.length !== 1) {
      throw new Error(
        'Card refused: a card with browser_handoff needs exactly one action whose effect is { kind: "open", target: "browser" }, labeled as the captain\'s step, such as Open browser and sign in.',
      );
    }
    if (actions.some((action) => settleEffectOf(action))) {
      throw new Error(
        "Card refused: a request for the captain to take over your browser is a decision of its own, never a merge card.",
      );
    }
    return {
      ...handoff,
      ...(declared.savedFailed ? { savedFailed: true as const } : {}),
      ...(declared.signIn ? { signIn: true as const } : {}),
    };
  }

  /**
   * A request card's actions once this Mac has a sign-in saved for its site
   * (docs/task-browser.md, "Signed-in sites"): the host adds Use my saved
   * <site> sign-in as the default, and the crewmate's open-browser action
   * becomes Sign in myself beside it. Once a crewmate said that save did not
   * sign its page in, Sign in myself leads and the save stays a second
   * choice that says so. The crewmate never learns which sites are saved;
   * without one its actions stand as it declared them.
   */
  withSavedSignIn(
    taskId: string,
    site: string,
    actions: readonly EmittedAction[],
  ): EmittedAction[] {
    const saved: OfferedSignIn | undefined = this.options.browsers?.savedSignInFor?.(taskId, site);
    if (!saved) return [...actions];
    const failed = saved.failedAt !== undefined;
    const own = actions.map(({ default: _default, ...action }) =>
      action.effect?.kind === "open" && action.effect.target === "browser"
        ? { ...action, label: SIGN_IN_MYSELF_LABEL, ...(failed ? { default: true } : {}) }
        : action,
    );
    return [
      ...own,
      {
        id: USE_SAVED_SIGN_IN_ACTION,
        label: failed ? SAVED_SIGN_IN_FAILED_LABEL : savedSignInLabel(saved.site),
        ...(failed ? {} : { default: true }),
        effect: { kind: "open", target: "browser", savedSignIn: true },
      },
    ];
  }

  /**
   * Whether `id` names the request card still up for the browser the
   * captain holds now (docs/task-browser.md, "Asking for help"): its
   * crewmate may revise it under the same id while he has the page, and the
   * revision redraws beside the page. A new request stays refused.
   */
  holdsRequest(taskId: string, id: string | undefined): boolean {
    const card = id?.trim() ? this.openCard(id.trim()) : undefined;
    const attachment = card?.attachment;
    if (card?.taskId !== taskId || attachment?.kind !== "browser" || !attachment.handoff)
      return false;
    const fact = this.options.browsers?.fact(taskId);
    return (
      fact?.state === "open" &&
      attachmentStanding(attachment, fact) === "same" &&
      (fact.control === "captain" || fact.control === "taking")
    );
  }

  /** The host pauses the task's browser for the captain, or refuses the card in words. */
  async pauseForCaptain(
    taskId: string,
    handoff: { site: string; reason: string; after: string; signIn?: true },
  ): Promise<void> {
    const answer = await this.options.browsers?.requestHelp(taskId, handoff);
    if (!answer) throw new Error("Card refused: this task has no browser to hand over.");
    if (!answer.ok) throw new Error(`Card refused: ${answer.text}`);
  }

  /**
   * A crewmate's browser button as its card's live attachment
   * (docs/task-browser.md, "From a card"): the label it gave, and the
   * browser its task holds now - open, or stopped with Open again still
   * offered. Refused in words when the label is not one, or when the task
   * has no browser to open.
   */
  browserAttachment(
    taskId: string,
    given: string | undefined,
    handoff: boolean,
  ): LiveAttachment | undefined {
    // A request for the captain's help always shows its browser: the site
    // it names comes from the host, never the card's words.
    const label = given ?? (handoff ? BROWSER_DOOR_LABEL : undefined);
    if (label === undefined) return undefined;
    const words = label.replace(/\s+/g, " ").trim();
    if (!words || words.length > LIVE_ATTACHMENT_LABEL_MAX) {
      throw new Error(
        `Card refused: browser_button is the label of one button, at most ${LIVE_ATTACHMENT_LABEL_MAX} characters, such as Try it or View booking.`,
      );
    }
    const fact = this.options.browsers?.fact(taskId);
    if (
      !fact ||
      fact.session === undefined ||
      fact.generation === undefined ||
      (fact.state === "stopped" && fact.stopped === "task-closed")
    ) {
      throw new Error(
        `Card refused: this task has no browser for browser_button to open. Open one with ${browserCommand("open <url>")} first, or emit the card without browser_button.`,
      );
    }
    if (handoff && fact.state !== "open") {
      throw new Error(
        `Card refused: this task's browser has stopped, so there is nothing to hand over. Open it with ${browserCommand("open <url>")} first.`,
      );
    }
    return {
      kind: "browser",
      label: words,
      taskId,
      session: fact.session,
      generation: fact.generation,
      ...(handoff ? { handoff: true as const } : {}),
    };
  }

  /**
   * The one fact line emit_card adds for a browser button whose page this
   * computer serves with no saved start (docs/task-browser.md, "Starting a
   * page again"): the card goes up, and the crewmate reads how a stopped
   * server comes back. Empty for every other card.
   */
  startReminder(taskId: string, attachment: LiveAttachment | undefined): string {
    if (attachment?.kind !== "browser" || attachment.handoff) return "";
    return this.options.browsers?.unstarted?.(taskId) ? startWords.missing() : "";
  }

  /**
   * A crewmate's browser button with a page (`browser_page`) as its card's
   * live attachment (docs/task-browser.md, "A page from the project"): the
   * label it gave and the path, once the host has found that file - an HTML
   * file reached through no link - in the task's working copy or its
   * project folder on this Mac. No browser need be open: the click opens
   * the page in the task's browser, checked again inside the project
   * folder, which is the only place it is served from. Refused in words
   * when the label is not one, the path is not a page, the card also asks
   * for help, the task has no project here, or the file is not there.
   */
  pageAttachment(
    taskId: string,
    given: string | undefined,
    page: string,
    handoff: boolean,
  ): LiveAttachment {
    if (handoff) {
      throw new Error(
        "Card refused: browser_page opens a page for the captain to use, and browser_handoff asks for their help in the browser as it is: give one, on a card of its own.",
      );
    }
    const words = (given ?? "").replace(/\s+/g, " ").trim();
    if (!words || words.length > LIVE_ATTACHMENT_LABEL_MAX) {
      throw new Error(
        `Card refused: browser_page needs browser_button, the label of its button, at most ${LIVE_ATTACHMENT_LABEL_MAX} characters, such as Play.`,
      );
    }
    const path = page.trim();
    const rule = projectPagePathRefusal(path);
    if (rule) throw new Error(`Card refused: browser_page must name ${rule}.`);
    const record = this.options.tasks.get(taskId);
    const folder = record?.repoId ? this.options.repos.get(record.repoId)?.path : undefined;
    if (!record || !folder) {
      throw new Error(
        "Card refused: browser_page opens a page from your task's project, and this task has no project. Emit the card without browser_page.",
      );
    }
    if (record.deviceId) {
      throw new Error(
        `Card refused: browser_page opens a page from the project folder on ${HERE.this}, and this task runs on another computer. Emit the card without browser_page.`,
      );
    }
    const here = projectPageFile(record.worktreeDir, path, "your working copy");
    const there = "file" in here ? here : projectPageFile(folder, path);
    if ("refusal" in here && "refusal" in there) {
      throw new Error(
        `Card refused: browser_page found no page to open. ${here.refusal} ${there.refusal} Name the HTML file you built, relative to your working copy.`,
      );
    }
    return { kind: "page", label: words, taskId, path };
  }
}
