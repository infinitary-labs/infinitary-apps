import { z } from "zod";
import { COMPUTER, HERE } from "./deviceNames";
import {
  type DeviceSsh,
  type DeviceView,
  deviceLabel,
  KEY_TEXT_PATTERN,
  reachFrom,
  type SshStopReason,
  userDisplayName,
} from "./devices";

/**
 * This Mac's own SSH connection to a computer it added by its address
 * (docs/devices.md, "Through the home's SSH"): the shapes both Macs read and
 * the words a person reads. The home keeps one connection to each such
 * computer while it runs, which forwards a private socket there to this
 * Mac's own connection; the computer's work dials that socket, never this
 * Mac's address.
 *
 * What rides the SSH session between the home and the controller it runs
 * there (`work connect --from-home`, docs/helper.md "Through the home's
 * SSH") is one JSON object a line, each typed by `firstmate`, versioned by
 * `v` and at most `SSH_MESSAGE_MAX_BYTES`: never a word a shell reads.
 */

/** The longest line either side of the SSH session reads; a longer one ends the session. */
export const SSH_MESSAGE_MAX_BYTES = 4096;
/** The controller's protocol version, which both sides check on every line. */
export const SSH_MESSAGE_VERSION = 1;

const socketPathSchema = z.string().min(2).max(1024).startsWith("/");

/**
 * What the home tells the controller: the forward is in place, so it may
 * check the home and publish its route; and, every 15 seconds, that the home
 * is still there, which renews the route's lease.
 */
export const homeSaysSchema = z.discriminatedUnion("firstmate", [
  z.strictObject({ firstmate: z.literal("forwarded"), v: z.literal(SSH_MESSAGE_VERSION) }),
  z.strictObject({ firstmate: z.literal("beat"), v: z.literal(SSH_MESSAGE_VERSION) }),
]);
export type HomeSays = z.infer<typeof homeSaysSchema>;

/**
 * Whether the work there runs in the background now: `running` while
 * launchd holds its agent, `at-login` when nobody is logged in there as its
 * user, so it starts the next time they log in, and `failed` when their
 * session is there and holds no agent, which no login mends. `unknown` when
 * the controller cannot ask.
 */
export const sshAgentStateSchema = z.enum(["running", "at-login", "failed", "unknown"]);
export type SshAgentState = z.infer<typeof sshAgentStateSchema>;

/**
 * What the controller tells the home: the private socket it made for this
 * connection, for the home to forward; that it checked the home answers
 * there and published its route; whether the work there runs; or that it
 * stopped, with why (`connectRefusalSchema`).
 */
export const controllerSaysSchema = z.discriminatedUnion("firstmate", [
  z.strictObject({
    firstmate: z.literal("socket"),
    v: z.literal(SSH_MESSAGE_VERSION),
    socket: socketPathSchema,
  }),
  z.strictObject({
    firstmate: z.literal("route"),
    v: z.literal(SSH_MESSAGE_VERSION),
    agent: sshAgentStateSchema,
  }),
  z.strictObject({
    firstmate: z.literal("agent"),
    v: z.literal(SSH_MESSAGE_VERSION),
    agent: sshAgentStateSchema,
  }),
  z.strictObject({
    firstmate: z.literal("refused"),
    reason: z.string().min(1).max(64),
  }),
]);
export type ControllerSays = z.infer<typeof controllerSaysSchema>;

/**
 * What a join the home starts over SSH reads on its input, its first line:
 * the one-use link, and the private socket the home's SSH session forwards
 * there for this join alone. Never in an argument, where that Mac's other
 * users could read it. `leave`: the home's captain agreed to leave another
 * home this user runs work for, should it not answer (docs/helper.md,
 * "Leaving a home that is gone"); nobody there is asked.
 */
export const sshJoinSchema = z.strictObject({
  firstmate: z.literal("join"),
  v: z.literal(SSH_MESSAGE_VERSION),
  link: z.string().min(1).max(2048),
  socket: socketPathSchema.optional(),
  leave: z.literal(true).optional(),
});
export type SshJoin = z.infer<typeof sshJoinSchema>;

