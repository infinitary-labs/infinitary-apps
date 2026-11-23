import type { Card } from "@shared/cards";
import {
  computerForgeHost,
  DEVICE_SETUP_ACTIONS,
  type DeviceSetupFacts,
  deviceForgeSignInCardId,
  deviceSetupActions,
  deviceSetupBody,
  deviceSetupCardId,
  deviceSetupDone,
  deviceSetupDoneLine,
  deviceSetupRows,
  deviceSetupTitle,
  GITHUB_HOST,
} from "@shared/deviceSetup";
import { type DeviceView, deviceRunsWork, type FoundTools, reachFrom } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import { changeRequestKind } from "@shared/forgeKinds";
import { AUTOMATIC_COMPUTER } from "@shared/placement";
import type { RepoView } from "@shared/repos";
import { type ComputerSignIns, signInPlace } from "@shared/signIns";
import { workSetupWordsInEnglish } from "@shared/workSetupWords";
import type { WorkDeviceContact } from "../connection/connection";

/**
 * Finishing a computer's setup (docs/devices.md, "Finishing its setup";
 * design skill `components/devices/FinishSetup`): the one host card the
 * home files when a computer that runs work joins, from typed facts only -
 * what the join found there, what that computer last said of its own
 * sign-ins, and the projects whose Runs on names it. The card is raised
 * again under its id as those facts change, comes down by itself with one
 * feed line once every row is done, and stays down after Not now, which
 * the card's own resolution remembers across restarts. The Firstmate is
 * never asked to write or judge any of it.
 *
 * The same reader keeps the backstop in step: a project that lives on
 * GitHub set to run on a computer with no GitHub sign-in of its own raises
 * that computer's GitHub card (`forgeNeeded`) unless the setup card already
 * asks, and a computer that reports its GitHub sign-in lets the tasks held
 * for it go on (`forgeReady`).
 */

/** The one device listing the card reads: never its secret. */
type ListedDevice = Pick<
  DeviceView,
  | "id"
  | "kind"
  | "name"
  | "user"
  | "onThisMac"
  | "inReach"
  | "ssh"
  | "workSetup"
  | "heldOnLocalNetwork"
>;

export type DeviceSetupOptions = {
  /** The live Devices list, including work reach and setup reasons. */
  devices: () => ListedDevice[];
  /** Every project, for the ones whose Runs on names a computer. */
  repos: { list(): RepoView[] };
  /** What each computer last said of its sign-ins, and a way to ask one that has said nothing. */
  signIns: {
    lastSaid(deviceId: string): ComputerSignIns | null;
    didNotAnswer(deviceId: string): boolean;
    signInsOf(deviceId: string): Promise<ComputerSignIns | null>;
  };
  /** The card stack's host cards: raise, withdraw, and what resolved one. */
  cards: {
    raise(card: Omit<Card, "author" | "priority" | "status" | "createdAt">): void;
    withdraw(id: string, reason: string): void;
    has(id: string): boolean;
    /** Whether the stack ever held the card, open or resolved. */
    stored(id: string): Pick<Card, "body" | "actions"> | undefined;
    chosenAction(id: string): string | undefined;
  };
  broadcastEvent: (event: FmEvent) => void;
  /** A project that lives on a host is set to run on a computer with no sign-in of its own there. */
  forgeNeeded?: (deviceId: string, host: string, repo: { id: string; name: string }) => void;
  /** A computer reported its own sign-in for a host where projects live. */
  forgeReady?: (deviceId: string, host: string) => void;
};

export class DeviceSetup {
  /** What the join found on each computer that joined since this Mac started. */
  private readonly found = new Map<string, FoundTools | undefined>();
  /** Each computer whose card is this run's business, with its rows as last raised. */
  private readonly raised = new Map<string, string | undefined>();

  constructor(private readonly options: DeviceSetupOptions) {}

  /**
   * A device used its link: a computer that runs work gets its setup card,
   * from what the join found and nothing else yet. One that found this Mac
   * again runs work as before, and a Mac that controls this Firstmate
   * needs no setup.
   */
  joined(device: ListedDevice, found: FoundTools | undefined, again: boolean): void {
    if (!deviceRunsWork(device.kind) || again) return;
    this.found.set(device.id, found);
    this.raised.set(device.id, undefined);
    this.refresh(device.id);
  }

  /** A computer said something new of its sign-ins: its rows may have moved, and a wait for a host's sign-in may end. */
  signInsChanged(deviceId: string): void {
    this.refresh(deviceId);
    const signIns = this.options.signIns.lastSaid(deviceId);
    for (const entry of signIns?.forges?.signIns ?? [])
      this.options.forgeReady?.(deviceId, entry.host);
  }

  /**
   * A project's Runs on changed: every computer's project row may have
   * moved, and a project that lives on GitHub or GitLab set to run on a
   * computer with no sign-in of its own there needs it before its next task.
   */
  runsOnChanged(repo: RepoView): void {
    for (const device of this.options.devices())
      if (deviceRunsWork(device.kind)) this.refresh(device.id);
    const deviceId = repo.runsOn;
    if (!deviceId || deviceId === AUTOMATIC_COMPUTER) return;
    if (!repo.host?.name || !changeRequestKind(repo.host.kind)) return;
    void this.options.signIns.signInsOf(deviceId).then((signIns) => {
      // Only a sign-in that computer offers from here is asked for.
      const host = computerForgeHost(signIns?.forges, repo.host);
      if (!host || !signIns?.forges) return;
      if (signIns.forges.signIns.some((entry) => entry.host === host)) return;
      this.options.forgeNeeded?.(deviceId, host, { id: repo.id, name: repo.name });
    });
  }

