import type { HostNotifications } from "@core/host";
import { CardNotifier } from "@core/notifications";
import { cardsSnapshotSchema } from "@shared/cards";
import type { CoreInvokeChannel } from "@shared/ipc";
import { readKeepingUnknown } from "@shared/openLists";

/**
 * A window's card notifications for a first mate in another program
 * (docs/view.md, "Notifications"): the same notifier reads the card pushes
 * that first mate sends, and posts on the computer the window is on, while
 * no window here is in front. A window on another computer posts this
 * way, and so does the window opened beside a first mate a command
 * started, which never posts itself (docs/run.md, "The window opened
 * beside it"). The switch is the first mate's: it is read before each one,
 * and unknown is off.
 */
export class ViewNotices {
  private readonly notifier: CardNotifier;
  private stopped = false;

  constructor(
    private readonly notifications: HostNotifications,
    private readonly ask: (channel: CoreInvokeChannel, args: unknown[]) => Promise<unknown>,
  ) {
    this.notifier = new CardNotifier({
      enabled: () => notifications.supported(),
      focused: () => notifications.focused(),
      show: (notification) => void this.post(notification),
    });
  }

  /** One `inf:cards` push. */
  observe(payload: unknown): void {
    const cards = readKeepingUnknown(cardsSnapshotSchema, payload);
    if (cards.success) this.notifier.observe(cards.data);
  }

  /** What the first mate shows now, so the next card it gains is news here. */
  async seed(): Promise<void> {
    try {
      const cards = readKeepingUnknown(cardsSnapshotSchema, await this.ask("inf:cards:list", []));
      if (cards.success) this.notifier.seed(cards.data);
    } catch {
      // The next push seeds it instead.
    }
  }

  /** The window reads everything again: what that read finds is old news, as restored cards are. */
  startOver(): void {
    this.notifier.forget();
    void this.seed();
  }

  stop(): void {
    this.stopped = true;
  }

  private async post(notification: { title: string; body: string }): Promise<void> {
    let on: unknown = false;
    try {
      on = await this.ask("inf:settings:notifications:get", []);
    } catch {
      return;
    }
    if (on !== true || this.stopped || this.notifications.focused()) return;
    this.notifications.show(notification);
  }
}
