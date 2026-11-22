import { randomUUID } from "node:crypto";
import type { FSWatcher } from "node:fs";
import type { FreshAuthentication } from "@core/secrets/approvals";
import { readStandbyHome, readStandbyState } from "@core/standby/keeper";
import {
  type FolderWatch,
  folderWatch,
  readTakeOverAnswer,
  TAKE_OVER_LOOK_MS,
  writeTakeOverAsk,
} from "@core/standby/takeOver";
import type { TakeOverOffer, ViewContact } from "@shared/devices";

export type TakeOverOutcome = { ok: boolean; text: string };

export const VIEW_TAKE_OVER_WORDS = {
  noOffer: "This Mac cannot take over now.",
  noConfirm:
    "This Mac cannot confirm it is you, with Touch ID or your password, so it cannot take over.",
  notConfirmed: "Nothing was taken over.",
  /** Follows macOS's own "Infinitary is trying to" in its dialog. */
  reason: (name: string) => `take over as your first mate's computer from ${name}`,
  stoppedWaiting:
    "This window stopped waiting before this Mac answered. Taking over may still go on, and its answer shows here.",
};

/**
 * The same on a Windows PC, which confirms with Windows Hello or the
 * person's Windows password (./host/windowsFreshAuthentication.ts), whose
 * dialog shows the reason alone, as a sentence.
 */
export const VIEW_TAKE_OVER_WORDS_WINDOWS: typeof VIEW_TAKE_OVER_WORDS = {
  noOffer: "This PC cannot take over now.",
  noConfirm:
    "This PC cannot confirm it is you, with Windows Hello or your Windows password, so it cannot take over.",
  notConfirmed: "Nothing was taken over.",
  reason: (name: string) => `Take over as your first mate's computer from ${name}.`,
  stoppedWaiting:
    "This window stopped waiting before this PC answered. Taking over may still go on, and its answer shows here.",
};

export function viewTakeOverWords(platform: NodeJS.Platform): typeof VIEW_TAKE_OVER_WORDS {
  return platform === "win32" ? VIEW_TAKE_OVER_WORDS_WINDOWS : VIEW_TAKE_OVER_WORDS;
}

/**
 * Take over on a computer that keeps a copy (docs/devices.md, "Taking
 * over"): the offer the window shows while the first mate's computer is out
 * of reach, and the captain's click, confirmed by Touch ID or the password
 * on a Mac and by Windows Hello or the Windows password on a Windows PC,
 * written for the work running here, which answers it.
 */
export class ViewTakeOver {
  private goodbye: "sleep" | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** Ends the wait for an answer still to come, with this outcome. */
  private waiting: ((answer: { state: "refused"; text: string }) => void) | null = null;

  constructor(
    private readonly options: {
      /** The work folder of this Mac's own work, which keeps the copy. */
      workDir: string;
      /** This Mac's id on the first mate's list. */
      deviceId: string;
      /** This computer confirms the person now; none where it cannot. */
      authentication: () => FreshAuthentication | undefined;
      /** What it says, in its system's words (`viewTakeOverWords`); a Mac's by default. */
      words?: typeof VIEW_TAKE_OVER_WORDS;
      /** The first mate started here: the window starts over as its own. */
      started: () => void;
      /** The offer changed. */
      changed: () => void;
      /** The folder's watch; the system's own by default. */
      watch?: FolderWatch;
      /** How often the answer is read again beside the watch (`TAKE_OVER_LOOK_MS`). */
      lookMs?: number;
    },
  ) {}

  /** The first mate's computer said it is going to sleep (`inf:home:goodbye`). */
  heardGoodbye(): void {
    this.goodbye = "sleep";
    this.options.changed();
  }

  /** It answered again: its goodbye is over. */
  heardAgain(): void {
    if (this.goodbye === null) return;
    this.goodbye = null;
    this.options.changed();
  }

  offer(contact: ViewContact): TakeOverOffer | undefined {
    if (contact !== "lost" && contact !== "closed") return undefined;
    const { workDir } = this.options;
    const copy = readStandbyState(workDir);
    if (!copy.stream || copy.at === null) return undefined;
    const home = readStandbyHome(workDir);
    const answer = readTakeOverAnswer(workDir);
    return {
      copyAt: copy.at,
      goodbye: contact === "closed" ? "quit" : this.goodbye,
      // Every other copy, as the first mate's computer last said it; one that held
      // more changes than this one may be newer.
      copies: (home?.copies ?? [])
        .filter((each) => each.deviceId !== this.options.deviceId)
        .slice(0, 64)
        .map((each) => ({
          name: each.name,
          copyAt: each.copyAt,
          newer: each.seq !== null && each.seq > copy.seq,
        })),
      ready: home !== null,
      asked: answer ? { state: answer.state, text: answer.text } : null,
    };
  }

  /** The captain's click: confirmed here, then asked of this computer's work, which answers. */
  async takeOver(contact: ViewContact, homeName: string): Promise<TakeOverOutcome> {
    const words = this.options.words ?? VIEW_TAKE_OVER_WORDS;
    const offer = this.offer(contact);
    if (!offer?.ready || offer.asked?.state === "running")
      return { ok: false, text: offer?.asked?.text ?? words.noOffer };
    const authentication = this.options.authentication();
    if (!authentication || !(await authentication.available().catch(() => false)))
      return { ok: false, text: words.noConfirm };
    if (!(await authentication.confirm(words.reason(homeName)).catch(() => false)))
      return { ok: false, text: words.notConfirmed };
    const id = randomUUID();
    const answered = this.answerOf(id);
    writeTakeOverAsk(this.options.workDir, { version: 1, id, at: Date.now() });
    this.options.changed();
    const answer = await answered;
    this.options.changed();
    if (answer.state === "started") this.options.started();
    return { ok: answer.state === "started", text: answer.text };
  }

  /** Resolves with the work's last answer to `id`, heard as it writes it. */
  private answerOf(id: string): Promise<{ state: "started" | "refused"; text: string }> {
    this.stopWaiting();
    return new Promise((resolve) => {
      const done = (answer: { state: "started" | "refused"; text: string }) => {
        this.stopLooking();
        this.waiting = null;
        resolve(answer);
      };
      this.waiting = done;
      const look = () => {
        const answer = readTakeOverAnswer(this.options.workDir);
        if (answer?.id !== id) return;
        this.options.changed();
        if (answer.state === "running") return;
        done({ state: answer.state, text: answer.text });
      };
      // The answer lands by a rename from a temporary name, reported by either name.
      this.watcher = (this.options.watch ?? folderWatch)(this.options.workDir, look);
      this.watcher.on("error", () => {});
      // The watch may miss the answer's rename; reading it again finds it all the same.
      this.timer = setInterval(look, this.options.lookMs ?? TAKE_OVER_LOOK_MS);
      this.timer.unref?.();
      look();
    });
  }

  private stopLooking(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ends a wait still open, so no click waits on a window that stopped. */
  private stopWaiting(): void {
    this.waiting?.({
      state: "refused",
      text: (this.options.words ?? VIEW_TAKE_OVER_WORDS).stoppedWaiting,
    });
    this.stopLooking();
  }

  dispose(): void {
    this.stopWaiting();
  }
}
