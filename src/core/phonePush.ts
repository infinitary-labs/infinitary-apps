import { createCipheriv, randomBytes } from "node:crypto";
import { type Card, onStage } from "@shared/cards";
import {
  type PhonePushCard,
  type PhonePushRegistration,
  type PhonePushRelayRequest,
  type PhonePushTarget,
  type PhonePushWithdrawal,
  phoneWithdrawRelay,
} from "@shared/phonePush";
import { cutText } from "@shared/textCut";
import type { DevicePairing } from "./devices/pairing";
import type { HostNotifications } from "./host";
import { type CardNotice, CardNotifier, type CardNotifierOptions } from "./notifications";
import { PhoneLetters } from "./phoneLetters";

/**
 * The phone sender (docs/phone-push.md): beside the Mac's own notifications,
 * a second `CardNotifier` hands it the same card-worthy moments, and it seals
 * each one for every paired phone that asked for pushes and posts it to
 * Infinitary's relay, which wakes the phone through Apple. Only the phone's
 * own key opens what it posts: the relay reads a grant, a push address and
 * sealed bytes, never a card's words. To a phone that takes withdrawals it
 * also posts which of the cards it pushed were since seen or left the
 * stage, so the phone removes their notifications ("Withdrawals").
 */

export type PhonePushesOptions = {
  /** Each paired phone that asked for pushes, with where (`DevicePairing.pushTargets`). */
  targets: () => PhonePushTarget[];
  /**
   * The relay said this registration no longer works: its push address is
   * gone, or its grant expired (`DevicePairing.forgetPush`).
   */
  forget: (deviceId: string, grant: string) => void;
  /**
   * Reads the phone's box of letters right after the relay refused its grant
   * (`PhoneLetters.readNow`); true when a newer letter renewed the
   * registration, so the refused card goes once more.
   */
  refused?: (deviceId: string) => Promise<boolean>;
  /** Where to post: Infinitary's relay, or a development run's stand-in. */
  relay: string;
  /** The Notifications switch (Settings -> General); no withdrawal goes while it is off. */
  switchedOn?: () => boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** Runs `run` after `ms`: a withdrawal waiting for its phone's spacing (`WITHDRAW_SPACING_MS`). */
  later?: (run: () => void, ms: number) => void;
  /** One line for what could not be sent; it never carries a card's words. */
  onProblem: (text: string) => void;
};

/**
 * A notification title longer than this is cut, so a push with the longest
 * body (`NOTICE_BODY_LIMIT`) stays inside Apple's 4 KB payload after sealing
 * and base64url.
 */
const TITLE_CUT = 200;

/** How long one post to the relay may take. */
const POST_TIMEOUT_MS = 10_000;

/** The 12-byte nonce AES-GCM takes, and its 16-byte tag. */
const NONCE_BYTES = 12;

/**
 * How long a 429 or a 503 holds the next push back: the relay counts its
 * limits per minute and asks the sender to wait a minute (its contract,
 * "Answers").
 */
const RELAY_WAIT_MS = 60_000;

/**
 * How long after one withdrawal to a phone the next may go. Apple asks for
 * no more than two or three background pushes an hour ("Pushing background
 * updates to your app") and may hold back an app that sends more; a
 * withdrawal is one, so each phone hears at most three an hour.
 */
export const WITHDRAW_SPACING_MS = 20 * 60_000;

/**
 * The most bytes Apple takes in one push's payload, which the relay also
 * refuses past (its `APPLE_PAYLOAD_LIMIT`): a withdrawal names as many
 * cards as fit.
 */
export const APPLE_PAYLOAD_LIMIT = 4096;

/** What the relay wraps around the sealed text for a withdrawal, less the text itself. */
const WITHDRAW_PAYLOAD_BYTES = Buffer.byteLength(
  JSON.stringify({ aps: { "content-available": 1 }, sealed: "" }),
);

/** The 16-byte tag AES-GCM adds. */
const TAG_BYTES = 16;

/** A withdrawn card and the pushes of it withdrawn (`PhonePushCard.push`). */
type Withdrawn = PhonePushWithdrawal["cards"][number];

/** How many random bytes name one push: never given to another. */
const PUSH_NAME_BYTES = 9;

/**
 * What the computer holds for one phone that takes withdrawals, this run
 * only: the push address and key its pushes went to, the pushes of each card
 * the relay took there that are not yet withdrawn, and the cards withdrawn
 * there, newest first.
 */
