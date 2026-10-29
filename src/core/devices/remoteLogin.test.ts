import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import {
  type DeviceView,
  deviceLabel,
  PAIRING_LINK_PREFIX,
  parsePairingLink,
} from "@shared/devices";
import { PHONE_DOOR_FOLDER } from "@shared/phoneLink";
import {
  addressAtPort,
  REMOTE_LOGIN_TIME_LIMIT_MS,
  type RemoteLoginAddOptions,
  remoteLoginWords,
} from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { connectClient } from "../../../tests/helpers/connectionClient";
import { macRelease } from "../../../tests/helpers/macRelease";
import { scratchDir, socketScratchDir } from "../../../tests/helpers/scratchDirs";
import {
  SSH_SERVER_AVAILABLE,
  type SshServer,
  startSshServer,
} from "../../../tests/helpers/sshServer";
import {
  addStandInPayload,
  STAND_IN_APP,
  standInFirstmate,
  standInProgram,
  standInRecord,
} from "../../../tests/helpers/standInFirstmate";
import { type HomeConnection, startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import { privateSocket } from "../helper/route";
import { hostEnv } from "../hostEnv";
import { BUILDS_FILE, publicTagFor } from "../update/updateChannels";
import * as appArchive from "./appArchive";
import { packApp } from "./appArchive";
import { claimLink } from "./dial";
import { FarBuilds } from "./farBuilds";
import { LINUX, MACOS } from "./farSystems";
import { hostTrustSshOptions, knownHostsLine, preferHostKey } from "./hostTrust";
import { type LocalityChallenge, placeLocalityChallenge } from "./locality";
import { OWN_KEY_COMMENT } from "./ownKey";
import { DevicePairing } from "./pairing";
import { PhoneDoor } from "./phoneDoor";
import { PublishedBuilds, publishedAssetName, standInTapFetch } from "./publishedBuilds";
import {
  DOWNLOAD_READY,
  MAC_DOWNLOAD_UPDATE,
  RELEASE_REQUIREMENT,
  readDownloadCount,
  UPDATE_STARTING,
  VERIFY_MAC_APP,
} from "./remoteDownload";
import {
  type DeviceSetupEvent,
  RemoteLogin,
  RemoteLoginRefusedError,
  sendCopy,
} from "./remoteLogin";
import { shellWord } from "./shellWord";
import { runSsh, SSH_OPTIONS, type SshProgram } from "./ssh";
import { placeOwnKey } from "./sshPassword";
import { UBUNTU_PACKAGE_BIN } from "./ubuntuPackage";

/**
 * Adding a Mac by its address over Remote Login (docs/devices.md, "Adding a
 * computer by its address"), as the home does it: the Mac's own `/usr/bin/ssh` in
 * batch mode against a real SSH server (`tests/helpers/sshServer.ts`), the
 * real pairing and connection, and a stand-in Firstmate bundle the home
 * sends. The stand-in's program does at the wire what the work mode does
 * when the home starts it - it reads the link from its input and uses it with
 * the Mac's own curl and a key of its own - and writes down how it was
 * started and what it found beside it. The real app joining this way is
 * `tests/e2e/run-work.spec.ts`.
 */

// Real processes: sshd, ssh, tar, curl and openssl (Mac slowest per-case
// fastest 2.1 s, docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 15_000 });

const standIn = (async (channel) => {
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

const connections: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
const servers: SshServer[] = [];
const doors: PhoneDoor[] = [];
afterEach(async () => {
  for (const door of doors.splice(0)) door.close();
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

/** The macOS user number the stand-in joins as; the home runs as another. */
const THEIR_UID = 4242;

/**
 * Add it the way the captain does after saying this is the Mac: the first
 * reach asks, and the yes is the line just shown. A later refusal is the
 * add's own.
 */
async function addChecked(
  remote: RemoteLogin,
  address: string,
  options: Partial<RemoteLoginAddOptions> = {},
) {
  const asked = await remote.addOrAsk(address, options);
  if (!("asks" in asked) || asked.asks !== "confirm") {
    if ("asks" in asked) throw new Error(`Asked ${asked.asks}.`);
    return asked;
  }
  const again = await remote.addOrAsk(address, { ...options, confirm: asked.line });
  if ("asks" in again) throw new Error(`Asked ${again.asks}.`);
  return again;
}

const standInBundle = (record: string, uid = THEIR_UID) => standInFirstmate(record, uid);

/** The other user's world: a home folder of its own, and where its work keeps its data. */
function otherUser(extra: Record<string, string> = {}) {
  const home = scratchDir("infinitary-remote-user-");
  const work = join(home, "work");
  return {
    home,
    work,
    env: {
      HOME: home,
      INFINITARY_HELPER_DATA_DIR: work,
      INFINITARY_DEVICE_NAME: "Mac mini",
      ...extra,
    },
  };
}

/**
 * A home: pairing, the connection (unless it is to be out of reach), and
 * adding over SSH. A home started again on the same `dir` is the same home,
 * answering at another port, as after its address changed.
 */
async function home(options: {
  ssh: SshProgram;
  bundle: string | null;
  listen?: boolean;
  ownUid?: number;
  dir?: string;
  inReach?: (deviceId: string) => boolean;
  here?: () => LocalityChallenge;
  copyEveryMs?: number;
  builds?: FarBuilds;
  idleTimeoutMs?: number;
  sendTimeoutMs?: number;
}) {
  const port = await claimedPort();
  const pairing = new DevicePairing({
    // Where the app keeps it has a space in it, as Application Support does.
    dir:
      options.dir ?? join(scratchDir("infinitary-remote-home-"), "Application Support", "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    port,
    ownUid: options.ownUid ?? THEIR_UID + 1,
  });
  pairings.push(pairing);
  const listening =
    options.listen === false
      ? null
      : startConnection({ dispatch: standIn, events: new CoreEventBus(), devices: pairing, port });
  if (listening) connections.push(listening);
  const said: DeviceSetupEvent[] = [];
  const remote = new RemoteLogin({
    pairing,
    ssh: options.ssh,
    flavor: "dev",
    appBundle: () => options.bundle,
    builds: options.builds,
    idleTimeoutMs: options.idleTimeoutMs,
    sendTimeoutMs: options.sendTimeoutMs,
    listening: async () => {
      await listening?.settled();
    },
    ...(options.inReach ? { inReach: options.inReach } : {}),
    ...(options.here ? { here: options.here } : {}),
    ...(options.copyEveryMs !== undefined ? { copyEveryMs: options.copyEveryMs } : {}),
    emit: (event) => said.push(event),
  });
  return {
    pairing,
    port,
    remote,
    said,
    /** Each line said, but the copy's moving count, which `sending` reads. */
    lines: () => said.filter((event) => event.copy?.state !== "sending").map((event) => event.text),
    /** The copy's count of the bytes it sent so far, each time it was said. */
    sending: () => said.filter((event) => event.copy?.state === "sending"),
    /** Resolves once the connection listens for what pairing holds now. */
    settled: async () => {
      await listening?.settled();
    },
    /** Stops answering where it was. */
    close: async () => {
      await listening?.close();
    },
  };
}

/** How many bytes this Mac's copy of `bundle` is, packed as it is sent; a Linux AppImage goes as itself. */
function packedSize(bundle: string): Promise<number> {
  if (bundle.endsWith(".AppImage")) return Promise.resolve(statSync(bundle).size);
  return new Promise((resolve, reject) => {
    const tar = packApp(bundle);
    let size = 0;
    tar.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
    });
    tar.once("error", reject);
    tar.once("close", () => resolve(size));
  });
}

async function server(): Promise<SshServer> {
  const started = await startSshServer();
  servers.push(started);
  return started;
}

describe.runIf(SSH_SERVER_AVAILABLE)("adding a Mac by its address over Remote Login", () => {
  // INF-1617: address-based add/update retain the join without promising a login start.
  for (const startup of ["unavailable", "unknown"] as const) {
    it(`keeps an address-added computer whose automatic startup is ${startup}, including after update`, async () => {
      const sshd = await server();
      const them = otherUser();
      const record = join(scratchDir("infinitary-remote-startup-"), "started");
      const at = await home({
        ssh: sshd.ssh({ remote: them.env }),
        bundle: standInFirstmate(record, THEIR_UID, { joined: startup, updated: startup }),
      });
      const device = await addChecked(at.remote, sshd.address);
      expect(at.pairing.list()).toEqual([
        expect.objectContaining({ id: device.id, automaticStartup: startup }),
      ]);
      expect(at.lines()).toContain(remoteLoginWords.startup(device, startup));
      expect(at.lines()).not.toContain(remoteLoginWords.atLogin(device));
      expect(at.lines().join(" ")).not.toContain("enable-linger");
      await at.remote.update(device.id);
      expect(at.pairing.list()).toEqual([
        expect.objectContaining({ id: device.id, automaticStartup: startup }),
      ]);
      expect(at.lines()).toContain(remoteLoginWords.updated(device, startup));
    });
  }

  // INF-333 N1: a join that never claimed its invite is a definite Add failure.
  it.each([1, 4, 255])(
    "an unclaimed Add ending with %s uses its definite refusal, never Update uncertainty",
    async (code) => {
      const sshd = await server();
      const them = otherUser();
      const record = join(scratchDir("infinitary-unclaimed-add-"), "started");
      const bundle = standInFirstmate(record, THEIR_UID, {
        joined: "at-login",
        updated: "running",
        startExit: { when: "join", code },
      });
      const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });
      const refused = await addChecked(at.remote, sshd.address).catch((error: unknown) => error);
      const reason = code === 255 ? "unreachable" : "failed";
      const lines = remoteLoginWords.refused(reason, {
        address: sshd.address,
        name: "Mac mini",
        doing: "add",
      });
      expect(refused).toBeInstanceOf(RemoteLoginRefusedError);
      expect((refused as Error).message).toBe(lines.join("\n"));
      expect(at.pairing.list()).toEqual([]);
      expect(at.lines().slice(-2)).toEqual([...lines]);
    },
  );

  it("reaches it with the captain's own SSH, sends this Mac's Firstmate, and that copy joins with the link from its input", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const left: string[] = [];
    const at = await home({
      ssh: sshd.ssh({ remote: them.env }),
      bundle: standInBundle(record),
      here: () => {
        const here = placeLocalityChallenge();
        left.push(here.path);
        return here;
      },
    });

    const device = await addChecked(at.remote, sshd.address);

    expect(device).toMatchObject({
      kind: "work",
      name: "Mac mini",
      user: "sam",
      remoteLogin: sshd.address,
      // The look read back the token this Mac left: the Mac at that address is this one.
      onThisMac: true,
    });
    // Read once, then gone.
    expect(left).toHaveLength(1);
    expect(existsSync(left[0] ?? "")).toBe(false);
    expect(at.pairing.list()).toEqual([expect.objectContaining({ remoteLogin: sshd.address })]);
    // Each step said once, in order, and when its work starts there.
    expect(at.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.settingUp("Mac mini"),
      remoteLoginWords.starting("Mac mini"),
      // One Mac in a test: the user it joined as is another user on this one.
      remoteLoginWords.atLogin(device),
    ]);
    // The copy's count is said between preparing it and starting it there.
    const copy = at.said.map((event) => event.copy?.state ?? null);
    expect(copy.indexOf("sending")).toBeGreaterThan(copy.indexOf("preparing"));
    expect(copy.lastIndexOf("sending")).toBeLessThan(copy.indexOf("starting"));
    expect(at.said.every((event) => event.tone === "info" && event.doing === "add")).toBe(true);
    // The copy arrived whole and joined with the link on its input, never in its words.
    const started = readFileSync(record, "utf8");
    expect(started).toMatch(
      new RegExp(
        `^started: work join --fetched /.+/firstmate[.-]\\w+/${escapeRegExp(STAND_IN_APP)} --from-home$`,
        "m",
      ),
    );
    expect(started).toContain("the home's own copy");
    expect(started).toContain("link on its input");
    expect(started).not.toContain(PAIRING_LINK_PREFIX);
    // Its one-use code went to curl on its input, never in curl's arguments.
    const { code, curl } = standInRecord(record);
    expect(code).toHaveLength(43);
    expect(curl).toHaveLength(1);
    expect(curl[0]).not.toContain(code);
    expect(curl[0]).toContain("--data-binary @-");
    // The temporary folder it was unpacked in is gone.
    const unpacked = /--fetched (.+) --from-home/.exec(started)?.[1] ?? "";
    expect(existsSync(unpacked)).toBe(false);
    // Nothing the feed said holds a link.
    expect(JSON.stringify(at.said)).not.toContain(PAIRING_LINK_PREFIX);
  });

  it("says how far the copy has gone: the bytes sent so far as they move, then starting it there, never a share of a total", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInBundle(record);
    // Bytes that do not compress, so the copy is about as big as they are.
    const payload = 4_000_000;
    addStandInPayload(bundle, randomBytes(payload));
    // Every piece said, so the count is seen moving however fast this Mac copies.
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle, copyEveryMs: 0 });

    const device = await addChecked(at.remote, sshd.address);

    const sending = at.sending();
    const counts = sending.map((event) => event.copy?.sent ?? -1);
    // It moved while the copy went: many counts, each more than the one before.
    expect(counts.length).toBeGreaterThan(3);
    for (const [index, count] of counts.entries())
      expect(count).toBeGreaterThan(index === 0 ? 0 : (counts[index - 1] ?? 0));
    // Its last count is every byte that reached that Mac: the copy as this Mac packs it.
    expect(counts.at(-1)).toBe(await packedSize(bundle));
    expect(counts.at(-1)).toBeGreaterThan(payload);
    // One run of lines, each in place of the one before, in the feed's words.
    expect(new Set(sending.map((event) => event.run?.id)).size).toBe(1);
    expect(sending.every((event) => event.run?.id)).toBe(true);
    expect(sending.map((event) => event.text)).toEqual(
      counts.map((count) => remoteLoginWords.sending("Mac mini", count)),
    );
    // Preparing it, the counts, then starting it there, then the joined line.
    const order = at.said.map((event) => event.copy?.state ?? event.stage);
    expect(order.slice(0, 2)).toEqual(["reaching", "preparing"]);
    expect(order.slice(2, 2 + counts.length).every((state) => state === "sending")).toBe(true);
    expect(order[2 + counts.length]).toBe("starting");
    expect(at.said[2 + counts.length]?.text).toBe(remoteLoginWords.starting("Mac mini"));
    expect(device).toMatchObject({ kind: "work", remoteLogin: sshd.address });
    // Nothing says a share of a total: no total rides it, and no line holds a percentage.
    for (const event of at.said) {
      expect(Object.keys(event.copy ?? {}).every((key) => key === "state" || key === "sent")).toBe(
        true,
      );
      expect(event.text).not.toContain("%");
    }

    // Said at most once a second, the count still says its first bytes and all it sent.
    const another = await server();
    const calm = await home({ ssh: another.ssh({ remote: otherUser().env }), bundle });
    const again = await addChecked(calm.remote, another.address);
    expect(again).toMatchObject({ kind: "work", remoteLogin: another.address });
    const calmCounts = calm.sending().map((event) => event.copy?.sent ?? -1);
    expect(calmCounts.length).toBeGreaterThanOrEqual(2);
    expect(calmCounts.length).toBeLessThan(counts.length);
    expect(calmCounts.at(-1)).toBe(counts.at(-1));
  });

  it("says why when SSH cannot reach or sign in to it, and starts nothing there", async () => {
    const sshd = await server();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInBundle(record);
    const closed = await claimedPort();
    const cases = [
      { ssh: sshd.ssh({ key: "locked" }), refusal: "key-locked" },
      // The app that holds the key asked, and was not approved.
      { ssh: sshd.ssh({ key: "agent" }), refusal: "agent-declined" },
      // The app that holds the key quit, taking its socket with it or leaving it behind.
      { ssh: sshd.ssh({ key: "agent" }), agent: "quit", refusal: "agent-not-running" },
      { ssh: sshd.ssh({ key: "agent" }), agent: "quit-left", refusal: "agent-not-running" },
      // A refused key, at a Remote Login that takes no password either.
      { ssh: sshd.ssh({ key: "refused" }), refusal: "password-off" },
      { ssh: sshd.ssh({ port: closed }), refusal: "remote-login-off" },
      { ssh: sshd.ssh(), address: "sam@no-such-mac.invalid", refusal: "unreachable" },
    ] as const;
    for (const each of cases) {
      sshd.knownHosts("known");
      await sshd.agentRuns("agent" in each ? each.agent : "open");
      const at = await home({ ssh: each.ssh, bundle });
      const address = "address" in each ? each.address : sshd.address;
      const refused = await addChecked(at.remote, address).catch((error: unknown) => error);
      const lines = remoteLoginWords.refused(each.refusal, { address, doing: "add" });
      expect(refused, each.refusal).toBeInstanceOf(RemoteLoginRefusedError);
      expect((refused as RemoteLoginRefusedError).refusal, each.refusal).toBe(each.refusal);
      expect((refused as RemoteLoginRefusedError).message, each.refusal).toBe(lines.join("\n"));
      const reached =
        each.refusal === "unreachable" || each.refusal === "remote-login-off"
          ? []
          : [remoteLoginWords.reaching(address)];
      expect(at.lines(), each.refusal).toEqual([...reached, ...lines]);
      expect(at.pairing.list()).toEqual([]);
    }
    expect(existsSync(record)).toBe(false);
  });

  it("asks for the check line before sending anything, remembers the yes only in its own list, and refuses a changed key", async () => {
    const sshd = await server();
    sshd.knownHosts("unknown");
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInBundle(record);
    const dir = join(scratchDir("infinitary-remote-home-"), "devices");
    const at = await home({ ssh: sshd.ssh(), bundle, dir });
    const asked = await at.remote.addOrAsk(sshd.address);
    expect(asked).toMatchObject({ asks: "confirm", address: sshd.address });
    if (!("line" in asked)) throw new Error("The check line was not asked.");
    expect(asked.line).toMatch(/^ED25519 SHA256:\S+$/);
    expect(at.lines()).toEqual([]);
    expect(at.pairing.list()).toEqual([]);
    expect(existsSync(record)).toBe(false);
    expect(existsSync(join(dir, "host-trust.json"))).toBe(false);

    const wrong = await at.remote
      .addOrAsk(sshd.address, { confirm: "ED25519 SHA256:not-the-line" })
      .catch((error: unknown) => error);
    expect(wrong).toBeInstanceOf(RemoteLoginRefusedError);
    expect(wrong).toMatchObject({ refusal: "host-changed" });
    expect(existsSync(record)).toBe(false);
    expect(existsSync(join(dir, "host-trust.json"))).toBe(false);
    expect(readFileSync(sshd.knownHostsFile, "utf8")).toBe("");

    const device = await at.remote.add(sshd.address, { confirm: asked.line });
    expect(device.remoteLogin).toBe(sshd.address);
    expect(statSync(join(dir, "host-trust.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "known_hosts")).mode & 0o777).toBe(0o600);
    const trust = JSON.parse(readFileSync(join(dir, "host-trust.json"), "utf8")) as {
      hosts: Record<string, { line: string; publicKey: string }>;
    };
    expect(trust.hosts[sshd.address]?.line).toBe(asked.line);
    expect(readFileSync(join(dir, "known_hosts"), "utf8")).toContain(
      trust.hosts[sshd.address]?.publicKey,
    );
    expect(readFileSync(sshd.knownHostsFile, "utf8")).toBe("");

    const later = await at.remote.addOrAsk(sshd.address).catch((error: unknown) => error);
    expect(later).not.toMatchObject({ asks: "confirm" });

    const changedRecord = join(scratchDir("infinitary-remote-record-"), "started");
    const changed = await home({
      ssh: sshd.ssh(),
      bundle: standInBundle(changedRecord),
      dir: join(scratchDir("infinitary-remote-home-"), "devices"),
    });
    changed.pairing.rememberHost(sshd.address, {
      type: "ssh-ed25519",
      publicKey: "AQID",
      line: "ED25519 SHA256:not-this-mac",
    });
    const refused = await changed.remote.addOrAsk(sshd.address).catch((error: unknown) => error);
    expect(refused).toMatchObject({ refusal: "host-changed" });
    expect(existsSync(changedRecord)).toBe(false);
    expect(changed.lines().some((line) => line.includes("Terminal"))).toBe(false);
  }, 30_000);

  it("refuses a computer of a system Firstmate does not run on, or whose user already runs work, before sending anything", async () => {
    const sshd = await server();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInBundle(record);

    // Another system: its uname says so.
    const bin = scratchDir("infinitary-remote-other-");
    writeFileSync(join(bin, "uname"), "#!/bin/sh\necho FreeBSD\n");
    chmodSync(join(bin, "uname"), 0o755);
    const other = otherUser({ PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin` });
    const notMac = await home({ ssh: sshd.ssh({ remote: other.env }), bundle });
    await expect(addChecked(notMac.remote, sshd.address)).rejects.toMatchObject({
      refusal: "other-system",
    });
    expect(notMac.lines().at(-2)).toBe(
      remoteLoginWords.refused("other-system", { address: sshd.address })[0],
    );

    // A user that joined a Firstmate already, whose grant this Mac cannot read as its own.
    const joined = otherUser();
    mkdirSync(joined.work, { recursive: true });
    writeFileSync(join(joined.work, "home.json"), "{}\n");
    const again = await home({ ssh: sshd.ssh({ remote: joined.env }), bundle });
    await expect(addChecked(again.remote, sshd.address)).rejects.toMatchObject({
      refusal: "already-joined",
    });
    expect(existsSync(record)).toBe(false);
  });

  /** A Mac added by its address to a home kept in `dir`, and the grant the copy there keeps. */
  async function addedTo(dir: string) {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInBundle(record);
    const ssh = sshd.ssh({ remote: them.env });
    const first = await home({ ssh, bundle, dir });
    const device = await addChecked(first.remote, sshd.address);
    const grant = () => JSON.parse(readFileSync(join(them.work, "home.json"), "utf8")).grant;
    expect(grant()).toMatchObject({ deviceId: device.id, homeKey: first.pairing.identity().pin });
    return { sshd, ssh, bundle, record, first, device, grant };
  }

  it("finds a Mac that runs this Firstmate's work again where this Mac is now, as the same computer", async () => {
    const dir = join(scratchDir("infinitary-remote-home-"), "devices");
    const { sshd, ssh, bundle, record, first, device, grant } = await addedTo(dir);

    // This Mac's address changed: Add it tells that Mac where this Mac is now.
    await first.close();
    const moved = await home({ ssh, bundle, dir });
    const found = await addChecked(moved.remote, sshd.address);
    expect(found).toMatchObject({ id: device.id, remoteLogin: sshd.address });
    expect(moved.pairing.list()).toEqual([expect.objectContaining({ id: device.id })]);
    expect(moved.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.finding(device),
      remoteLoginWords.starting(deviceLabel(device)),
      remoteLoginWords.atLogin(device),
    ]);
    // The copy's lines name the computer on the list, so its own row follows them.
    expect(moved.said.filter((event) => event.copy)).not.toEqual([]);
    for (const event of moved.said.filter((each) => each.copy))
      expect(event).toMatchObject({ stage: "finding", deviceId: device.id });
    expect(moved.said[1]).toMatchObject({ stage: "finding", deviceId: device.id });
    // The copy there used the key it was paired with, and dials where this Mac is now.
    expect(readFileSync(record, "utf8")).toContain("again");
    expect(grant()).toMatchObject({
      deviceId: device.id,
      at: parsePairingLink(moved.pairing.invite({ kind: "work" }).link).at,
    });
  });

  it("leaves a Mac that runs this Firstmate's work as it is while it is in reach, and sends nothing", async () => {
    const dir = join(scratchDir("infinitary-remote-home-"), "devices");
    const { sshd, ssh, bundle, record, device } = await addedTo(dir);
    const started = () => readFileSync(record, "utf8").match(/^started: /gm)?.length ?? 0;
    const sent = started();
    const near = await home({ ssh, bundle, dir, inReach: (id) => id === device.id });
    await expect(addChecked(near.remote, sshd.address)).rejects.toMatchObject({
      refusal: "in-reach",
    });
    expect(near.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      ...remoteLoginWords.refused("in-reach", { address: sshd.address, name: "Running as Sam" }),
    ]);
    expect(near.lines().at(-2)).toBe(
      "Running as Sam already runs work for your first mate, and is in reach.",
    );
    expect(started()).toBe(sent);
  });

  it("sets up anew a Mac this Firstmate removed, and asks once about another Firstmate's before sending anything", async () => {
    const dir = join(scratchDir("infinitary-remote-home-"), "devices");
    const { sshd, ssh, bundle, record, first, device, grant } = await addedTo(dir);

    // Removed while out of reach: that Mac lets this one go, then joins anew.
    first.pairing.remove(device.id, { farewell: true });
    first.said.splice(0);
    const anew = await addChecked(first.remote, sshd.address);
    expect(anew.id).not.toBe(device.id);
    expect(first.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.settingUp("Mac mini"),
      remoteLoginWords.starting("Mac mini"),
      remoteLoginWords.atLogin(anew),
    ]);
    expect(readFileSync(record, "utf8")).toContain("removed earlier");
    expect(grant()).toMatchObject({ deviceId: anew.id });

    const started = () => readFileSync(record, "utf8").match(/^started: /gm)?.length ?? 0;
    const sent = started();
    const other = await home({ ssh, bundle });
    const asked = await other.remote.addOrAsk(sshd.address);
    expect(asked).toMatchObject({ asks: "confirm", address: sshd.address });
    expect(other.lines()).toEqual([]);
    expect(started()).toBe(sent);
    if (!("line" in asked)) throw new Error("The check line was not asked.");
    expect(await other.remote.addOrAsk(sshd.address, { confirm: asked.line })).toEqual({
      asks: "leave",
      address: sshd.address,
      name: "Mac mini",
    });
    expect(other.lines()).toEqual([remoteLoginWords.reaching(sshd.address)]);
    expect(started()).toBe(sent);
    expect(other.pairing.list()).toEqual([]);
    expect(grant()).toMatchObject({ homeKey: first.pairing.identity().pin });
  });

  it("on the captain's yes, tells the join there to leave another Firstmate, and says so once it joined", async () => {
    const dir = join(scratchDir("infinitary-remote-home-"), "devices");
    const { sshd, ssh, bundle, record } = await addedTo(dir);
    const other = await home({ ssh, bundle });

    const device = await addChecked(other.remote, sshd.address, { leave: true });

    expect(device).toMatchObject({ kind: "work", remoteLogin: sshd.address });
    expect(other.pairing.list()).toEqual([expect.objectContaining({ id: device.id })]);
    const text = readFileSync(record, "utf8");
    expect(text).toContain("leave on its input");
    expect(text).toContain("left the other home");
    expect(other.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.settingUp("Mac mini"),
      remoteLoginWords.starting("Mac mini"),
      ...remoteLoginWords.leftOther(device, { kept: 1, unremoved: 0 }),
      remoteLoginWords.atLogin(device),
    ]);
    expect(other.lines()[3]).toBe(
      "Running as Sam left the other first mate it ran work for. Its unmerged work stays there.",
    );
  });

  it("leaves another Firstmate that still answers there as it is, even after the captain's yes", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInFirstmate(record, THEIR_UID, {
      joined: "at-login",
      updated: "running",
      otherAnswers: true,
    });
    const ssh = sshd.ssh({ remote: them.env });
    const first = await home({ ssh, bundle });
    await addChecked(first.remote, sshd.address);
    const before = readFileSync(join(them.work, "home.json"), "utf8");

    const other = await home({ ssh, bundle });
    await expect(addChecked(other.remote, sshd.address, { leave: true })).rejects.toMatchObject({
      refusal: "still-answers",
    });
    expect(other.lines().slice(-2)).toEqual([
      `${sshd.address} runs work for another first mate, which still answers.`,
      "Remove it from that first mate, then ask again.",
    ]);
    expect(readFileSync(record, "utf8")).toContain("leave on its input");
    expect(other.pairing.list()).toEqual([]);
    // The link nobody used is closed, and the grant there names the first home still.
    expect(other.pairing.any()).toBe(false);
    expect(readFileSync(join(them.work, "home.json"), "utf8")).toBe(before);
  });

  it("says when the join there could not reach this Mac through its SSH, or is the user Firstmate runs as, and closes the link", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");

    // Nothing answers here: the join there dials only the socket this Mac
    // forwards, and nothing else.
    const quiet = await home({
      ssh: sshd.ssh({ remote: them.env }),
      bundle: standInBundle(record),
      listen: false,
    });
    await expect(addChecked(quiet.remote, sshd.address)).rejects.toMatchObject({
      refusal: "failed",
    });
    expect(quiet.lines().slice(-2)).toEqual(
      remoteLoginWords.refused("failed", { address: sshd.address, name: "Mac mini" }),
    );
    expect(standInRecord(record).curl.every((args) => args.includes("--unix-socket"))).toBe(true);
    // The link nobody could use is closed: the home listens for nothing.
    expect(quiet.pairing.any()).toBe(false);

    const same = await home({
      ssh: sshd.ssh({ remote: them.env }),
      bundle: standInBundle(record),
      ownUid: THEIR_UID,
    });
    await expect(addChecked(same.remote, sshd.address)).rejects.toMatchObject({
      refusal: "same-user",
    });
    expect(same.pairing.list()).toEqual([]);
    expect(same.pairing.any()).toBe(false);
  });

  it("tells another Mac whose user has Firstmate's own user number from Firstmate's own user on this Mac, by what the look read there", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    // The token is not where the look reads, as on another Mac: that Mac is
    // somewhere else, whatever address its connection reaches this Mac from.
    const elsewhere = await home({
      ssh: sshd.ssh({ remote: them.env }),
      bundle: standInBundle(record),
      ownUid: THEIR_UID,
      here: () => {
        const here = placeLocalityChallenge();
        rmSync(here.path);
        return here;
      },
    });
    const device = await addChecked(elsewhere.remote, sshd.address);
    expect(device).toMatchObject({ user: "sam", onThisMac: false });
    expect(elsewhere.pairing.list()).toEqual([expect.objectContaining({ onThisMac: false })]);

    // INF-472: its update tells the work there it runs on another Mac, so the
    // agent there starts as an app while this Mac's connection is held.
    await elsewhere.remote.update(device.id);
    expect(readFileSync(record, "utf8")).toMatch(
      new RegExp(`^started: work update .* --device ${device.id} --on-home-mac false$`, "m"),
    );
  });

  it("updates Firstmate on a Mac added by its address, and removes what it set up there", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInBundle(record);
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });
    const device = await addChecked(at.remote, sshd.address);
    at.said.splice(0);

    // Update: this Mac's Firstmate goes there again and starts as `work update`,
    // its crew paused first, before anything there stops (INF-721 friction 9).
    const startedWhenPaused: string[] = [];
    const pause = async () => {
      startedWhenPaused.push(existsSync(record) ? readFileSync(record, "utf8") : "");
    };
    expect(await at.remote.update(device.id, { pause })).toMatchObject({ id: device.id });
    expect(startedWhenPaused).toHaveLength(1);
    expect(startedWhenPaused[0]).not.toContain("work update");
    expect(at.lines()).toEqual([
      remoteLoginWords.updating(device),
      remoteLoginWords.starting(deviceLabel(device)),
      remoteLoginWords.updated(device, "running"),
    ]);
    // It is checked there to be this home's computer before anything changes,
    // and told it runs on this Mac, as the look found it when it was added.
    const expected = `--home ${at.pairing.identity().pin} --device ${device.id}`;
    expect(device.onThisMac).toBe(true);
    expect(readFileSync(record, "utf8")).toMatch(
      new RegExp(
        `^started: work update --fetched /.+/${escapeRegExp(STAND_IN_APP)} --from-home ${expected} --on-home-mac true$`,
        "m",
      ),
    );
    at.said.splice(0);

    // Remove: the copy kept there removes what Firstmate set up.
    const kept = join(them.work, "app", STAND_IN_APP);
    cpSync(bundle, kept, { recursive: true });
    expect(await at.remote.removeThere(device)).toBe(true);
    expect(at.lines()).toEqual([
      remoteLoginWords.removing(device),
      remoteLoginWords.removedThere(device, 0),
    ]);
    expect(readFileSync(record, "utf8")).toContain(
      `started: work remove --from-home ${expected}\n`,
    );
  });

  // INF-325: "Could not reach kunchen@mac-home." after the 30-minute limit
  // stopped an update; SSH exits 255 once stopped, which is not why.
  it("says the time limit stopped an update before it started there, never that it could not reach that computer", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const held = scratchDir("infinitary-held-check-");
    const ready = join(held, "ready");
    const resume = join(held, "resume");
    // That computer checks and unpacks the copy it got for longer than the limit.
    const marker = `printf "${UPDATE_STARTING}`;
    const ssh = sshd.ssh({
      remote: them.env,
      programs: {
        [marker]: `touch "${ready}"; while [ ! -f "${resume}" ]; do sleep 1; done; ${marker}`,
      },
    });
    const at = await home({ ssh, bundle: standInBundle(record) });
    const device = await addChecked(at.remote, sshd.address);
    at.said.splice(0);
    const checking = new Promise<void>((resolve) => {
      const watcher = watch(held, () => {
        if (existsSync(ready)) {
          watcher.close();
          resolve();
        }
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const updating = at.remote.update(device.id).catch((error: unknown) => error);
      await checking;
      await vi.advanceTimersByTimeAsync(REMOTE_LOGIN_TIME_LIMIT_MS);
      const refused = await updating;
      const lines = remoteLoginWords.stopped(deviceLabel(device), "update", "timeout");
      expect(refused).toBeInstanceOf(RemoteLoginRefusedError);
      expect((refused as Error).message).toBe(lines.join("\n"));
      expect(at.lines().slice(-2)).toEqual([...lines]);
      expect(readFileSync(record, "utf8")).not.toContain("started: work update");
    } finally {
      vi.useRealTimers();
      writeFileSync(resume, "resume");
    }
  });

  // INF-325: setting up has the same limit, on its own SSH connection.
  it("says the time limit stopped setting it up, never that it could not reach that computer", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const held = scratchDir("infinitary-held-join-");
    const gate = {
      when: "join" as const,
      ready: join(held, "ready"),
      resume: join(held, "resume"),
    };
    const bundle = standInFirstmate(record, THEIR_UID, {
      joined: "at-login",
      updated: "none",
      startGate: gate,
    });
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });
    const joining = new Promise<void>((resolve) => {
      const watcher = watch(held, () => {
        if (existsSync(gate.ready)) {
          watcher.close();
          resolve();
        }
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const adding = addChecked(at.remote, sshd.address).catch((error: unknown) => error);
      await joining;
      // The limit, then the wait the connection gets to end by itself.
      await vi.advanceTimersByTimeAsync(REMOTE_LOGIN_TIME_LIMIT_MS + 10_000);
      const refused = await adding;
      const lines = remoteLoginWords.stopped("Mac mini", "add", "timeout");
      expect(refused).toBeInstanceOf(RemoteLoginRefusedError);
      expect((refused as Error).message).toBe(lines.join("\n"));
      expect(at.lines().slice(-2)).toEqual([...lines]);
      expect(at.pairing.list()).toEqual([]);
    } finally {
      vi.useRealTimers();
      writeFileSync(gate.resume, "resume");
    }
  });

  it("says when it could not remove all it set up there, and that the computer tries again at its next login", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const stuck = join(them.work, "worktrees", "t-clean");
    const bundle = standInFirstmate(record, THEIR_UID, {
      joined: "at-login",
      updated: "running",
      removed: { firstmate: "removed", kept: [], unremoved: [stuck] },
    });
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });
    const device = await addChecked(at.remote, sshd.address);
    cpSync(bundle, join(them.work, "app", STAND_IN_APP), { recursive: true });
    at.said.splice(0);

    // It let the home go already, so nothing is left there for it to hear.
    expect(await at.remote.removeThere(device)).toBe(true);
    expect(at.lines()).toEqual([
      remoteLoginWords.removing(device),
      ...remoteLoginWords.notAllRemovedThere(device, 0),
    ]);
    expect(at.lines()).not.toContain(remoteLoginWords.removedThere(device, 0));
    expect(at.said.slice(-2).map((event) => [event.stage, event.tone])).toEqual([
      ["done", "warn"],
      ["done", "warn"],
    ]);
  });

  it("says nothing of this Firstmate's was there to remove when that Mac runs work for another Firstmate now", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    // The work mode there refuses another home's folder, and touches nothing.
    const bundle = standInFirstmate(record, THEIR_UID, {
      joined: "at-login",
      updated: "running",
      removed: { firstmate: "refused", reason: "other-home" },
    });
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });
    const device = await addChecked(at.remote, sshd.address);
    cpSync(bundle, join(them.work, "app", STAND_IN_APP), { recursive: true });
    at.said.splice(0);

    // Nothing of this home's is there to hear it, and nothing was removed.
    expect(await at.remote.removeThere(device)).toBe(true);
    expect(at.lines()).toEqual([
      remoteLoginWords.removing(device),
      remoteLoginWords.nothingThere(device),
    ]);
    expect(at.said.at(-1)).toMatchObject({ stage: "done", tone: "info", deviceId: device.id });
  });

  it("says when the session there refused to run it in the background, after adding and after updating", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const bundle = standInFirstmate(record, THEIR_UID, { joined: "failed", updated: "failed" });
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle });

    const device = await addChecked(at.remote, sshd.address);
    expect(at.lines()).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.settingUp("Mac mini"),
      remoteLoginWords.starting("Mac mini"),
      ...remoteLoginWords.notInBackground(device, "add"),
    ]);
    // Never the next login: no login starts what that session refused.
    expect(at.lines()).not.toContain(remoteLoginWords.atLogin(device));
    expect(at.said.slice(-2).map((event) => [event.stage, event.tone])).toEqual([
      ["done", "warn"],
      ["done", "warn"],
    ]);
    at.said.splice(0);

    await at.remote.update(device.id);
    expect(at.lines()).toEqual([
      remoteLoginWords.updating(device),
      remoteLoginWords.starting(deviceLabel(device)),
      remoteLoginWords.updated(device, "failed"),
      ...remoteLoginWords.notInBackground(device, "update"),
    ]);
    expect(at.lines()).not.toContain(remoteLoginWords.updated(device, "running"));
    expect(at.said.slice(-2).every((event) => event.tone === "warn")).toBe(true);
  });

  /** An invented password: no person's, and nothing this test may find kept anywhere. */
  const INVENTED = "invented-pw-4c1f";

  /** Every file under `dir`, as text, for a search. */
  function savedText(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return savedText(path);
      return entry.isFile() ? [readFileSync(path, "latin1")] : [];
    });
  }

  /** The folders a password run makes for its askpass; each is gone once it ends. */
  const askpassFolders = () =>
    readdirSync(tmpdir()).filter((name) => name.startsWith("infinitary-p-"));

  it("asks for that user's password once when the Mac did not let the captain's key in, lets Firstmate's own key in with it, and keeps none of it", async () => {
    const them = otherUser();
    const sshd = await startSshServer({ passwords: true, home: them.home });
    servers.push(sshd);
    sshd.knownHosts("unknown");
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const ssh = sshd.ssh({ key: "refused", password: INVENTED, remote: them.env });
    const root = scratchDir("infinitary-remote-home-");
    const dir = join(root, "Application Support", "devices");
    const at = await home({ ssh, bundle: standInBundle(record), dir });
    const placedKeys = join(them.home, ".ssh", "authorized_keys");

    const checked = await at.remote.addOrAsk(sshd.address);
    if (!("asks" in checked) || checked.asks !== "confirm") throw new Error("No check line.");
    // The captain's key is refused there: the password is asked, and nothing else happens.
    const asked = await at.remote.addOrAsk(sshd.address, { confirm: checked.line });
    expect(asked).toEqual({ asks: "password", address: sshd.address, user: userInfo().username });
    expect(at.lines()).toEqual([remoteLoginWords.reaching(sshd.address)]);
    expect(existsSync(placedKeys)).toBe(false);
    expect(existsSync(join(dir, "ssh-key"))).toBe(false);

    // A wrong one is said in the feed and asked again; nothing is placed.
    const wrong = await at.remote.addOrAsk(sshd.address, { password: "not-the-password" });
    expect(wrong).toEqual({ ...asked, wrong: true });
    expect(at.lines().slice(1)).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.lettingIn(sshd.address),
      ...remoteLoginWords.refused("password-wrong", { address: sshd.address }),
    ]);
    expect(existsSync(placedKeys)).toBe(false);

    const device = await at.remote.addOrAsk(sshd.address, { password: INVENTED });
    expect(device).toMatchObject({ kind: "work", remoteLogin: sshd.address });
    expect(at.lines().slice(5)).toEqual([
      remoteLoginWords.reaching(sshd.address),
      remoteLoginWords.lettingIn(sshd.address),
      remoteLoginWords.settingUp("Mac mini"),
      remoteLoginWords.starting("Mac mini"),
      remoteLoginWords.atLogin(device as DeviceView),
    ]);
    // Firstmate's own key, kept in its own folder, is what that Mac lets in now.
    expect(statSync(join(dir, "ssh-key")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "ssh-key", "id_ed25519")).mode & 0o777).toBe(0o600);
    const publicLine = readFileSync(join(dir, "ssh-key", "id_ed25519.pub"), "utf8").trim();
    expect(publicLine).toMatch(new RegExp(`^ssh-ed25519 \\S+ ${OWN_KEY_COMMENT}$`));
    expect(readFileSync(placedKeys, "utf8")).toBe(`${publicLine}\n`);
    expect(statSync(join(them.home, ".ssh")).mode & 0o077).toBe(0);
    expect(statSync(placedKeys).mode & 0o077).toBe(0);
    // The password was typed once, by the one run that asks: never an argument or in an environment.
    const runs = sshd.sshRuns();
    expect(runs.filter((run) => run.args.includes("PubkeyAuthentication=no"))).toHaveLength(2);
    for (const run of runs) {
      expect(run.args.join(" ")).not.toContain(INVENTED);
      expect(run.envHeldPassword).toBe(false);
    }
    // Nothing kept, said or left holds it.
    expect(savedText(root).some((text) => text.includes(INVENTED))).toBe(false);
    expect(JSON.stringify(at.said)).not.toContain(INVENTED);
    expect(JSON.stringify(at.said)).not.toContain("not-the-password");
    expect(askpassFolders()).toEqual([]);

    // A later add reaches it with Firstmate's own key, and never asks for a password.
    const sent = sshd.sshRuns().length;
    const later = await home({ ssh, bundle: standInBundle(record), dir, inReach: () => true });
    await expect(later.remote.addOrAsk(sshd.address)).rejects.toMatchObject({
      refusal: "in-reach",
    });
    expect(later.lines()[0]).toBe(remoteLoginWords.reaching(sshd.address));
    expect(
      sshd
        .sshRuns()
        .slice(sent)
        .some((run) => run.args.includes("PubkeyAuthentication=no")),
    ).toBe(false);
    expect(readFileSync(placedKeys, "utf8")).toBe(`${publicLine}\n`);
  }, 30_000);

  it("says a wrong password the Mac's own SSH typed, and that a Mac taking no password does not, with nothing kept", async () => {
    const takes = await startSshServer({ passwords: true });
    servers.push(takes);
    const record = join(scratchDir("infinitary-remote-record-"), "started");
    const root = scratchDir("infinitary-remote-home-");
    const at = await home({
      ssh: takes.ssh({ key: "refused" }),
      bundle: standInBundle(record),
      dir: join(root, "Application Support", "devices"),
    });
    await expect(addChecked(at.remote, takes.address)).rejects.toThrow("Asked password.");
    // The Mac's own SSH asks for it, and this server, as the test's own user, takes none.
    const wrong = await at.remote.addOrAsk(takes.address, { password: INVENTED });
    expect(wrong).toMatchObject({ asks: "password", wrong: true });
    expect(at.lines().slice(-3)).toEqual([
      remoteLoginWords.lettingIn(takes.address),
      ...remoteLoginWords.refused("password-wrong", { address: takes.address }),
    ]);
    expect(savedText(root).some((text) => text.includes(INVENTED))).toBe(false);
    expect(JSON.stringify(at.said)).not.toContain(INVENTED);
    expect(askpassFolders()).toEqual([]);

    // A Mac whose Remote Login lets no one in with a password says so, and asks for none.
    const keysOnly = await server();
    const none = await home({
      ssh: keysOnly.ssh({ key: "refused" }),
      bundle: standInBundle(record),
    });
    const refused = await addChecked(none.remote, keysOnly.address).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(RemoteLoginRefusedError);
    expect(refused).toMatchObject({ refusal: "password-off" });
    expect(none.lines()).toEqual([
      remoteLoginWords.reaching(keysOnly.address),
      ...remoteLoginWords.refused("password-off", { address: keysOnly.address, doing: "add" }),
    ]);
    expect(existsSync(record)).toBe(false);
  }, 30_000);

  it("types a password only to the Mac whose check line it remembers", async () => {
    const sshd = await startSshServer({ passwords: true });
    servers.push(sshd);
    const folder = join(scratchDir("infinitary-remote-trust-"), "a folder");
    mkdirSync(folder);
    const known = join(folder, "known_hosts");
    // A key unlike the Mac's own, under the name SSH looks it up by.
    execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(folder, "k")]);
    const [type = "", publicKey = ""] = readFileSync(join(folder, "k.pub"), "utf8").split(" ");
    const other = preferHostKey([{ type, publicKey }]);
    if (!other) throw new Error("No key.");
    writeFileSync(known, `${knownHostsLine(sshd.address, other)}\n`, { mode: 0o600 });
    const password = Buffer.from(INVENTED);
    const outcome = await placeOwnKey({
      ssh: sshd.ssh({ key: "refused" }),
      address: sshd.address,
      trusted: hostTrustSshOptions(known, sshd.address, other),
      methods: ["password"],
      publicLine: "ssh-ed25519 AAAA firstmate-3000",
      password,
    });
    // SSH refused the Mac before it signed in, so the askpass was never answered.
    expect(outcome).toEqual({ refusal: "host-changed" });
    expect(password.every((byte) => byte === 0)).toBe(true);
    // With no remembered check at all, nothing starts.
    const none = Buffer.from(INVENTED);
    expect(
      await placeOwnKey({
        ssh: sshd.ssh({ key: "refused" }),
        address: sshd.address,
        trusted: [],
        methods: ["password"],
        publicLine: "ssh-ed25519 AAAA firstmate-3000",
        password: none,
      }),
    ).toEqual({ refusal: "host-unknown" });
    expect(none.every((byte) => byte === 0)).toBe(true);
    expect(askpassFolders()).toEqual([]);
  }, 30_000);

  it("says nothing is set up there when the copy is gone, and a copy that cannot send itself sends nothing", async () => {
    const sshd = await server();
    const them = otherUser();
    const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle: null });
    await expect(addChecked(at.remote, sshd.address)).rejects.toMatchObject({
      refusal: "cannot-send",
    });
    expect(at.lines()).toEqual([...remoteLoginWords.refused("cannot-send", { address: "" })]);
    const device = {
      id: "mini",
      kind: "work" as const,
      name: "Mac mini",
      pairedAt: 0,
      user: "sam",
      remoteLogin: sshd.address,
    };
    // Nothing is set up there, so nothing is left to hear, and nothing was removed.
    at.said.splice(0);
    expect(await at.remote.removeThere(device)).toBe(true);
    expect(at.lines()).toEqual([
      remoteLoginWords.removing(device),
      remoteLoginWords.nothingThere(device),
    ]);
  });
});

