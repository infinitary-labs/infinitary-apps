import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceLabel } from "@shared/devices";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addChecked,
  closeEach,
  home,
  otherUser,
  server,
  THEIR_UID,
} from "../../../tests/helpers/remoteLoginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE } from "../../../tests/helpers/sshServer";
import { standInFirstmate, standInProgram } from "../../../tests/helpers/standInFirstmate";
import { writeInstalled } from "../helper/background";
import { BUILDS_FILE } from "../update/releaseBuilds";
import { publicTagFor } from "../update/updateChannels";
import { claimLink } from "./dial";
import { FarBuilds } from "./farBuilds";
import { JoinedHome } from "./joinedHome";
import { PublishedBuilds, publishedAssetName, standInTapFetch } from "./publishedBuilds";
import { shellWord } from "./shellWord";
import { UBUNTU_PACKAGE_BIN } from "./ubuntuPackage";

/**
 * Adding an Ubuntu computer by its address (docs/devices.md, "Adding a
 * computer by its address"), with and without systemd, over a real SSH
 * server (`tests/helpers/remoteLoginHome.ts`).
 */

// Real processes: sshd, ssh, tar, curl and openssl (Mac slowest per-case
// fastest 2.1 s, docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 15_000 });

afterEach(closeEach);

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
    return {
      bin,
      path: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      sudo: join(bin, "sudo"),
      osRelease,
    };
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

  it("updates an already joined Ubuntu worker in place after checking its address and identity", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = scratchDir("infinitary-ubuntu-update-record-");
    const program = standInProgram(standInFirstmate(join(record, "started"), THEIR_UID));
    const there = ubuntu(record, "on");
    writeFileSync(join(there.bin, "dpkg-query"), "#!/bin/sh\necho 0.12.0\n");
    const deb = randomBytes(64_000);
    const builds = new FarBuilds({
      own: () => null,
      chip: "arm64",
      published: new PublishedBuilds({
        version: "0.13.0",
        dir: scratchDir("infinitary-ubuntu-update-builds-"),
        fetchImpl: standInTapFetch(debRelease(deb, "0.13.0")),
      }),
    });
    const ssh = sshd.ssh({
      remote: { ...them.env, PATH: there.path },
      programs: {
        "/etc/os-release": there.osRelease,
        [UBUNTU_PACKAGE_BIN]: program,
        [`${shellWord("sudo")} ${shellWord("-n")}`]: `${shellWord(there.sudo)} ${shellWord("-n")}`,
      },
    });
    const at = await home({ ssh, bundle: null, builds });
    const { link } = at.pairing.invite({ kind: "work", at: `127.0.0.1:${at.port}` });
    await at.settled();
    const grant = await claimLink(link, {
      kind: "work",
      name: "Ubuntu worker",
      user: { name: "builder", uid: THEIR_UID },
    });
    const joined = new JoinedHome(them.work, () => {});
    joined.join(grant, Date.now());
    const pause = vi.fn(async () => {});
    const options = { address: sshd.address, pause };
    const check = await at.remote.update(grant.deviceId, options);
    if (!("asks" in check) || check.asks !== "confirm")
      throw new Error("Expected the address check before installing.");
    expect(pause).not.toHaveBeenCalled();
    expect(readdirSync(record)).toEqual([]);
    const confirmed = { ...options, confirm: check.line };
    joined.join({ ...grant, deviceId: "other-worker" }, Date.now());
    await expect(at.remote.update(grant.deviceId, confirmed)).rejects.toMatchObject({
      refusal: "another-computer",
    });
    expect(pause).not.toHaveBeenCalled();
    expect(readdirSync(record)).not.toContain("installed.deb");
    joined.join(grant, Date.now());
    writeInstalled(them.work, { app: join(them.work, "Infinitary.AppImage"), service: null });
    await expect(at.remote.update(grant.deviceId, confirmed)).rejects.toMatchObject({
      lines: expect.arrayContaining([expect.stringContaining("does not reach the Ubuntu package")]),
    });
    expect(readdirSync(record)).not.toContain("installed.deb");
    writeInstalled(them.work, { app: null, service: null });
    expect(await at.remote.update(grant.deviceId, confirmed)).toMatchObject({ id: grant.deviceId });
    expect(readFileSync(join(record, "installed.deb"))).toEqual(deb);
    expect(readFileSync(join(record, "started"), "utf8")).toContain("work update --from-home");
    expect(joined.read()?.grant).toEqual(grant);
    expect(at.pairing.list()).toEqual([expect.objectContaining({ id: grant.deviceId })]);
    expect(at.pairing.list()[0]?.remoteLogin).toBeUndefined();
    expect(at.pairing.list()[0]?.packageUpdateAt).toBe(sshd.address);
  });

  it("says an update whose installer ran past the time limit may already have installed it, never that nothing changed", async () => {
    const sshd = await server();
    const them = otherUser();
    const record = scratchDir("infinitary-ubuntu-slow-record-");
    const program = standInProgram(standInFirstmate(join(record, "started"), THEIR_UID));
    const there = ubuntu(record, "on");
    writeFileSync(join(there.bin, "dpkg-query"), "#!/bin/sh\necho 0.12.0\n");
    // The installer outlasts the time limit there.
    writeFileSync(join(there.bin, "apt-get"), "#!/bin/sh\nsleep 4\n", { mode: 0o755 });
    const deb = randomBytes(64_000);
    const builds = new FarBuilds({
      own: () => null,
      chip: "arm64",
      published: new PublishedBuilds({
        version: "0.13.0",
        dir: scratchDir("infinitary-ubuntu-slow-builds-"),
        fetchImpl: standInTapFetch(debRelease(deb, "0.13.0")),
      }),
    });
    const ssh = sshd.ssh({
      remote: { ...them.env, PATH: there.path },
      programs: {
        "/etc/os-release": there.osRelease,
        [UBUNTU_PACKAGE_BIN]: program,
        [`${shellWord("sudo")} ${shellWord("-n")}`]: `${shellWord(there.sudo)} ${shellWord("-n")}`,
      },
    });
    const at = await home({ ssh, bundle: null, builds, sendTimeoutMs: 1_500 });
    const { link } = at.pairing.invite({ kind: "work", at: `127.0.0.1:${at.port}` });
    await at.settled();
    const grant = await claimLink(link, {
      kind: "work",
      name: "Ubuntu worker",
      user: { name: "builder", uid: THEIR_UID },
    });
    new JoinedHome(them.work, () => {}).join(grant, Date.now());
    const options = { address: sshd.address, pause: async () => {} };
    const check = await at.remote.update(grant.deviceId, options);
    if (!("asks" in check) || check.asks !== "confirm")
      throw new Error("Expected the address check before installing.");
    const [worker] = at.pairing.list();
    if (!worker) throw new Error("Expected the worker on the list.");
    await expect(
      at.remote.update(grant.deviceId, { ...options, confirm: check.line }),
    ).rejects.toMatchObject({
      refusal: "failed",
      uncertain: true,
      lines: remoteLoginWords.uncertain(deviceLabel(worker)),
    });
  });

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
