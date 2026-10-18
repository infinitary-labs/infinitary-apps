import { constants, cpSync, mkdirSync, renameSync, rmSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import { basename, join } from "node:path";
import type { FoundTools } from "@shared/connection";
import {
  type DeviceGrant,
  deviceRunsWork,
  type PairingLink,
  parsePairingLink,
  splitDialAddress,
} from "@shared/devices";
import { isLoopback, isThisMachine, LOOPBACK_ADDRESS } from "../connection/addresses";
import {
  claimLink,
  type DialOptions,
  dialHome,
  findHomeAgain,
  HomeKeyMismatchError,
  PairRefusedError,
  probeHome,
} from "../devices/dial";
import { HomeLink } from "../devices/homeLink";
import { type Joined, JoinedHome } from "../devices/joinedHome";
import { type Launcher, readInstalled } from "./background";
import type { CleanUpResult } from "./cleanUp";
import { homePlace } from "./homePlace";
import { FolderBusyError, lockFolder, STOPPED_RUN_WAIT_MS, takeFolderWithin } from "./lock";
import { homeDialOptions } from "./route";
import { type HomePlace, helperWords, homeLabel, type InBackground } from "./words";

/**
 * Joining a home as a computer that runs work (docs/helper.md): read the
 * link, check that the Mac it names answers with its key, ask the person,
 * and only on their yes use the link, as this Mac's name and the macOS user
 * this runs as, saying what it found here. The grant is kept in the data
 * folder through `JoinedHome`, its one writer, private to this user. Once
 * joined, it sets itself up to run in the background (`./background.ts`).
 *
 * A command run on another Mac asks its question before it gets Firstmate
 * from the home, then starts that copy with `fetched`: the person agreed
 * already, so it is not asked again, and the copy is kept in the data folder
 * for the background to start.
 *
 * A link from the home this user already runs work for finds that home
 * where the link says it is now (docs/helper.md, "Finding the home again"):
 * the same computer on its list, with everything kept here. When that home
 * removed it while it was out of reach, the removal goes first, as it would
 * have, and the link then joins it anew. A link from another home, while
 * the one it runs work for does not answer, asks to leave that one first
 * (`leaveFor`).
 */

/** How the join talks to its person: lines to show, and a question to answer. */
export type HelperIO = {
  say: (lines: readonly string[]) => void;
  /** Shows the question's lines and the prompt, and answers what was typed ("" for none). */
  ask: (lines: readonly string[], prompt: string) => Promise<string>;
};

export type JoinOptions = {
  /** The link, as the person pasted it. */
  text: string;
  /** This computer's system, which the question's words follow; a Mac's unless named. */
  platform?: string;
  dataDir: string;
  io: HelperIO;
  /** This Mac's own name, and the macOS user this runs as. */
  device: { name: string; user: { name: string; uid: number } };
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
  timeoutMs?: number;
  now?: () => number;
  /** The contract version it speaks to the home; this build's own unless a test stands in another. */
  protocolVersion?: string;
  /**
   * The copy of Firstmate a command got from the home, which the person
   * agreed to before it was fetched: the bundle, kept in the data folder's
   * `app/` once the link is used.
   */
  fetched?: { app: string };
  /** What it has here: git and Claude Code (`findTools`), unless a test stands in its own. */
  found?: () => Promise<FoundTools>;
  /**
   * Sets it up to run in the background as this user, from the program
   * that starts this app; nothing when absent, as in a test that runs it
   * itself.
   */
  background?: (setUp: { launcher: Launcher | null; app: string | null }) => Promise<InBackground>;
  /**
   * Stops the run the background started, so the folder is free to find the
   * home again, and answers how to load it again as it was; null when
   * nothing runs in the background. Nothing is stopped when absent.
   */
  pauseBackground?: () => Promise<(() => Promise<void>) | null>;
  /** How long to wait for a stopped run to let the folder go. */
  lockWaitMs?: number;
  /**
   * Where the link's dials go: the private socket the home's SSH session
   * forwards here while it sets this computer up (docs/helper.md, "Started
   * by the home"); by default the link's own address. A link that reaches
   * its home only through that connection dials nothing without one.
   */
  dial?: DialOptions;
  /**
   * The captain of the home that started this over Remote Login agreed to
   * leave a home this user runs work for, should it not answer
   * (docs/helper.md, "Leaving a home that is gone"): nobody here is asked.
   */
  leave?: boolean;
  /**
   * Removes what Firstmate set up here (`cleanUp`), once a home that removed
   * this computer while it was out of reach says so; nothing is removed when
   * absent.
   */
  cleanUp?: () => Promise<CleanUpResult>;
};

/**
 * How the join went: joined, with the home's name and whether it runs in
 * the background now - `again` when it found the home it already ran work
 * for, and `left`, how many working copies and leftovers it kept, when it
 * left another home first - or refused, with the reason (`not-a-link`, `kind`, `busy`, `joined`,
 * `unreachable`, `not-that-mac`, `declined`, `not-kept`, or the home's own
 * refusal, such as `used` or `same-user`).
 */
export type JoinOutcome =
  | {
      ok: true;
      grant: DeviceGrant;
      name: string | null;
      background: InBackground;
      again: boolean;
      left?: { kept: number; unremoved: number };
    }
  | { ok: false; reason: string };

type Refused = { ok: false; reason: string };

/**
 * What using the link left, under the folder's lock: the grant, the home's
 * name, the copy kept, and whether it found the home it already ran work for.
 */
type Used = {
  ok: true;
  grant: DeviceGrant;
  name: string | null;
  kept: string | null;
  again: boolean;
};

/**
 * Where a grant dials its home (docs/helper.md, "Finding the home again"): a
 * grant naming one of this Mac's own network addresses dials loopback at the
 * same port, where the home listens too and which no network change moves.
 * Such a grant was kept before the command for another user here named
 * loopback, or by a user here added at its address. A grant naming another
 * Mac, a name, or loopback already dials where it did.
 */
export function homeDialAddress(
  at: string,
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>,
): string {
  const address = splitDialAddress(at);
  if (!address || isLoopback(address.host) || !isThisMachine(address.host, interfaces?.()))
    return at;
  return `${LOOPBACK_ADDRESS}:${address.port}`;
}

export async function joinHome(options: JoinOptions): Promise<JoinOutcome> {
  const { io, dataDir } = options;
  const refuse = refuser(io);
  let link: PairingLink;
  try {
    link = parsePairingLink(options.text);
  } catch {
    return refuse("not-a-link", helperWords.notALink);
  }
  if (!deviceRunsWork(link.kind)) return refuse("kind", helperWords.viewLink);
  const place = homePlace(link, options.interfaces);
  const joinedHome = new JoinedHome(dataDir, () => {});
  const already = joinedHome.read();
  if (already?.grant.homeKey === link.key) return findAgain(options, link, place);
  if (already) return leaveFor(options, link, place, already);

  let release: () => void;
  try {
    release = lockFolder(dataDir);
  } catch (error) {
    if (error instanceof FolderBusyError) return refuse("busy", helperWords.busy);
    throw error;
  }
  let used: Used;
  try {
    // Read again under the lock: a join may have finished between.
    const raced = joinedHome.read();
    if (raced) return alreadyJoined(io, raced, options.interfaces);
    const outcome = await joinWithLink(options, link, place, { probed: false, asked: false });
    if (!outcome.ok) return outcome;
    used = outcome;
  } finally {
    release();
  }
  // Out of the folder's lock, so the run the background starts can take it.
  const background = await inBackground(options, used.kept);
  io.say(
    helperWords.joined(
      place,
      used.name,
      options.device.user.name,
      background,
      used.grant.kind === "mac",
    ),
  );
  return { ok: true, grant: used.grant, name: used.name, background, again: false };
}

/**
 * A link from the home this user already runs work for: that home is
 * looked for where the link says it is now, then the background's run is
 * stopped so the folder is free, and the link is used with the key this
 * computer was paired with. The same computer stays on the home's list and
 * every project and sign-in here stays; a copy of Firstmate the command got
 * is kept in place of the one kept here, and the background starts again.
 * Refused, nothing changed and the run starts again as it was.
 */
async function findAgain(
  options: JoinOptions,
  link: PairingLink,
  place: HomePlace,
): Promise<JoinOutcome> {
  const { io, dataDir } = options;
  const refuse = refuser(io);
  // That home must answer where the link says before anything here stops.
  try {
    await probeHome(link, link.key, linkDial(options));
  } catch (error) {
    return error instanceof HomeKeyMismatchError
      ? refuse("not-that-mac", helperWords.notThatMac(place))
      : refuse("unreachable", helperWords.unreachable(place));
  }
  let resume = (await options.pauseBackground?.()) ?? null;
  const release = await takeFolderWithin(
    dataDir,
    resume ? (options.lockWaitMs ?? STOPPED_RUN_WAIT_MS) : 0,
  );
  if (!release) {
    await resume?.();
    return refuse("busy", helperWords.busy);
  }
  const joinedHome = new JoinedHome(dataDir, () => {});
  let outcome: Used | Refused;
  try {
    outcome = await findWithLink(options, link, place, joinedHome, () => {
      // A removal takes the background away with the rest.
      resume = null;
    });
  } finally {
    release();
  }
  if (!outcome.ok) {
    await resume?.();
    return outcome;
  }
  const { again } = outcome;
  const kept = again ? keepFetchedAgain(options, dataDir) : outcome.kept;
  const background = await inBackground(options, kept);
  const user = options.device.user.name;
  io.say(
    again
      ? helperWords.foundAgain(place, outcome.name, user, background)
      : helperWords.joined(place, outcome.name, user, background, outcome.grant.kind === "mac"),
  );
  return { ok: true, grant: outcome.grant, name: outcome.name, background, again };
}

/**
 * Under the folder's lock: the link used with the key this computer was
 * paired with. The grant then dials the link's address. A home that no
 * longer lists this computer removed it while it was out of reach: it goes
 * as a removal would, then the link joins it anew.
 */
async function findWithLink(
  options: JoinOptions,
  link: PairingLink,
  place: HomePlace,
  joinedHome: JoinedHome,
  removed: () => void,
): Promise<Used | Refused> {
  const { io } = options;
  // Read again under the lock: a removal may have finished between.
  const joined = joinedHome.read();
  if (!joined || joined.grant.homeKey !== link.key) return refuser(io)("busy", helperWords.busy);
  let grant: DeviceGrant;
  try {
    grant = await findHomeAgain(
      options.text,
      joined.grant,
      await deviceOf(options),
      linkDial(options),
    );
  } catch (error) {
    if (!(error instanceof PairRefusedError) || error.refused !== "removed")
      return linkRefused(io, error, place);
    // Noted as not finished until the removal says what it could not remove.
    joinedHome.leave(
      {
        name: homeLabel(homePlace(joined.grant, options.interfaces), joined.name),
        reason: "removed",
        at: (options.now ?? Date.now)(),
      },
      options.cleanUp ? [] : undefined,
    );
    removed();
    const cleaned = await options.cleanUp?.();
    io.say([
      ...helperWords.removedEarlier(place, joined.name),
      // Joining anew clears the note, so nothing tries again on its own.
      ...(cleaned
        ? helperWords.cleanedUp(cleaned.kept, cleaned.unreadable, cleaned.unremoved, {
            triesAgain: false,
            ...(cleaned.claude ? { claude: cleaned.claude } : {}),
          })
        : []),
    ]);
    return joinWithLink(options, link, place, { probed: true, asked: false });
  }
  joinedHome.dialAt(grant.at, grant.via);
  const name = await hearName(grant, options);
  if (name) joinedHome.name(name);
  return { ok: true, grant, name: name ?? joined.name, kept: null, again: true };
}

/**
 * A link from another home while this user runs work for one
 * (docs/helper.md, "Leaving a home that is gone"). While the home it runs
 * work for answers, it stays: that home brings its unmerged work home when
 * its captain removes it. Once that home does not answer and the new one
 * does, the person is asked, and only on their yes it leaves the old home as
 * a removal would - its run stopped, what Firstmate set up for it removed,
 * work that never merged kept - then the link joins the new home with the
 * same yes. Declined, nothing changed and the run goes on as it was.
 */
async function leaveFor(
  options: JoinOptions,
  link: PairingLink,
  place: HomePlace,
  already: Joined,
): Promise<JoinOutcome> {
  const { io, dataDir } = options;
  const refuse = refuser(io);
  try {
    // Where that home answers now: its address, or the route its SSH keeps here.
    await probeHome(already.grant, already.grant.homeKey, {
      timeoutMs: options.timeoutMs,
      ...homeDialOptions(dataDir, already.grant, options.now),
    });
    return alreadyJoined(io, already, options.interfaces);
  } catch {
    // Out of reach, or something else answers there: the person decides.
  }
  try {
    await probeHome(link, link.key, linkDial(options));
  } catch (error) {
    return error instanceof HomeKeyMismatchError
      ? refuse("not-that-mac", helperWords.notThatMac(place))
      : refuse("unreachable", helperWords.unreachable(place));
  }
  const from = formerHome(already, place, options.interfaces);
  // One yes leaves the old home and joins the new one; a command that
  // fetched this copy asked only about joining, and the home that started
  // it over Remote Login asked its own captain.
  const answer = options.leave
    ? "yes"
    : await io.ask(
        [
          ...helperWords.askLeave(from),
          ...(options.fetched
            ? []
            : helperWords.ask(place, options.device.user.name, options.platform)),
        ],
        helperWords.prompt,
      );
  if (answer.trim().toLowerCase() !== "yes") return refuse("joined", helperWords.declined);

  let resume = (await options.pauseBackground?.()) ?? null;
  const release = await takeFolderWithin(
    dataDir,
    resume ? (options.lockWaitMs ?? STOPPED_RUN_WAIT_MS) : 0,
  );
  if (!release) {
    await resume?.();
    return refuse("busy", helperWords.busy);
  }
  const joinedHome = new JoinedHome(dataDir, () => {});
  let outcome: Used | Refused;
  let left = { kept: 0, unremoved: 0 };
  try {
    // Read again under the lock: a join or removal may have finished between.
    const joined = joinedHome.read();
    if (joined?.grant.homeKey !== already.grant.homeKey) {
      outcome = refuse("busy", helperWords.busy);
    } else {
      // Noted as not finished until the removal says what it could not remove.
      joinedHome.leave(
        { name: from, reason: "left", at: (options.now ?? Date.now)() },
        options.cleanUp ? [] : undefined,
      );
      // A removal takes the background away with the rest.
      resume = null;
      const cleaned = await options.cleanUp?.();
      left = { kept: cleaned?.kept.length ?? 0, unremoved: cleaned?.unremoved?.length ?? 0 };
      io.say([
        ...helperWords.leftHome(from),
        // Joining anew clears the note, so nothing tries again on its own.
        ...(cleaned
          ? helperWords.cleanedUp(cleaned.kept, cleaned.unreadable, cleaned.unremoved, {
              triesAgain: false,
              ...(cleaned.claude ? { claude: cleaned.claude } : {}),
            })
          : []),
      ]);
      outcome = await joinWithLink(options, link, place, { probed: true, asked: true });
    }
  } finally {
    release();
  }
  if (!outcome.ok) {
    await resume?.();
    return outcome;
  }
  const background = await inBackground(options, outcome.kept);
  io.say(
    helperWords.joined(
      place,
      outcome.name,
      options.device.user.name,
      background,
      outcome.grant.kind === "mac",
    ),
  );
  return { ok: true, grant: outcome.grant, name: outcome.name, background, again: false, left };
}

/**
 * The home this user runs work for, as its question names it: by its own
 * name, or as an earlier Firstmate when the new link comes from the same
 * place, as it does from a Firstmate installed there again.
 */
function formerHome(
  already: Joined,
  place: HomePlace,
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>,
): string {
  const was = homePlace(already.grant, interfaces);
  if (was.thisMac && place.thisMac) return helperWords.earlierHome(was);
  if (was.host === place.host) return helperWords.earlierHome({ ...was, thisMac: false });
  return homeLabel(was, already.name);
}

/**
 * Under the folder's lock, with nothing joined: checks the home answers
 * (unless `probed`), asks the person (unless a command fetched this copy, or
 * the person said yes already, `asked`),
 * keeps the copy it fetched, uses the link, keeps the grant and hears the
 * home's name once.
 */
async function joinWithLink(
  options: JoinOptions,
  link: PairingLink,
  place: HomePlace,
  { probed, asked }: { probed: boolean; asked: boolean },
): Promise<Used | Refused> {
  const { io, dataDir } = options;
  const refuse = refuser(io);
  // The Mac the link names must answer with its own key before the person
  // is asked anything; nothing is sent to it yet.
  if (!probed) {
    try {
      await probeHome(link, link.key, linkDial(options));
    } catch (error) {
      return error instanceof HomeKeyMismatchError
        ? refuse("not-that-mac", helperWords.notThatMac(place))
        : refuse("unreachable", helperWords.unreachable(place));
    }
  }

  if (!options.fetched && !asked) {
    const answer = await io.ask(
      helperWords.ask(place, options.device.user.name, options.platform),
      helperWords.prompt,
    );
    if (answer.trim().toLowerCase() !== "yes") return refuse("declined", helperWords.declined);
  }

  // The copy a command fetched is kept before the link is used, so a Mac
  // that joined always has the Firstmate it runs.
  let kept: string | null = null;
  if (options.fetched) {
    try {
      kept = keepApp(options.fetched.app, dataDir);
    } catch {
      return refuse("not-kept", helperWords.notKept);
    }
  }

  let grant: DeviceGrant;
  try {
    grant = await claimLink(
      options.text,
      { kind: link.kind, ...(await deviceOf(options)) },
      linkDial(options),
    );
  } catch (error) {
    if (kept) rmSync(kept, { recursive: true, force: true });
    return linkRefused(io, error, place);
  }
  const joinedHome = new JoinedHome(dataDir, () => {});
  joinedHome.join(grant, (options.now ?? Date.now)());

  // Once, to hear the home say its own name.
  const name = await hearName(grant, options);
  if (name) joinedHome.name(name);
  return { ok: true, grant, name, kept, again: false };
}

/** How a dial with the link goes: within the join's time, where the join was told to dial. */
function linkDial(options: JoinOptions): DialOptions {
  return { ...options.dial, timeoutMs: options.timeoutMs };
}

/** This Mac's name, the user it runs as and what it found here, as the home is told them. */
async function deviceOf(options: JoinOptions): Promise<{
  name: string;
  user: { name: string; uid: number };
  found?: FoundTools;
}> {
  const found = options.found ? await options.found().catch(() => undefined) : undefined;
  return { name: options.device.name, user: options.device.user, ...(found ? { found } : {}) };
}

/**
 * Found again by a command that got Firstmate from the home: its copy is
 * kept in place of the one kept here, as an update keeps one. Answers the
 * copy the background starts: that one, or the one kept here before when it
 * could not be kept.
 */
function keepFetchedAgain(options: JoinOptions, dataDir: string): string | null {
  const before = readInstalled(dataDir).app;
  if (!options.fetched) return before;
  try {
    const kept = keepApp(options.fetched.app, dataDir);
    if (before && before !== kept) rmSync(before, { recursive: true, force: true });
    return kept;
  } catch {
    return before;
  }
}

/** Sets it up in the background from the copy kept here, or from this program; `none` with nothing to do it. */
async function inBackground(options: JoinOptions, kept: string | null): Promise<InBackground> {
  if (!options.background) return "none";
  return options
    .background({ launcher: fetchedLauncher(kept), app: kept })
    .catch((): InBackground => "failed");
}

/** Says why the home refused a link, or that it could not be reached, and answers the refusal. */
function linkRefused(io: HelperIO, error: unknown, place: HomePlace): Refused {
  const refuse = refuser(io);
  if (error instanceof HomeKeyMismatchError)
    return refuse("not-that-mac", helperWords.notThatMac(place));
  if (!(error instanceof PairRefusedError))
    return refuse("unreachable", helperWords.unreachable(place));
  switch (error.refused) {
    case "used":
      return refuse("used", helperWords.used(place));
    case "expired":
      return refuse("expired", helperWords.expired(place));
    case "unknown":
      return refuse("unknown", helperWords.closedLink(place));
    case "same-user":
      return refuse("same-user", helperWords.sameUser);
    default:
      return refuse(error.refused, helperWords.refused(place));
  }
}

/** This user runs work for another home, which stays. */
function alreadyJoined(
  io: HelperIO,
  already: Joined,
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>,
): Refused {
  return refuser(io)(
    "joined",
    helperWords.alreadyJoined(homeLabel(homePlace(already.grant, interfaces), already.name)),
  );
}

function refuser(io: HelperIO) {
  return (reason: string, lines: readonly string[]): Refused => {
    io.say(lines);
    return { ok: false, reason };
  };
}

/**
 * Keeps the copy of Firstmate a command fetched in the data folder's
 * `app/` - a Mac's bundle, or a Linux AppImage file - cloned where the disk
 * can (APFS), in place of one kept before. Answers where it is now.
 */
export function keepApp(bundle: string, dataDir: string): string {
  const dir = join(dataDir, "app");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, basename(bundle));
  const next = `${target}.next`;
  rmSync(next, { recursive: true, force: true });
  cpSync(bundle, next, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    mode: constants.COPYFILE_FICLONE,
  });
  rmSync(target, { recursive: true, force: true });
  renameSync(next, target);
  return target;
}

/**
 * The kept copy's own program, which the background starts; null to start
 * this one. A Linux AppImage is its own program.
 */
export function fetchedLauncher(kept: string | null): Launcher | null {
  if (!kept) return null;
  if (kept.endsWith(".AppImage")) return { executable: kept, args: [] };
  return { executable: join(kept, "Contents", "MacOS", basename(kept, ".app")), args: [] };
}

/** Dials the home once with a fresh grant and answers the name its welcome says, if any. */
async function hearName(grant: DeviceGrant, options: JoinOptions): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const link = new HomeLink({
      grant,
      as: "work",
      dial: (dialed) => dialHome(dialed, linkDial(options)),
      ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
      onPush: () => {},
      ...(options.timeoutMs === undefined ? {} : { welcomeTimeoutMs: options.timeoutMs }),
      // Only the name: the home counts this dial as nothing of the work here in reach.
      nameOnly: true,
      onState: (state) => {
        if (settled || state.contact === "reaching") return;
        settled = true;
        link.close();
        resolve(state.contact === "in-reach" ? state.name : null);
      },
    });
    link.start();
  });
}
