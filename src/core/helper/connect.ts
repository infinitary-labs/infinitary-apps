import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ControllerSays,
  type ExpectedHome,
  type HomeSays,
  homeSaysSchema,
  readSshMessage,
  SSH_MESSAGE_MAX_BYTES,
  SSH_MESSAGE_VERSION,
  type SshAgentState,
  sshMessageLine,
} from "@shared/sshConnection";
import { HomeKeyMismatchError, probeHome } from "../devices/dial";
import { JoinedHome } from "../devices/joinedHome";
import { isProfileRetired } from "../storage/retiredProfile";
import { HomeRoute, ROUTE_LEASE_MS, socketPathFits } from "./route";

/**
 * The controller the home's SSH connection runs on this Mac
 * (`work connect --from-home`, docs/helper.md "Through the home's SSH"):
 * the far end of that connection, which keeps the route this computer's
 * work dials while the connection lasts, and not a moment longer.
 *
 * In order:
 * 1. It checks the folder runs work for the home and as the computer the
 *    home expects (`--home`, `--device`), and through the home's SSH
 *    connection; anything else is refused before anything is touched.
 * 2. It takes a new generation of the route (`HomeRoute.begin`), so no
 *    earlier connection can publish or withdraw it, and makes a fresh
 *    folder only this user may enter, under `/tmp` so the socket's path
 *    fits, then tells the home the socket's path.
 * 3. Once the home says the forward is in place, it checks the home
 *    answers there with its own key, sending nothing, and only then
 *    publishes the route, and says whether this computer's work runs.
 * 4. Each beat from the home renews the route's lease; a route the next
 *    connection took ends it, and so does its folder moving into a newer
 *    app's (docs/helper.md, "Under the other name"), so the home connects
 *    again to the folder the work runs from now.
 * 5. The end of its input - the SSH connection went, or the home quit or
 *    crashed - or 75 seconds with no beat withdraws this generation's route,
 *    removes its own folder and nothing else, and ends it.
 *
 * Nothing it holds is a key or a link: the route names a socket, the home's
 * pin and this computer's id. The work itself is the background's run,
 * which reads the route on every dial and is never started or stopped here.
 */

export type ConnectOptions = {
  dataDir: string;
  /** The home and computer the home's SSH connection expects this folder to run work for. */
  expected: ExpectedHome;
  /** What the home says over the SSH connection, a line at a time. */
  input: NodeJS.ReadableStream;
  /** What it says to the home. */
  output: NodeJS.WritableStream;
  /** Where its folder is made; `/tmp`, short enough for a socket on any Mac. */
  socketBase?: string;
  /** Whether this computer's work runs in the background now (`backgroundState`). */
  agent?: () => Promise<SshAgentState>;
  /** How long the home has to put the forward in place. */
  forwardWaitMs?: number;
  /** How long it waits for a beat before it takes the home to be gone. */
  silenceMs?: number;
  /** How long the check that the home answers may take. */
  probeTimeoutMs?: number;
  now?: () => number;
};

/**
 * How it ended: the home let it go (`ended`), went quiet (`silent`), a later
 * connection took the route (`superseded`), its folder moved (`moved`), or
 * it was refused, with why.
 */
export type ConnectEnded = "ended" | "silent" | "superseded" | "moved" | { refused: string };

const FORWARD_WAIT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
/** The prefix of the folder its socket lives in, so a person can tell what made it. */
export const SOCKET_FOLDER_PREFIX = "infinitary-r-";

