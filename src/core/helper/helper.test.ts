import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import {
  buildPairingLink,
  type DeviceKind,
  parsePairingLink,
  splitDialAddress,
} from "@shared/devices";
import { HOME_CAPABILITIES, PROTOCOL_VERSION } from "@shared/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { claudeOnComputer } from "../../../tests/helpers/computerClaude";
import { freePort } from "../../../tests/helpers/connectionClient";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { forwardSocket, type SocketForward } from "../../../tests/helpers/socketForward";
import {
  type HomeConnection,
  startConnection,
  type WorkDeviceContact,
} from "../connection/connection";
import { claimLink } from "../devices/dial";
import { createKeyIdentity } from "../devices/identity";
import { JoinedHome } from "../devices/joinedHome";
import { DevicePairing } from "../devices/pairing";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { writeInstalled } from "./background";
import { cleanUp, LEFT_CLAUDE_LOGIN } from "./cleanUp";
import { type HelperIO, homeDialAddress, joinHome } from "./join";
import { HomeRoute, ROUTE_LEASE_MS } from "./route";
import { type HelperRun, helperStatus, startHelper } from "./run";
import type { HeldSignIns } from "./signIns";
import { helperWords } from "./words";

/**
 * What runs work for a home, joining and running (docs/helper.md), against
 * the real connection and the real pairing over scratch folders, with a
 * stand-in core: the home's side is the one the app runs. Every home here
 * listens on loopback, so it is on this Mac and the computer that runs work
 * is another user on it; the words for another Mac are in words.test.ts.
 * The built app itself, started as its own process, is tests/e2e/run-work.spec.ts.
 */

const BUILDER = { name: "builder", uid: 502 };
const OTHER_UID = 501;

const standIn = (async (channel) => {
  if (channel === "inf:app:healthcheck")
    return {
      ok: true,
      version: "9.9.9",
      platform: "test-os",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [...HOME_CAPABILITIES],
    };
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

const connections: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
const runs: HelperRun[] = [];
const forwards: SocketForward[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) run.stop();
  await Promise.all(forwards.splice(0).map((forward) => forward.close()));
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
});

async function home(
  options: {
    ownUid?: number;
    protocolVersion?: string;
    now?: () => number;
    onJoined?: ConstructorParameters<typeof DevicePairing>[0]["onJoined"];
    /** This Mac's own network addresses as the home reads them; none unless a test gives some. */
    network?: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
    /** The home takes every device for one on another Mac. */
    joinsFromAnotherMac?: boolean;
  } = {},
) {
  let port = await freePort();
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-helper-home-"), "devices"),
    onProblem: () => {},
    interfaces: options.network ?? (() => ({})),
    port,
    ownUid: options.ownUid ?? OTHER_UID,
    ...(options.now ? { now: options.now } : {}),
    ...(options.onJoined ? { onJoined: options.onJoined } : {}),
    ...(options.joinsFromAnotherMac ? { joinsFromAnotherMac: true } : {}),
  });
  pairings.push(pairing);
  const listen = () => {
    const connection = startConnection({
      dispatch: standIn,
      events: new CoreEventBus(),
      devices: pairing,
      port,
      name: () => "MacBook Pro",
      ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    });
    connections.push(connection);
    return connection;
  };
  let connection = listen();
  return {
    pairing,
    /** Where the home answers now. */
    get at() {
      return `127.0.0.1:${port}`;
    },
    connection: () => connection,
    /** Firstmate quits there, and later opens again. */
    quit: () => connection.close(),
    reopen: async () => {
      connection = listen();
      await connection.settled();
    },
    /** The home's address changes: it stops answering where it was, and answers somewhere else. */
    move: async () => {
      await connection.close();
      port = await freePort();
      connection = listen();
      await connection.settled();
    },
    link: async (kind: DeviceKind = "work") => {
      const { link } = pairing.invite({ kind, at: `127.0.0.1:${port}` });
      await connection.settled();
      return link;
    },
    /** The link inside the command for another user on this Mac, where the home sends it. */
    command: async () => {
      const { link } = pairing.invite({ kind: "work", command: "another-user" });
      await connection.settled();
      return link;
    },
  };
}

/** This Mac's own network address, as `os.networkInterfaces()` lists it. */
const network = (...addresses: string[]): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  en0: addresses.map(
    (address) =>
      ({
        address,
        netmask: address.includes(":") ? "ffff:ffff:ffff:ffff::" : "255.255.255.0",
        family: address.includes(":") ? "IPv6" : "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: null,
        ...(address.includes(":") ? { scopeid: 0 } : {}),
      }) as NetworkInterfaceInfo,
  ),
});

/** A person at Terminal: what was shown, and what they type when asked. */
function person(answer = "yes") {
  const said: string[] = [];
  const asked: string[][] = [];
  const io: HelperIO = {
    say: (lines) => said.push(...lines),
    ask: async (lines, prompt) => {
      asked.push([...lines, prompt]);
      return answer;
    },
  };
  return { io, said, asked };
}

const join_ = (text: string, dataDir: string, io: HelperIO) =>
  joinHome({ text, dataDir, io, device: { name: "MacBook Pro", user: BUILDER }, timeoutMs: 2_000 });

const thisMac = { thisMac: true, host: "127.0.0.1" };