type PhoneWithdrawals = {
  token: string;
  key: string;
  pushed: Map<string, string[]>;
  withdrawn: Withdrawn[];
  /** The pushes on the list that no withdrawal named yet: they go first. */
  fresh: Set<string>;
  /** When the last withdrawal went to the relay. */
  lastAt?: number;
  /** A withdrawal waits for its spacing. */
  waitingToSend: boolean;
};

export class PhonePushes {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly inFlight = new Set<Promise<void>>();
  /** A phone whose pushes wait after a 429, until when. */
  private readonly waiting = new Map<string, number>();
  /** Every push waits after a 503, until when: the relay itself is not ready. */
  private relayWaitsUntil = 0;
  /** Each phone that takes withdrawals, by device id. */
  private readonly withdrawals = new Map<string, PhoneWithdrawals>();
  /**
   * The newest cards broadcast, by id: a push the relay takes after its card
   * was already seen is withdrawn against it (`pushedTo`).
   */
  private lastCards: Map<string, Card> | undefined;
  /**
   * Each push the relay has not yet answered, by name, and whether its card
   * was seen or left the stage since: a later unread update of the card does
   * not keep this push's notification (`pushedTo`).
   */
  private readonly unanswered = new Map<string, { cardId: string; due: boolean }>();
  private readonly later: (run: () => void, ms: number) => void;

  constructor(private readonly options: PhonePushesOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.later =
      options.later ??
      ((run, ms) => {
        setTimeout(run, ms).unref?.();
      });
  }

  /** Whether any paired phone asked for pushes. */
  any(): boolean {
    return this.options.targets().length > 0;
  }

  /**
   * Sends one card-worthy moment to every phone that asked; never waits for
   * the relay. A phone the relay asked to wait is skipped until the wait
   * ends: Apple keeps only an app's newest push, and the card stays on the
   * stage for when the phone opens.
   */
  send(notice: CardNotice): void {
    const now = this.now();
    if (now < this.relayWaitsUntil) return;
    const push = randomBytes(PUSH_NAME_BYTES).toString("base64url");
    const card: PhonePushCard = {
      v: 1,
      kind: notice.kind,
      cardId: notice.cardId,
      title: cutText(notice.title, TITLE_CUT),
      body: notice.body,
      push,
    };
    const posts: Promise<void>[] = [];
    for (const target of this.options.targets()) {
      const { deviceId } = target;
      if (now < (this.waiting.get(deviceId) ?? 0)) continue;
      this.waiting.delete(deviceId);
      posts.push(this.pushCard(target, card, true));
    }
    if (posts.length === 0) return;
    this.unanswered.set(push, { cardId: notice.cardId, due: false });
    this.track(
      Promise.all(posts)
        .finally(() => this.unanswered.delete(push))
        .then(() => undefined),
    );
  }

  /**
   * Posts one card to one phone, and when the relay takes it from a phone
   * that takes withdrawals, notes it for them. On a refused grant, a newer
   * letter in the phone's box sends it once more (`again`), under the
   * registration the letter renewed.
   */
  private async pushCard(
    target: PhonePushTarget,
    card: PhonePushCard,
    again: boolean,
  ): Promise<void> {
    const { deviceId, registration } = target;
    const sent = await this.post(
      deviceId,
      registration,
      this.options.relay,
      sealCardPush(registration.key, card),
      "a card push",
      again ? () => this.pushAgain(deviceId, card) : undefined,
    );
    if (sent && registration.withdrawals) this.pushedTo(target, card.cardId, card.push ?? "");
  }

  /** The card the relay refused goes once more, to the registration a letter renewed. */
  private pushAgain(deviceId: string, card: PhonePushCard): void {
    const target = this.options.targets().find((entry) => entry.deviceId === deviceId);
    if (!target || this.now() < this.relayWaitsUntil) return;
    this.track(this.pushCard(target, card, false));
  }

  /**
   * Reads one cards broadcast for withdrawals: a card pushed to a phone that
   * takes them is withdrawn once its newest version was seen, or once it
   * left the stage (gone, ended, or waiting on its author's answer). The
   * first withdrawal to a phone goes at once, a later one
   * `WITHDRAW_SPACING_MS` after the one before.
   */
  observe(cards: Card[]): void {
    const byId = new Map(cards.map((card) => [card.id, card]));
    this.lastCards = byId;
    for (const sending of this.unanswered.values())
      if (withdrawable(byId.get(sending.cardId))) sending.due = true;
    if (this.withdrawals.size === 0) return;
    const targets = new Map(this.options.targets().map((target) => [target.deviceId, target]));
    for (const id of this.withdrawals.keys()) {
      if (!targets.get(id)?.registration.withdrawals) this.withdrawals.delete(id);
    }
    for (const [deviceId, phone] of this.withdrawals) {
      this.renewList(phone, targets.get(deviceId));
      this.withdrawDue(deviceId, phone, byId);
    }
  }

