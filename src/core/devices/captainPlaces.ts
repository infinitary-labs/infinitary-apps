import { AsyncLocalStorage } from "node:async_hooks";
import type { ActionActor } from "@shared/actions";
import { HOME } from "@shared/deviceNames";
import type { DeviceView } from "@shared/devices";
import type { CoreInvokeChannel } from "@shared/ipc";
import { askingView } from "../askedFromAView";

/**
 * The captain's own input: a message, a Suggest tags press, a card's choice,
 * close or Got it, a reply under a card, and a line in the Crewmate tab. Each is kept as the
 * captain's latest input, with the computer or phone it came from.
 */
const CAPTAIN_INPUT_CHANNELS = new Set<CoreInvokeChannel>([
  "inf:converse",
  "inf:cards:act",
  "inf:cards:close",
  "inf:cards:note-done",
  "inf:cards:reply",
  "inf:projects:suggest-tags",
  "inf:task:steer",
]);

export function isCaptainInput(
  channel: CoreInvokeChannel,
  actor: ActionActor | { kind: "device" } | undefined,
): boolean {
  return CAPTAIN_INPUT_CHANNELS.has(channel) && (actor ?? { kind: "captain" }).kind === "captain";
}

/**
 * Where the captain is (docs/devices.md, "Where the captain is"): the
 * computer or phone whose window sent the captain's input. The window on
 * the first mate's own computer asks as the captain with no device; a
 * paired view asks naming its device (docs/connection.md, "Requests"), so
 * the place is a typed fact the connection proved, never a guess.
 *
 * It is named only while the captain has another computer or phone paired:
 * with one computer there is nowhere else to be.
 */
export type CaptainPlace = {
  /** The place in a crewmate's words, as its prompt names the captain's computers. */
  words: string;
  /** When the captain's input came from it, in milliseconds since the epoch. */
  at: number;
};

/** What the crew reads of where the captain is (`CrewSupervisorOptions.captainPlaces`). */
export type CaptainPlaceReads = {
  /** Where the captain input running now came from; undefined outside one, or with one computer. */
  inputFrom(): string | undefined;
  /** The captain's latest input and where it came from; undefined before any, or with one computer. */
  latest(): CaptainPlace | undefined;
};

export class CaptainPlaces implements CaptainPlaceReads {
  private readonly input = new AsyncLocalStorage<string | undefined>();
  private last: CaptainPlace | undefined;

  constructor(
    private readonly options: {
      /** Every paired device: computers, Macs that control this one, phones. */
      devices: () => readonly Pick<DeviceView, "id" | "name" | "system">[];
      /** The first mate's own computer's name, as macOS gives it; absent when it could not be read. */
      homeName?: string;
      now: () => number;
    },
  ) {}

  /**
   * Runs the captain's input - a message, a card's choice or close, a reply,
   * a line in the Crewmate tab - so whatever it steers can name where it
   * came from, and keeps it as the captain's latest input.
   */
  during<T>(work: () => T): T {
    const words = this.asking();
    if (words !== undefined) this.last = { words, at: this.options.now() };
    return this.input.run(words, work);
  }

  inputFrom(): string | undefined {
    return this.input.getStore();
  }

  latest(): CaptainPlace | undefined {
    // A device removed since is no place to name.
    return this.options.devices().length > 0 ? this.last : undefined;
  }

  /** The place of the request running now, in words; undefined with nothing paired. */
  private asking(): string | undefined {
    const devices = this.options.devices();
    if (devices.length === 0) return undefined;
    const view = askingView();
    // Named precisely, with its role, as the crewmate's prompt lists it.
    if (view === undefined)
      return this.options.homeName ? `${this.options.homeName}, ${HOME.the}` : HOME.the;
    const device = devices.find((each) => each.id === view);
    if (!device) return undefined;
    return device.system === "ios" ? `${device.name}, a phone` : device.name;
  }
}