/**
 * INF-1827's accepted plan, "Join by its address" at first launch, with the
 * captain's answers (the desktop's own SSH, a port on the row, the password
 * once): this computer signs in to the other over the person's own SSH and
 * runs the one fixed command there, which asks the Infinitary open there
 * for a computer link at its door. The other computer is a real door over
 * real pairing in its own data folder, which each SSH session there is
 * handed as that account's own settings would.
 */
describe.runIf(SSH_SERVER_AVAILABLE)("asking a computer for a link by its address", () => {
  /** The other computer's open Infinitary: its pairing and its door, in a data folder of its own. */
  async function farHome() {
    const data = join(scratchDir("infinitary-far-home-"), "data");
    const pairing = new DevicePairing({ dir: join(data, "devices"), interfaces: () => ({}) });
    pairings.push(pairing);
    const door = await PhoneDoor.open({
      dir: join(data, PHONE_DOOR_FOLDER),
      invite: (phone) => pairing.invite({ kind: "mac", ...(phone ? { phone } : {}) }),
      listening: async () => {},
    });
    doors.push(door);
    return { data, pairing };
  }

  it("checks the key line first, then answers that computer's link with the host it reached, saying nothing in the feed", async () => {
    const sshd = await server();
    const far = await farHome();
    const at = await home({
      ssh: sshd.ssh({ remote: { INFINITARY_USER_DATA_DIR: far.data } }),
      bundle: null,
    });
    const asked = await at.remote.linkAt(sshd.address);
    if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
    expect(asked.address).toBe(sshd.address);
    const answer = await at.remote.linkAt(sshd.address, { confirm: asked.line });
    if (!("link" in answer)) throw new Error(`No link: ${JSON.stringify(answer)}`);
    const link = parsePairingLink(answer.link);
    expect(link).toMatchObject({ kind: "mac", key: far.pairing.identity().pin });
    expect(answer.host).toBe("127.0.0.1");
    // The yes is kept by its address; the next ask goes straight to the link.
    expect(at.pairing.rememberedHost(sshd.address)).toMatchObject({ line: asked.line });
    const again = await at.remote.linkAt(sshd.address);
    expect("link" in again && parsePairingLink(again.link).code).not.toBe(link.code);
    expect(at.said).toEqual([]);
  });

  it("reaches the port typed beside the address, and keeps the key line under that address", async () => {
    const sshd = await server();
    const far = await farHome();
    // The person's own SSH settings name no port that answers: only the typed one does.
    const at = await home({
      ssh: sshd.ssh({ port: 1, remote: { INFINITARY_USER_DATA_DIR: far.data } }),
      bundle: null,
    });
    const address = addressAtPort(sshd.address, String(sshd.port));
    if (!address) throw new Error("No address at the port.");
    expect(address).toBe(`ssh://${sshd.address}:${sshd.port}`);
    const asked = await at.remote.linkAt(address);
    if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
    const answer = await at.remote.linkAt(address, { confirm: asked.line });
    expect("link" in answer && parsePairingLink(answer.link).key).toBe(far.pairing.identity().pin);
    expect(at.pairing.rememberedHost(address)).toMatchObject({ line: asked.line });
    expect(at.pairing.rememberedHost(sshd.address)).toBeNull();
    // Without the port, the person's own settings name one where nothing listens.
    expect(await at.remote.linkAt(sshd.address)).toEqual({ refused: "remote-login-off" });
  });

  it("says Infinitary is not open there, and refuses a link this computer made for itself", async () => {
    const sshd = await server();
    const empty = join(scratchDir("infinitary-far-home-"), "data");
    const closed = await home({
      ssh: sshd.ssh({ remote: { INFINITARY_USER_DATA_DIR: empty, HOME: dirname(empty) } }),
      bundle: null,
    });
    const asked = await closed.remote.linkAt(sshd.address);
    if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
    expect(await closed.remote.linkAt(sshd.address, { confirm: asked.line })).toEqual({
      refused: "not-open",
    });

    // Over SSH to its own account, the door that answers is this computer's own.
    const own = join(scratchDir("infinitary-own-home-"), "data");
    const self = await home({
      ssh: sshd.ssh({ remote: { INFINITARY_USER_DATA_DIR: own } }),
      bundle: null,
      dir: join(own, "devices"),
    });
    doors.push(
      await PhoneDoor.open({
        dir: join(own, PHONE_DOOR_FOLDER),
        invite: () => self.pairing.invite({ kind: "mac" }),
        listening: async () => {},
      }),
    );
    const line = await self.remote.linkAt(sshd.address);
    if (!("asks" in line) || line.asks !== "confirm") throw new Error("No key line.");
    expect(await self.remote.linkAt(sshd.address, { confirm: line.line })).toEqual({
      refused: "self",
    });
  });

  it("asks that account's password once when it refuses the key, lets Infinitary's own key in, and keeps none of it", async () => {
    const INVENTED = "invented-pw-77aa";
    const them = otherUser();
    const sshd = await startSshServer({ passwords: true, home: them.home });
    servers.push(sshd);
    const far = await farHome();
    const root = scratchDir("infinitary-remote-home-");
    const at = await home({
      ssh: sshd.ssh({
        key: "refused",
        password: INVENTED,
        remote: { ...them.env, INFINITARY_USER_DATA_DIR: far.data },
      }),
      bundle: null,
      dir: join(root, "Application Support", "devices"),
    });
    const checked = await at.remote.linkAt(sshd.address);
    if (!("asks" in checked) || checked.asks !== "confirm") throw new Error("No key line.");
    const asked = await at.remote.linkAt(sshd.address, { confirm: checked.line });
    expect(asked).toEqual({ asks: "password", address: sshd.address, user: userInfo().username });
    expect(await at.remote.linkAt(sshd.address, { password: "not-the-password" })).toEqual({
      ...asked,
      wrong: true,
    });
    const answer = await at.remote.linkAt(sshd.address, { password: INVENTED });
    expect("link" in answer && parsePairingLink(answer.link).key).toBe(far.pairing.identity().pin);
    expect(readFileSync(join(them.home, ".ssh", "authorized_keys"), "utf8")).toMatch(
      new RegExp(`^ssh-ed25519 \\S+ ${OWN_KEY_COMMENT}\n$`),
    );
    for (const run of sshd.sshRuns()) {
      expect(run.args.join(" ")).not.toContain(INVENTED);
      expect(run.envHeldPassword).toBe(false);
    }
    expect(at.said).toEqual([]);
  }, 30_000);
});

