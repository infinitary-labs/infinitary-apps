import { z } from "zod";
import { CONNECTION_PORT } from "./connection";
import { deviceFirewallSchema, firewallWords } from "./devices";
import * as m from "./i18n/messages.generated";
import { joinAtRefusalWords, reachSchema } from "./joinByAddress";
import {
  LINUX_INSTALLERS,
  type LinuxInstalls,
  remoteLoginPasswordQuestionSchema,
  remoteLoginRefusalSchema,
  remoteLoginWords,
} from "./remoteLogin";

/**
 * Setting the first mate up on another computer over SSH, from the welcome
 * screen's Another computer (docs/first-launch.md, "Setting it up from
 * here"). Seven steps: read its SSH key, sign in, check its system, send
 * Infinitary, start the first mate there with the copy's own
 * `start-at-boot`, connect from here as Join by its address does, and
 * connect a subscription for it, which is the view's own first launch. The
 * first five are one request of the first mate here (`inf:devices:home-at`),
 * asked again with each answer as Join by its address asks; the window then
 * joins with `inf:devices:join-at` and `inf:devices:join-held`.
 */

/** What the person agreed to on the way. */
export const homeAtOptionsSchema = z.strictObject({
  /** The key line they said was that computer. */
  confirm: z.string().min(1).max(160).optional(),
  /** That account's password, typed once; never kept. */
  password: z.string().min(1).max(1024).optional(),
  /** Their yes to making an ordinary account named infinitary there, after a root sign-in. */
  account: z.literal(true).optional(),
});
export type HomeAtOptions = z.infer<typeof homeAtOptionsSchema>;

/**
 * Why it stopped: a reason Remote Login already names, or one of this
 * setup's own:
 *
 * - `not-an-address`: the text is no address, or the port no port.
 * - `root`: a root sign-in on a Mac, where no account is made for it.
 * - `no-systemd`: a Linux computer with no systemd, which starts nothing at boot.
 * - `no-curl`: a Linux computer with no curl, which this computer asks for a link with.
 * - `controls`: the Infinitary open there controls a first mate on another computer.
 * - `no-link`: something there answered the link request but made no link, so one may run there.
 * - `not-started`: the copy's `start-at-boot` did not start it there.
 * - `cancelled`: the person pressed Cancel; it stopped at the next step.
 */
export const homeAtRefusalSchema = z.union([
  remoteLoginRefusalSchema,
  z.enum([
    "not-an-address",
    "root",
    "no-systemd",
    "no-curl",
    "controls",
    "no-link",
    "not-started",
    "cancelled",
  ]),
]);
export type HomeAtRefusal = z.infer<typeof homeAtRefusalSchema>;

/** The steps on screen, in order. */
export const HOME_STEPS = [
  "key",
  "sign-in",
  "look",
  "send",
  "start",
  "connect",
  "sign-up",
] as const;
export type HomeStep = (typeof HOME_STEPS)[number];

const linuxInstallsSchema: z.ZodType<LinuxInstalls> = z.strictObject({
  installer: z.enum(LINUX_INSTALLERS).optional(),
  t64: z.boolean().optional(),
});

/**
 * One answer: the key line, the password once, the question before making
 * an account, the offer to connect where Infinitary already runs, a stop at
 * a step, or the first mate started there with what the screen says of it.
 */
