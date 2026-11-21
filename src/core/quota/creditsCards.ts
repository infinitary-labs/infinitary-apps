import type { Card } from "@shared/cards";
import type { QuotaSnapshotView } from "@shared/quota";
import type { ComputerSignIns } from "@shared/signIns";
import { creditsOfferCard, creditsOfferCardId } from "../orchestrator/hostCards";
import {
  type CreditsOffer,
  CreditsWatch,
  creditsOffers,
  forgetAnsweredOffers,
} from "./creditsSwitch";

/**
 * Keep going on credits at the home (docs/quota.md "Keep going on credits"):
 * each account's switch, the crew's run-out card that offers it and the feed
 * lines that say it started spending or ran out, for this Mac's own accounts
 * and for each computer that runs work's. A computer's switch is saved on
 * that computer, so the home only sends it there and reads its rows back.
 */
export type CreditsCardsOptions = {
  /** This Mac's own switch, saved in its vault (`HomeQuota.setKeepGoingOnCredits`). */
  setHere: (accountId: string, on: boolean) => void;
  /** Whether this Mac's own account's switch is on, held by a refusal or not. */
  onHere: (accountId: string) => boolean;
  /** This Mac's newest allowance reading. */
  latest: () => QuotaSnapshotView | undefined;
  /** The feed lines a new reading of this Mac's own says (`HomeQuota.noteCredits`). */
  noteHere: (snapshot: QuotaSnapshotView) => string[];
  /** Each computer that runs work's own sign-ins and its switch there (`DeviceSignIns`). */
  computers: {
    keepGoing: (deviceId: string, accountId: string, on: boolean) => Promise<unknown>;
    lastSaid: (deviceId: string) => ComputerSignIns | null;
    placeOf: (deviceId: string) => { where: string } | undefined;
    /** Whether that computer can use a saved reset now: it takes the order and is in reach. */
    canUseSavedReset: (deviceId: string) => boolean;
  };
  /**
   * Whether a run-out card may offer to turn on the account's Use saved
   * resets on their own (docs/quota.md): it is off, and where it is the
   * switch can be turned on. Absent offers it nowhere.
   */
  offersAutoResets?: (accountId: string, deviceId?: string) => boolean;
  cards: {
    raiseHostCard: (card: Omit<Card, "author" | "priority" | "status" | "createdAt">) => unknown;
    withdrawHostCard: (id: string, reason: string) => void;
  };
  /** One feed line. */
  note: (text: string) => void;
  now: () => number;
};

export class CreditsCards {
  private readonly offeredHere = new Set<string>();
  private readonly offeredThere = new Map<string, Set<string>>();
  private readonly watchThere = new Map<string, CreditsWatch>();

  constructor(private readonly options: CreditsCardsOptions) {}

  /** Turns an account's switch; with `deviceId`, that computer's own, saved there. */
  async setKeepGoing(accountId: string, on: boolean, deviceId?: string): Promise<void> {
    if (deviceId) await this.options.computers.keepGoing(deviceId, accountId, on);
    else this.options.setHere(accountId, on);
    if (on)
      this.options.cards.withdrawHostCard(creditsOfferCardId(accountId, deviceId), "kept going");
  }

  /**
   * A committed crew decision dropped a level or waits on these providers'
   * spent allowance, on this Mac or on `deviceId`: the run-out card, once
   * per spent allowance of an account.
   */
  spentAt(piProviders: string[], deviceId?: string): void {
    if (!deviceId) {
      for (const offer of creditsOffers(
        this.options.latest(),
        piProviders,
        this.offeredHere,
        this.options.onHere,
        this.options.now(),
      ))
        this.options.cards.raiseHostCard(
          creditsOfferCard({ ...offer, ...this.autoOffer(offer, offer.accountId) }),
        );
      return;
    }
    const where = this.options.computers.placeOf(deviceId)?.where;
    if (!where) return;
    const resets = this.options.computers.canUseSavedReset(deviceId);
    for (const offer of creditsOffers(
      this.options.computers.lastSaid(deviceId)?.quota ?? undefined,
      piProviders,
      this.offeredOn(deviceId),
      this.onThere(deviceId),
      this.options.now(),
    )) {
      // A computer that cannot use a saved reset now is offered none: an older one, or one out of reach.
      const { savedResets, ...rest } = offer;
      const shown: CreditsOffer = resets ? offer : rest;
      if (!shown.credits && !shown.savedResets) continue;
      this.options.cards.raiseHostCard(
        creditsOfferCard({
          ...shown,
          ...this.autoOffer(shown, shown.accountId, deviceId),
          computer: { deviceId, where },
        }),
      );
    }
  }

  /** A new reading of this Mac's own allowance. */
  readHere(snapshot: QuotaSnapshotView | undefined): void {
    // An offered account whose allowance answers again may be offered again.
    forgetAnsweredOffers(snapshot, this.offeredHere, this.options.now());
    // Keep going on credits: started spending, ran out, answers again.
    for (const text of snapshot ? this.options.noteHere(snapshot) : []) this.options.note(text);
  }

  /** A computer that runs work said its sign-ins, its allowance as read there. */
  readThere(deviceId: string): void {
    const snapshot = this.options.computers.lastSaid(deviceId)?.quota;
    const where = this.options.computers.placeOf(deviceId)?.where;
    if (!snapshot || !where) return;
    forgetAnsweredOffers(snapshot, this.offeredOn(deviceId), this.options.now());
    // That computer ends its own refusal hold on a top-up; the home only says the lines.
    let watch = this.watchThere.get(deviceId);
    if (!watch) {
      watch = new CreditsWatch(this.onThere(deviceId), where);
      this.watchThere.set(deviceId, watch);
    }
    for (const text of watch.observe(snapshot, this.options.now()).lines) this.options.note(text);
  }

  /** The card's offer to turn on Use saved resets on their own, beside a saved reset it offers. */
  private autoOffer(
    offer: CreditsOffer,
    accountId: string,
    deviceId?: string,
  ): { offerAutoResets?: true } {
    return offer.savedResets && this.options.offersAutoResets?.(accountId, deviceId)
      ? { offerAutoResets: true }
      : {};
  }

  private offeredOn(deviceId: string): Set<string> {
    let offered = this.offeredThere.get(deviceId);
    if (!offered) {
      offered = new Set();
      this.offeredThere.set(deviceId, offered);
    }
    return offered;
  }

  /** Whether an account's switch is on there, as that computer's own rows say. */
  private onThere(deviceId: string): (accountId: string) => boolean {
    return (accountId) =>
      this.options.computers
        .lastSaid(deviceId)
        ?.accounts.some((account) => account.id === accountId && account.keepGoingOnCredits) ===
      true;
  }
}