describe.runIf(SSH_SERVER_AVAILABLE)("adding an Ubuntu computer by its address", () => {
  /** What `loginctl` says where systemd is not PID 1, as on INF-1194's Ubuntu 24.04 container. */
  const NO_SYSTEMD = [
    "System has not been booted with systemd as init system (PID 1). Can't operate.",
    "Failed to connect to bus: Host is down",
  ];

  /**
   * An Ubuntu 24.04 computer on x64 with no Infinitary, whose account may
   * install with no password: a folder first on its search path with its
   * `uname`, `dpkg-query`, `sudo` (which runs what it is given as this user,
   * as root would), `apt-get` and `loginctl`, each writing down what it was
   * asked, and its `/etc/os-release`. Where systemd does not run, `loginctl`
   * says so and fails. The package's program is the stand-in Firstmate.
   */
  function ubuntu(record: string, linger: "on" | "no-systemd") {
    const bin = scratchDir("infinitary-ubuntu-bin-");
    const tool = (name: string, lines: readonly string[]) =>
      writeFileSync(join(bin, name), ["#!/bin/sh", ...lines, ""].join("\n"), { mode: 0o755 });
    const asked = (name: string) => shellWord(join(record, name));
    tool("uname", ['case "$1" in -m) echo x86_64;; -n) echo ubuntu-box;; *) echo Linux;; esac']);
    tool("dpkg-query", ["exit 1"]);
    tool("sudo", [
      `printf '%s\\n' "$*" >> ${asked("sudo")}`,
      'if [ "$1 $2" = "-n true" ]; then exit 0; fi',
      'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done',
      "shift",
      'SUDO_USER="$(id -un)"; export SUDO_USER',
      'exec "$@"',
    ]);
    tool("apt-get", [
      `printf '%s\\n' "$*" >> ${asked("apt-get")}`,
      'for f in "$@"; do deb="$f"; done',
      `cp "$deb" ${asked("installed.deb")}`,
    ]);
    tool("loginctl", [
      `printf '%s\\n' "$*" >> ${asked("loginctl")}`,
      ...(linger === "no-systemd"
        ? [...NO_SYSTEMD.map((line) => `echo ${shellWord(line)} >&2`), "exit 1"]
        : []),
    ]);
    // macOS's own sha256sum checks no list quietly, as root's install does.
    if (process.platform === "darwin")
      tool("sha256sum", [
        'if [ "$1" = -c ]; then exec shasum -a 256 -c -s; fi',
        'exec shasum -a 256 "$@"',
      ]);
    const osRelease = join(bin, "os-release");
    writeFileSync(osRelease, 'ID=ubuntu\nVERSION_ID="24.04"\n');
    return { path: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, sudo: join(bin, "sudo"), osRelease };
  }

  /** A stand-in tap whose release at `version` publishes `deb` as its Ubuntu package. */
  function debRelease(deb: Buffer, version: string): string {
    const dir = scratchDir("infinitary-ubuntu-release-");
    const tag = publicTagFor(version);
    const asset = publishedAssetName(version, { system: "linux", chip: "x64", kind: "deb" });
    if (!tag || !asset) throw new Error("The fixture version is not publishable.");
    mkdirSync(join(dir, tag));
    writeFileSync(join(dir, BUILDS_FILE), JSON.stringify({ schemaVersion: 1, channels: {} }));
    writeFileSync(join(dir, tag, asset), deb);
    const sha256 = createHash("sha256").update(deb).digest("hex");
    writeFileSync(join(dir, tag, `${asset}.sha256`), `${sha256}  ${asset}\n`);
    return dir;
  }

  // INF-1240, from INF-1194's live run: on Ubuntu 24.04 with no systemd running, apt had
  // installed the package when linger failed, and the add said nothing changed there.
  it.each(["on", "no-systemd"] as const)(
    "installs the package, joins and updates with linger %s, naming the one sudo line only where linger could not be turned on",
    async (linger) => {
      const sshd = await server();
      const them = otherUser();
      const record = scratchDir("infinitary-ubuntu-record-");
      const program = standInProgram(standInFirstmate(join(record, "started"), THEIR_UID));
      const there = ubuntu(record, linger);
      const deb = randomBytes(64_000);
      const builds = new FarBuilds({
        own: () => null,
        chip: "arm64",
        published: new PublishedBuilds({
          version: "0.13.0",
          dir: join(scratchDir("infinitary-ubuntu-home-builds-"), "builds"),
          fetchImpl: standInTapFetch(debRelease(deb, "0.13.0")),
        }),
      });
      const ssh = sshd.ssh({
        remote: { ...them.env, PATH: there.path },
        programs: {
          "/etc/os-release": there.osRelease,
          [UBUNTU_PACKAGE_BIN]: program,
          // Root's step names sudo first, so the stand-in runs it on any shell, never the real one.
          [`${shellWord("sudo")} ${shellWord("-n")}`]: `${shellWord(there.sudo)} ${shellWord("-n")}`,
        },
      });
      const at = await home({ ssh, bundle: null, builds });

      const device = await addChecked(at.remote, sshd.address);

      expect(device).toMatchObject({ kind: "work", remoteLogin: sshd.address });
      expect(at.pairing.list()).toEqual([expect.objectContaining({ id: device.id })]);
      // apt installed the package the release published, and root's step deleted it after.
      expect(readFileSync(join(record, "installed.deb"))).toEqual(deb);
      const cache = join(them.home, ".cache");
      expect(readdirSync(cache).flatMap((folder) => readdirSync(join(cache, folder)))).toEqual([]);
      expect(readFileSync(join(record, "loginctl"), "utf8")).toContain("enable-linger");
      // The package's own program joined on the captain's yes here, asking nothing there,
      // and starts at the next login there.
      expect(readFileSync(join(record, "started"), "utf8")).toMatch(
        /^started: work join --from-home --agreed$/m,
      );
      const sudoLine =
        linger === "on" ? [] : remoteLoginWords.afterLogout(device, device.user ?? "");
      /** The last lines said, each with its stage and tone, from `first` on. */
      const lastSaid = (first: string) =>
        at.said
          .slice(at.said.findIndex((event) => event.text === first))
          .map((event) => [event.stage, event.tone, event.text]);
      expect(lastSaid(remoteLoginWords.atLogin(device))).toEqual([
        ["done", "info", remoteLoginWords.atLogin(device)],
        ...sudoLine.map((line) => ["done", "warn", line]),
      ]);
      at.said.splice(0);

      // An update installs the package again, and says the same of linger.
      await at.remote.update(device.id);
      expect(readFileSync(join(record, "apt-get"), "utf8").trim().split("\n")).toHaveLength(2);
      expect(lastSaid(remoteLoginWords.updated(device, "running"))).toEqual([
        ["done", "info", remoteLoginWords.updated(device, "running")],
        ...sudoLine.map((line) => ["done", "warn", line]),
      ]);
    },
  );
});