export const homeAtAnswerSchema = z.union([
  z.strictObject({
    asks: z.literal("confirm"),
    address: z.string().min(1).max(255),
    line: z.string().min(1).max(160),
  }),
  remoteLoginPasswordQuestionSchema,
  z.strictObject({
    asks: z.literal("account"),
    address: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
  }),
  z.strictObject({
    /** Infinitary already runs for that account there: connect to it instead. */
    asks: z.literal("runs"),
    address: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
  }),
  z.strictObject({
    refused: homeAtRefusalSchema,
    /** The step it stopped at. */
    step: z.enum(HOME_STEPS),
    /** That computer's own name, once the look read it. */
    name: z.string().min(1).max(255).optional(),
    missing: z.array(z.string().min(1).max(16)).max(16).optional(),
    installs: linuxInstallsSchema.optional(),
    reach: reachSchema.optional(),
    /** Something there changed before it stopped: an account made, or the Ubuntu package going in. */
    changed: z.literal(true).optional(),
  }),
  z.strictObject({
    started: z.literal(true),
    /** The address to connect from here: an account made there is this one. */
    address: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    /** The account it runs as there, which the administrator line names. */
    user: z.string().min(1).max(64).optional(),
    /** A Linux account that does not linger: its first mate stops when it logs out. */
    lingerOff: z.boolean(),
    /** A Mac where that account is not logged in: it starts at its next login. */
    waitsForLogin: z.boolean(),
    /** It has an address on a local or private network this computer can dial. */
    private: z.boolean(),
    firewall: deviceFirewallSchema.optional(),
  }),
]);
export type HomeAtAnswer = z.infer<typeof homeAtAnswerSchema>;
export type HomeAtStarted = Extract<HomeAtAnswer, { started: true }>;
export type HomeAtRefused = Extract<HomeAtAnswer, { refused: unknown }>;

/**
 * A stop's two lines, the second empty where the first says it all:
 * Remote Login's own words for adding a computer, with this screen's ending
 * where they send the person to add it with a command, or this setup's own.
 * `address` is the address as typed.
 */
export function homeAtRefusalLines(refused: HomeAtRefused, address: string): [string, string] {
  const name = refused.name ?? address;
  const computer = name;
  switch (refused.refused) {
    case "not-an-address":
    case "no-curl":
    case "controls":
    case "no-link":
      return [joinAtRefusalWords(refused.refused, address), ""];
    case "root":
      return [m.devicesHomeRoot({ computer }), m.devicesHomeCommandsInstead()];
    case "no-systemd":
      return [m.devicesHomeNoSystemd({ computer }), m.devicesHomeCommandsInstead()];
    case "not-started":
      return [m.devicesHomeNotStarted({ computer }), m.devicesHomeCommandsInstead()];
    case "cancelled":
      return [m.devicesHomeCancelled({ computer }), ""];
    case "password-off":
      return [remoteLoginWords.refused("password-off", { address })[0], m.devicesHomeOrCommands()];
    case "key-not-taken":
      return [remoteLoginWords.refused("key-not-taken", { address })[0], m.devicesHomeKeyWay()];
    case "sandbox-off":
      return [
        remoteLoginWords.refused("sandbox-off", { address, name })[0],
        m.devicesHomeSandboxWay(),
      ];
    case "cannot-install":
      return [
        remoteLoginWords.refused("cannot-install", { address, name })[0],
        m.devicesHomeInstallWay(),
      ];
    default:
      return remoteLoginWords.refused(refused.refused, {
        address,
        name,
        doing: "add",
        missing: refused.missing,
        installs: refused.installs,
        reach: refused.reach,
        ending: m.devicesHomeOrCommands(),
      });
  }
}

/**
 * What the screen says when the first mate started there and this computer
 * could not connect to it: no private address, a firewall that may keep it
 * out, or its port that did not answer. `way` is the one command to run there.
 */
export function homeConnectLines(
  started: HomeAtStarted,
  computer: string,
): { lines: [string, string]; way?: string } {
  if (!started.private)
    return { lines: [m.devicesHomeNoPrivate({ computer }), m.devicesHomeNoPrivateWay()] };
  if (started.firewall) {
    const said = firewallWords(started.firewall);
    return { lines: [m.devicesHomeFirewall({ computer }), said.lines[1]], way: said.way };
  }
  return {
    lines: [
      m.devicesHomeUnreachable({ computer, port: String(CONNECTION_PORT) }),
      m.devicesHomeUnreachableWay(),
    ],
  };
}

/** Where a stop leaves the steps after it. */
export function homeStepsLeft(at: HomeStep): number {
  return HOME_STEPS.length - 1 - HOME_STEPS.indexOf(at);
}
