import { X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { CONNECTION_PORT } from "@shared/connection";
import { deviceRunsWork, parsePairingLink } from "@shared/devices";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { createKeyIdentity, type KeyIdentity } from "./identity";
import { DevicePairing, type DevicePairingOptions } from "./pairing";

/**
 * Pairing on its own (docs/devices.md): links, the claim, the list on disk
 * and the seam the connection reads, on a clock the test moves. The whole
 * join over TLS is src/core/connection/connection.test.ts.
 */

function manualClock() {
  let now = 5_000_000;
  const timers: { at: number; run: () => void }[] = [];
  return {
    now: () => now,
    schedule: ((ms, run) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    }) satisfies DevicePairingOptions["schedule"],
    pending: () => timers.length,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter((candidate) => candidate.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
    },
  };
}

const made: DevicePairing[] = [];
afterEach(() => {
  for (const pairing of made.splice(0)) pairing.dispose();
});

function pairingAt(
  dir = join(scratchDir("infinitary-pairing-"), "devices"),
  clock = manualClock(),
  options: Partial<DevicePairingOptions> = {},
) {
  const problems: string[] = [];
  const pairing = new DevicePairing({
    dir,
    ...clock,
    onProblem: (text) => problems.push(text),
    // No private address unless a test gives one: a link names loopback.
    interfaces: () => ({}),
    ownUid: HOME_UID,
    ...options,
  });
  made.push(pairing);
  return { pairing, dir, clock, problems };
}

/** One network interface entry, as `os.networkInterfaces()` lists it. */
const iface = (address: string, internal = false): NetworkInterfaceInfo =>
  ({
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  }) as NetworkInterfaceInfo;

/**
 * A request on a TLS socket where the device showed `device`'s key, or none,
 * dialed from `from` (another Mac's address unless a test says otherwise),
 * to this Mac at `to`, when a test says where.
 */
const shown = (
  device: KeyIdentity | null,
  from = "192.168.1.30",
  to?: { address: string; port: number },
) =>
  ({
    headers: {},
    socket: {
      remoteAddress: from,
      ...(to ? { localAddress: to.address, localPort: to.port } : {}),
      getPeerX509Certificate: () => (device ? new X509Certificate(device.cert) : undefined),
    },
  }) as unknown as IncomingMessage;

/** The home's own macOS user in these tests, and another user on the same Mac. */
const HOME_UID = 501;
const BUILDER = { name: "builder", uid: 502 };

const claimWith = (
  pairing: DevicePairing,
  link: string,
  kind = "view",
  name = "Studio Mac",
  device: KeyIdentity | null = createKeyIdentity("Firstmate device"),
  // A device that may run work says its user; a view does not. `window`:
  // Firstmate at its first launch rather than its work mode.
  options: { user?: { name: string; uid: number }; from?: string; window?: true } = {},
) =>
  pairing.claim(
    {
      code: parsePairingLink(link).code,
      kind,
      name,
      ...(kind === "work" || kind === "mac" ? { user: options.user ?? BUILDER } : {}),
      ...(options.window ? { window: true } : {}),
    },
    shown(device, options.from),
  );

