import type { Card } from "@shared/cards";
import { HERE } from "@shared/deviceNames";
import { type DeviceView, deviceLabel, deviceRunsWork } from "@shared/devices";
import {
  DEVICE_UPDATE_ACTIONS,
  type DeviceUpdateNudgeFacts,
  deviceUpdateActionId,
  deviceUpdateActions,
  deviceUpdateBody,
  deviceUpdateCardId,
  deviceUpdateGap,
  deviceUpdateMeta,
  deviceUpdateSeenLine,
  deviceUpdateTitle,
} from "@shared/deviceUpdateNudge";
import type { FmEvent } from "@shared/events";

/**
 * The card that nudges the captain to update a computer on an older Firstmate
 * (docs/devices.md, "Another version, and updating"): raised from the same
 * typed comparison Settings -> Devices makes (`DeviceView.otherVersion`),
 * once per gap, never again for a reconnect that says the same. It comes
 * down by itself once the computer runs this computer's version, and stays
 * down after Not now or Update it for that gap - the answer carries the gap
 * in its action id, so a restart remembers it - until this computer or that
 * one changes version. A refused update raises it again once with the
 * refusal in its body. The Firstmate is never asked to judge any of it.
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
};

export class DeviceUpdateNudge {
  /** Each computer's card as last raised this run, by what it said. */
  private readonly raised = new Map<string, string>();
  /** The gap each computer's card was last raised for this run. */
  private readonly gaps = new Map<string, string>();
  /** What a refused update said, until the next one starts. */
  private readonly refusals = new Map<string, string[]>();

  constructor(private readonly options: DeviceUpdateNudgeOptions) {}

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
    // A computer on a newer Firstmate is this computer's to update.
    if (other.than !== "older") {
      this.forget(deviceId, "the computer is not behind");
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
      refusal: this.refusals.get(deviceId),
    };
    const gap = deviceUpdateGap(facts);
    const signature = JSON.stringify([gap, other.takesWork, other.updateBy, facts.refusal ?? []]);
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

  /** Whether the captain already answered the card for this gap. */
  private remembered(id: string, gap: string, deviceId: string): boolean {
    const chosen = this.options.cards.chosenAction(id);
    if (
      chosen === deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.notNow, gap) ||
      chosen === deviceUpdateActionId(DEVICE_UPDATE_ACTIONS.update, gap)
    )
      return true;
    // The close control names no gap: it holds for the gap this run knows, or the one before a restart.
    const known = this.gaps.get(deviceId);
    return chosen === "dismissed" && (known === undefined || known === gap);
  }

  private forget(deviceId: string, reason: string): void {
    this.options.cards.withdraw(deviceUpdateCardId(deviceId), reason);
    this.raised.delete(deviceId);
    this.gaps.delete(deviceId);
    this.refusals.delete(deviceId);
  }
}