describe("joining a home as a computer that runs work", () => {
  it("refuses text that is not a link, and a link for the app on another Mac, asking nothing", async () => {
    const at = await home();
    const dataDir = scratchDir("infinitary-helper-");
    for (const [text, words] of [
      ["firstmate3000://join?as=work", helperWords.notALink],
      ["hello", helperWords.notALink],
      [await at.link("view"), helperWords.viewLink],
    ] as const) {
      const { io, said, asked } = person();
      expect(await join_(text, dataDir, io)).toMatchObject({ ok: false });
      expect(said).toEqual(words);
      expect(asked).toEqual([]);
    }
    expect(existsSync(join(dataDir, "home.json"))).toBe(false);
  });

  it("asks nothing when the Mac a link names is out of reach, or is not that Mac", async () => {
    const at = await home();
    const link = parsePairingLink(await at.link());
    const dataDir = scratchDir("infinitary-helper-");
    const nobody = buildPairingLink({ ...link, at: `127.0.0.1:${await freePort()}` });
    const impostor = buildPairingLink({ ...link, key: createKeyIdentity("x").pin });
    for (const [text, words] of [
      [nobody, helperWords.unreachable(thisMac)],
      [impostor, helperWords.notThatMac(thisMac)],
    ] as const) {
      const { io, said, asked } = person();
      expect(await join_(text, dataDir, io)).toMatchObject({ ok: false });
      expect(said).toEqual(words);
      expect(asked).toEqual([]);
    }
    // Nothing was sent: the link is still open.
    expect(at.pairing.list()).toEqual([]);
  });

  it("joins only on a typed yes, as its user, keeping the grant private to it", async () => {
    const at = await home();
    const link = await at.link();
    const dataDir = join(scratchDir("infinitary-helper-"), "helper");

    const no = person("no");
    expect(await join_(link, dataDir, no.io)).toMatchObject({ ok: false, reason: "declined" });
    expect(no.asked).toEqual([[...helperWords.ask(thisMac, "builder"), helperWords.prompt]]);
    expect(no.said).toEqual(helperWords.declined);
    expect(at.pairing.list()).toEqual([]);

    // The same link, still open, with a yes this time.
    const yes = person(" Yes ");
    expect(await join_(link, dataDir, yes.io)).toMatchObject({ ok: true, name: "MacBook Pro" });
    expect(yes.said).toEqual(helperWords.joined(thisMac, "MacBook Pro", "builder", "none"));
    expect(at.pairing.list()).toEqual([
      expect.objectContaining({
        kind: "work",
        name: "MacBook Pro",
        user: "builder",
        onThisMac: true,
      }),
    ]);
    const joined = new JoinedHome(dataDir).read();
    expect(joined).toMatchObject({ name: "MacBook Pro", grant: { kind: "work", at: at.at } });
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, "home.json")).mode & 0o777).toBe(0o600);
    // The lock went with the join.
    expect(existsSync(join(dataDir, "running.lock"))).toBe(false);
    expect(readFileSync(join(dataDir, "home.json"), "utf8")).not.toContain(
      parsePairingLink(link).code,
    );
  });

  it("joins with a link for a Mac as a Mac, which its window may control the home from, and as another user from the home's own Mac", async () => {
    const elsewhere = await home({ joinsFromAnotherMac: true });
    const dataDir = join(scratchDir("infinitary-helper-"), "helper");
    expect(await join_(await elsewhere.link("mac"), dataDir, person().io)).toMatchObject({
      ok: true,
      grant: { kind: "mac" },
    });
    expect(elsewhere.pairing.list()).toEqual([
      expect.objectContaining({ kind: "mac", name: "MacBook Pro", user: "builder" }),
    ]);
    expect(new JoinedHome(dataDir).read()?.grant.kind).toBe("mac");

    // The same link on the home's own Mac is another user there, which only runs work.
    const here = await home();
    const userDir = join(scratchDir("infinitary-helper-"), "helper");
    expect(await join_(await here.link("mac"), userDir, person().io)).toMatchObject({
      ok: true,
      grant: { kind: "work" },
    });
    expect(here.pairing.list()).toEqual([
      expect.objectContaining({ kind: "work", user: "builder", onThisMac: true }),
    ]);
  });

  it("hears the home's name with one dial the home counts as nothing of this computer in reach", async () => {
    const at = await home();
    const contacts: WorkDeviceContact[] = [];
    const versions: string[] = [];
    at.connection().onWorkDevice((contact) => contacts.push(contact));
    at.connection().onWorkVersion((deviceId) => versions.push(deviceId));
    const dataDir = join(scratchDir("infinitary-helper-"), "helper");
    expect(await join_(await at.link(), dataDir, person().io)).toMatchObject({
      ok: true,
      name: "MacBook Pro",
    });
    expect(new JoinedHome(dataDir).read()).toMatchObject({ name: "MacBook Pro" });
    // The home welcomed the dial before the join heard the name, and told nothing of it.
    expect(contacts).toEqual([]);
    expect(versions).toEqual([]);
  });

  it("refuses to run as the user Firstmate itself runs as, and keeps the link for another", async () => {
    const at = await home({ ownUid: BUILDER.uid });
    const link = await at.link();
    const dataDir = scratchDir("infinitary-helper-");
    const { io, said } = person();
    expect(await join_(link, dataDir, io)).toMatchObject({ ok: false, reason: "same-user" });
    expect(said).toEqual(helperWords.sameUser);
    expect(new JoinedHome(dataDir).read()).toBeNull();
    expect(at.pairing.list()).toEqual([]);
  });

  it("refuses a used or expired link, and a link from another home once joined", async () => {
    let now = 1_000_000;
    const at = await home({ now: () => now });
    const link = await at.link();
    const first = scratchDir("infinitary-helper-");
    expect(await join_(link, first, person().io)).toMatchObject({ ok: true });

    const other = await home();
    const again = person();
    expect(await join_(await other.link(), first, again.io)).toMatchObject({ reason: "joined" });
    expect(again.said).toEqual(helperWords.alreadyJoined("Infinitary on this computer"));
    expect(again.asked).toEqual([]);
    expect(other.pairing.list()).toEqual([]);
    // Said so even while its run works from the folder.
    writeFileSync(join(first, "running.lock"), `${process.ppid}\n`);
    const running = person();
    expect(await join_(await other.link(), first, running.io)).toMatchObject({ reason: "joined" });
    expect(running.said).toEqual(helperWords.alreadyJoined("Infinitary on this computer"));

    const used = person();
    expect(await join_(link, scratchDir("infinitary-helper-"), used.io)).toMatchObject({
      reason: "used",
    });
    expect(used.said).toEqual(helperWords.used(thisMac));

    const late = await at.link();
    now += 10 * 60 * 1000;
    const expired = person();
    expect(await join_(late, scratchDir("infinitary-helper-"), expired.io)).toMatchObject({
      reason: "expired",
    });
    expect(expired.said).toEqual(helperWords.expired(thisMac));
  });

  it("sets itself up in the background once joined, out of the folder's lock, and tells the home what it found", async () => {
    const found: unknown[] = [];
    const at = await home({ onJoined: (_device, tools) => found.push(tools) });
    const dataDir = scratchDir("infinitary-helper-");
    const asked: { locked: boolean; launcher: unknown; app: unknown }[] = [];
    const { io, said } = person();
    const outcome = await joinHome({
      text: await at.link(),
      dataDir,
      io,
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 2_000,
      found: async () => ({ git: true, claudeCode: false }),
      background: async (setUp) => {
        asked.push({ locked: existsSync(join(dataDir, "running.lock")), ...setUp });
        return "running";
      },
    });
    expect(outcome).toMatchObject({ ok: true });
    // The run it starts can take the folder: the join let it go first.
    expect(asked).toEqual([{ locked: false, launcher: null, app: null }]);
    expect(said).toEqual(helperWords.joined(thisMac, "MacBook Pro", "builder", "running"));
    expect(found).toEqual([{ git: true, claudeCode: false }]);
  });

  it("joins with the copy a command fetched without asking again, and keeps that copy", async () => {
    const at = await home();
    const fetched = join(scratchDir("infinitary-helper-fetched-"), "Firstmate 3000.app");
    mkdirSync(join(fetched, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(fetched, "Contents", "MacOS", "Firstmate 3000"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    const dataDir = scratchDir("infinitary-helper-");
    const launchers: unknown[] = [];
    const join2 = (text: string, folder: string) => {
      const { io, said, asked } = person();
      return joinHome({
        text,
        dataDir: folder,
        io,
        device: { name: "MacBook Pro", user: BUILDER },
        timeoutMs: 2_000,
        fetched: { app: fetched },
        background: async ({ launcher, app }) => {
          launchers.push({ launcher, app });
          return "running";
        },
      }).then((outcome) => ({ outcome, said, asked }));
    };
    const link = await at.link();
    const first = await join2(link, dataDir);
    expect(first.outcome).toMatchObject({ ok: true });
    expect(first.asked).toEqual([]);
    const kept = join(dataDir, "app", "Firstmate 3000.app");
    expect(readFileSync(join(kept, "Contents", "MacOS", "Firstmate 3000"), "utf8")).toBe(
      "#!/bin/sh\n",
    );
    expect(statSync(join(kept, "Contents", "MacOS", "Firstmate 3000")).mode & 0o111).not.toBe(0);
    expect(launchers).toEqual([
      {
        launcher: { executable: join(kept, "Contents", "MacOS", "Firstmate 3000"), args: [] },
        app: kept,
      },
    ]);

    // A command whose link was used keeps nothing.
    const other = scratchDir("infinitary-helper-");
    const used = await join2(link, other);
    expect(used.outcome).toMatchObject({ ok: false, reason: "used" });
    expect(existsSync(join(other, "app", "Firstmate 3000.app"))).toBe(false);
  });

  it("refuses while another process works from the same folder", async () => {
    const at = await home();
    const dataDir = scratchDir("infinitary-helper-");
    // The process that started this one is running.
    writeFileSync(join(dataDir, "running.lock"), `${process.ppid}\n`);
    const { io, said, asked } = person();
    expect(await join_(await at.link(), dataDir, io)).toMatchObject({ reason: "busy" });
    expect(said).toEqual(helperWords.busy);
    expect(asked).toEqual([]);
  });
});

describe("finding the home again after its address changes", () => {
  /** A user that joined `at`, with something of its own kept here: a sign-in's folder. */
  async function joinedAt(at: Awaited<ReturnType<typeof home>>) {
    const dataDir = scratchDir("infinitary-helper-");
    const outcome = await join_(await at.link(), dataDir, person().io);
    if (!outcome.ok) throw new Error(outcome.reason);
    mkdirSync(join(dataDir, "accounts"), { recursive: true });
    writeFileSync(join(dataDir, "accounts", "kept"), "a sign-in\n");
    return { dataDir, grant: outcome.grant, joined: new JoinedHome(dataDir).read() };
  }

  function running(dataDir: string) {
    const said: string[] = [];
    const started = startHelper({ dataDir, say: (lines) => said.push(...lines), retryMs: [20] });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    return { run: started.run, said };
  }

  it("finds its home where a new link says, as the same computer, with its run stopped first and everything kept", async () => {
    const joinedNames: { again: boolean }[] = [];
    const at = await home({ onJoined: (_device, _found, again) => joinedNames.push({ again }) });
    const { dataDir, grant, joined } = await joinedAt(at);
    const before = running(dataDir);
    await expect.poll(() => before.run.state().contact).toBe("in-reach");

    await at.move();
    await expect.poll(() => before.said.at(-1)).toBe(helperWords.quit(thisMac, "MacBook Pro")[0]);
    const steps: string[] = [];
    const { io, said, asked } = person();
    const outcome = await joinHome({
      text: await at.link(),
      dataDir,
      io,
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 2_000,
      // As launchd stops the run it started.
      pauseBackground: async () => {
        steps.push("paused");
        await before.run.stop();
        return async () => {
          steps.push("resumed");
        };
      },
      background: async (setUp) => {
        steps.push(`started ${JSON.stringify(setUp)}`);
        return "running";
      },
    });
    expect(outcome).toMatchObject({ ok: true, again: true, name: "MacBook Pro" });
    expect(asked).toEqual([]);
    expect(said).toEqual(helperWords.foundAgain(thisMac, "MacBook Pro", "builder", "running"));
    expect(steps).toEqual(["paused", `started ${JSON.stringify({ launcher: null, app: null })}`]);
    // The same computer on the home's list, dialing the home where it is now.
    expect(at.pairing.list()).toEqual([expect.objectContaining({ id: grant.deviceId })]);
    expect(joinedNames).toEqual([{ again: false }, { again: true }]);
    expect(new JoinedHome(dataDir).read()).toEqual({
      ...joined,
      grant: { ...grant, at: at.at },
    });
    expect(readFileSync(join(dataDir, "accounts", "kept"), "utf8")).toBe("a sign-in\n");
    expect(helperStatus(dataDir, { formatTime: () => "then" })[0]).toBe(
      helperWords.status(thisMac, "MacBook Pro", at.at, "then", false)[0],
    );

    const after = running(dataDir);
    await expect.poll(() => after.said).toEqual(helperWords.inReach(thisMac, "MacBook Pro"));
  });

  it("keeps the copy of Firstmate a new command got in place of the one kept here", async () => {
    const at = await home();
    const bundle = (text: string) => {
      const app = join(scratchDir("infinitary-helper-fetched-"), "Firstmate 3000.app");
      mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
      writeFileSync(join(app, "Contents", "MacOS", "Firstmate 3000"), text, { mode: 0o755 });
      return app;
    };
    const dataDir = scratchDir("infinitary-helper-");
    const started: unknown[] = [];
    const joinWith = async (app: string) =>
      joinHome({
        text: await at.link(),
        dataDir,
        io: person().io,
        device: { name: "MacBook Pro", user: BUILDER },
        timeoutMs: 2_000,
        fetched: { app },
        background: async ({ launcher, app: kept }) => {
          started.push(launcher);
          // As setting it up in the background records it.
          writeInstalled(dataDir, { service: null, app: kept });
          return "running";
        },
      });
    expect(await joinWith(bundle("#!/bin/sh\n# first\n"))).toMatchObject({ again: false });
    await at.move();
    expect(await joinWith(bundle("#!/bin/sh\n# second\n"))).toMatchObject({ again: true });
    const kept = join(dataDir, "app", "Firstmate 3000.app");
    expect(readFileSync(join(kept, "Contents", "MacOS", "Firstmate 3000"), "utf8")).toBe(
      "#!/bin/sh\n# second\n",
    );
    expect(started.at(-1)).toEqual({
      executable: join(kept, "Contents", "MacOS", "Firstmate 3000"),
      args: [],
    });
  });

  it("does what a removal would have done when the home removed it while it was out of reach, then joins it anew", async () => {
    const at = await home();
    const { dataDir, grant } = await joinedAt(at);
    await at.move();
    at.pairing.remove(grant.deviceId, { farewell: true });
    const steps: string[] = [];
    const { io, said, asked } = person();
    const outcome = await joinHome({
      text: await at.link(),
      dataDir,
      io,
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 2_000,
      pauseBackground: async () => {
        steps.push("paused");
        return async () => {
          steps.push("resumed");
        };
      },
      cleanUp: () => cleanUp({ dataDir, background: null }),
    });
    expect(outcome).toMatchObject({ ok: true, again: false });
    // Joining anew asks its yes, as any join does.
    expect(asked).toEqual([[...helperWords.ask(thisMac, "builder"), helperWords.prompt]]);
    expect(said).toEqual([
      ...helperWords.removedEarlier(thisMac, "MacBook Pro"),
      ...helperWords.cleanedUp([]),
      ...helperWords.joined(thisMac, "MacBook Pro", "builder", "none"),
    ]);
    expect(steps).toEqual(["paused"]);
    expect(existsSync(join(dataDir, "accounts"))).toBe(false);
    const [listed] = at.pairing.list();
    expect(listed?.id).not.toBe(grant.deviceId);
    expect(new JoinedHome(dataDir).read()?.grant).toMatchObject({
      at: at.at,
      deviceId: listed?.id,
    });
    expect(new JoinedHome(dataDir).read()?.grant.key).not.toBe(grant.key);
  });

  it("leaves the Claude login Firstmate made for that home to the run after the join, which signs it out before anything uses Claude", async () => {
    const at = await home();
    const { dataDir, grant } = await joinedAt(at);
    const claude = claudeOnComputer(dataDir, "made");
    await claude.signIn;
    await at.move();
    at.pairing.remove(grant.deviceId, { farewell: true });
    const { io, said } = person();
    // A command in Terminal: it signs nothing out itself.
    const outcome = await joinHome({
      text: await at.link(),
      dataDir,
      io,
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 2_000,
      cleanUp: () => cleanUp({ dataDir, background: null }),
    });
    expect(outcome).toMatchObject({ ok: true, again: false });
    expect(said).toEqual([
      ...helperWords.removedEarlier(thisMac, "MacBook Pro"),
      ...helperWords.cleanedUp([], [], [], { triesAgain: false, claude: "later" }),
      ...helperWords.joined(thisMac, "MacBook Pro", "builder", "none"),
    ]);
    expect(claude.signedIn()).toBe(true);

    // The run that follows, in this user's login session, signs it out first:
    // its sign-ins load only after, though one is already kept here.
    mkdirSync(join(dataDir, "accounts"), { recursive: true });
    writeFileSync(join(dataDir, "accounts", "registry.json"), "{}\n");
    const loadedWhileSignedIn: boolean[] = [];
    const ran: string[] = [];
    const started = startHelper({
      dataDir,
      say: (lines) => ran.push(...lines),
      retryMs: [20],
      log: () => {},
      signOutClaude: claude.signOutClaude,
      signIns: async () => {
        loadedWhileSignedIn.push(claude.signedIn());
        return {
          host: { reached: () => {}, dropped: () => {} },
          close: async () => {},
        } as unknown as HeldSignIns;
      },
    });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    await expect.poll(() => loadedWhileSignedIn).toEqual([false]);
    expect(ran).toContain(helperWords.claudeLogin("signed-out")[0]);
    expect(claude.seen.logouts).toBe(1);
    expect(existsSync(join(dataDir, LEFT_CLAUDE_LOGIN))).toBe(false);
  });

  it("names what that removal could not remove, without promising a second try, and joins it anew all the same", async () => {
    const at = await home();
    const { dataDir, grant } = await joinedAt(at);
    await at.move();
    at.pairing.remove(grant.deviceId, { farewell: true });
    const stuck = join(dataDir, "worktrees", "t-clean");
    const { io, said } = person();
    const outcome = await joinHome({
      text: await at.link(),
      dataDir,
      io,
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 2_000,
      cleanUp: async () => ({ kept: [], unremoved: [stuck] }),
    });
    expect(outcome).toMatchObject({ ok: true, again: false });
    expect(said).toEqual([
      ...helperWords.removedEarlier(thisMac, "MacBook Pro"),
      ...helperWords.cleanedUp([], [], [stuck], { triesAgain: false }),
      ...helperWords.joined(thisMac, "MacBook Pro", "builder", "none"),
    ]);
    expect(said).not.toContain(helperWords.cleanedUp([])[0]);
    // Joined anew: the note of the earlier removal is gone with what it noted.
    expect(new JoinedHome(dataDir).unfinished()).toBeNull();
    expect(new JoinedHome(dataDir).read()?.grant.deviceId).toBe(at.pairing.list()[0]?.id);
  });

  it("leaves everything as it was when the home is not there or refuses the link, and loads its run again", async () => {
    let now = 1_000_000;
    const at = await home({ now: () => now });
    const { dataDir, joined } = await joinedAt(at);
    const steps: string[] = [];
    const again = (text: string) => {
      const { io, said } = person();
      return joinHome({
        text,
        dataDir,
        io,
        device: { name: "MacBook Pro", user: BUILDER },
        timeoutMs: 2_000,
        pauseBackground: async () => {
          steps.push("paused");
          return async () => {
            steps.push("resumed");
          };
        },
      }).then((outcome) => ({ outcome, said }));
    };

    // Nothing answers where the link says: nothing here stops.
    const link = parsePairingLink(await at.link());
    const nowhere = await again(buildPairingLink({ ...link, at: `127.0.0.1:${await freePort()}` }));
    expect(nowhere.outcome).toMatchObject({ ok: false, reason: "unreachable" });
    expect(nowhere.said).toEqual(helperWords.unreachable(thisMac));
    expect(steps).toEqual([]);

    // The home refuses the link: its run starts again as it was.
    const late = await at.link();
    now += 10 * 60 * 1000;
    const expired = await again(late);
    expect(expired.outcome).toMatchObject({ ok: false, reason: "expired" });
    expect(expired.said).toEqual(helperWords.expired(thisMac));
    expect(steps).toEqual(["paused", "resumed"]);
    expect(new JoinedHome(dataDir).read()).toEqual(joined);
  });

  it("refuses while a run someone started by hand works from the folder", async () => {
    const at = await home();
    const { dataDir, joined } = await joinedAt(at);
    writeFileSync(join(dataDir, "running.lock"), `${process.ppid}\n`);
    const { io, said } = person();
    const outcome = await joinHome({
      text: await at.link(),
      dataDir,
      io,
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 2_000,
      pauseBackground: async () => null,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "busy" });
    expect(said).toEqual(helperWords.busy);
    expect(new JoinedHome(dataDir).read()).toEqual(joined);
  });
});

describe("leaving a home that is gone for a new one", () => {
  /** A user that joined a home which then quit for good, with a sign-in of its own kept here. */
  async function joinedToGone() {
    const gone = await home();
    const dataDir = scratchDir("infinitary-helper-");
    const outcome = await join_(await gone.link(), dataDir, person().io);
    if (!outcome.ok) throw new Error(outcome.reason);
    mkdirSync(join(dataDir, "accounts"), { recursive: true });
    writeFileSync(join(dataDir, "accounts", "kept"), "a sign-in\n");
    await gone.quit();
    return { gone, dataDir, joined: new JoinedHome(dataDir).read() };
  }

  /** Both homes listen on this Mac, so the one it leaves is named as an earlier Firstmate here. */
  const from = "an earlier Infinitary on this computer";

  it("asks first, and on its yes leaves the old home as a removal would, keeping unmerged work, then joins the new one", async () => {
    const { gone, dataDir } = await joinedToGone();
    const kept = join(dataDir, "worktrees", "t-unmerged");
    const at = await home();
    const steps: string[] = [];
    const { io, said, asked } = person();
    const outcome = await joinHome({
      text: await at.link(),
      dataDir,
      io,
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 2_000,
      pauseBackground: async () => {
        steps.push("paused");
        return async () => {
          steps.push("resumed");
        };
      },
      cleanUp: async () => {
        // As a removal: the old grant is gone and the note says it has not finished.
        const joinedHome = new JoinedHome(dataDir);
        steps.push(
          `cleaned ${JSON.stringify({ joined: joinedHome.read(), left: joinedHome.left()?.reason, unfinished: joinedHome.unfinished() })}`,
        );
        await cleanUp({ dataDir, background: null });
        return { kept: [kept] };
      },
      background: async () => "running",
    });
    expect(outcome).toMatchObject({ ok: true, again: false, name: "MacBook Pro" });
    // One question, one yes: leaving the old home and joining the new one.
    expect(asked).toEqual([
      [...helperWords.askLeave(from), ...helperWords.ask(thisMac, "builder"), helperWords.prompt],
    ]);
    expect(said).toEqual([
      ...helperWords.leftHome(from),
      ...helperWords.cleanedUp([kept], [], [], { triesAgain: false }),
      ...helperWords.joined(thisMac, "MacBook Pro", "builder", "running"),
    ]);
    expect(steps).toEqual([
      "paused",
      `cleaned ${JSON.stringify({ joined: null, left: "left", unfinished: [] })}`,
    ]);
    expect(existsSync(join(dataDir, "accounts"))).toBe(false);
    const [listed] = at.pairing.list();
    expect(new JoinedHome(dataDir).read()?.grant).toMatchObject({
      at: at.at,
      deviceId: listed?.id,
    });
    expect(new JoinedHome(dataDir).left()).toBeNull();
    // The old home is gone: nothing reaches it, and its own list is not touched.
    expect(gone.pairing.list()).toHaveLength(1);
  });

  it("asks only about leaving when a command fetched this copy after its own question", async () => {
    const { dataDir } = await joinedToGone();
    const at = await home();
    const app = join(scratchDir("infinitary-helper-fetched-"), "Firstmate 3000.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(join(app, "Contents", "MacOS", "Firstmate 3000"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    const { io, asked } = person();
    const outcome = await joinHome({
      text: await at.link(),
      dataDir,
      io,
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 2_000,
      fetched: { app },
      cleanUp: () => cleanUp({ dataDir, background: null }),
    });
    expect(outcome).toMatchObject({ ok: true, again: false });
    expect(asked).toEqual([[...helperWords.askLeave(from), helperWords.prompt]]);
    expect(existsSync(join(dataDir, "app", "Firstmate 3000.app"))).toBe(true);
  });

  it("changes nothing without a yes, or when the new home does not answer", async () => {
    const { dataDir, joined } = await joinedToGone();
    const at = await home();
    const steps: string[] = [];
    const tryJoin = async (text: string, answer: string) => {
      const { io, said, asked } = person(answer);
      const outcome = await joinHome({
        text,
        dataDir,
        io,
        device: { name: "MacBook Pro", user: BUILDER },
        timeoutMs: 2_000,
        pauseBackground: async () => {
          steps.push("paused");
          return null;
        },
        cleanUp: async () => {
          steps.push("cleaned");
          return { kept: [] };
        },
      });
      return { outcome, said, asked };
    };

    const declined = await tryJoin(await at.link(), "no");
    expect(declined.outcome).toMatchObject({ ok: false, reason: "joined" });
    expect(declined.asked).toHaveLength(1);
    expect(declined.said).toEqual(helperWords.declined);

    const link = parsePairingLink(await at.link());
    const nowhere = await tryJoin(
      buildPairingLink({ ...link, at: `127.0.0.1:${await freePort()}` }),
      "yes",
    );
    expect(nowhere.outcome).toMatchObject({ ok: false, reason: "unreachable" });
    expect(nowhere.asked).toEqual([]);

    expect(steps).toEqual([]);
    expect(at.pairing.list()).toEqual([]);
    expect(new JoinedHome(dataDir).read()).toEqual(joined);
    expect(readFileSync(join(dataDir, "accounts", "kept"), "utf8")).toBe("a sign-in\n");
  });

  it("says it left the old home when the new link is refused after its yes", async () => {
    let now = 1_000_000;
    const { dataDir } = await joinedToGone();
    const at = await home({ now: () => now });
    const late = await at.link();
    now += 10 * 60 * 1000;
    const { io, said } = person();
    const outcome = await joinHome({
      text: late,
      dataDir,
      io,
      device: { name: "MacBook Pro", user: BUILDER },
      timeoutMs: 2_000,
      cleanUp: () => cleanUp({ dataDir, background: null }),
    });
    expect(outcome).toMatchObject({ ok: false, reason: "expired" });
    expect(said.slice(-2)).toEqual(helperWords.expired(thisMac));
    expect(new JoinedHome(dataDir).read()).toBeNull();
    // The leave finished and kept no work, so the note goes with the rest.
    expect(helperStatus(dataDir)).toEqual(helperWords.notJoined);
  });
});

describe("running work for a home", () => {
  async function joined(options: Parameters<typeof home>[0] = {}) {
    const at = await home(options);
    const dataDir = scratchDir("infinitary-helper-");
    const outcome = await join_(await at.link(), dataDir, person().io);
    if (!outcome.ok) throw new Error(outcome.reason);
    return { ...at, dataDir, deviceId: outcome.grant.deviceId };
  }

  function start(dataDir: string, protocolVersion?: string) {
    const said: string[] = [];
    const started = startHelper({
      dataDir,
      say: (lines) => said.push(...lines),
      retryMs: [20],
      ...(protocolVersion ? { protocolVersion } : {}),
    });
    if (started.ok) runs.push(started.run);
    return { started, said };
  }

  it("says nothing was joined when nothing was", () => {
    const { started, said } = start(scratchDir("infinitary-helper-"));
    expect(started).toEqual({ ok: false, reason: "not-joined" });
    expect(said).toEqual(helperWords.notJoined);
  });

  it("stays in reach of its home, keeps trying while Firstmate is closed there, and comes back", async () => {
    const at = await joined();
    const { started, said } = start(at.dataDir);
    if (!started.ok) throw new Error(started.reason);
    const inReach = helperWords.inReach(thisMac, "MacBook Pro")[0];
    await expect.poll(() => said).toEqual([inReach]);
    expect(started.run.state()).toMatchObject({ contact: "in-reach", takesWork: true });
    // One process at a time works from the folder.
    expect(start(at.dataDir).said).toEqual(helperWords.busy);
    expect(helperStatus(at.dataDir)[1]).toBe("It is running now.");

    await at.quit();
    await expect.poll(() => said.at(-1)).toBe(helperWords.quit(thisMac, "MacBook Pro")[0]);
    await at.reopen();
    await expect.poll(() => said.at(-1)).toBe(inReach);

    started.run.stop();
    expect(await started.run.ended).toBe("stopped");
    expect(helperStatus(at.dataDir)[1]).toBe("It is not running now.");
  });

  it("takes no new work from a home on another major, and says so once", async () => {
    const at = await joined({ protocolVersion: "9.0.0" });
    const { started, said } = start(at.dataDir);
    if (!started.ok) throw new Error(started.reason);
    await expect.poll(() => started.run.state().takesWork).toBe(false);
    expect(said).toEqual([
      ...helperWords.inReach(thisMac, "MacBook Pro"),
      ...helperWords.noNewWork(thisMac, "MacBook Pro"),
    ]);
  });

  it("stops and forgets its grant when the home removes it", async () => {
    const at = await joined();
    const { started, said } = start(at.dataDir);
    if (!started.ok) throw new Error(started.reason);
    await expect.poll(() => started.run.state().contact).toBe("in-reach");
    at.pairing.remove(at.deviceId);
    expect(await started.run.ended).toBe("removed");
    expect(said.slice(-2)).toEqual(helperWords.removed(thisMac, "MacBook Pro"));
    expect(new JoinedHome(at.dataDir).read()).toBeNull();
    expect(helperStatus(at.dataDir)).toEqual(helperWords.left("Infinitary on this computer"));
    expect(existsSync(join(at.dataDir, "running.lock"))).toBe(false);
  });

  it("says what it joined, where and since when, without dialing", async () => {
    expect(helperStatus(scratchDir("infinitary-helper-"))).toEqual(helperWords.notJoined);
    const at = await joined();
    expect(helperStatus(at.dataDir, { formatTime: () => "3 Oct 2026 14:06" })).toEqual(
      helperWords.status(thisMac, "MacBook Pro", at.at, "3 Oct 2026 14:06", false),
    );
  });
});

describe("a home on this Mac while this Mac's network address changes", () => {
  function start(dataDir: string, interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>) {
    const said: string[] = [];
    const started = startHelper({
      dataDir,
      say: (lines) => said.push(...lines),
      retryMs: [20],
      interfaces,
    });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    return { run: started.run, said };
  }

  const inReach = helperWords.inReach(thisMac, "MacBook Pro")[0];
  const quit = helperWords.quit(thisMac, "MacBook Pro")[0];

  it("joins by the command for another user at loopback, and stays in reach with no new command once the address changes", async () => {
    let address = network("192.168.65.2");
    const at = await home({ network: () => address });
    const link = await at.command();
    // That user dials from this Mac itself, so the command names loopback, not 192.168.65.2.
    expect(parsePairingLink(link).at).toBe(at.at);
    const dataDir = scratchDir("infinitary-helper-");
    const outcome = await join_(link, dataDir, person().io);
    if (!outcome.ok) throw new Error(outcome.reason);
    const { said } = start(dataDir, () => address);
    await expect.poll(() => said).toEqual([inReach]);

    // This Mac moves to another network, and the home listens anew there.
    address = network("192.168.65.77");
    await at.quit();
    await expect.poll(() => said.at(-1)).toBe(quit);
    await at.reopen();
    await expect.poll(() => said.at(-1)).toBe(inReach);
    // The same computer, dialing where it always did; no new link was made for it.
    expect(at.pairing.list()).toEqual([expect.objectContaining({ id: outcome.grant.deviceId })]);
    expect(new JoinedHome(dataDir).read()?.grant.at).toBe(at.at);
  });

  it("dials loopback from its next run when its grant names this Mac's own network address", async () => {
    let address = network("192.168.65.2");
    const at = await home({ network: () => address });
    const dataDir = scratchDir("infinitary-helper-");
    const outcome = await join_(await at.link(), dataDir, person().io);
    if (!outcome.ok) throw new Error(outcome.reason);
    // As an earlier version kept it, from a link that named this Mac's network address.
    const port = splitDialAddress(at.at)?.port;
    new JoinedHome(dataDir).dialAt(`192.168.65.2:${port}`);

    const { said } = start(dataDir, () => address);
    await expect.poll(() => said).toEqual([inReach]);
    // Kept so, with everything else in the grant as it was.
    expect(new JoinedHome(dataDir).read()?.grant).toEqual({ ...outcome.grant, at: at.at });

    address = network("192.168.65.77");
    await at.quit();
    await expect.poll(() => said.at(-1)).toBe(quit);
    await at.reopen();
    await expect.poll(() => said.at(-1)).toBe(inReach);
  });

  it("leaves a grant dialing another Mac, a name or loopback where it did", () => {
    const interfaces = () => network("192.168.65.2", "fd7a:115c::5");
    expect(homeDialAddress("192.168.65.2:47623", interfaces)).toBe("127.0.0.1:47623");
    expect(homeDialAddress("[fd7a:115c::5]:47623", interfaces)).toBe("127.0.0.1:47623");
    for (const at of [
      "192.168.65.77:47623",
      "mini.local:47623",
      "mac.tail.ts.net:47623",
      "127.0.0.1:52011",
      "[::1]:47623",
    ])
      expect(homeDialAddress(at, interfaces), at).toBe(at);
  });
});

describe("a home that reaches this computer through its own SSH connection", () => {
  /** The far end of the home's SSH connection on this Mac: a private socket carried to the home. */
  async function forward(at: string): Promise<SocketForward> {
    const made = await forwardSocket(splitDialAddress(at)?.port ?? 0);
    forwards.push(made);
    return made;
  }

  it("dials only the route its connection keeps now, follows a new one, and is out of reach without one", async () => {
    const at = await home();
    const first = await forward(at.at);
    const { link } = at.pairing.invite(
      { kind: "work" },
      { remoteLogin: "builder@mini.local", via: "ssh", locality: "elsewhere" },
    );
    await at.connection().settled();
    const grant = await claimLink(
      link,
      { kind: "work", name: "Mac mini", user: BUILDER },
      { target: { socket: first.socket } },
    );
    const dataDir = scratchDir("infinitary-helper-");
    new JoinedHome(dataDir).join(grant, Date.now());
    let now = Date.now();
    const started = startHelper({
      dataDir,
      say: () => {},
      retryMs: [20],
      now: () => now,
    });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    const { run } = started;

    // No route yet: out of reach, and nothing is dialed - not even the
    // home's loopback, where the grant says the home is and where it answers.
    await expect.poll(() => run.state().contact).toBe("lost");
    expect(first.carried()).toBe(1);

    // The home's connection publishes its route: in reach through it.
    const route = new HomeRoute(dataDir, () => now);
    const one = route.begin();
    route.publish(one, { socket: first.socket, homeKey: grant.homeKey, deviceId: grant.deviceId });
    await expect.poll(() => run.state().contact).toBe("in-reach");
    expect(first.carried()).toBe(2);
    // A link from another home is refused while this one answers through its route.
    const other = await home();
    expect(await join_(await other.link(), dataDir, person().io)).toEqual({
      ok: false,
      reason: "joined",
    });
    expect(first.carried()).toBe(3);

    // A new connection takes the route at another socket, and the old one
    // drops: the same run follows it, never started again.
    const second = await forward(at.at);
    const two = route.begin();
    route.publish(two, { socket: second.socket, homeKey: grant.homeKey, deviceId: grant.deviceId });
    first.cut();
    await expect.poll(() => second.carried()).toBe(1);
    await expect.poll(() => run.state().contact).toBe("in-reach");
    expect(first.carried()).toBe(3);

    // Its connection stops renewing it, and the route it left is no route:
    // out of reach, the same computer, nothing forgotten or dialed elsewhere.
    now += ROUTE_LEASE_MS;
    second.cut();
    await expect.poll(() => run.state().contact).toBe("lost");
    expect(second.carried()).toBe(1);
    expect(run.state().removed).toBe(false);
    expect(new JoinedHome(dataDir).read()?.grant).toEqual(grant);
    expect(at.pairing.list()).toEqual([expect.objectContaining({ id: grant.deviceId })]);

    // Renewed, it is in reach again where it was.
    route.publish(two, { socket: second.socket, homeKey: grant.homeKey, deviceId: grant.deviceId });
    await expect.poll(() => run.state().contact).toBe("in-reach");
    run.stop();
    expect(await run.ended).toBe("stopped");
  });

  it("moves a computer joined by a command onto the home's SSH when the home finds it again by its address", async () => {
    const at = await home();
    const dataDir = scratchDir("infinitary-helper-");
    const joined = await join_(await at.link(), dataDir, person().io);
    if (!joined.ok) throw new Error(joined.reason);
    expect(joined.grant).not.toHaveProperty("via");
    mkdirSync(join(dataDir, "accounts"), { recursive: true });
    writeFileSync(join(dataDir, "accounts", "kept"), "a sign-in\n");
    const before = new JoinedHome(dataDir).read();

    // This Mac's address changes, so the command's grant dials where it was.
    await at.move();
    const through = await forward(at.at);
    const { link } = at.pairing.invite(
      { kind: "work" },
      { remoteLogin: "builder@mini.local", via: "ssh", locality: "elsewhere" },
    );
    await at.connection().settled();
    const steps: string[] = [];
    const outcome = await joinHome({
      text: link,
      dataDir,
      io: person().io,
      device: { name: "Mac mini", user: BUILDER },
      timeoutMs: 2_000,
      dial: { target: { socket: through.socket } },
      pauseBackground: async () => {
        steps.push("paused");
        return async () => {
          steps.push("resumed");
        };
      },
      background: async () => {
        steps.push("started");
        return "running";
      },
    });

    // The same computer, its sign-ins kept, now reaching the home only over its SSH.
    expect(outcome).toMatchObject({ ok: true, again: true });
    expect(steps).toEqual(["paused", "started"]);
    const grant = { ...joined.grant, at: parsePairingLink(link).at, via: "ssh" };
    expect(new JoinedHome(dataDir).read()).toEqual({ ...before, grant });
    expect(readFileSync(join(dataDir, "accounts", "kept"), "utf8")).toBe("a sign-in\n");
    expect(at.pairing.list()).toEqual([expect.objectContaining({ id: joined.grant.deviceId })]);
    expect(at.pairing.sshConnections()).toEqual([
      { deviceId: joined.grant.deviceId, address: "builder@mini.local" },
    ]);
    expect(at.pairing.addressChanged(joined.grant.deviceId, ["192.168.1.40:1"])).toBe(false);

    // Its run dials only the route the home's SSH keeps, never an address.
    const now = Date.now();
    const started = startHelper({ dataDir, say: () => {}, retryMs: [20], now: () => now });
    if (!started.ok) throw new Error(started.reason);
    runs.push(started.run);
    await expect.poll(() => started.run.state().contact).toBe("lost");
    const carried = through.carried();
    const route = new HomeRoute(dataDir, () => now);
    route.publish(route.begin(), {
      socket: through.socket,
      homeKey: grant.homeKey,
      deviceId: grant.deviceId,
    });
    await expect.poll(() => started.run.state().contact).toBe("in-reach");
    expect(through.carried()).toBeGreaterThan(carried);
  });

  it("keeps a computer the home added by its address on the home's SSH, refusing a command's link", async () => {
    const at = await home();
    const through = await forward(at.at);
    const ssh = at.pairing.invite(
      { kind: "work" },
      { remoteLogin: "builder@mini.local", via: "ssh", locality: "elsewhere" },
    );
    await at.connection().settled();
    const grant = await claimLink(
      ssh.link,
      { kind: "work", name: "Mac mini", user: BUILDER },
      { target: { socket: through.socket } },
    );
    const dataDir = scratchDir("infinitary-helper-");
    new JoinedHome(dataDir).join(grant, Date.now());
    const outcome = await joinHome({
      text: await at.link(),
      dataDir,
      io: person().io,
      device: { name: "Mac mini", user: BUILDER },
      timeoutMs: 2_000,
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(new JoinedHome(dataDir).read()?.grant).toEqual(grant);
  });
});