describe.runIf(SSH_SERVER_AVAILABLE)("a private socket the home's own SSH forwards", () => {
  /** SSH's options without its refusal to share a connection: this one is the app's own, kept private. */
  const OWN_MASTER = SSH_OPTIONS.filter(
    (option, index, all) => option !== "ControlMaster=no" && all[index + 1] !== "ControlMaster=no",
  );

  it("carries a computer's pinned connection to the home, private to its user, and nothing else", async () => {
    const sshd = await server();
    const ssh = sshd.ssh();
    // A forward the person's own SSH settings ask for, which the home's
    // connection must not open.
    const settings = ssh.args[1] ?? "";
    const unasked = await claimedPort();
    writeFileSync(
      settings,
      `${readFileSync(settings, "utf8")}  LocalForward 127.0.0.1:${unasked} 127.0.0.1:9\n`,
    );
    const at = await home({ ssh, bundle: null });
    const control = join(socketScratchDir("fm-c-"), "c");
    const socket = join(socketScratchDir("fm-r-"), "h");
    const env = hostEnv();
    delete env.SSH_ASKPASS;
    delete env.SSH_ASKPASS_REQUIRE;
    const master = spawn(
      ssh.program,
      [
        ...ssh.args,
        ...OWN_MASTER,
        "-o",
        "ControlPersist=no",
        "-M",
        "-S",
        control,
        "-N",
        "--",
        sshd.address,
      ],
      { env, stdio: ["ignore", "ignore", "pipe"] },
    );
    let said = "";
    master.stderr?.on("data", (chunk: Buffer) => {
      said += chunk.toString("utf8");
    });
    const exited = new Promise((resolve) => master.once("exit", resolve));
    /** One request on the app's own control socket, never a connection of its own. */
    const ask = (...args: string[]) =>
      new Promise<number | null>((resolve) => {
        const asked = spawn(
          "/usr/bin/ssh",
          ["-F", "/dev/null", "-S", control, "-o", "BatchMode=yes", ...args, "--", sshd.address],
          { env, stdio: "ignore" },
        );
        asked.once("exit", resolve);
      });
    const reaches = (path: string | number) =>
      new Promise<boolean>((resolve) => {
        const dialed = typeof path === "number" ? connect(path, "127.0.0.1") : connect(path);
        dialed.once("connect", () => {
          dialed.destroy();
          resolve(true);
        });
        dialed.once("error", () => resolve(false));
      });
    try {
      await vi.waitFor(() => expect(existsSync(control), said).toBe(true), { timeout: 5_000 });
      expect(await reaches(unasked)).toBe(false);
      const forward = `${socket}:127.0.0.1:${at.port}`;
      expect(await ask("-O", "forward", "-R", forward)).toBe(0);
      await vi.waitFor(() => expect(existsSync(socket)).toBe(true));
      // SSH makes it for this user alone, and a dial's route takes it.
      expect(statSync(socket).mode & 0o777).toBe(0o600);
      expect(privateSocket(socket)).toBe(true);

      const { link } = at.pairing.invite(
        { kind: "work" },
        { remoteLogin: sshd.address, via: "ssh", locality: "elsewhere" },
      );
      await at.settled();
      const grant = await claimLink(
        link,
        { kind: "work", name: "Mac mini", user: { name: "sam", uid: THEIR_UID } },
        { target: { socket } },
      );
      expect(grant.via).toBe("ssh");
      const client = await connectClient(grant, { dial: { target: { socket } } });
      expect(client.welcome).toMatchObject({ t: "welcome", takesWork: true });
      await client.close();

      // Cancelled, the socket answers nothing more. SSH answers the cancel
      // once it has sent it, before the server closes its listener.
      expect(await ask("-O", "cancel", "-R", forward)).toBe(0);
      await vi.waitFor(async () => expect(await reaches(socket)).toBe(false), { timeout: 5_000 });
      expect(await ask("-O", "exit")).toBe(0);
      await exited;
      // With its connection gone, a request on its control socket fails
      // rather than open a connection of its own.
      expect(await ask("-O", "check")).not.toBe(0);
    } finally {
      if (master.exitCode === null && master.signalCode === null) master.kill();
    }
  });
});