export async function connectFromHome(options: ConnectOptions): Promise<ConnectEnded> {
  const say = (message: ControllerSays) => {
    options.output.write(sshMessageLine(message));
  };
  const refuse = (reason: string): ConnectEnded => {
    say({ firstmate: "refused", reason });
    return { refused: reason };
  };
  const superseded = (): ConnectEnded => {
    say({ firstmate: "refused", reason: "superseded" });
    return "superseded";
  };
  const joined = new JoinedHome(options.dataDir, () => {}).read();
  if (!joined) return refuse("not-joined");
  const { grant } = joined;
  if (grant.homeKey !== options.expected.homeKey || grant.deviceId !== options.expected.deviceId)
    return refuse("other-home");
  if (grant.via !== "ssh") return refuse("not-ssh");

  const lines = lineReader(options.input);
  const route = new HomeRoute(options.dataDir, options.now);
  const generation = route.begin();
  let folder: string | null = null;
  try {
    folder = privateFolder(options.socketBase ?? "/tmp");
    const socket = join(folder, "s");
    if (!socketPathFits(socket)) return refuse("no-socket");
    say({ firstmate: "socket", v: SSH_MESSAGE_VERSION, socket });

    // The forward first: nothing is checked or published before it is in place.
    const forwarded = await lines.next(options.forwardWaitMs ?? FORWARD_WAIT_MS);
    if (forwarded === "ended") return "ended";
    if (forwarded === "silent" || forwarded.firstmate !== "forwarded") return refuse("no-forward");
    try {
      await probeHome(grant, grant.homeKey, {
        target: { socket },
        timeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      });
    } catch (error) {
      return refuse(error instanceof HomeKeyMismatchError ? "not-that-home" : "unreachable");
    }
    const entry = { socket, homeKey: grant.homeKey, deviceId: grant.deviceId };
    if (!route.publish(generation, entry)) return superseded();
    let agent = (await options.agent?.()) ?? "unknown";
    say({ firstmate: "route", v: SSH_MESSAGE_VERSION, agent });

    for (;;) {
      const heard = await lines.next(options.silenceMs ?? ROUTE_LEASE_MS);
      if (heard === "ended" || heard === "silent") return heard;
      if (heard.firstmate !== "beat") continue;
      if (isProfileRetired(dirname(options.dataDir))) {
        say({ firstmate: "refused", reason: "moved" });
        return "moved";
      }
      if (!route.publish(generation, entry)) return superseded();
      // Asked again until it runs: a user who logs in there starts it.
      if (agent !== "running" && options.agent) {
        const now = await options.agent();
        if (now !== agent) say({ firstmate: "agent", v: SSH_MESSAGE_VERSION, agent: now });
        agent = now;
      }
    }
  } finally {
    lines.close();
    route.withdraw(generation);
    // Its own folder, and nothing else: the socket a cancelled forward leaves.
    if (folder) rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * A fresh folder under `base` that only this user may enter: made with a
 * name nobody can guess, 0700, and checked to be a real folder this user
 * owns before a socket goes in it.
 */
function privateFolder(base: string): string {
  const folder = mkdtempSync(join(base, SOCKET_FOLDER_PREFIX));
  const made = lstatSync(folder);
  const uid = process.getuid?.();
  if (!made.isDirectory() || (uid !== undefined && made.uid !== uid) || (made.mode & 0o077) !== 0) {
    rmSync(folder, { recursive: true, force: true });
    throw new Error("The folder for the home's connection is not private to this user.");
  }
  return folder;
}

/**
 * The home's lines, one message at a time: the next one, `silent` after
 * `waitMs` with none, or `ended` once the input ends. A line that is too
 * long ends it; one that is not a message is skipped.
 */
function lineReader(input: NodeJS.ReadableStream) {
  const queue: HomeSays[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  let held = "";
  const end = () => {
    ended = true;
    wake?.();
  };
  const onData = (chunk: Buffer | string) => {
    held += chunk.toString();
    for (let at = held.indexOf("\n"); at >= 0; at = held.indexOf("\n")) {
      const message = readSshMessage(homeSaysSchema, held.slice(0, at));
      held = held.slice(at + 1);
      if (message) queue.push(message);
    }
    if (Buffer.byteLength(held) > SSH_MESSAGE_MAX_BYTES) end();
    wake?.();
  };
  input.on("data", onData);
  input.once("end", end);
  input.once("close", end);
  input.once("error", end);
  return {
    next(waitMs: number): Promise<HomeSays | "ended" | "silent"> {
      return new Promise((resolve) => {
        const take = () => {
          const message = queue.shift();
          if (message) return message;
          return ended ? "ended" : null;
        };
        const now = take();
        if (now) return resolve(now);
        const timer = setTimeout(() => {
          wake = null;
          resolve("silent");
        }, waitMs);
        wake = () => {
          const next = take();
          if (!next) return;
          clearTimeout(timer);
          wake = null;
          resolve(next);
        };
      });
    },
    close() {
      input.off("data", onData);
      wake = null;
    },
  };
}
