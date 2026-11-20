import { z } from "zod";
import { COMPUTER, HERE } from "./deviceNames";
import {
  remoteLoginPasswordQuestionSchema,
  remoteLoginRefusalSchema,
  remoteLoginWords,
} from "./remoteLogin";

/**
 * Joining the first mate on another computer by its address, from this
 * app's first launch (docs/view.md, "Joining by its address"; design skill
 * `components/devices/JoinAnotherMac`, "By its address"): this computer
 * signs in there with the person's own SSH, asks the Infinitary open there
 * for a one-use computer link, then asks the paste path's question and
 * joins as a pasted link does. The link stays in the main process; the
 * window reads only these answers.
 */

/** What the person agreed to on the way: the key line they said was that computer, and its password, typed once. */
export const joinAtOptionsSchema = z.strictObject({
  confirm: z.string().min(1).max(160).optional(),
  password: z.string().min(1).max(1024).optional(),
});
export type JoinAtOptions = z.infer<typeof joinAtOptionsSchema>;

/**
 * Why no link came back: a reason the Remote Login reach already names
 * (`remoteLoginRefusalSchema`), or one of this join's own:
 *
 * - `not-an-address`: the text is no address, or the port no port.
 * - `not-open`: no Infinitary is open for that account there.
 * - `too-old`: the Infinitary open there makes no link this way.
 * - `no-curl`: that Linux computer has no curl, which the link is asked with.
 * - `controls`: the Infinitary open there controls another computer.
 * - `no-link`: it answered without a link.
 * - `self`: the link it made is this app's own.
 */
export const joinAtRefusalSchema = z.union([
  remoteLoginRefusalSchema,
  z.enum(["not-an-address", "not-open", "too-old", "no-curl", "controls", "no-link", "self"]),
]);
export type JoinAtRefusal = z.infer<typeof joinAtRefusalSchema>;

/** The key line to compare before any sign-in there. */
const confirmQuestionSchema = z.strictObject({
  asks: z.literal("confirm"),
  address: z.string().min(1).max(255),
  line: z.string().min(1).max(160),
});

const refusedSchema = z.strictObject({ refused: joinAtRefusalSchema });

/**
 * What one step answers: the key line to compare, the password question,
 * the paste path's question once a link is held, or why it stopped.
 */
export const joinAtAnswerSchema = z.union([
  confirmQuestionSchema,
  remoteLoginPasswordQuestionSchema,
  z.strictObject({
    asks: z.literal("join"),
    /** The link adds a computer that can also run work. */
    runsWork: z.boolean(),
    /** The link also names a private-network address. */
    alsoPrivate: z.boolean(),
  }),
  refusedSchema,
]);
export type JoinAtAnswer = z.infer<typeof joinAtAnswerSchema>;

/**
 * What the first mate answers for one step (`RemoteLogin.linkAt`): the same
 * questions and refusals, or the link with the host the person's SSH
 * reached, which the join dials first. Beside a command, the window's
 * program asks it of the command's first mate (`inf:devices:link-at`,
 * docs/run.md, "Joining another computer"); the shell holds the link and
 * never hands it to the window's page.
 */
export const linkAtAnswerSchema = z.union([
  confirmQuestionSchema,
  remoteLoginPasswordQuestionSchema,
  z.strictObject({
    link: z.string().min(1).max(1024),
    host: z.string().min(1).max(255).nullable(),
  }),
  refusedSchema,
]);
export type LinkAtAnswer = z.infer<typeof linkAtAnswerSchema>;

/** The computer an address names, for the paste path's question: `studio` for `kun@studio`. */
export function computerOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? address : address.slice(at + 1);
}

/** The one warning line for each refusal, naming the address as typed. */
export function joinAtRefusalWords(refused: JoinAtRefusal, address: string): string {
  switch (refused) {
    case "not-an-address":
      return `That is not an address to reach a ${COMPUTER.one} at, such as kun@studio, with a port from 1 to 65535 or none.`;
    case "not-open":
      return `Infinitary is not open on ${address}. Open it there, then try again.`;
    case "too-old":
      return `Infinitary on ${address} is too old to make a link this way. Update it there, or paste a link from it instead.`;
    case "no-curl":
      return `${address} has no curl, which ${HERE.this} asks Infinitary there for a link with. Install curl there, then try again.`;
    case "controls":
      return `Infinitary on ${address} controls your first mate on another ${COMPUTER.one}. Join that ${COMPUTER.one} instead.`;
    case "no-link":
      return `Infinitary on ${address} made no link. Make one there, in Settings → Devices, and paste it instead.`;
    case "self":
      return `${address} is ${HERE.this}. Type the address of the ${COMPUTER.one} your first mate is on.`;
    case "password-off":
      return `${address} did not accept your SSH key, and does not take a password. Let your SSH key in there, then try again.`;
    case "key-not-taken":
      return `${address} did not let Infinitary's own key in after it was placed there. Paste a link from that ${COMPUTER.one} instead.`;
    case "failed":
      return `Could not ask ${address} for a link. Try again.`;
    default:
      return remoteLoginWords.refused(refused, { address }).join(" ");
  }
}

/**
 * Set up from your first mate's computer, at this app's first launch
 * (docs/view.md, "Joining"; design skill `components/devices/JoinAnotherMac`,
 * "Set up from your first mate's computer"): what the person types or
 * compares on their first mate's computer to add this one by its address,
 * read here without an administrator. `offered` is false on a system the
 * address way cannot set up (a Windows PC, an Arm Linux computer), where the
 * window shows no such choice.
 */
export const setUpHereSchema = z.strictObject({
  offered: z.boolean(),
  /** The account Infinitary runs as here, which the address names first. */
  user: z.string().min(1).max(64).nullable(),
  /** Its private network address, such as Tailscale's (100.64.0.0/10). */
  privateAddress: z.string().min(1).max(64).nullable(),
  /**
   * Its name on the local network, such as `studio.local`, on a Mac; its
   * local network address elsewhere, where nothing may announce a name.
   */
  localName: z.string().min(1).max(255).nullable(),
  /** Whether this computer's SSH server, Remote Login on a Mac, answers on its own loopback. */
  remoteLogin: z.enum(["on", "off", "unknown"]),
  /** The check line its first mate's computer asks the person to compare, as `lineAt` answers. */
  line: z.string().min(1).max(160).nullable(),
  /** The address shown whose key `line` is: the private network address first, else the local one. */
  lineAt: z.string().min(1).max(255).nullable(),
  /** A Mac opens its Sharing settings, where Remote Login is turned on. */
  opensSharing: z.boolean(),
});
export type SetUpHere = z.infer<typeof setUpHereSchema>;