/** `text` as a regular expression matches it, letter for letter. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Accepted INF-322: Add and Update download on an older addressed Mac,
// report real byte observations, and send the home bundle only on failure.
// Its slowest cases add and update over SSH against a release of their own,
// and each download waits out at least one of the script's once-a-second
// counts (Mac slowest per-case fastest 5.7 s).
describe.runIf(SSH_SERVER_AVAILABLE && process.platform === "darwin")(
  "an addressed Mac downloads its own copy",
  { timeout: 30_000 },
  () => {
    async function fixture(
      paceMs = 0,
      idleTimeoutMs?: number,
      options: {
        here?: boolean;
        fetchHere?: boolean;
        realVerifier?: boolean;
        backstopMs?: number;
        gate?: { when: "update" | "join"; ready: string; resume: string };
      } = {},
    ) {
      const sshd = await server();
      const them = otherUser();
      const record = join(scratchDir("infinitary-download-record-"), "started");
      const bundle = standInFirstmate(record, THEIR_UID, {
        joined: "at-login",
        updated: "running",
        ...(options.gate ? { startGate: options.gate } : {}),
      });
      addStandInPayload(bundle, randomBytes(128_000));
      const release = await macRelease(bundle, "0.13.0", paceMs);
      const fetched: string[] = [];
      const tap = standInTapFetch(release.dir);
      const builds = new FarBuilds({
        own: () => (options.fetchHere ? null : bundle),
        chip: "arm64",
        published: new PublishedBuilds({
          version: "0.13.0",
          dir: join(them.home, "builds"),
          fetchImpl: async (input, init) => {
            fetched.push(String(input));
            return tap(input, init);
          },
        }),
      });
      const ssh = sshd.ssh({
        remote: {
          ...them.env,
          CFFIXED_USER_HOME: them.home,
          INFINITARY_LOCAL_CODESIGN_DIR: join(them.home, "unused-signing"),
          TMPDIR: them.home,
          CURL_CA_BUNDLE: release.cert,
        },
        downloads: release.downloads,
        programs: options.realVerifier ? {} : release.programs,
        elsewhere: !options.here,
      });
      const at = await home({
        ssh,
        bundle,
        builds,
        idleTimeoutMs,
        sendTimeoutMs: options.backstopMs,
      });
      return { at, release, record, fetched, address: sshd.address, ssh, them, bundle };
    }

    it("downloads, checks and starts Add and Update, with counts from the final response and no app sent here", async () => {
      const { at, release, record, fetched, address } = await fixture(60);
      try {
        const device = await addChecked(at.remote, address);
        expect(device).toMatchObject({ name: "Mac mini" });
        for (const doing of ["add", "update"] as const) {
          if (doing === "update") {
            at.said.splice(0);
            await at.remote.update(device.id);
          }
          const downloads = at.said.filter((event) => event.copy?.download);
          const counts = downloads.map((event) => event.copy?.download?.received ?? -1);
          expect(
            downloads.every(
              (event) =>
                (event.copy?.download?.received ?? 0) > 0 ||
                event.copy?.download?.total !== undefined,
            ),
          ).toBe(true);
          expect(counts.at(-1)).toBe(release.size);
          expect(counts.some((count) => count > 0 && count < release.size)).toBe(true);
          expect(downloads.at(-1)?.copy?.download?.total).toBe(release.size);
          expect(new Set(downloads.map((event) => event.run?.id)).size).toBe(1);
          expect(at.sending()).toEqual([]);
        }
        expect(release.requests()).toBe(2);
        expect(fetched.some((url) => url.endsWith(".zip"))).toBe(false);
        const started = readFileSync(record, "utf8");
        expect(started).toContain("work join --fetched");
        expect(started).toContain("work update --fetched");
        for (const match of started.matchAll(/--fetched (.+?) --from-home/g))
          expect(existsSync(match[1] ?? "")).toBe(false);
      } finally {
        await release.stop();
      }
    });

    it.each([
      ["download", "fail"],
      ["checksum", "corrupt"],
    ] as const)(
      "immediately sends its counted copy on %s failure, for Add and Update",
      async (_what, failure) => {
        const { at, release, record, address } = await fixture();
        release.mode(failure);
        try {
          const device = await addChecked(at.remote, address);
          for (const doing of ["add", "update"] as const) {
            if (doing === "update") {
              at.said.splice(0);
              await at.remote.update(device.id);
            }
            expect(at.lines()).toContain(
              remoteLoginWords.downloadFallback(
                doing === "add" ? "Mac mini" : deviceLabel(device),
                failure === "corrupt",
              ),
            );
            expect(at.sending().at(-1)?.copy?.sent).toBeGreaterThan(128_000);
            expect(at.said.at(-1)?.stage).toBe("done");
          }
          // Corrupt bytes never execute; only the fallback enters each operation.
          const started = readFileSync(record, "utf8");
          expect(started.match(/started: work update /g)).toHaveLength(1);
        } finally {
          await release.stop();
        }
      },
    );

    it("reports bytes so far without inventing a total when release storage sends no size", async () => {
      const { at, release, address } = await fixture();
      release.knownSize(false);
      try {
        await addChecked(at.remote, address);
        const last = at.said.filter((event) => event.copy?.download).at(-1);
        expect(last?.copy?.download).toEqual({ received: release.size });
        expect(last?.text).toBe(remoteLoginWords.downloading("Mac mini", release.size));
        expect(last?.text).toContain("so far");
      } finally {
        await release.stop();
      }
    });

    it("does not start an update without the home's acknowledgement when its download session stops", async () => {
      const { release, record, address, ssh, them } = await fixture();
      let ready: () => void = () => {};
      const downloaded = new Promise<void>((resolve) => {
        ready = resolve;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const ran = runSsh({
          ssh,
          address,
          command: [
            "/bin/sh",
            "-c",
            MAC_DOWNLOAD_UPDATE,
            "infinitary",
            "fixture-home",
            "fixture-device",
            "false",
            release.sha256,
            release.publicUrl,
          ],
          idleTimeoutMs: 120_000,
          stdin: async (sink) => {
            await new Promise<void>((resolve) => sink.once("close", resolve));
          },
          onLine: (line) => {
            if (line === DOWNLOAD_READY) ready();
            return readDownloadCount(line) !== null;
          },
        });
        await downloaded;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(await ran).toMatchObject({ stopped: "inactive" });
        expect(existsSync(record)).toBe(false);
        vi.useRealTimers();
        await expect
          .poll(() => readdirSync(them.home).filter((name) => name.startsWith("firstmate.")))
          .toEqual([]);
      } finally {
        vi.useRealTimers();
        await release.stop();
      }
    });

    it("keeps another user on this Mac on the local-copy path without a public lookup", async () => {
      const { at, release, address, fetched } = await fixture(0, undefined, { here: true });
      try {
        const device = await addChecked(at.remote, address);
        expect(device.onThisMac).toBe(true);
        await at.remote.update(device.id);
        expect(fetched).toEqual([]);
        expect(release.requests()).toBe(0);
        expect(at.sending().length).toBeGreaterThan(0);
      } finally {
        await release.stop();
      }
    });

    it.each(["invalid", "wrong-team"] as const)(
      "rejects a %s publisher signature before Add and Update and sends the local copy",
      async (signature) => {
        const { at, release, address } = await fixture();
        release.signature(signature);
        try {
          const device = await addChecked(at.remote, address);
          for (const doing of ["add", "update"] as const) {
            if (doing === "update") {
              at.said.splice(0);
              await at.remote.update(device.id);
            }
            expect(at.lines()).toContain(remoteLoginWords.downloadFallback("Mac mini", true));
            expect(at.sending().length).toBeGreaterThan(0);
          }
          expect(release.verifications()).toHaveLength(2);
        } finally {
          await release.stop();
        }
      },
    );

    // INF-344 F1/F2: preserve the production argv shape; substitute only the Apple fixture's requirement expression.
    it("the native verifier accepts an inline Apple requirement using the production invocation", () => {
      const home = scratchDir("infinitary-native-requirement-");
      const verifier = join(home, "verify-apple");
      const argsFile = join(home, "argv.json");
      writeFileSync(
        verifier,
        `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const at = args.indexOf('-R') + 1;
args[at] = args[at].replace(${JSON.stringify(RELEASE_REQUIREMENT)}, 'anchor apple');
const ran = spawnSync('/usr/bin/codesign', args, { stdio: 'inherit' });
process.exit(ran.status ?? 1);
`,
        { mode: 0o755 },
      );
      const env = hostEnv({
        HOME: home,
        CFFIXED_USER_HOME: home,
        INFINITARY_LOCAL_CODESIGN_DIR: join(home, "signing"),
      });
      const ran = spawnSync(
        "/bin/sh",
        [
          "-c",
          `B="$1"; ${VERIFY_MAC_APP.replace("/usr/bin/codesign", shellWord(verifier))}`,
          "infinitary",
          "/System/Applications/Calculator.app",
        ],
        { env, encoding: "utf8" },
      );
      expect(ran.status, ran.stderr).toBe(0);
      expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([
        "--verify",
        "--deep",
        "--strict",
        "-R",
        "=" + RELEASE_REQUIREMENT,
        "/System/Applications/Calculator.app",
      ]);
      const unsigned = standInFirstmate(join(home, "started"), THEIR_UID);
      const rejected = spawnSync(
        "/bin/sh",
        ["-c", `B="$1"; ${VERIFY_MAC_APP}`, "infinitary", unsigned],
        { env, encoding: "utf8" },
      );
      expect(rejected.status).toBe(7);
      expect(rejected.stderr).toContain("not signed");
    });

    // INF-344 F3: a held fallback fetch must not retain a failed download's observation.
    it.each(["add", "update"] as const)(
      "%s clears failed download progress while preparing the fallback build",
      async (doing) => {
        const { at, release, address } = await fixture(0, undefined, { fetchHere: true });
        const device = doing === "update" ? await addChecked(at.remote, address) : undefined;
        at.said.splice(0);
        release.mode("corrupt");
        let resume = () => {};
        let fetching = () => {};
        const prepared = new Promise<void>((resolve) => {
          fetching = resolve;
        });
        const get = vi.spyOn(PublishedBuilds.prototype, "get").mockImplementation(
          () =>
            new Promise((resolve) => {
              resume = () => resolve({ path: release.zip, sha256: release.sha256 });
              fetching();
            }),
        );
        const operation = device ? at.remote.update(device.id) : addChecked(at.remote, address);
        const settled = operation.catch((error: unknown) => error);
        try {
          await prepared;
          const fallback = at.said.find(
            (event) => event.text === remoteLoginWords.downloadFallback("Mac mini", true),
          );
          expect(fallback?.copy).toEqual({ state: "preparing" });
          expect(at.said.at(-1)?.copy).toEqual({ state: "preparing" });
          resume();
          expect(await settled).toMatchObject({ name: "Mac mini" });
        } finally {
          resume();
          await settled;
          get.mockRestore();
          await release.stop();
        }
      },
    );

    it("the native verifier rejects an unsigned downloaded bundle under a scratch HOME", async () => {
      const { at, release, address } = await fixture(0, undefined, { realVerifier: true });
      try {
        await addChecked(at.remote, address);
        expect(at.lines()).toContain(remoteLoginWords.downloadFallback("Mac mini", true));
        expect(at.sending().length).toBeGreaterThan(0);
      } finally {
        await release.stop();
      }
    });

    it("bounds the metadata lookup and keeps the local bundle available when it aborts", async () => {
      const controller = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      let requested: () => void = () => {};
      const reading = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const published = new PublishedBuilds({
        version: "0.13.0",
        dir: scratchDir("infinitary-lookup-"),
        fetchImpl: async (_input, init) => {
          expect(init?.signal).toBe(controller.signal);
          requested();
          return new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            }),
          );
        },
      });
      const bundle = standInBundle(join(scratchDir("infinitary-lookup-app-"), "started"));
      const builds = new FarBuilds({ own: () => bundle, chip: "arm64", published });
      try {
        const lookup = builds.downloadFor(MACOS, "arm64");
        await reading;
        expect(timeout).toHaveBeenCalledWith(5_000);
        controller.abort(new DOMException("Lookup timed out", "TimeoutError"));
        expect(await lookup).toBeNull();
        expect(await builds.for(MACOS, "arm64")).toEqual({ form: "bundle", path: bundle });
      } finally {
        timeout.mockRestore();
      }
    });

    it("a Linux home's fallback fetch uses the preparation backstop, not transfer inactivity", async () => {
      const { at, release, address } = await fixture(0, 120_000, { fetchHere: true });
      release.mode("fail");
      let fetched: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        fetched = resolve;
      });
      let complete: (value: { path: string; sha256: string }) => void = () => {};
      const waiting = new Promise<{ path: string; sha256: string }>((resolve) => {
        complete = resolve;
      });
      const get = vi.spyOn(PublishedBuilds.prototype, "get").mockImplementation(() => {
        fetched();
        return waiting;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let ended = false;
        const operation = addChecked(at.remote, address);
        void operation.then(
          () => {
            ended = true;
          },
          () => {
            ended = true;
          },
        );
        await started;
        await vi.advanceTimersByTimeAsync(180_000);
        expect(ended).toBe(false);
        complete({ path: release.zip, sha256: release.sha256 });
        expect(await operation).toMatchObject({ name: "Mac mini" });
      } finally {
        vi.useRealTimers();
        get.mockRestore();
        await release.stop();
      }
    });

    it("sent update scripts reject malformed archives and mismatched checksums before the start marker", async () => {
      const { release, address, ssh, record, bundle } = await fixture();
      const archive = readFileSync(release.zip);
      const tar = packApp(bundle);
      const packed = new Promise<number | null>((resolve) => tar.once("close", resolve));
      const chunks: Buffer[] = [];
      for await (const chunk of tar.stdout) chunks.push(chunk as Buffer);
      expect(await packed).toBe(0);
      const truncatedTar = Buffer.concat(chunks).subarray(0, 8);
      const truncated = archive.subarray(0, 64);
      const cases = [
        { script: MACOS.update.bundle, bytes: truncatedTar, sha256: release.sha256 },
        {
          script: MACOS.update.zip,
          bytes: truncated,
          sha256: createHash("sha256").update(truncated).digest("hex"),
        },
        { script: LINUX.update.appimage, bytes: archive, sha256: "0".repeat(64) },
      ];
      try {
        for (const each of cases) {
          if (!each.script) throw new Error("No update script.");
          const result = await runSsh({
            ssh,
            address,
            command: [
              "/bin/sh",
              "-c",
              each.script,
              "infinitary",
              "fixture-home",
              "fixture-device",
              "false",
              each.sha256,
            ],
            stdin: async (sink) => {
              sink.write(each.bytes);
            },
          });
          expect(result.code).toBe(4);
          expect(result.stdout.split("\n")).not.toContain(UPDATE_STARTING);
        }
        expect(existsSync(record)).toBe(false);
        expect(release.verifications()).toEqual([]);
      } finally {
        await release.stop();
      }
    });

    // INF-333 N2: bytes sent is not permission to announce that the app started.
    it.each(["valid", "invalid", "wrong-team"] as const)(
      "a sent zip stays before starting until its %s signature result",
      async (signature) => {
        const { at, release, address, record } = await fixture(0, undefined, { fetchHere: true });
        const device = await addChecked(at.remote, address);
        release.mode("fail");
        release.signature("hold");
        at.said.splice(0);
        const get = vi
          .spyOn(PublishedBuilds.prototype, "get")
          .mockResolvedValue({ path: release.zip, sha256: release.sha256 });
        const ready = new Promise<void>((resolve) => {
          const watcher = watch(release.dir, () => {
            if (existsSync(release.verificationReady)) {
              watcher.close();
              resolve();
            }
          });
        });
        try {
          const operation = at.remote.update(device.id).catch((error: unknown) => error);
          await ready;
          expect(at.sending().length).toBeGreaterThan(0);
          expect(at.said.filter((event) => event.copy?.state === "starting")).toEqual([]);
          release.signature(signature);
          const result = await operation;
          if (signature === "valid") {
            expect(result).toMatchObject({ id: device.id });
            expect(at.said.filter((event) => event.copy?.state === "starting")).toHaveLength(1);
            expect(readFileSync(record, "utf8")).toContain("started: work update");
          } else {
            expect(result).toBeInstanceOf(RemoteLoginRefusedError);
            expect((result as Error).message).toBe(
              remoteLoginWords
                .refused("failed", { address, name: "Mac mini", doing: "update" })
                .join("\n"),
            );
            expect(at.said.filter((event) => event.copy?.state === "starting")).toEqual([]);
            expect(readFileSync(record, "utf8")).not.toContain("started: work update");
          }
        } finally {
          release.signature("valid");
          get.mockRestore();
          await release.stop();
        }
      },
    );

    // Review F1/F2/F7: transfer inactivity is not a timer on silent start work.
    for (const mode of ["download", "send"] as const) {
      for (const when of ["join", "update"] as const) {
        it(`${mode}: lets silent ${when} work finish after the transfer deadline and says it is starting`, async () => {
          const dir = scratchDir("infinitary-start-gate-");
          const gate = { when, ready: join(dir, "ready"), resume: join(dir, "resume") };
          const { at, release, address } = await fixture(0, 120_000, {
            gate,
            here: mode === "send",
            backstopMs: 30 * 60_000,
          });
          const device = when === "update" ? await addChecked(at.remote, address) : undefined;
          const ready = new Promise<void>((resolve) => {
            const watcher = watch(dir, () => {
              if (existsSync(gate.ready)) {
                watcher.close();
                resolve();
              }
            });
          });
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          try {
            let ended = false;
            const operation = device ? at.remote.update(device.id) : addChecked(at.remote, address);
            void operation.then(
              () => {
                ended = true;
              },
              () => {
                ended = true;
              },
            );
            await ready;
            await vi.advanceTimersByTimeAsync(180_000);
            expect(ended).toBe(false);
            expect(
              at.said.filter((event) => event.copy?.state === "starting").length,
            ).toBeGreaterThan(0);
            writeFileSync(gate.resume, "resume");
            expect(await operation).toMatchObject({ name: "Mac mini" });
          } finally {
            vi.useRealTimers();
            writeFileSync(gate.resume, "resume");
            await release.stop();
          }
        });
      }
    }

    it("a lost update outcome after acknowledgement is uncertain, not an invitation to retry", async () => {
      const dir = scratchDir("infinitary-uncertain-update-");
      const gate = {
        when: "update" as const,
        ready: join(dir, "ready"),
        resume: join(dir, "resume"),
      };
      const { at, release, address, record } = await fixture(0, 120_000, {
        gate,
        backstopMs: 300_000,
      });
      const device = await addChecked(at.remote, address);
      at.said.splice(0);
      const ready = new Promise<void>((resolve) => {
        const watcher = watch(dir, () => {
          if (existsSync(gate.ready)) {
            watcher.close();
            resolve();
          }
        });
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const operation = at.remote.update(device.id).catch((error: unknown) => error);
        await ready;
        await vi.advanceTimersByTimeAsync(300_000);
        const refused = await operation;
        expect(refused).toBeInstanceOf(RemoteLoginRefusedError);
        expect((refused as Error).message).toBe(remoteLoginWords.uncertain("Mac mini").join("\n"));
        expect(at.sending()).toEqual([]);
        expect(readFileSync(record, "utf8").match(/started: work update /g)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        writeFileSync(gate.resume, "resume");
        await release.stop();
      }
    });

    it("a stalled download falls back instead of calling a reachable Mac unreachable", async () => {
      const { at, release, address } = await fixture(0, 1_500);
      release.mode("hang");
      try {
        const device = await addChecked(at.remote, address);
        expect(device.name).toBe("Mac mini");
        expect(at.lines()).toContain(remoteLoginWords.downloadFallback("Mac mini", false));
        expect(at.sending().length).toBeGreaterThan(0);
        expect(at.said.every((event) => event.stage !== "refused")).toBe(true);
        await expect.poll(() => release.active()).toBe(0);
      } finally {
        await release.stop();
      }
    });
  },
);

// INF-320: a refused input must not leave tar blocked on its full output pipe.
it("stops and reaps packing when the receiving input fails early", async () => {
  const record = join(scratchDir("infinitary-pack-stop-"), "started");
  const bundle = standInBundle(record);
  addStandInPayload(bundle, randomBytes(8_000_000));
  const packed = vi.spyOn(appArchive, "packApp");
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error("The session ended."));
    },
  });
  sink.on("error", () => {});
  try {
    await expect(sendCopy({ form: "bundle", path: bundle }, sink)).rejects.toThrow(
      "Packing Infinitary stopped",
    );
    expect(packed).toHaveBeenCalledOnce();
    const tar = packed.mock.results[0]?.value;
    if (!tar) throw new Error("No packing process was observed.");
    expect(tar.exitCode !== null || tar.signalCode !== null).toBe(true);
  } finally {
    packed.mockRestore();
  }
});

// INF-325 and INF-322: an inactivity stop outranks SSH's exit 255, and
// actual movement, not a heartbeat, renews the two-minute deadline.
it("measures inactivity since real movement and preserves the stop reason despite SSH exit 255", async () => {
  const program = join(scratchDir("infinitary-idle-ssh-"), "ssh");
  writeFileSync(
    program,
    `#!${process.execPath}
process.on('SIGTERM', () => process.exit(255));
require('node:readline').createInterface({ input: process.stdin }).on('line', line => console.log(line));
`,
    { mode: 0o755 },
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let sink: import("node:stream").Writable | undefined;
  let heard: () => void = () => {};
  const line = () =>
    new Promise<void>((resolve) => {
      heard = resolve;
    });
  try {
    const ready = line();
    const ran = runSsh({
      ssh: { program, args: [] },
      address: "fixture",
      idleTimeoutMs: 120_000,
      stdin: async (input) => {
        sink = input;
        input.write("ready\n");
        await new Promise<void>((resolve) => input.once("close", resolve));
      },
      onLine: (value) => {
        heard();
        return value === "bytes";
      },
    });
    await ready;
    await vi.advanceTimersByTimeAsync(119_000);
    const moved = line();
    sink?.write("bytes\n");
    await moved;
    await vi.advanceTimersByTimeAsync(119_000);
    const beat = line();
    sink?.write("heartbeat\n");
    await beat;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await ran).toMatchObject({ code: 255, stopped: "inactive" });
  } finally {
    vi.useRealTimers();
  }
});
