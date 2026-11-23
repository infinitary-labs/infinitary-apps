import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PHONE_DOOR_FOLDER } from "@shared/phoneLink";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeEach,
  doors,
  home,
  otherUser,
  pairings,
  server,
  standInBundle,
  THEIR_UID,
} from "../../../tests/helpers/remoteLoginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE } from "../../../tests/helpers/sshServer";
import { STAND_IN_APP, standInFirstmate } from "../../../tests/helpers/standInFirstmate";
import type { FarBuilds } from "./farBuilds";
import { type HomeReach, homeAt } from "./homeAt";
import { DevicePairing } from "./pairing";
import { PhoneDoor } from "./phoneDoor";
import type { DeviceSetupEvent, Look } from "./remoteLogin";
import type { SshProgram } from "./ssh";

/**
 * INF-6207's approved plan, part 2: the welcome screen's Another computer
 * sets the first mate up on that computer over SSH - its key line first,
 * the person's own SSH, its system, the copy kept in that account's
 * Applications folder, then the copy's own `start-at-boot`. The other
 * computer is a real SSH server on loopback with an account folder of its
 * own, and the copy is the stand-in Firstmate, which writes down how it was
 * started.
 */

// Real processes: sshd, ssh and tar (docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 15_000 });

afterEach(closeEach);

/** A Linux computer starts the first mate at every restart only with systemd. */
const SYSTEMD = process.platform !== "linux" || existsSync("/run/systemd/system");

async function setUp(boot = 0, hears?: (event: DeviceSetupEvent) => void) {
  const sshd = await server();
  const them = otherUser();
  const record = join(scratchDir("infinitary-home-record-"), "started");
  const bundle =
    boot === 0
      ? standInBundle(record)
      : standInFirstmate(record, THEIR_UID, { joined: "at-login", updated: "running", boot });
  const at = await home({
    ssh: sshd.ssh({ remote: them.env }),
    bundle,
    ...(hears ? { hears } : {}),
  });
  return { sshd, them, record, at };
}

describe.runIf(SSH_SERVER_AVAILABLE && SYSTEMD)(
  "setting the first mate up on another computer",
  () => {
    it("asks the key line first, then keeps the copy in that account's Applications and starts it at boot", async () => {
      const { sshd, them, record, at } = await setUp();
      const asked = await at.remote.homeAt(sshd.address);
      if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
      // Nothing reached that account before the yes.
      expect(existsSync(record)).toBe(false);

      const answer = await at.remote.homeAt(sshd.address, { confirm: asked.line });
      expect(answer).toMatchObject({
        started: true,
        address: sshd.address,
        name: "Mac mini",
        lingerOff: expect.any(Boolean),
        waitsForLogin: expect.any(Boolean),
        private: expect.any(Boolean),
      });
      expect(readFileSync(record, "utf8")).toBe("started: start-at-boot\n");
      expect(existsSync(join(them.home, "Applications", STAND_IN_APP))).toBe(true);
      expect(at.lines()).toEqual([
        remoteLoginWords.reaching(sshd.address),
        remoteLoginWords.settingUp("Mac mini"),
        remoteLoginWords.starting("Mac mini"),
      ]);
      // It started a first mate there; it added no computer here.
      expect(at.pairing.list()).toEqual([]);
    });

    it("stops at the start step when the copy's start-at-boot fails, naming that computer", async () => {
      const { sshd, record, at } = await setUp(1);
      const asked = await at.remote.homeAt(sshd.address);
      if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
      expect(await at.remote.homeAt(sshd.address, { confirm: asked.line })).toEqual({
        refused: "not-started",
        step: "start",
        name: "Mac mini",
      });
      expect(readFileSync(record, "utf8")).toBe("started: start-at-boot\n");
    });

    it("stops at the next step after Cancel, and deletes the copy it sent before anything started", async () => {
      let cancel = () => {};
      let cancelled = false;
      const { sshd, them, record, at } = await setUp(0, (event) => {
        // Cancel pressed once the copy is under way.
        if (cancelled || event.copy?.state !== "preparing") return;
        cancelled = true;
        cancel();
      });
      cancel = () => at.remote.cancelHomeAt(sshd.address);
      const asked = await at.remote.homeAt(sshd.address);
      if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
      expect(await at.remote.homeAt(sshd.address, { confirm: asked.line })).toEqual({
        refused: "cancelled",
        step: "send",
        name: "Mac mini",
      });
      expect(cancelled).toBe(true);
      expect(existsSync(join(them.home, "Applications", STAND_IN_APP))).toBe(false);
      expect(existsSync(record)).toBe(false);
    });

    it("offers to connect where Infinitary already runs for that account, sending nothing", async () => {
      const sshd = await server();
      const data = join(scratchDir("infinitary-far-home-"), "data");
      const pairing = new DevicePairing({ dir: join(data, "devices"), interfaces: () => ({}) });
      pairings.push(pairing);
      doors.push(
        await PhoneDoor.open({
          dir: join(data, PHONE_DOOR_FOLDER),
          invite: () => pairing.invite({ kind: "mac" }),
          listening: async () => {},
        }),
      );
      const them = otherUser({ INFINITARY_USER_DATA_DIR: data });
      const record = join(scratchDir("infinitary-home-record-"), "started");
      const at = await home({ ssh: sshd.ssh({ remote: them.env }), bundle: standInBundle(record) });
      const asked = await at.remote.homeAt(sshd.address);
      if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
      expect(await at.remote.homeAt(sshd.address, { confirm: asked.line })).toEqual({
        asks: "runs",
        address: sshd.address,
        name: "Mac mini",
      });
      expect(existsSync(record)).toBe(false);
      expect(existsSync(join(them.home, "Applications"))).toBe(false);
    });
  },
);