  /**
   * The Notifications switch turned on: a withdrawal held while it was off
   * goes now, or once its spacing is over.
   */
  switched(): void {
    for (const deviceId of this.withdrawals.keys()) this.sendWithdrawal(deviceId);
  }

  /** Waits for every post in flight; tests and shutdown read what was sent. */
  async settled(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  private track(work: Promise<void>): void {
    const tracked = work.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  /** Moves a phone's pushed cards that are due onto its withdrawal list, and sends it. */
  private withdrawDue(deviceId: string, phone: PhoneWithdrawals, byId: Map<string, Card>): void {
    const due = [...phone.pushed].filter(([id]) => withdrawable(byId.get(id)));
    if (due.length === 0) return;
    for (const [cardId, pushes] of due) {
      phone.pushed.delete(cardId);
      this.withdraw(phone, cardId, pushes);
    }
    this.sendWithdrawal(deviceId);
  }

  /** Puts a card's pushes at the front of a phone's list, beside any withdrawn before. */
  private withdraw(phone: PhoneWithdrawals, cardId: string, pushes: string[]): void {
    const earlier = phone.withdrawn.find((other) => other.cardId === cardId)?.pushes ?? [];
    phone.withdrawn = [
      { cardId, pushes: [...new Set([...earlier, ...pushes])] },
      ...phone.withdrawn.filter((other) => other.cardId !== cardId),
    ];
    for (const push of pushes) phone.fresh.add(push);
  }

  /**
   * The relay took a card push for a phone that takes withdrawals: the card
   * is withdrawn once due, at once when the newest broadcast already shows it
   * seen or gone. A push whose card was seen or left the stage while the
   * relay had not answered is withdrawn alone, even if a newer update of the
   * card now waits unread. Only while the phone's push address and key are
   * still the ones the push went to: a phone that handed the same ones again
   * still shows it.
   */
  private pushedTo(sentTo: PhonePushTarget, cardId: string, push: string): void {
    const { deviceId } = sentTo;
    const target = this.options.targets().find((entry) => entry.deviceId === deviceId);
    if (
      !target?.registration.withdrawals ||
      target.registration.token !== sentTo.registration.token ||
      target.registration.key !== sentTo.registration.key
    ) {
      return;
    }
    let phone = this.withdrawals.get(deviceId);
    if (!phone) {
      phone = {
        token: target.registration.token,
        key: target.registration.key,
        pushed: new Map(),
        withdrawn: [],
        fresh: new Set(),
        waitingToSend: false,
      };
      this.withdrawals.set(deviceId, phone);
    }
    this.renewList(phone, target);
    if (this.unanswered.get(push)?.due) {
      this.withdraw(phone, cardId, [push]);
      this.sendWithdrawal(deviceId);
      return;
    }
    // Pushed again, as an author's answer: the new push is withdrawn only
    // once due; a withdrawal of the earlier one leaves its notification.
    phone.pushed.set(cardId, [...(phone.pushed.get(cardId) ?? []), push]);
    if (this.lastCards) this.withdrawDue(deviceId, phone, this.lastCards);
  }

  /**
   * A phone that handed a new push address or key starts anew: the pushes it
   * tracked and the list went to the old one. Handing the same ones again
   * keeps both: a push the phone already removed matches nothing there, and
   * a withdrawal waiting for its spacing still goes.
   */
  private renewList(phone: PhoneWithdrawals, target: PhonePushTarget | undefined): void {
    if (!target) return;
    const { token, key } = target.registration;
    if (token === phone.token && key === phone.key) return;
    phone.token = token;
    phone.key = key;
    phone.pushed.clear();
    phone.withdrawn = [];
    phone.fresh.clear();
  }

  /**
   * Posts a phone's withdrawal now, or once its spacing and any wait the
   * relay asked for are over. It goes only while the switch is on, to a
   * phone that still takes withdrawals, and only when a card was withdrawn
   * since the last one went.
   */
  private sendWithdrawal(deviceId: string): void {
    const phone = this.withdrawals.get(deviceId);
    if (!phone?.fresh.size || phone.waitingToSend) return;
    if (!(this.options.switchedOn?.() ?? true)) return;
    const now = this.now();
    const at = Math.max(
      phone.lastAt === undefined ? now : phone.lastAt + WITHDRAW_SPACING_MS,
      this.waiting.get(deviceId) ?? 0,
      this.relayWaitsUntil,
    );
    if (at > now) {
      phone.waitingToSend = true;
      this.later(() => {
        phone.waitingToSend = false;
        this.sendWithdrawal(deviceId);
      }, at - now);
      return;
    }
    const target = this.options.targets().find((entry) => entry.deviceId === deviceId);
    if (!target?.registration.withdrawals) {
      this.withdrawals.delete(deviceId);
      return;
    }
    this.renewList(phone, target);
    if (phone.fresh.size === 0) return;
    const { key } = target.registration;
    const cards = fittingWithdrawal(phone.withdrawn, phone.fresh);
    const named = new Set(cards.flatMap((card) => card.pushes));
    // What went before and no longer fits is dropped; a push no withdrawal
    // named yet that does not fit waits for the next one.
    for (const push of named) phone.fresh.delete(push);
    phone.withdrawn = phone.withdrawn.flatMap(({ cardId, pushes }) => {
      const kept = pushes.filter((push) => named.has(push) || phone.fresh.has(push));
      return kept.length > 0 ? [{ cardId, pushes: kept }] : [];
    });
    if (cards.length === 0) return;
    phone.lastAt = now;
    this.waiting.delete(deviceId);
    // Each card names the pushes withdrawn, so another push of it, which Apple
    // may deliver before this slower background push, keeps its notification.
    const withdrawal: PhonePushWithdrawal = { v: 1, kind: "withdraw", cards };
    this.track(
      this.post(
        deviceId,
        target.registration,
        phoneWithdrawRelay(this.options.relay),
        seal(key, withdrawal),
        "a withdrawal",
      ).then(() => undefined),
    );
    this.sendWithdrawal(deviceId);
  }

  /**
   * Posts one sealed push; true when the relay took it. `again` runs when the
   * relay refused the grant and the phone's box held a newer letter.
   */
  private async post(
    deviceId: string,
    registration: PhonePushRegistration,
    url: string,
    sealed: string,
    what: string,
    again?: () => void,
  ): Promise<boolean> {
    const request: PhonePushRelayRequest = {
      token: registration.token,
      environment: registration.environment,
      grant: registration.grant,
      sealed,
    };
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
      if (response.ok) return true;
      // 410: Apple no longer takes this address. 403: the grant expired or
      // does not name it. Either way the phone registers again and hands a
      // new one when it next connects, so this one is forgotten.
      if (response.status === 410 || response.status === 403) {
        this.options.forget(deviceId, registration.grant);
        // The phone may have left a newer grant or push address in a letter
        // (docs/phone-push.md, "Letters"): read its box once more now.
        const { refused } = this.options;
        if (refused)
          this.track(
            refused(deviceId).then((renewed) => {
              if (renewed) again?.();
            }),
          );
        return false;
      }
      if (response.status === 429) this.waiting.set(deviceId, this.now() + RELAY_WAIT_MS);
      if (response.status === 503) this.relayWaitsUntil = this.now() + RELAY_WAIT_MS;
      this.options.onProblem(`the push relay refused ${what} with ${response.status}`);
    } catch (error) {
      this.options.onProblem(`${what} did not reach the relay: ${(error as Error).name}`);
    }
    return false;
  }
}

/**
 * The home's notifiers on the cards broadcast seam: the Mac's own
 * Notification Center, which needs a host that can show them, and beside it
 * the phone sender, which needs only the switch and a phone that asked, so a
 * computer with no window still sends (docs/phone-push.md). Both stay quiet
 * while a window of this computer is in front; the phone sender also while
 * a window in a program of its own says it is in front.
 */
export function cardNotifiers(options: {
  notifications: HostNotifications;
  /** Whether a window in a program of its own says it is in front (`WindowsInFront`). */
  windowsInFront: () => boolean;
  /** The Notifications switch (Settings -> General). */
  switchedOn: () => boolean;
  phones: Pick<
    DevicePairing,
    "pushTargets" | "forgetPush" | "letterBoxes" | "noteLetterRead" | "takeLetter"
  >;
  relay: string;
  /** What the record knows about a card, for both notifiers' words. */
  facts?: CardNotifierOptions["facts"];
  /** Runs `run` every `ms` until the answer is called: the pass that reads boxes due. */
  every?: (run: () => void, ms: number) => () => void;
}): {
  observe: (cards: Card[]) => void;
  switched: () => void;
  /** Starts reading each phone's box: once now, then from the hourly pass. */
  start: () => void;
  stop: () => void;
} {
  const { notifications, switchedOn, phones, facts } = options;
  const mac = new CardNotifier({
    enabled: () => notifications.supported() && switchedOn(),
    focused: () => notifications.focused(),
    show: (notice) => notifications.show(notice),
    ...(facts ? { facts } : {}),
  });
  const onProblem = (line: string) => console.warn(`[phone-push] ${line}`);
  // Each phone's box of letters is read once a day, checked each hour so a
  // computer that restarts often still reads it, and right after a refusal.
  const letters = new PhoneLetters({ phones, relay: options.relay, onProblem });
  const every =
    options.every ??
    ((run, ms) => {
      const timer = setInterval(run, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  const readLetters = () => void letters.readDue();
  let stopReading: (() => void) | undefined;
  const pushes = new PhonePushes({
    targets: () => phones.pushTargets(),
    forget: (deviceId, grant) => phones.forgetPush(deviceId, grant),
    refused: (deviceId) => letters.readNow(deviceId),
    relay: options.relay,
    switchedOn,
    onProblem,
  });
  // The window may run in a program of its own, beside a first mate a
  // command started or on another Mac: it says when it is in front.
  const phone = new CardNotifier({
    enabled: () => switchedOn() && pushes.any(),
    focused: () => notifications.focused() || options.windowsInFront(),
    show: (notice) => pushes.send(notice),
    ...(facts ? { facts } : {}),
  });
  return {
    observe: (cards) => {
      mac.observe(cards);
      phone.observe(cards);
      // Withdrawals go whether or not a window is in front: that is where
      // the captain sees the cards whose notifications the phone removes.
      pushes.observe(cards);
    },
    switched: () => {
      if (switchedOn()) pushes.switched();
    },
    // A home paused mid-move starts no pass, so nothing writes the record it hands on.
    start: () => {
      if (stopReading) return;
      stopReading = every(readLetters, LETTER_PASS_MS);
      readLetters();
    },
    stop: () => {
      stopReading?.();
      stopReading = undefined;
    },
  };
}

/** How often the computer looks for boxes not read in the last day (`LETTER_READ_EVERY_MS`). */
const LETTER_PASS_MS = 3_600_000;

/**
 * Seals one card for one phone: AES-256-GCM under the phone's key, with a
 * random nonce, as base64url of the nonce, the ciphertext and the tag.
 */
export function sealCardPush(key: string, card: PhonePushCard): string {
  return seal(key, card);
}

/** Seals one withdrawal for one phone, as a card push is sealed. */
export function sealWithdrawal(key: string, withdrawal: PhonePushWithdrawal): string {
  return seal(key, withdrawal);
}

function seal(key: string, what: PhonePushCard | PhonePushWithdrawal): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), nonce);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(what), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, sealed, cipher.getAuthTag()]).toString("base64url");
}

