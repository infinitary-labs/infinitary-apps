import type { Card } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import { appBehind, type DeviceView, deviceLabel, deviceRunsWork } from "@shared/devices";
import {
  appUpdateCard,
  appUpdateCardId,
  appUpdateGap,
  DEVICE_UPDATE_ACTIONS,
  type DeviceUpdateNudgeFacts,
  deviceUpdateActionId,
  deviceUpdateActions,
  deviceUpdateBody,
  deviceUpdateCardId,
  deviceUpdateGap,
  deviceUpdateMeta,
  deviceUpdateSeenLine,
  deviceUpdatesItself,
  deviceUpdateTitle,
  sourceMatchCard,
  sourceMatchGap,
} from "@shared/deviceUpdateNudge";
import type { FmEvent } from "@shared/events";
import * as m from "@shared/i18n/messages.generated";
import type {
  PackageUpdateAddressQuestion,
  RemoteLoginConfirmQuestion,
  RemoteLoginPasswordQuestion,
} from "@shared/remoteLogin";
import { RemoteLoginRefusedError } from "./remoteLogin";

/**
 * A computer on an older Firstmate is updated by itself, and the card that
 * asks the captain to update it is only for what this computer cannot do
 * alone (docs/devices.md, "Updating by itself" and "Another version, and
 * updating"). Both read the same typed comparison Settings -> Devices makes
 * (`DeviceView.otherVersion`). A computer this one can update with nothing
 * asked of the captain (`deviceUpdatesItself`) is updated once per gap this
 * run as it connects, its crew paused and carried on as for a click, and no
 * card goes up; one the captain answered Not now for that gap is left as
 * they said. The card goes up when that update asks a password, does not go
 * through, or is not this computer's to do - once per gap, never again for a
 * reconnect that says the same. It comes down by itself once the computer
 * runs this computer's version, and stays down after Not now or Update it
 * for that gap - the answer carries the gap in its action id, so a restart
 * remembers it - until this computer or that one changes version. A refused
 * update raises it again once with the refusal in its body. The Firstmate is
 * never asked to judge any of it.
 */

export type DeviceUpdateNudgeOptions = {
  /** The devices as the home lists them, with what it reads of each right now. */
  devices: () => DeviceView[];
  /** This computer's Firstmate version. */
  homeApp: () => string | undefined;
  /** The card stack's host cards: raise, withdraw, and what resolved one. */
  cards: {
    raise(card: Omit<Card, "author" | "priority" | "status" | "createdAt">): void;
    withdraw(id: string, reason: string): void;
    has(id: string): boolean;
    chosenAction(id: string): string | undefined;
  };
  broadcastEvent: (event: FmEvent) => void;
  /**
   * Whether this computer's version is the one that did not start on that
   * computer (`Computers.failedHere`): no card asks to send it again.
   */
  failedHere?: (deviceId: string) => boolean;
  /**
   * Whether the captain let that computer run this computer's source
   * (`Computers.sourceAllowed`): one allowed is matched by itself, and one
   * not yet is asked once on its card.
   */
  sourceAllowed?: (deviceId: string) => boolean;
  /**
   * Update, as the captain's click asks it (`Computers.update`): it answers
   * the computer on the list once it is back, a question asked there (a
   * password, a changed host to confirm, an update address), or rejects
   * with what refused it.
   */
  update: (
    deviceId: string,
  ) => Promise<
    | DeviceView
    | RemoteLoginPasswordQuestion
    | RemoteLoginConfirmQuestion
    | PackageUpdateAddressQuestion
  >;
};

export class DeviceUpdateNudge {
  /** Each computer's card as last raised this run, by what it said. */
  private readonly raised = new Map<string, string>();
  /** The gap each computer's card was last raised for this run. */
  private readonly gaps = new Map<string, string>();
  /** What a refused update said, until the next one starts. */
  private readonly refusals = new Map<string, string[]>();
  /** The gap each computer was updated by itself for this run: once per gap. */
  private readonly tried = new Map<string, string>();
  /** Computers being updated by themselves now: their answer decides the card. */
  private readonly updating = new Set<string>();

  /** Each app card as last raised this run, by what it said. */
  private readonly appsRaised = new Map<string, string>();

  constructor(private readonly options: DeviceUpdateNudgeOptions) {}

