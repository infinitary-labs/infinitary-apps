import { type DeviceView, deviceLabel } from "@shared/devices";
import { parseRemoteLoginAddress, type RemoteLoginAddAnswer } from "@shared/remoteLogin";
import type { TypedWake } from "../orchestrator/wakes";
import { type DeviceSetupEvent, RemoteLoginRefusedError } from "./remoteLogin";

/**
 * How long the captain's click on the first mate's add card stays the start
 * of the add at its address, measured from the click or the last question
 * the add asked (the check line, the password, another first mate there).
 * An add that waits longer than this on an unanswered question was left,
 * and an add started later in Settings is the captain's own.
 */
export const CARD_ADD_WAIT_MS = 30 * 60_000;

type Began = { at: number; running: boolean; finished: string[] };

/**
 * The adds that began on the first mate's card (docs/devices.md, "Asking the
 * first mate"): the captain's Add it opens Settings -> Devices, which adds
 * the computer at the card's address over SSH. The first mate hears how
 * that add ended once, as a `device-add` wake: on the list, with the lines
 * that finished it, or refused, with the refusal's two lines. A question
 * the add asks on the way is not its end, an add typed in Settings with no
 * card is the captain's own and wakes nothing, and a second press while
 * one runs is refused there without ending it.
 */
export class CardAdds {
  private readonly began = new Map<string, Began>();
  private tell: (wake: TypedWake) => void = () => {};

  constructor(private readonly now: () => number = Date.now) {}

  /** Who hears how an add ended: the first mate's lane, once it is built. */
  attach(tell: (wake: TypedWake) => void): void {
    this.tell = tell;
  }

  /**
   * A card's click, as the card's action answered it: an open effect that
   * adds a computer by its address is the first mate's add card, the only
   * card whose button carries one.
   */
  chose(result: { effect?: { kind: string; add?: string | undefined } }): void {
    const address = result.effect?.kind === "open" ? result.effect.add : undefined;
    const key = address ? parseRemoteLoginAddress(address) : null;
    if (key) this.began.set(key, { at: this.now(), running: false, finished: [] });
  }

  /** A step of an operation over SSH: a line that finishes an add this watches is kept for its wake. */
  heard(event: DeviceSetupEvent): void {
    if (event.doing !== "add" || event.stage !== "done") return;
    const began = this.began.get(event.address);
    if (began?.running) began.finished.push(event.text);
  }

  /** Runs one press of an add at `text`, and tells the first mate how it ended when it began on the card. */
  async watch<T extends RemoteLoginAddAnswer>(text: string, add: () => Promise<T>): Promise<T> {
    const address = parseRemoteLoginAddress(text);
    const began = address ? this.began.get(address) : undefined;
    if (!address || !began || began.running) return add();
    if (this.now() - began.at > CARD_ADD_WAIT_MS) {
      this.began.delete(address);
      return add();
    }
    began.running = true;
    began.finished = [];
    let answer: T;
    try {
      answer = await add();
    } catch (error) {
      this.began.delete(address);
      const lines =
        error instanceof RemoteLoginRefusedError
          ? [...error.lines]
          : [error instanceof Error ? error.message : String(error)];
      this.tell({ facts: { kind: "device-add", address, outcome: "refused", lines } });
      throw error;
    }
    if ("asks" in answer) {
      began.running = false;
      began.at = this.now();
      return answer;
    }
    this.began.delete(address);
    const device: DeviceView = answer;
    this.tell({
      facts: {
        kind: "device-add",
        address,
        outcome: "added",
        name: deviceLabel(device),
        deviceId: device.id,
        lines: began.finished,
      },
    });
    return answer;
  }
}