describe("device pairing", () => {
  // INF-64 piece 2: first-phone discovery must track the actual invitation's lifetime.
  it("offers phone discovery only for unspent direct invitations, until Stop or expiry", () => {
    const { pairing, clock } = pairingAt();
    const seen: boolean[] = [];
    const off = pairing.subscribe(() => seen.push(pairing.phoneMayJoin()));
    expect(pairing.phoneMayJoin()).toBe(false);
    const work = pairing.invite({ kind: "work" });
    expect(pairing.phoneMayJoin()).toBe(false);
    pairing.stop(work.id);
    const remote = pairing.invite({ kind: "mac" }, { via: "ssh", remoteLogin: "test-mac.local" });
    expect(pairing.phoneMayJoin()).toBe(false);
    pairing.stop(remote.id);
    const direct = pairing.invite({ kind: "mac" });
    expect(seen.at(-1)).toBe(true);
    pairing.stop(direct.id);
    expect(seen.at(-1)).toBe(false);
    const view = pairing.invite({ kind: "view" });
    expect(seen.at(-1)).toBe(true);
    claimWith(pairing, view.link);
    expect(seen.at(-1)).toBe(false);
    pairing.invite({ kind: "mac" });
    clock.advance(10 * 60 * 1000);
    expect(seen.at(-1)).toBe(false);
    off();
  });

  it("makes a link that names this home's key, loopback by default, good for ten minutes", () => {
    const { pairing, clock } = pairingAt();
    expect(pairing.any()).toBe(false);
    const invite = pairing.invite({ kind: "view" });
    expect(invite).toMatchObject({ kind: "view", expiresAt: clock.now() + 10 * 60 * 1000 });
    expect(parsePairingLink(invite.link)).toMatchObject({
      kind: "view",
      at: `127.0.0.1:${CONNECTION_PORT}`,
      key: pairing.identity().pin,
    });
    expect(
      parsePairingLink(pairing.invite({ kind: "work", at: "mac.tail.ts.net:9" }).link),
    ).toMatchObject({ kind: "work", at: "mac.tail.ts.net:9" });
    expect(pairing.any()).toBe(true);
  });

  it("tells its listeners when a link opens and when it expires", () => {
    const { pairing, clock } = pairingAt();
    let heard = 0;
    pairing.subscribe(() => {
      heard += 1;
    });
    pairing.invite({ kind: "view" });
    expect(heard).toBe(1);
    clock.advance(10 * 60 * 1000 - 1);
    expect(pairing.any()).toBe(true);
    clock.advance(1);
    expect(heard).toBe(2);
    expect(pairing.any()).toBe(false);
  });

  it("spends a link on its first use and refuses it after, or once it expires", () => {
    const { pairing, clock } = pairingAt();
    const first = pairing.invite({ kind: "view" }).link;
    const outcome = claimWith(pairing, first);
    if (!outcome.ok) throw new Error(outcome.reason);
    expect(outcome.grant).toMatchObject({ kind: "view" });
    expect(claimWith(pairing, first)).toMatchObject({ ok: false, refused: "used" });

    const late = pairing.invite({ kind: "view" }).link;
    clock.advance(10 * 60 * 1000);
    expect(claimWith(pairing, late)).toMatchObject({ ok: false, refused: "expired" });
    expect(
      pairing.claim(
        { code: "C".repeat(43), kind: "view", name: "Studio Mac" },
        shown(createKeyIdentity("x")),
      ),
    ).toMatchObject({ ok: false, refused: "unknown" });
    expect(pairing.list()).toHaveLength(1);
  });

  it("spends a link only when used well: right kind, a key of the device's own, a body it reads", () => {
    const { pairing } = pairingAt();
    const link = pairing.invite({ kind: "work" }).link;
    expect(claimWith(pairing, link, "view")).toMatchObject({ ok: false, refused: "kind" });
    expect(claimWith(pairing, link, "work", "Mini", null)).toMatchObject({
      ok: false,
      refused: "unproven",
    });
    for (const body of [
      undefined,
      "text",
      { code: parsePairingLink(link).code, kind: "work" },
      { code: parsePairingLink(link).code, kind: "work", name: "a‮b" },
      { code: parsePairingLink(link).code, kind: "work", name: "x".repeat(65) },
      { code: parsePairingLink(link).code, kind: "work", name: "Mini", extra: true },
      // A computer that runs work must say the macOS user it runs as.
      { code: parsePairingLink(link).code, kind: "work", name: "Mini" },
      { code: parsePairingLink(link).code, kind: "work", name: "Mini", user: { name: "x" } },
      {
        code: parsePairingLink(link).code,
        kind: "work",
        name: "Mini",
        user: { name: "a b", uid: 502 },
      },
    ])
      expect(pairing.claim(body, shown(createKeyIdentity("x")))).toMatchObject({
        ok: false,
        refused: "malformed",
      });
    expect(claimWith(pairing, link, "work", "  Mini  ")).toMatchObject({
      ok: true,
      grant: { kind: "work" },
    });
    expect(pairing.list().map(({ name, kind, user }) => ({ name, kind, user }))).toEqual([
      { name: "Mini", kind: "work", user: "builder" },
    ]);
  });

  it("refuses work run as the home's own user on this Mac, and keeps the link for another user", () => {
    const interfaces = () => ({ en0: [iface("192.168.1.20")] });
    const { pairing } = pairingAt(undefined, undefined, { interfaces });
    const link = pairing.invite({ kind: "work" }).link;
    const asHome = { name: "sam", uid: HOME_UID };
    // From this Mac, by loopback or by its own address, as the home's own user.
    for (const from of ["127.0.0.1", "::ffff:127.0.0.1", "::1", "192.168.1.20"])
      expect(
        claimWith(pairing, link, "work", "MacBook Pro", undefined, { user: asHome, from }),
        from,
      ).toMatchObject({ ok: false, refused: "same-user" });
    expect(pairing.list()).toEqual([]);
    // The link was not spent: another user on this Mac joins with it.
    expect(
      claimWith(pairing, link, "work", "MacBook Pro", undefined, { from: "127.0.0.1" }),
    ).toMatchObject({ ok: true, grant: { kind: "work" } });
    expect(pairing.list()).toEqual([
      expect.objectContaining({ kind: "work", user: "builder", onThisMac: true }),
    ]);
  });

  it("joins another Mac as a Mac, by its window or its work, and a link for a Mac used on this Mac as a second app or another user", () => {
    const { pairing } = pairingAt();
    const asHome = { name: "sam", uid: HOME_UID };
    // From another Mac, at its first launch or by its work mode, as any user:
    // a Mac, which both controls and runs work.
    expect(
      claimWith(pairing, pairing.invite({ kind: "mac" }).link, "mac", "Air", undefined, {
        window: true,
        user: asHome,
      }),
    ).toMatchObject({ ok: true, grant: { kind: "mac" } });
    expect(claimWith(pairing, pairing.invite({ kind: "mac" }).link, "mac", "Mini")).toMatchObject({
      ok: true,
      grant: { kind: "mac" },
    });
    // On this Mac: Firstmate at a second app's first launch only controls,
    // whoever runs it; its work mode as another user only runs work, and as
    // the home's own user is refused, keeping the link.
    const here = { from: "127.0.0.1" } as const;
    expect(
      claimWith(pairing, pairing.invite({ kind: "mac" }).link, "mac", "Second app", undefined, {
        ...here,
        window: true,
        user: asHome,
      }),
    ).toMatchObject({ ok: true, grant: { kind: "view" } });
    const link = pairing.invite({ kind: "mac" }).link;
    expect(
      claimWith(pairing, link, "mac", "MacBook Pro", undefined, { ...here, user: asHome }),
    ).toMatchObject({ ok: false, refused: "same-user" });
    expect(claimWith(pairing, link, "mac", "MacBook Pro", undefined, here)).toMatchObject({
      ok: true,
      grant: { kind: "work" },
    });
    expect(pairing.list().map(({ name, kind, user }) => ({ name, kind, user }))).toEqual([
      { name: "Air", kind: "mac", user: "sam" },
      { name: "Mini", kind: "mac", user: "builder" },
      { name: "Second app", kind: "view", user: undefined },
      { name: "MacBook Pro", kind: "work", user: "builder" },
    ]);
    // A Mac says its user; Firstmate at its first launch takes no link for another user.
    expect(
      pairing.claim(
        {
          code: parsePairingLink(pairing.invite({ kind: "mac" }).link).code,
          kind: "mac",
          name: "X",
        },
        shown(createKeyIdentity("Firstmate device")),
      ),
    ).toMatchObject({ ok: false, refused: "malformed" });
    expect(
      claimWith(pairing, pairing.invite({ kind: "work" }).link, "work", "X", undefined, {
        window: true,
      }),
    ).toMatchObject({ ok: false, refused: "kind" });
  });

  // INF-64 piece 1: a phone joins as a view whichever link it used, so it is never under Runs on.
  it("joins a phone as a view by a link for a Mac or an older view, never as a computer that runs work", () => {
    const { pairing } = pairingAt();
    const phoneClaim = (
      link: string,
      kind: string,
      name: string,
      device = createKeyIdentity("Phone"),
    ) =>
      pairing.claim(
        { code: parsePairingLink(link).code, kind, name, system: "ios" },
        shown(device),
      );
    // Dialing from another address, as a phone on Wi-Fi does, and no user to say.
    expect(phoneClaim(pairing.invite({ kind: "mac" }).link, "mac", "Kun's iPhone")).toMatchObject({
      ok: true,
      grant: { kind: "view" },
    });
    // An older home's link for a view joins it the same way.
    expect(phoneClaim(pairing.invite({ kind: "view" }).link, "view", "iPad")).toMatchObject({
      ok: true,
      grant: { kind: "view" },
    });
    // The link for another user here is not for a phone, and stays open.
    const work = pairing.invite({ kind: "work" }).link;
    expect(phoneClaim(work, "work", "Nope")).toMatchObject({ ok: false, refused: "kind" });
    const listed = pairing.list();
    expect(listed.map(({ name, kind, system }) => ({ name, kind, system }))).toEqual([
      { name: "Kun's iPhone", kind: "view", system: "ios" },
      { name: "iPad", kind: "view", system: "ios" },
    ]);
    // So nothing a project could run on is on the list.
    expect(listed.some((device) => deviceRunsWork(device.kind))).toBe(false);
    // The same key joining twice is one entry, as for any device.
    const phone = createKeyIdentity("Phone");
    expect(phoneClaim(pairing.invite({ kind: "mac" }).link, "mac", "A", phone)).toMatchObject({
      ok: true,
    });
    expect(phoneClaim(pairing.invite({ kind: "mac" }).link, "mac", "A", phone)).toMatchObject({
      ok: false,
      refused: "paired",
    });
  });

  it("lets a phone find this Mac again with a link for a Mac, keeping it a view", () => {
    const { pairing } = pairingAt();
    const phone = createKeyIdentity("Phone");
    const joined = pairing.claim(
      {
        code: parsePairingLink(pairing.invite({ kind: "mac" }).link).code,
        kind: "mac",
        name: "iPhone",
        system: "ios",
      },
      shown(phone),
    );
    expect(joined).toMatchObject({ ok: true, grant: { kind: "view" } });
    const again = pairing.claim(
      {
        code: parsePairingLink(pairing.invite({ kind: "mac" }).link).code,
        kind: "mac",
        name: "iPhone",
        system: "ios",
        again: true,
      },
      shown(phone),
    );
    expect(again).toMatchObject({ ok: true, grant: { kind: "view" } });
    expect(pairing.list()).toEqual([expect.objectContaining({ kind: "view", system: "ios" })]);
    // A view that never said it is a phone still cannot use a link for a Mac to find it again.
    const air = createKeyIdentity("Infinitary device");
    claimWith(pairing, pairing.invite({ kind: "view" }).link, "view", "Air", air);
    expect(
      pairing.claim(
        {
          code: parsePairingLink(pairing.invite({ kind: "mac" }).link).code,
          kind: "mac",
          name: "Air",
          user: BUILDER,
          again: true,
        },
        shown(air),
      ),
    ).toMatchObject({ ok: false, refused: "kind" });
  });

  it("hands Leave from a Mac that runs work to Remove, so its work comes first, and still says it left", () => {
    const left: string[] = [];
    const handed: string[] = [];
    const { pairing } = pairingAt(undefined, undefined, {
      onLeft: (device) => left.push(device.name),
      leaveWithWork: (device) => {
        handed.push(device.name);
        return true;
      },
    });
    const air = claimWith(pairing, pairing.invite({ kind: "mac" }).link, "mac", "Air");
    const view = claimWith(pairing, pairing.invite({ kind: "view" }).link, "view", "Old Air");
    if (!air.ok || !view.ok) throw new Error("did not join");
    pairing.leave(air.grant.deviceId);
    // Remove's to finish: it stays on the list until its work is here.
    expect(handed).toEqual(["Air"]);
    expect(pairing.list().map((device) => device.name)).toEqual(["Air", "Old Air"]);
    // One that only controls is off the list at once.
    pairing.leave(view.grant.deviceId);
    expect(handed).toEqual(["Air"]);
    expect(pairing.list().map((device) => device.name)).toEqual(["Air"]);
    expect(left).toEqual(["Air", "Old Air"]);
  });

  it("keeps the kind of a computer that finds this Mac again with a link for a Mac", () => {
    const { pairing } = pairingAt();
    const mini = createKeyIdentity("Firstmate device");
    const joined = claimWith(pairing, pairing.invite({ kind: "work" }).link, "work", "Mini", mini);
    expect(joined).toMatchObject({ ok: true, grant: { kind: "work" } });
    const again = pairing.claim(
      {
        code: parsePairingLink(pairing.invite({ kind: "mac" }).link).code,
        kind: "mac",
        name: "Mini",
        user: BUILDER,
        again: true,
      },
      shown(mini),
    );
    // A Mac added before a Mac could do both gains nothing until it is added again.
    expect(again).toMatchObject({ ok: true, grant: { kind: "work" } });
    expect(pairing.list()).toEqual([expect.objectContaining({ name: "Mini", kind: "work" })]);
    // One that only controls never finds this Mac with a link for one that runs work.
    const air = createKeyIdentity("Firstmate device");
    claimWith(pairing, pairing.invite({ kind: "view" }).link, "view", "Air", air);
    expect(
      pairing.claim(
        {
          code: parsePairingLink(pairing.invite({ kind: "mac" }).link).code,
          kind: "mac",
          name: "Air",
          user: BUILDER,
          again: true,
        },
        shown(air),
      ),
    ).toMatchObject({ ok: false, refused: "kind" });
  });

  it("lets another Mac run work as any user, and a view on this Mac as the home's own", () => {
    const { pairing } = pairingAt();
    const sameNumber = { name: "sam", uid: HOME_UID };
    expect(
      claimWith(pairing, pairing.invite({ kind: "work" }).link, "work", "Mini", undefined, {
        user: sameNumber,
      }),
    ).toMatchObject({ ok: true });
    expect(
      claimWith(pairing, pairing.invite({ kind: "view" }).link, "view", "Second app", undefined, {
        from: "127.0.0.1",
      }),
    ).toMatchObject({ ok: true });
    expect(pairing.list().map(({ name, user, onThisMac }) => ({ name, user, onThisMac }))).toEqual([
      { name: "Mini", user: "sam", onThisMac: false },
      { name: "Second app", user: undefined, onThisMac: true },
    ]);
  });

  it("reads a list saved before it recorded users and where devices joined from", () => {
    const { dir } = pairingAt();
    const device = createKeyIdentity("Firstmate device");
    const saved = {
      version: 1,
      devices: [{ id: "d1", kind: "view", name: "Air", pairedAt: 1, keyPin: device.pin }],
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "devices.json"), JSON.stringify(saved));
    const again = pairingAt(dir);
    expect(again.problems).toEqual([]);
    expect(again.pairing.list()).toEqual([{ id: "d1", kind: "view", name: "Air", pairedAt: 1 }]);
    expect(again.pairing.admit(shown(device))).toEqual({ id: "d1", kind: "view" });
  });

  it("admits a device by the key it showed when it joined, as the kind the home set", () => {
    const { pairing } = pairingAt();
    const mini = createKeyIdentity("Firstmate device");
    const outcome = claimWith(pairing, pairing.invite({ kind: "work" }).link, "work", "Mini", mini);
    if (!outcome.ok) throw new Error(outcome.reason);
    const { deviceId } = outcome.grant;
    // With where it joined from, which its work hears in its welcome.
    expect(pairing.admit(shown(mini))).toEqual({ id: deviceId, kind: "work", onThisMac: false });
    expect(pairing.holds(deviceId)).toBe(true);
    expect(pairing.admit(shown(null))).toBeNull();
    expect(pairing.admit(shown(createKeyIdentity("Firstmate device")))).toBeNull();
    // One entry per key: the same key cannot join twice, so Remove always cuts it off.
    expect(
      claimWith(pairing, pairing.invite({ kind: "view" }).link, "view", "Mini again", mini),
    ).toMatchObject({ ok: false, refused: "paired" });
  });

  it("removes a device and tells its listeners before Remove returns", () => {
    const { pairing } = pairingAt();
    const device = createKeyIdentity("Firstmate device");
    const outcome = claimWith(
      pairing,
      pairing.invite({ kind: "view" }).link,
      "view",
      "Studio Mac",
      device,
    );
    if (!outcome.ok) throw new Error(outcome.reason);
    const { deviceId } = outcome.grant;
    const heldWhenTold: boolean[] = [];
    pairing.subscribe(() => heldWhenTold.push(pairing.holds(deviceId)));

    expect(pairing.remove(deviceId)).toMatchObject({ id: deviceId, name: "Studio Mac" });
    expect(heldWhenTold).toEqual([false]);
    expect(pairing.admit(shown(device))).toBeNull();
    expect(pairing.list()).toEqual([]);
    expect(() => pairing.remove(deviceId)).toThrow("No device with that id");
  });

  it("keeps the list and the key across a restart, private to this macOS user, with no code in it", () => {
    const { pairing, dir } = pairingAt();
    const link = pairing.invite({ kind: "view" }).link;
    const device = createKeyIdentity("Firstmate device");
    const outcome = claimWith(pairing, link, "view", "Studio Mac", device);
    if (!outcome.ok) throw new Error(outcome.reason);
    const { pin } = pairing.identity();

    const again = pairingAt(dir).pairing;
    expect(again.list()).toEqual(pairing.list());
    expect(again.identity().pin).toBe(pin);
    expect(again.admit(shown(device))).toMatchObject({
      id: outcome.grant.deviceId,
    });
    // A restart forgets every open link.
    expect(claimWith(again, pairing.invite({ kind: "view" }).link)).toMatchObject({
      refused: "unknown",
    });

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const file of ["devices.json", "home-key.pem", "home-cert.pem"])
      expect(statSync(join(dir, file)).mode & 0o777, file).toBe(0o600);
    const saved = readFileSync(join(dir, "devices.json"), "utf8");
    expect(saved).toContain(device.pin);
    expect(saved).not.toContain(parsePairingLink(link).code);
  });

  it("admits nobody and changes nothing when its list cannot be read", () => {
    for (const written of ["{not json", JSON.stringify({ version: 2, devices: [] })]) {
      const { pairing, dir } = pairingAt();
      const device = createKeyIdentity("Firstmate device");
      const outcome = claimWith(
        pairing,
        pairing.invite({ kind: "view" }).link,
        "view",
        "Mac",
        device,
      );
      if (!outcome.ok) throw new Error(outcome.reason);
      writeFileSync(join(dir, "devices.json"), written);

      const broken = pairingAt(dir);
      expect(broken.problems).toHaveLength(1);
      expect(broken.pairing.any()).toBe(false);
      expect(broken.pairing.admit(shown(device))).toBeNull();
      expect(broken.pairing.holds(outcome.grant.deviceId)).toBe(false);
      expect(() => broken.pairing.invite({ kind: "view" })).toThrow("cannot be read");
      expect(() => broken.pairing.remove(outcome.grant.deviceId)).toThrow("cannot be read");
      expect(readFileSync(join(dir, "devices.json"), "utf8")).toBe(written);
    }
  });

  it("closes an open link with Stop it, and leaves a used one as it was", () => {
    const { pairing } = pairingAt();
    let heard = 0;
    pairing.subscribe(() => {
      heard += 1;
    });
    const open = pairing.invite({ kind: "view" });
    pairing.stop(open.id);
    expect(heard).toBe(2);
    expect(pairing.any()).toBe(false);
    expect(claimWith(pairing, open.link)).toMatchObject({ ok: false, refused: "unknown" });

    const used = pairing.invite({ kind: "view" });
    expect(claimWith(pairing, used.link)).toMatchObject({ ok: true });
    pairing.stop(used.id);
    pairing.stop("no-such-link");
    expect(claimWith(pairing, used.link)).toMatchObject({ ok: false, refused: "used" });
    expect(pairing.list()).toHaveLength(1);
  });

  it("says who joined once the list holds it, and nothing of the link", () => {
    const joined: { name: string; listed: number }[] = [];
    const { pairing } = pairingAt(undefined, undefined, {
      onJoined: (device) => {
        expect(device).not.toHaveProperty("keyPin");
        joined.push({ name: device.name, listed: pairing.list().length });
      },
    });
    const link = pairing.invite({ kind: "view" }).link;
    expect(claimWith(pairing, link, "view", "MacBook Air")).toMatchObject({ ok: true });
    expect(claimWith(pairing, link, "view", "MacBook Air")).toMatchObject({ ok: false });
    expect(joined).toEqual([{ name: "MacBook Air", listed: 1 }]);
  });

  // INF-1156 accepted option A: phone-only preference, with every local fallback retained.
  it("prefers private addresses only for phone invitations and falls back locally", () => {
    let interfaces = { en0: [iface("192.168.1.20")], utun4: [iface("100.101.7.3")] };
    const { pairing } = pairingAt(undefined, undefined, { interfaces: () => interfaces });
    pairing.noteNetworkName("test-mac.local");
    const phone = parsePairingLink(pairing.invite({ kind: "mac", phone: true }).link);
    expect(phone.at).toBe(`100.101.7.3:${CONNECTION_PORT}`);
    expect(phone.also).toEqual([
      `test-mac.local:${CONNECTION_PORT}`,
      `192.168.1.20:${CONNECTION_PORT}`,
    ]);
    expect(parsePairingLink(pairing.invite({ kind: "mac" }).link).at).toBe(
      `test-mac.local:${CONNECTION_PORT}`,
    );
    expect(
      parsePairingLink(pairing.invite({ kind: "work", command: "another-user", phone: true }).link)
        .at,
    ).toBe(`127.0.0.1:${CONNECTION_PORT}`);
    interfaces = { en0: [iface("192.168.1.20")], utun4: [] };
    expect(parsePairingLink(pairing.invite({ kind: "mac", phone: true }).link)).toMatchObject({
      at: `test-mac.local:${CONNECTION_PORT}`,
      also: [`192.168.1.20:${CONNECTION_PORT}`],
    });
  });

  it("sends a link every address this Mac has, and no longer keeps a chosen one", () => {
    let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = {
      lo0: [iface("127.0.0.1", true)],
      bridge100: [iface("192.168.64.1")],
      en0: [iface("192.168.1.20"), { ...iface("fe80::1"), family: "IPv6", scopeid: 4 }],
      utun4: [iface("100.101.7.3")],
      en5: [iface("8.8.4.4")],
    };
    const { pairing, dir, clock } = pairingAt(undefined, undefined, {
      interfaces: () => interfaces,
    });
    expect(pairing.addresses()).toEqual({
      addresses: [
        { address: "192.168.1.20", network: "local" },
        { address: "192.168.64.1", network: "local" },
        { address: "100.101.7.3", network: "private" },
      ],
      chosen: null,
      current: "192.168.1.20",
    });
    const carried = parsePairingLink(pairing.invite({ kind: "view" }).link);
    expect(carried.at).toBe(`192.168.1.20:${CONNECTION_PORT}`);
    expect(carried.also).toEqual([
      `192.168.64.1:${CONNECTION_PORT}`,
      `100.101.7.3:${CONNECTION_PORT}`,
    ]);
    pairing.noteNetworkName("kuns-macbook-pro.local");
    const named = parsePairingLink(pairing.invite({ kind: "view" }).link);
    expect(named.at).toBe(`kuns-macbook-pro.local:${CONNECTION_PORT}`);
    expect(named.also?.[0]).toBe(`192.168.1.20:${CONNECTION_PORT}`);

    let heard = 0;
    pairing.subscribe(() => {
      heard += 1;
    });
    // The request still answers, and still refuses an address that is not this Mac's, and changes nothing.
    expect(pairing.setAddress("100.101.7.3").current).toBe("192.168.1.20");
    expect(heard).toBe(0);
    expect(pairing.address()).toBe("192.168.1.20");
    expect(existsSync(join(dir, "address.json"))).toBe(false);
    expect(() => pairing.setAddress("8.8.4.4")).toThrow("not one of this computer's own addresses");
    expect(() => pairing.setAddress("10.9.9.9")).toThrow(
      "not one of this computer's own addresses",
    );

    // A restart reads no saved choice. The first address is the one in use.
    const again = pairingAt(dir, clock, { interfaces: () => interfaces }).pairing;
    expect(again.addresses()).toMatchObject({ chosen: null, current: "192.168.1.20" });
    interfaces = { en0: [iface("192.168.1.20")] };
    expect(again.addresses()).toMatchObject({ chosen: null, current: "192.168.1.20" });
    expect(again.setAddress(null)).toMatchObject({ chosen: null, current: "192.168.1.20" });
    interfaces = {};
    expect(again.addresses()).toEqual({ addresses: [], chosen: null, current: null });
    expect(parsePairingLink(again.invite({ kind: "view" }).link).at).toBe(
      `127.0.0.1:${CONNECTION_PORT}`,
    );
  });

  it("follows this Mac's network, and tells its listeners once a move has held", () => {
    let interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = { en0: [iface("192.168.65.2")] };
    const { pairing, clock } = pairingAt(undefined, undefined, { interfaces: () => interfaces });
    const heard: (string | null)[] = [];
    pairing.subscribe(() => heard.push(pairing.addresses().current));
    const look = () => clock.advance(5_000);
    const stop = pairing.followNetwork();
    look();
    look();
    expect(heard).toEqual([]);

    // This Mac moves to another network: told once two looks agree, and only once.
    interfaces = { en0: [iface("192.168.65.77")] };
    look();
    expect(heard).toEqual([]);
    look();
    expect(heard).toEqual(["192.168.65.77"]);
    expect(parsePairingLink(pairing.invite({ kind: "view" }).link).at).toBe(
      `192.168.65.77:${CONNECTION_PORT}`,
    );
    heard.length = 0;
    look();
    look();
    expect(heard).toEqual([]);

    // A moment off the network while it changes Wi-Fi is no change.
    interfaces = {};
    look();
    interfaces = { en0: [iface("192.168.65.77")] };
    look();
    look();
    expect(heard).toEqual([]);
    // Off it for longer, it is told: a link then names loopback.
    interfaces = {};
    look();
    look();
    expect(heard).toEqual([null]);

    // A new address beside the one in use is told too, so Devices can offer it;
    // the captain's choice of it is told once, by the choice.
    interfaces = { en0: [iface("192.168.65.77")], utun4: [iface("100.101.7.3")] };
    look();
    look();
    pairing.setAddress("100.101.7.3");
    look();
    look();
    expect(heard).toEqual([null, "192.168.65.77"]);

    // Following again replaces the look; stopped, or disposed, nothing looks.
    pairing.followNetwork();
    expect(clock.pending()).toBe(2);
    stop();
    expect(clock.pending()).toBe(2);
    pairing.dispose();
    expect(clock.pending()).toBe(0);
  });

  it("sends the command for another user on this Mac to loopback, whatever this Mac's address", () => {
    const { pairing } = pairingAt(undefined, undefined, {
      interfaces: () => ({ en0: [iface("192.168.1.20")] }),
    });
    const at = (request: Parameters<DevicePairing["invite"]>[0]) =>
      parsePairingLink(pairing.invite(request).link).at;
    // That user dials from this Mac itself, where loopback answers on every network.
    expect(at({ kind: "work", command: "another-user" })).toBe(`127.0.0.1:${CONNECTION_PORT}`);
    // Another Mac, a Mac reached over Remote Login and a view dial this Mac's address.
    expect(at({ kind: "work", command: "another-mac" })).toBe(`192.168.1.20:${CONNECTION_PORT}`);
    expect(at({ kind: "work" })).toBe(`192.168.1.20:${CONNECTION_PORT}`);
    expect(at({ kind: "view" })).toBe(`192.168.1.20:${CONNECTION_PORT}`);
  });

  it("lets a command read an open work link to get Firstmate, without spending it", () => {
    const { pairing, clock } = pairingAt();
    const work = pairing.invite({ kind: "work" });
    const code = parsePairingLink(work.link).code;
    expect(pairing.opened({ code })).toBeNull();
    expect(pairing.opened({ code })).toBeNull();
    expect(
      pairing.opened({ code: parsePairingLink(pairing.invite({ kind: "view" }).link).code }),
    ).toBe("kind");
    expect(pairing.opened({ code: "C".repeat(43) })).toBe("unknown");
    expect(pairing.opened({ code: 7 })).toBe("malformed");
    // Read twice, it still joins once.
    expect(claimWith(pairing, work.link, "work", "Mac mini")).toMatchObject({ ok: true });
    expect(pairing.opened({ code })).toBe("used");
    const late = pairing.invite({ kind: "work" });
    clock.advance(10 * 60 * 1000);
    expect(pairing.opened({ code: parsePairingLink(late.link).code })).toBe("expired");
  });

  it("lets a computer that runs work on its list get Firstmate by its own key to update, and nobody else", () => {
    const { pairing } = pairingAt();
    const mini = createKeyIdentity("Firstmate device");
    expect(
      claimWith(pairing, pairing.invite({ kind: "work" }).link, "work", "Mac mini", mini),
    ).toMatchObject({ ok: true });
    const air = createKeyIdentity("Firstmate device");
    expect(
      claimWith(pairing, pairing.invite({ kind: "view" }).link, "view", "MacBook Air", air),
    ).toMatchObject({ ok: true });
    expect(pairing.opened({}, shown(mini))).toBeNull();
    // A Mac that controls this Firstmate runs no work to update.
    expect(pairing.opened({}, shown(air))).toBe("kind");
    // A key the list does not hold, or none, gets nothing.
    expect(pairing.opened({}, shown(createKeyIdentity("Firstmate device")))).toBe("unknown");
    expect(pairing.opened({}, shown(null))).toBe("unknown");
    expect(pairing.opened({})).toBe("unknown");
    // Removed, it gets nothing either.
    const [listed] = pairing.list().filter((device) => device.kind === "work");
    pairing.remove(listed?.id ?? "");
    expect(pairing.opened({}, shown(mini))).toBe("unknown");
  });

  it("keeps when each device was last seen, and which wait to be removed, beside the list", () => {
    const { pairing, dir, clock } = pairingAt();
    const link = pairing.invite({ kind: "work" }).link;
    const joined = claimWith(pairing, link, "work", "Mac mini");
    if (!joined.ok) throw new Error(joined.reason);
    const id = joined.grant.deviceId;
    let heard = 0;
    pairing.subscribe(() => {
      heard += 1;
    });
    pairing.seen(id, 7_000_000);
    pairing.seen("not-on-the-list", 7_000_000);
    pairing.removeWhenBack(id, true);
    expect(heard).toBe(1);
    expect(statSync(join(dir, "seen.json")).mode & 0o777).toBe(0o600);
    // The list an older app reads is the list it knows.
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")).devices[0]),
    ).toEqual(["id", "kind", "name", "pairedAt", "user", "onThisMac", "keyPin"]);

    const again = pairingAt(dir, clock).pairing;
    expect(again.lastSeen(id)).toBe(7_000_000);
    expect(again.lastSeen("not-on-the-list")).toBeUndefined();
    expect(again.removingWhenBack(id)).toBe(true);
    again.removeWhenBack(id, false);
    expect(pairingAt(dir, clock).pairing.removingWhenBack(id)).toBe(false);
    again.removeWhenBack(id, true);
    again.remove(id);
    const after = pairingAt(dir, clock).pairing;
    expect(after.lastSeen(id)).toBeUndefined();
    expect(after.removingWhenBack(id)).toBe(false);
    expect(() => after.removeWhenBack(id, true)).toThrow("No device with that id");
  });

  it("keeps what each device said it is beside the list, where an older app never reads it", () => {
    const { pairing, dir, clock, problems } = pairingAt();
    const link = pairing.invite({ kind: "work" }).link;
    const joined = claimWith(pairing, link, "work", "Studio", undefined, { user: BUILDER });
    if (!joined.ok) throw new Error(joined.reason);
    const id = joined.grant.deviceId;
    // Before its first hello the list says nothing of what it is.
    expect(pairing.list()[0]).not.toHaveProperty("system");
    let heard = 0;
    pairing.subscribe(() => {
      heard += 1;
    });
    pairing.noteSystem(id, { system: "linux", chip: "x64" });
    pairing.noteSystem(id, { system: "linux", chip: "x64" });
    pairing.noteSystem("not-on-the-list", { system: "macos" });
    expect(heard).toBe(1);
    expect(pairing.list()[0]).toMatchObject({ id, system: "linux", chip: "x64" });
    expect(statSync(join(dir, "systems.json")).mode & 0o777).toBe(0o600);
    // The list an older app reads is the list it knows.
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")).devices[0]),
    ).toEqual(["id", "kind", "name", "pairedAt", "user", "onThisMac", "keyPin"]);

    // A later hello that says only a chip keeps the system it said before.
    const again = pairingAt(dir, clock).pairing;
    expect(again.list()[0]).toMatchObject({ system: "linux", chip: "x64" });
    again.noteSystem(id, { chip: "arm64" });
    expect(pairingAt(dir, clock).pairing.list()[0]).toMatchObject({
      system: "linux",
      chip: "arm64",
    });
    again.remove(id);
    expect(JSON.parse(readFileSync(join(dir, "systems.json"), "utf8")).devices).toEqual({});
    expect(problems).toEqual([]);
  });

  it("names every device a computer when what each one is cannot be read, and never writes over it", () => {
    const { pairing, dir, clock } = pairingAt();
    const joined = claimWith(pairing, pairing.invite({ kind: "mac" }).link, "mac", "Laptop");
    if (!joined.ok) throw new Error(joined.reason);
    writeFileSync(join(dir, "systems.json"), "{ not json");
    const { pairing: again, problems } = pairingAt(dir, clock);
    expect(problems).toEqual([
      "What each device is cannot be read; Devices names each one a computer.",
    ]);
    again.noteSystem(joined.grant.deviceId, { system: "ios" });
    expect(again.list()[0]).not.toHaveProperty("system");
    expect(readFileSync(join(dir, "systems.json"), "utf8")).toBe("{ not json");
  });

  it("keeps the address a Mac was added at over Remote Login beside the list, and which device used its link", () => {
    const heard: (string | undefined)[] = [];
    const { pairing, dir, clock } = pairingAt(undefined, undefined, {
      onJoined: (device) => heard.push(device.remoteLogin),
    });
    const invite = pairing.invite({ kind: "work" }, { remoteLogin: "sam@mini.local" });
    expect(pairing.claimedBy(invite.id)).toBeUndefined();
    const joined = claimWith(pairing, invite.link, "work", "Mac mini", undefined, {
      from: "192.168.1.30",
    });
    if (!joined.ok) throw new Error(joined.reason);
    const id = joined.grant.deviceId;
    expect(pairing.claimedBy(invite.id)).toBe(id);
    expect(pairing.list()).toEqual([
      expect.objectContaining({ id, remoteLogin: "sam@mini.local" }),
    ]);
    // A link made any other way names no address.
    const plain = claimWith(pairing, pairing.invite({ kind: "work" }).link, "work", "iMac");
    if (!plain.ok) throw new Error(plain.reason);
    expect(pairing.list()[1]).not.toHaveProperty("remoteLogin");
    // The joined line hears where it was added.
    expect(heard).toEqual(["sam@mini.local", undefined]);
    // Beside the list, private, with how the device reaches this Mac: its own
    // dial to this Mac's address, since the link said nothing else.
    expect(statSync(join(dir, "ssh.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, "ssh.json"), "utf8"))).toEqual({
      version: 1,
      devices: { [id]: { address: "sam@mini.local", connection: "network" } },
    });
    expect(pairing.sshConnections()).toEqual([]);
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")).devices[0]),
    ).toEqual(["id", "kind", "name", "pairedAt", "user", "onThisMac", "keyPin"]);
    const again = pairingAt(dir, clock).pairing;
    expect(again.list()[0]?.remoteLogin).toBe("sam@mini.local");
    // Removed, it is forgotten with the device.
    expect(again.remove(id).remoteLogin).toBe("sam@mini.local");
    expect(
      pairingAt(dir, clock)
        .pairing.list()
        .map((device) => device.remoteLogin),
    ).toEqual([undefined]);
  });

  it("reads where a computer joins from off its link when the home found it over SSH, never off its socket", () => {
    const { pairing } = pairingAt();
    // Found to be another Mac, it joins with the home's own user number,
    // though a forwarded connection reaches this Mac from loopback.
    const elsewhere = pairing.invite(
      { kind: "work" },
      { remoteLogin: "sam@mini.local", locality: "elsewhere" },
    );
    const mini = claimWith(pairing, elsewhere.link, "work", "Mac mini", undefined, {
      user: { name: "sam", uid: HOME_UID },
      from: "127.0.0.1",
    });
    expect(mini).toMatchObject({ ok: true });
    // Found to be this Mac, the home's own user is refused wherever its
    // socket says it dialed from, and the link stays good for another user.
    const here = pairing.invite(
      { kind: "work" },
      { remoteLogin: "builder@this-mac.local", locality: "this-mac" },
    );
    expect(
      claimWith(pairing, here.link, "work", "This computer", undefined, {
        user: { name: "me", uid: HOME_UID },
        from: "192.168.1.30",
      }),
    ).toMatchObject({ ok: false, refused: "same-user" });
    expect(claimWith(pairing, here.link, "work", "Builder")).toMatchObject({ ok: true });
    expect(pairing.list().map(({ name, onThisMac }) => ({ name, onThisMac }))).toEqual([
      { name: "Mac mini", onThisMac: false },
      { name: "Builder", onThisMac: true },
    ]);
  });

  it("makes a link that reaches this Mac only through its own SSH connection, and keeps that with the computer", () => {
    const { pairing, dir, clock, problems } = pairingAt(undefined, undefined, {
      // This Mac has a private address; the link names loopback all the same.
      interfaces: () => ({ en0: [iface("192.168.1.20")] }),
    });
    const invite = pairing.invite(
      { kind: "work" },
      { remoteLogin: "sam@mini.local", via: "ssh", locality: "elsewhere" },
    );
    expect(parsePairingLink(invite.link)).toMatchObject({
      kind: "work",
      at: `127.0.0.1:${CONNECTION_PORT}`,
      via: "ssh",
    });
    // Only a computer that runs work, added by its address, reaches it that way.
    expect(() => pairing.invite({ kind: "work" }, { via: "ssh" })).toThrow(
      "Only a computer that runs work",
    );
    expect(() =>
      pairing.invite({ kind: "view" }, { remoteLogin: "sam@mini.local", via: "ssh" }),
    ).toThrow("Only a computer that runs work");
    const key = createKeyIdentity("Firstmate device");
    const joined = claimWith(pairing, invite.link, "work", "Mac mini", key, { from: "127.0.0.1" });
    if (!joined.ok) throw new Error(joined.reason);
    const id = joined.grant.deviceId;
    expect(pairing.list()).toEqual([
      expect.objectContaining({ id, remoteLogin: "sam@mini.local", onThisMac: false }),
    ]);
    expect(pairing.sshConnections()).toEqual([{ deviceId: id, address: "sam@mini.local" }]);
    expect(JSON.parse(readFileSync(join(dir, "ssh.json"), "utf8")).devices[id]).toEqual({
      address: "sam@mini.local",
      connection: "ssh",
    });
    // Its connection follows this Mac wherever it listens: a new port, or a
    // new address, is never an address it still looks for.
    pairing.admit(shown(key, "127.0.0.1", { address: "127.0.0.1", port: 47_000 }));
    expect(pairing.addressChanged(id, ["127.0.0.1:47001", "192.168.1.40:47001"])).toBe(false);
    // Kept across a restart.
    expect(pairingAt(dir, clock).pairing.sshConnections()).toEqual([
      { deviceId: id, address: "sam@mini.local" },
    ]);
    // Removed, it is forgotten with the device.
    pairing.remove(id);
    expect(pairing.sshConnections()).toEqual([]);
    expect(pairingAt(dir, clock).pairing.sshConnections()).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("keeps a computer on the list, out of reach, when how this Mac reaches it over SSH cannot be read", () => {
    const { pairing, dir, clock } = pairingAt();
    const invite = pairing.invite(
      { kind: "work" },
      { remoteLogin: "sam@mini.local", via: "ssh", locality: "elsewhere" },
    );
    const joined = claimWith(pairing, invite.link, "work", "Mac mini");
    if (!joined.ok) throw new Error(joined.reason);
    const id = joined.grant.deviceId;
    writeFileSync(join(dir, "ssh.json"), "{ not json");
    const unreadable = pairingAt(dir, clock);
    // Not reached over SSH, and never off the list or a new identity.
    expect(unreadable.pairing.sshConnections()).toEqual([]);
    expect(unreadable.pairing.holds(id)).toBe(true);
    expect(unreadable.pairing.list()).toEqual([
      expect.objectContaining({ id, name: "Mac mini", onThisMac: false }),
    ]);
    // And never written over, so a captain who mends the file finds it all there.
    const later = unreadable.pairing.invite({ kind: "work" }, { remoteLogin: "ann@studio.local" });
    expect(claimWith(unreadable.pairing, later.link, "work", "Studio")).toMatchObject({ ok: true });
    unreadable.pairing.remove(id);
    expect(readFileSync(join(dir, "ssh.json"), "utf8")).toBe("{ not json");
    expect(unreadable.problems).toEqual([
      "How this computer reaches the computers it added by their address cannot be read.",
      "How this computer reaches the computers it added by their address is kept as it was.",
    ]);
  });

  it("keeps where each device last reached this Mac, and says when this Mac's address changed since", () => {
    const { pairing, dir, clock } = pairingAt();
    const key = createKeyIdentity("Firstmate device");
    const joined = claimWith(
      pairing,
      pairing.invite({ kind: "work" }).link,
      "work",
      "Mac mini",
      key,
    );
    if (!joined.ok) throw new Error(joined.reason);
    const id = joined.grant.deviceId;
    const here = ["127.0.0.1:47000", "192.168.1.20:47000"];
    // Never in reach yet: nothing to say.
    expect(pairing.addressChanged(id, here)).toBe(false);
    // It reached this Mac where the connection listens now.
    pairing.admit(shown(key, "192.168.1.30", { address: "::ffff:192.168.1.20", port: 47_000 }));
    expect(pairing.addressChanged(id, here)).toBe(false);
    expect(statSync(join(dir, "reached.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(dir, "reached.json"), "utf8"))).toEqual({
      version: 1,
      reached: { [id]: "192.168.1.20:47000" },
    });
    // The network gave this Mac another address: it still looks for the old one.
    const moved = ["127.0.0.1:47000", "192.168.1.31:47000"];
    expect(pairing.addressChanged(id, moved)).toBe(true);
    expect(pairingAt(dir, clock).pairing.addressChanged(id, moved)).toBe(true);
    // On no network nothing from another Mac reaches this one anywhere, and
    // while the connection listens nowhere there is nothing to compare.
    expect(pairing.addressChanged(id, ["127.0.0.1:47000"])).toBe(false);
    expect(pairing.addressChanged(id, [])).toBe(false);
    // Loopback is listened on whatever this Mac's address: only its port can move.
    pairing.admit(shown(key, "127.0.0.1", { address: "127.0.0.1", port: 47_000 }));
    expect(pairing.addressChanged(id, moved)).toBe(false);
    expect(pairing.addressChanged(id, ["127.0.0.1:47001"])).toBe(true);
    // Found again where this Mac is now, it looks for it there from then on.
    const found = pairing.claim(
      {
        code: parsePairingLink(pairing.invite({ kind: "work" }).link).code,
        kind: "work",
        name: "Mac mini",
        user: BUILDER,
        again: true,
      },
      shown(key, "127.0.0.1", { address: "127.0.0.1", port: 47_001 }),
    );
    expect(found).toMatchObject({ ok: true });
    expect(pairing.addressChanged(id, ["127.0.0.1:47001"])).toBe(false);
    // The list an older app reads is the list it knows; removed, it is forgotten.
    expect(
      Object.keys(JSON.parse(readFileSync(join(dir, "devices.json"), "utf8")).devices[0]),
    ).toEqual(["id", "kind", "name", "pairedAt", "user", "onThisMac", "keyPin"]);
    pairing.remove(id);
    expect(JSON.parse(readFileSync(join(dir, "reached.json"), "utf8")).reached).toEqual({});
  });

  it("says macOS holds a computer joined from another Mac on the local network until it is first in reach", () => {
    const { pairing, dir, clock, problems } = pairingAt();
    // A computer joins from `from`, having dialed this Mac at `to`, through `link`.
    const joinAt = (
      to: string,
      from = "192.168.1.30",
      link = pairing.invite({ kind: "work" }).link,
      key = createKeyIdentity("Firstmate device"),
    ) => {
      const joined = pairing.claim(
        { code: parsePairingLink(link).code, kind: "work", name: "Mac mini", user: BUILDER },
        shown(key, from, { address: to, port: 47_000 }),
      );
      if (!joined.ok) throw new Error(joined.reason);
      return joined.grant.deviceId;
    };
    const held = joinAt("192.168.1.20");
    expect(pairing.heldOnLocalNetwork(held)).toBe(true);
    expect(pairingAt(dir, clock).pairing.heldOnLocalNetwork(held)).toBe(true);
    // A private network service's address is not the local network; this Mac's
    // own loopback is no dial macOS asks about, and another user on this Mac
    // dials it; this Mac's own SSH connection is no dial of that computer's.
    const tailnet = joinAt("100.101.7.3");
    const thisMac = joinAt("127.0.0.1", "127.0.0.1");
    const overSsh = joinAt(
      "127.0.0.1",
      "127.0.0.1",
      pairing.invite(
        { kind: "work" },
        { remoteLogin: "sam@mini.local", via: "ssh", locality: "elsewhere" },
      ).link,
    );
    for (const id of [tailnet, thisMac, overSsh])
      expect(pairing.heldOnLocalNetwork(id)).toBe(false);
    // A Mac that controls this Firstmate runs no work.
    const view = claimWith(pairing, pairing.invite({ kind: "view" }).link);
    if (!view.ok) throw new Error(view.reason);
    expect(pairing.heldOnLocalNetwork(view.grant.deviceId)).toBe(false);
    // In reach once, its work got through, and nothing holds it from then on.
    pairing.seen(held, clock.now());
    expect(pairing.heldOnLocalNetwork(held)).toBe(false);
    expect(pairingAt(dir, clock).pairing.heldOnLocalNetwork(held)).toBe(false);
    // While when each was last seen cannot be read, none reads as never in reach.
    const second = joinAt("10.0.0.20");
    expect(pairing.heldOnLocalNetwork(second)).toBe(true);
    expect(pairingAt(dir, clock).pairing.heldOnLocalNetwork(second)).toBe(true);
    writeFileSync(join(dir, "seen.json"), "{ not json");
    const unreadable = pairingAt(dir, clock);
    expect(unreadable.pairing.heldOnLocalNetwork(second)).toBe(false);
    expect(unreadable.problems).toEqual([
      "When devices were last seen cannot be read; Devices starts without it.",
    ]);
    expect(problems).toEqual([]);
  });

  it("keeps the address a computer was found again at over Remote Login", () => {
    const { pairing, dir, clock } = pairingAt();
    const key = createKeyIdentity("Firstmate device");
    const joined = claimWith(
      pairing,
      pairing.invite({ kind: "work" }).link,
      "work",
      "Mac mini",
      key,
    );
    if (!joined.ok) throw new Error(joined.reason);
    const id = joined.grant.deviceId;
    expect(pairing.list()[0]).not.toHaveProperty("remoteLogin");
    const invite = pairing.invite({ kind: "work" }, { remoteLogin: "sam@mini.local" });
    const found = pairing.claim(
      {
        code: parsePairingLink(invite.link).code,
        kind: "work",
        name: "Mac mini",
        user: BUILDER,
        again: true,
      },
      shown(key),
    );
    expect(found).toEqual({ ok: true, grant: joined.grant });
    expect(pairing.claimedBy(invite.id)).toBe(id);
    expect(pairingAt(dir, clock).pairing.list()).toEqual([
      expect.objectContaining({ id, remoteLogin: "sam@mini.local" }),
    ]);
  });

  it("listens for a computer removed while out of reach until it has heard it, three refusals or a month", () => {
    const { pairing, dir, clock } = pairingAt();
    const key = createKeyIdentity("Firstmate device");
    const joined = claimWith(
      pairing,
      pairing.invite({ kind: "work" }).link,
      "work",
      "Mac mini",
      key,
    );
    if (!joined.ok) throw new Error(joined.reason);
    clock.advance(10 * 60 * 1000);
    pairing.remove(joined.grant.deviceId, { farewell: true });
    // Nothing is paired, yet the home listens, and refuses that key.
    expect(pairing.any()).toBe(true);
    expect(pairing.admit(shown(key))).toBeNull();
    expect(pairingAt(dir, clock).pairing.any()).toBe(true);
    expect(pairing.admit(shown(key))).toBeNull();
    expect(pairing.admit(shown(key))).toBeNull();
    expect(pairing.any()).toBe(false);

    const second = createKeyIdentity("Firstmate device");
    const again = claimWith(
      pairing,
      pairing.invite({ kind: "work" }).link,
      "work",
      "Mac mini",
      second,
    );
    if (!again.ok) throw new Error(again.reason);
    clock.advance(10 * 60 * 1000);
    pairing.remove(again.grant.deviceId, { farewell: true });
    expect(pairing.any()).toBe(true);
    clock.advance(30 * 24 * 60 * 60 * 1000);
    expect(pairing.any()).toBe(false);
    // A removal it is told of at once keeps nothing.
    const third = claimWith(pairing, pairing.invite({ kind: "view" }).link);
    if (!third.ok) throw new Error(third.reason);
    clock.advance(10 * 60 * 1000);
    pairing.remove(third.grant.deviceId);
    expect(pairing.any()).toBe(false);
  });

  it("lets a device on the list find this Mac again with a new link, as it was, and tells a removed one so", () => {
    const told: { name: string; again: boolean }[] = [];
    const { pairing, dir, clock } = pairingAt(undefined, undefined, {
      onJoined: (device, _found, again) => told.push({ name: device.name, again }),
    });
    const key = createKeyIdentity("Firstmate device");
    const findAgain = (link: string, device: KeyIdentity) =>
      pairing.claim(
        {
          code: parsePairingLink(link).code,
          kind: "work",
          name: "Mac mini",
          user: BUILDER,
          again: true,
        },
        shown(device),
      );
    const joined = claimWith(
      pairing,
      pairing.invite({ kind: "work" }).link,
      "work",
      "Mac mini",
      key,
    );
    if (!joined.ok) throw new Error(joined.reason);
    const [listed] = pairing.list();
    clock.advance(60 * 60 * 1000);

    // The same key, asking again: the link is spent and the entry stays as it was.
    const link = pairing.invite({ kind: "work" }).link;
    expect(findAgain(link, key)).toEqual({ ok: true, grant: joined.grant });
    expect(pairing.list()).toEqual([listed]);
    expect(claimWith(pairing, link, "work")).toMatchObject({ ok: false, refused: "used" });
    expect(told).toEqual([
      { name: "Mac mini", again: false },
      { name: "Mac mini", again: true },
    ]);
    // Without asking again, a key on the list is still one entry.
    expect(
      claimWith(pairing, pairing.invite({ kind: "work" }).link, "work", "Mac mini", key),
    ).toMatchObject({
      ok: false,
      refused: "paired",
    });

    // Removed while out of reach: the key hears it, the link stays open, and
    // the home stops listening for it.
    pairing.remove(joined.grant.deviceId, { farewell: true });
    expect(pairingAt(dir, clock).pairing.any()).toBe(true);
    const next = pairing.invite({ kind: "work" }).link;
    expect(findAgain(next, key)).toMatchObject({ ok: false, refused: "removed" });
    expect(pairingAt(dir, clock).pairing.any()).toBe(false);
    expect(pairing.list()).toEqual([]);
    const anew = claimWith(pairing, next, "work", "Mac mini");
    expect(anew).toMatchObject({ ok: true });
    expect(told.at(-1)).toEqual({ name: "Mac mini", again: false });
    // A key that was never on the list hears the same.
    expect(
      findAgain(pairing.invite({ kind: "work" }).link, createKeyIdentity("Firstmate device")),
    ).toMatchObject({ ok: false, refused: "removed" });
  });
});