describe.runIf(SSH_SERVER_AVAILABLE && !SYSTEMD)("on a Linux computer without systemd", () => {
  it("stops at checking its system, before sending anything", async () => {
    const { sshd, them, record, at } = await setUp();
    const asked = await at.remote.homeAt(sshd.address);
    if (!("asks" in asked) || asked.asks !== "confirm") throw new Error("No key line.");
    expect(await at.remote.homeAt(sshd.address, { confirm: asked.line })).toMatchObject({
      refused: "no-systemd",
      step: "look",
    });
    expect(existsSync(record)).toBe(false);
    expect(existsSync(join(them.home, "Applications"))).toBe(false);
  });
});

/**
 * A root sign-in to a Linux computer, from review findings on this setup:
 * the account made for the first mate, its system checked again as that
 * account, the Ubuntu package installed over root's sign-in, and an SSH
 * drop named with its step and port. The other computer is a stand-in ssh
 * that answers the fixed scripts as a Linux server would; the look and the
 * install are stand-ins too, since the real ones are proved over real SSH
 * above and in remoteLogin's own tests.
 */
describe("a root sign-in on a Linux computer", () => {
  const ROOT = "root@vps";
  const ACCOUNT = "infinitary@vps";
  const linuxLook = (more: Partial<Look>): Look => ({
    os: "Linux",
    arch: "x86_64",
    needs: [],
    installs: {},
    sandboxOff: false,
    systemd: true,
    name: "vps",
    ...more,
  });

  /** An ssh that makes the account, and drops the connection at the start step. */
  function standInSsh(): SshProgram {
    const script = join(scratchDir("infinitary-home-ssh-"), "ssh.mjs");
    writeFileSync(
      script,
      [
        "const words = process.argv.slice(2).join(' ');",
        "if (words.includes('useradd')) { process.stdout.write('infinitary:account=infinitary\\n'); process.exit(0); }",
        "if (words.includes('start-at-boot')) { process.stderr.write('Connection closed by 203.0.113.5 port 22\\n'); process.exit(255); }",
        "process.exit(0);",
      ].join("\n"),
    );
    return { program: process.execPath, args: [script] };
  }

  function reachFor(looks: Record<string, Look>, ubuntu: boolean) {
    const installs: { address: string; uid: number | undefined }[] = [];
    const remembered = new Map<string, unknown>([[ROOT, { line: "vps ssh-ed25519 AAAA" }]]);
    const ssh = standInSsh();
    const builds = {
      readsPublished: () => ubuntu,
      canSend: () => true,
      fetches: () => false,
      for: async () => ({ refusal: "cannot-send" as const }),
    } as unknown as FarBuilds;
    const step = { say: () => {}, refuse: () => {}, warn: () => {} };
    const reach: HomeReach = {
      options: {
        pairing: {
          ownUid: 501,
          rememberedHost: (address: string) => remembered.get(address),
          rememberHost: (address: string, key: unknown) => remembered.set(address, key),
          ownKeyPlacedIn: () => false,
          ownKeyPlacedAt: () => {},
        },
        here: () => ({ path: "/tmp/here", localityOf: () => "elsewhere", dispose: () => {} }),
      } as unknown as HomeReach["options"],
      builds,
      cancels: new Set(),
      confirmHost: async () => ({ ok: true }),
      look: (async (address: string) => {
        const look = looks[address];
        if (!look) throw new Error(`No look for ${address}.`);
        return look;
      }) as unknown as HomeReach["look"],
      withPassword: (async (
        _a: string,
        _p: unknown,
        _s: unknown,
        attempt: () => Promise<unknown>,
      ) => ({
        ran: await attempt(),
      })) as unknown as HomeReach["withPassword"],
      refusedOver: (async (_address: string, refusal: string) =>
        refusal === "unreachable"
          ? { refusal, reach: { step: "sign-in", port: 22 } }
          : { refusal }) as unknown as HomeReach["refusedOver"],
      installUbuntu: (async (
        look: Look,
        at: { address: string; beforeInstall?: () => Promise<void> },
      ) => {
        await at.beforeInstall?.();
        installs.push({ address: at.address, uid: look.uid });
        return "ready";
      }) as unknown as HomeReach["installUbuntu"],
      askLink: (async () => ({ none: "not-open" })) as unknown as HomeReach["askLink"],
      sshFor: (address) => ({ ssh, address }),
      stepper: (() => step) as unknown as HomeReach["stepper"],
      once: (_key, run) => run(),
    };
    return { reach, installs, remembered };
  }

  it("installs the Ubuntu package over root's sign-in and goes on as the account it made", async () => {
    const { reach, installs, remembered } = reachFor(
      {
        [ROOT]: linuxLook({
          uid: 0,
          user: "root",
          distro: "ubuntu",
          release: "24.04",
          sudo: "free",
        }),
        [ACCOUNT]: linuxLook({
          uid: 1001,
          user: "infinitary",
          distro: "ubuntu",
          release: "24.04",
          sudo: "no",
        }),
      },
      true,
    );
    expect(await homeAt(reach, ROOT)).toEqual({ asks: "account", address: ROOT, name: "vps" });
    // The drop at the start step names the step and the port it signs in at.
    expect(await homeAt(reach, ROOT, { account: true })).toEqual({
      refused: "unreachable",
      step: "start",
      name: "vps",
      changed: true,
      reach: { step: "sign-in", port: 22 },
    });
    expect(installs).toEqual([{ address: ROOT, uid: 0 }]);
    expect(remembered.get(ACCOUNT)).toEqual(remembered.get(ROOT));
  });

  it("checks the account's system again, which may not keep the sandbox root could", async () => {
    const { reach, installs } = reachFor(
      {
        [ROOT]: linuxLook({ uid: 0, user: "root" }),
        [ACCOUNT]: linuxLook({ uid: 1001, user: "infinitary", sandboxOff: true }),
      },
      false,
    );
    expect(await homeAt(reach, ROOT, { account: true })).toEqual({
      refused: "sandbox-off",
      step: "look",
      name: "vps",
      changed: true,
    });
    expect(installs).toEqual([]);
  });

  it("stops where an account runs work for another first mate, or its closed window joined one", async () => {
    const other = "ssh-ed25519 AAAAother";
    const { reach, installs } = reachFor(
      {
        [ROOT]: linuxLook({ uid: 0, user: "root" }),
        [ACCOUNT]: linuxLook({ uid: 1001, user: "infinitary", joined: true, home: other }),
        "kun@box": linuxLook({ uid: 1000, user: "kun", windowHome: other, windowDevice: "d1" }),
      },
      false,
    );
    expect(await homeAt(reach, "kun@box")).toEqual({
      refused: "already-joined",
      step: "look",
      name: "vps",
    });
    // An infinitary account already there is checked again after root makes it.
    expect(await homeAt(reach, ROOT, { account: true })).toEqual({
      refused: "already-joined",
      step: "look",
      name: "vps",
      changed: true,
    });
    expect(installs).toEqual([]);
  });

  it("stops with the key not taken when the account it made would ask a password it does not have", async () => {
    const { reach } = reachFor({ [ROOT]: linuxLook({ uid: 0, user: "root" }) }, false);
    const signIn = reach.withPassword;
    reach.withPassword = ((
      address: string,
      ...rest: Parameters<typeof signIn> extends [string, ...infer R] ? R : never
    ) =>
      address === ACCOUNT
        ? Promise.resolve({ asks: "password", address })
        : signIn(address, ...rest)) as typeof signIn;
    expect(await homeAt(reach, ROOT, { account: true })).toEqual({
      refused: "key-not-taken",
      step: "look",
      name: "vps",
      changed: true,
    });
  });

  it("stops where something already answers there with no link, so no second copy starts", async () => {
    for (const [none, refused] of [
      ["controls", "controls"],
      ["refused", "no-link"],
      ["unreadable", "no-link"],
    ] as const) {
      const { reach, installs } = reachFor(
        {
          [ACCOUNT]: linuxLook({
            uid: 1001,
            user: "infinitary",
            distro: "ubuntu",
            release: "24.04",
          }),
        },
        true,
      );
      reach.askLink = (async () => ({ none })) as unknown as HomeReach["askLink"];
      expect(await homeAt(reach, ACCOUNT)).toEqual({ refused, step: "look", name: "vps" });
      expect(installs).toEqual([]);
    }
  });

  it("keeps a running setup's Cancel when a second start is refused", async () => {
    const { reach } = reachFor({ [ACCOUNT]: linuxLook({ uid: 1001, user: "infinitary" }) }, false);
    const held = new Set<string>();
    reach.once = async (key, run) => {
      if (held.has(key)) throw new Error("Already being set up.");
      held.add(key);
      try {
        return await run();
      } finally {
        held.delete(key);
      }
    };
    let second: Promise<unknown> = Promise.resolve();
    const look = reach.look;
    reach.look = (async (...args: Parameters<typeof look>) => {
      // Cancel pressed while the look runs, then Continue pressed again.
      reach.cancels.add(ACCOUNT);
      second = homeAt(reach, ACCOUNT).catch((error: Error) => error.message);
      return look(...args);
    }) as typeof look;
    expect(await homeAt(reach, ACCOUNT)).toEqual({ refused: "cancelled", step: "sign-in" });
    expect(await second).toBe("Already being set up.");
    expect(reach.cancels.has(ACCOUNT)).toBe(false);
  });
});