/**
 * Whether a card pushed to a phone is withdrawn: its newest version was
 * seen, or it is no longer on the stage.
 */
function withdrawable(card: Card | undefined): boolean {
  return !card || card.ended !== undefined || !onStage(card) || card.currentUpdateSeen === true;
}

/**
 * The pushes of a withdrawal list whose sealed withdrawal, as the relay wraps
 * it for Apple, fits `APPLE_PAYLOAD_LIMIT`: first those no withdrawal named
 * yet (`fresh`), then those that went before, each newest first, so a card's
 * long history never crowds out a push still to go. Counted by adding each
 * name's JSON bytes, as `JSON.stringify` writes them with no spaces.
 */
export function fittingWithdrawal(
  cards: readonly Withdrawn[],
  fresh: ReadonlySet<string>,
): Withdrawn[] {
  const bytes = (what: unknown) => Buffer.byteLength(JSON.stringify(what));
  const fits = (plain: number) =>
    WITHDRAW_PAYLOAD_BYTES + Math.ceil(((NONCE_BYTES + plain + TAG_BYTES) * 4) / 3) <=
    APPLE_PAYLOAD_LIMIT;
  let plain = bytes({ v: 1, kind: "withdraw", cards: [] } satisfies PhonePushWithdrawal);
  const named = new Map<string, Set<string>>();
  packing: for (const wentBefore of [false, true]) {
    for (const { cardId, pushes } of cards) {
      for (const push of [...pushes].reverse()) {
        if (fresh.has(push) === wentBefore) continue;
        const into = named.get(cardId);
        // A comma before each name after a card's first, and before each card after the first.
        const more = into
          ? 1 + bytes(push)
          : (named.size > 0 ? 1 : 0) + bytes({ cardId, pushes: [push] });
        if (!fits(plain + more)) break packing;
        plain += more;
        if (into) into.add(push);
        else named.set(cardId, new Set([push]));
      }
    }
  }
  return cards.flatMap(({ cardId, pushes }) => {
    const kept = named.get(cardId);
    return kept ? [{ cardId, pushes: pushes.filter((push) => kept.has(push)) }] : [];
  });
}