/** How many bytes a line takes, as UTF-8. */
function bytesOf(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** One line for the other side, as it is written. */
export function sshMessageLine(message: HomeSays | ControllerSays | SshJoin): string {
  const line = JSON.stringify(message);
  if (bytesOf(line) > SSH_MESSAGE_MAX_BYTES) throw new Error("That line is too long.");
  return `${line}\n`;
}

/** One line from the other side, or null when it is not one of `schema`'s. */
export function readSshMessage<T>(schema: z.ZodType<T>, line: string): T | null {
  const text = line.trim();
  if (!text.startsWith("{") || bytesOf(text) > SSH_MESSAGE_MAX_BYTES) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * What the home checks the computer at an address is before it starts
 * anything there: the pin of the home its grant names and its id on that
 * home's list, both public. They ride the controller's, an update's and a
 * removal's arguments, so the work mode there refuses another home's or
 * another computer's folder (`other-home`) and touches nothing.
 */
export const expectedHomeSchema = z.strictObject({
  homeKey: z.string().regex(KEY_TEXT_PATTERN),
  deviceId: z.string().min(1).max(64),
});
export type ExpectedHome = z.infer<typeof expectedHomeSchema>;

/** A computer named for the words. */
type Named = Pick<DeviceView, "name" | "user" | "onThisMac">;

/**
 * Whether this Mac stopped trying a computer because Firstmate there runs
 * work for another Firstmate now (`other-home`): it is not coming back, so
 * neither it nor its work is waited for, and removing it here is the way on.
 */
export function runsForAnotherFirstmate(ssh: DeviceSsh | undefined): boolean {
  return ssh?.state === "stopped" && ssh.reason === "other-home";
}

/** "the next time sam logs in there", or "the next time Builder logs in" for a user on this Mac. */
function nextLogin(device: Named): string {
  if (!device.user) return "the next time someone logs in there";
  return device.onThisMac
    ? `the next time ${userDisplayName(device.user)} logs in`
    : `the next time ${device.user} logs in there`;
}

/** The words for this Mac's SSH connection to a computer, in the design skill's words. */
export const sshConnectionWords = {
  /** The end of a row's mono line, after the address. */
  detail(ssh: DeviceSsh, device: Named & Pick<DeviceView, "seenAt">): string {
    const reach = reachFrom({ inReach: false, ssh });
    // Design skill `components/devices/DevicesTab`, "Reached over your SSH":
    // a computer never seen says "connecting using SSH…" for every try,
    // including once its reach is reconnecting. "reconnecting using SSH…"
    // only once it has been seen. The right side still says out of reach.
    if (reach === "connecting" || (reach === "reconnecting" && device.seenAt === undefined))
      return "connecting using SSH…";
    if (reach === "reconnecting") return "reconnecting using SSH…";
    switch (ssh.state) {
      case "connected":
        return "connected using SSH";
      case "connecting":
        return "connecting using SSH…";
      case "reconnecting":
        return "reconnecting using SSH…";
      case "at-login":
        return `starts ${nextLogin(device)}`;
      case "not-started":
        return "could not start";
      case "stopped":
        return "needs you";
    }
  },

  /** What happened and what to do, for a connection this Mac stopped trying. */
  stopped(reason: SshStopReason, at: { address: string; device: Named }): [string, string] {
    const { address } = at;
    const name = deviceLabel(at.device);
    switch (reason) {
      case "host-unknown":
        return [
          `${HERE.This} has not checked ${address} yet, so it cannot tell it is your ${COMPUTER.one}.`,
          `Add it again by its address, and say this is the ${COMPUTER.one}.`,
        ];
      case "host-changed":
        return [
          `${address} does not answer as the ${COMPUTER.one} ${HERE.this} reached before.`,
          "If you did not set it up again, someone may be in between. Check it, then try again.",
        ];
      case "key-refused":
        return [
          `${address} did not accept your SSH key.`,
          "Check that Remote Login is on there and lets you in, then try again.",
        ];
      case "key-locked":
        return [
          `Could not sign in to ${address}. Your SSH key is locked, or its app did not answer.`,
          `Unlock it, and ${HERE.this} tries again when it wakes and every few minutes.`,
        ];
      case "agent-declined":
        return [
          `Could not sign in to ${address}. The app that holds your SSH key did not approve it.`,
          `${HERE.This} tries again when it wakes and every few minutes. Approve it in that app when it asks.`,
        ];
      case "agent-not-running":
        return [
          `Could not sign in to ${address}. The app that holds your SSH key is not open.`,
          `Open that app, and ${HERE.this} tries again when it wakes and every few minutes.`,
        ];
      case "forwarding-refused":
        return [
          `Remote Login on ${address} does not let Infinitary's connection through.`,
          "Allow forwarding in its SSH settings, then try again.",
        ];
      case "not-set-up":
        return [`Infinitary is not set up on ${name} any more.`, "Remove it, then add it again."];
      // SSH checked it answers as the Mac this Mac reached before, so it is
      // that Mac, which left this Firstmate for another; the words name the
      // address, which holds whichever Mac answers there.
      case "other-home":
        return [
          `${address} runs work for another first mate now.`,
          `Remove ${name} here. Nothing changes there for the other first mate.`,
        ];
    }
  },

  /** Said once, when the connection comes back after this Mac stopped trying it. */
  back: (device: Named) => `${deviceLabel(device)} is connected using SSH again.`,

  /** Said once, when the connection is up and that user's session holds no background work. */
  notStarted: (device: Named): [string, string] => [
    `${deviceLabel(device)} could not start running work in the background.`,
    "Update it, or remove it and add it again.",
  ],

  /**
   * A removed computer this Mac could not reach for thirty days to remove
   * what Firstmate set up there: it stops trying, and says so once.
   */
  gaveUp: (cleanup: { name: string; address: string }): [string, string] => [
    `Could not remove what Infinitary set up on ${cleanup.name}: ${HERE.this} has not reached ${cleanup.address} in thirty days.`,
    "It stays there, with any unmerged work, until it is deleted there by hand.",
  ],

  /** Change address, as the row's question says it. */
  changeAddress: (device: Named) => `Where to reach ${deviceLabel(device)}`,
  /** The feed's line once the address changed. */
  addressChanged: (device: Named, address: string) =>
    `${HERE.This} reaches ${deviceLabel(device)} at ${address} now.`,
};