  /**
   * A computer came into reach: one whose card is still asking and which
   * has said nothing of its sign-ins is asked now, so the card reads what
   * it has rather than what the join assumed.
   */
  contact(contact: WorkDeviceContact): void {
    if (contact.contact !== "in-reach") return;
    const deviceId = contact.deviceId;
    if (!this.asking(deviceId) || this.options.signIns.lastSaid(deviceId)) return;
    void this.options.signIns.signInsOf(deviceId);
  }

  /** The Devices list follows both connections; only active setup cards follow those changes. */
  reachChanged(devices: readonly ListedDevice[]): void {
    for (const device of devices) {
      const { id, kind } = device;
      if (deviceRunsWork(kind) && this.options.cards.has(deviceSetupCardId(id)))
        this.refresh(id, device);
    }
  }

  devicesChanged(): void {
    const listed = new Set(this.options.devices().map((device) => device.id));
    for (const deviceId of [...this.raised.keys()]) {
      if (listed.has(deviceId)) continue;
      this.raised.delete(deviceId);
      this.found.delete(deviceId);
      this.options.cards.withdraw(deviceSetupCardId(deviceId), "the computer was removed");
      // Each host a project lives on may have raised its own card for it.
      const hosts = new Set([GITHUB_HOST]);
      for (const repo of this.options.repos.list())
        if (repo.host?.name && changeRequestKind(repo.host.kind)) hosts.add(repo.host.name);
      for (const host of hosts)
        this.options.cards.withdraw(
          deviceForgeSignInCardId(host, deviceId),
          "the computer was removed",
        );
    }
  }

  private facts(deviceId: string, device: ListedDevice | undefined): DeviceSetupFacts | undefined {
    if (!device || !deviceRunsWork(device.kind)) return undefined;
    const place = signInPlace({ ...device, onThisMac: device.onThisMac === true });
    const reach = reachFrom(device);
    return {
      deviceId,
      place,
      reach,
      waitReason:
        reach === "in-reach"
          ? null
          : workSetupWordsInEnglish(place.label, device.workSetup, device.heldOnLocalNetwork),
      found: this.found.get(deviceId),
      signIns: this.options.signIns.lastSaid(deviceId),
      signInsUnanswered: this.options.signIns.didNotAnswer(deviceId),
      runs: this.options.repos
        .list()
        .filter((repo) => repo.runsOn === deviceId)
        .map((repo) => repo.name),
    };
  }

  /**
   * Whether the card is this computer's business: raised this run, or on
   * the stack from before, and not turned down with Not now.
   */
  private asking(deviceId: string): boolean {
    const id = deviceSetupCardId(deviceId);
    if (this.options.cards.chosenAction(id) === DEVICE_SETUP_ACTIONS.notNow) return false;
    return this.raised.has(deviceId) || this.options.cards.stored(id) !== undefined;
  }

  /**
   * Reads the facts again and puts the card where they say: up with its
   * rows as they stand, revised only when a row moved since it was last
   * raised, or down for good with one feed line once every row is done.
   */
  refresh(
    deviceId: string,
    device = this.options.devices().find((entry) => entry.id === deviceId),
  ): void {
    const id = deviceSetupCardId(deviceId);
    const facts = this.facts(deviceId, device);
    if (!facts) {
      this.devicesChanged();
      return;
    }
    if (!this.asking(deviceId)) return;
    const up = this.options.cards.has(id);
    if (deviceSetupDone(facts)) {
      if (up) this.options.cards.withdraw(id, "set up");
      if (up || this.raised.has(deviceId))
        this.options.broadcastEvent({ type: "firstmate_note", text: deviceSetupDoneLine(facts) });
      this.raised.delete(deviceId);
      this.found.delete(deviceId);
      return;
    }
    const actions = deviceSetupActions(facts);
    const done = deviceSetupRows(facts);
    if (!up && this.options.cards.chosenAction(id)) {
      // Reconnection can re-read the same sign-ins, including after a home restart.
      // Compare the last offer's typed row markers and action ids, not its prose.
      if (facts.reach !== "in-reach" || !facts.signIns) return;
      const previous = this.options.cards.stored(id);
      if (
        previous &&
        done.every((row) =>
          previous.body.includes(`data-setup-row="${row.id}" data-done="${row.done}"`),
        ) &&
        actions.length === previous.actions.length &&
        actions.every((action, index) => action.id === previous.actions[index]?.id)
      )
        return;
    }
    const rows = JSON.stringify([
      facts.reach,
      facts.waitReason,
      facts.signIns !== null,
      facts.signInsUnanswered,
      done.map((row) => row.done),
      actions.map((action) => action.id),
    ]);
    if (this.raised.has(deviceId) && this.raised.get(deviceId) === rows) return;
    this.raised.set(deviceId, rows);
    this.options.cards.raise({
      id,
      title: deviceSetupTitle(facts.place),
      meta: facts.place.label,
      body: deviceSetupBody(facts),
      actions,
    });
    // Its setup card owns the next step, so a second card cannot offer a stale sign-in.
    this.options.cards.withdraw(
      deviceForgeSignInCardId(GITHUB_HOST, deviceId),
      "the setup card asks for it",
    );
  }
}