  /**
   * The device list changed: the app open on each computer gets its card
   * when it said it cannot get this computer's version by itself, or that
   * getting it did not go through (docs/devices.md, "Updating the app open
   * there"), once per gap and step; it comes down once that app follows by
   * itself again, runs this computer's version, or goes. Not now holds it
   * for that gap and step.
   */
  appsChanged(devices: readonly DeviceView[]): void {
    const home = this.options.homeApp();
    const seen = new Set<string>();
    for (const device of devices) {
      const version = device.appVersion;
      const follow = version?.follow;
      if (
        !home ||
        !version?.app ||
        !follow ||
        !appBehind(device, version) ||
        (follow.step !== "cannot" && follow.step !== "failed")
      )
        continue;
      seen.add(device.id);
      const id = appUpdateCardId(device.id);
      const facts = {
        deviceId: device.id,
        device: deviceLabel(device),
        app: version.app,
        home,
        follow,
      };
      const gap = appUpdateGap(facts);
      const chosen = this.options.cards.chosenAction(id);
      if (
        chosen === deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.notNow, gap) ||
        chosen === deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.update, gap)
      )
        continue;
      const signature = JSON.stringify([gap, follow.reason, follow.problem]);
      if (this.appsRaised.get(device.id) === signature) continue;
      this.appsRaised.set(device.id, signature);
      this.options.cards.raise({ id, ...appUpdateCard(facts) });
    }
    for (const deviceId of [...this.appsRaised.keys()])
      if (!seen.has(deviceId)) {
        this.appsRaised.delete(deviceId);
        const same = devices.find((device) => device.id === deviceId)?.appVersion?.same === true;
        this.options.cards.withdraw(appUpdateCardId(deviceId), same ? "updated" : "withdrawn");
      }
  }

  /** A computer connected, or went: its card goes where its version says. */
  refresh(deviceId: string, forced = false): void {
    const id = deviceUpdateCardId(deviceId);
    const device = this.options.devices().find((entry) => entry.id === deviceId);
    if (!device || !deviceRunsWork(device.kind)) {
      this.forget(deviceId, "the computer was removed");
      return;
    }
    const other = device.otherVersion;
    if (!other) {
      // Out of reach, its version is unknown: down without memory. On this
      // computer's version, the gap closed.
      if (this.options.cards.has(id)) {
        this.options.cards.withdraw(id, "updated");
        if (device.inReach)
          this.options.broadcastEvent({
            type: "firstmate_note",
            text: `${deviceLabel(device)} runs ${HERE.this}'s version of Infinitary now.`,
          });
      }
      this.raised.delete(deviceId);
      return;
    }
    // This computer runs source: that one is matched to its commit, asked once.
    if (other.source) {
      this.refreshSource(device, other.source.commit, forced);
      return;
    }
    // A computer on a newer Firstmate is this computer's to update.
    if (other.than !== "older") {
      this.forget(deviceId, "the computer is not behind");
      return;
    }
    if (this.options.failedHere?.(deviceId)) {
      this.forget(deviceId, "this version did not start there");
      return;
    }
    const facts: DeviceUpdateNudgeFacts = {
      deviceId,
      name: device.name,
      user: device.user,
      onThisMac: device.onThisMac,
      remoteLogin: device.remoteLogin,
      other,
      homeApp: this.options.homeApp(),
      system: device.system,
      refusal: this.refusals.get(deviceId),
    };
    const gap = deviceUpdateGap(facts);
    // An update by itself under way: what it answers decides whether the card goes up.
    if (this.updating.has(deviceId)) return;
    // Only a Not now for this gap holds it; a legacy closed card names no
    // gap, so it holds the card alone (`remembered`), never every later update.
    if (
      deviceUpdatesItself(facts) &&
      this.tried.get(deviceId) !== gap &&
      this.options.cards.chosenAction(id) !==
        deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.notNow, gap)
    ) {
      this.updateItself(deviceId, gap);
      return;
    }
    const signature = JSON.stringify([
      gap,
      other.takesWork,
      other.updateBy,
      facts.system,
      facts.refusal ?? [],
    ]);
    if (!forced && (this.raised.get(deviceId) === signature || this.remembered(id, gap, deviceId)))
      return;
    const first = this.gaps.get(deviceId) !== gap;
    this.raised.set(deviceId, signature);
    this.gaps.set(deviceId, gap);
    this.options.cards.raise({
      id,
      title: deviceUpdateTitle(facts),
      meta: deviceUpdateMeta(facts),
      body: deviceUpdateBody(facts),
      actions: deviceUpdateActions(facts),
    });
    if (first)
      this.options.broadcastEvent({ type: "firstmate_note", text: deviceUpdateSeenLine(facts) });
  }

  /**
   * A computer on another build than this computer's source (docs/devices.md,
   * "Matching the home's build"): one the captain let run source is matched
   * by itself once per commit; any other gets the card that asks once, which
   * stays down after Not now for that commit. A commit that did not start
   * there is never sent again.
   */
  private refreshSource(device: DeviceView, commit: string, forced: boolean): void {
    const deviceId = device.id;
    const id = deviceUpdateCardId(deviceId);
    if (this.options.failedHere?.(deviceId)) {
      this.forget(deviceId, "this build did not start there");
      return;
    }
    if (this.updating.has(deviceId)) return;
    const facts = {
      deviceId,
      device: deviceLabel(device),
      commit,
      refusal: this.refusals.get(deviceId),
    };
    const gap = sourceMatchGap(facts);
    const chosen = this.options.cards.chosenAction(id);
    const notNow = chosen === deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.notNow, gap);
    if (this.options.sourceAllowed?.(deviceId) && this.tried.get(deviceId) !== gap && !notNow) {
      this.updateItself(deviceId, gap);
      return;
    }
    const signature = JSON.stringify([gap, facts.refusal ?? []]);
    if (!forced && (this.raised.get(deviceId) === signature || this.remembered(id, gap, deviceId)))
      return;
    const first = this.gaps.get(deviceId) !== gap;
    this.raised.set(deviceId, signature);
    this.gaps.set(deviceId, gap);
    this.options.cards.raise({ id, ...sourceMatchCard(facts) });
    if (first)
      this.options.broadcastEvent({
        type: "firstmate_note",
        text: m.devicesSourceSeenLine({ device: facts.device }),
      });
  }

  /** An update's step: a refusal puts the card up again once, with what it said. */
  updateSaid(event: Extract<FmEvent, { type: "device_update" }>): void {
    if (event.stage === "refused") {
      this.refusals.set(event.deviceId, [...(this.refusals.get(event.deviceId) ?? []), event.text]);
      this.refresh(event.deviceId, true);
    } else if (event.stage === "updating") this.refusals.delete(event.deviceId);
  }

  /** The device list changed: a computer taken off it takes its card with it. */
  devicesChanged(): void {
    const listed = new Set(this.options.devices().map((device) => device.id));
    for (const deviceId of [...this.gaps.keys()])
      if (!listed.has(deviceId)) this.forget(deviceId, "the computer was removed");
  }

  /**
   * Updates the computer with nothing asked of the captain, its card down
   * while it goes. Once it answers, the card goes where its version says: a
   * computer back on this computer's version has none, and one that asked a
   * password, or whose update did not go through, gets it, with what refused
   * it.
   */
  private updateItself(deviceId: string, gap: string): void {
    this.tried.set(deviceId, gap);
    this.updating.add(deviceId);
    this.refusals.delete(deviceId);
    this.raised.delete(deviceId);
    this.options.cards.withdraw(deviceUpdateCardId(deviceId), "it is being updated by itself");
    const settled = (refusal?: readonly string[]) => {
      this.updating.delete(deviceId);
      // An update over the connection said its refusal as it went (`updateSaid`).
      if (refusal && !this.refusals.has(deviceId)) this.refusals.set(deviceId, [...refusal]);
      this.refresh(deviceId, refusal !== undefined);
    };
    this.options.update(deviceId).then(
      () => settled(),
      (error: unknown) =>
        settled(
          error instanceof RemoteLoginRefusedError
            ? error.lines
            : [error instanceof Error ? error.message : String(error)],
        ),
    );
  }

  /** Whether the captain already answered the card for this gap. */
  private remembered(id: string, gap: string, deviceId: string): boolean {
    const chosen = this.options.cards.chosenAction(id);
    if (
      chosen === deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.notNow, gap) ||
      chosen === deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.update, gap)
    )
      return true;
    // A legacy dismissed resolution names no gap: preserve its saved hold
    // for the known gap. The current minus records no such resolution.
    const known = this.gaps.get(deviceId);
    return chosen === "dismissed" && (known === undefined || known === gap);
  }

  private forget(deviceId: string, reason: string): void {
    this.options.cards.withdraw(deviceUpdateCardId(deviceId), reason);
    this.raised.delete(deviceId);
    this.gaps.delete(deviceId);
    this.refusals.delete(deviceId);
    this.tried.delete(deviceId);
  }
}
