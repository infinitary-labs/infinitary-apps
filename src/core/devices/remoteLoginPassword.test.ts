import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { DeviceView } from "@shared/devices";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addChecked,
  closeEach,
  home,
  otherUser,
  server,
  servers,
  standInBundle,
} from "../../../tests/helpers/remoteLoginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE, startSshServer } from "../../../tests/helpers/sshServer";
import { hostTrustSshOptions, knownHostsLine, preferHostKey } from "./hostTrust";
import { OWN_KEY_COMMENT } from "./ownKey";
import { RemoteLoginRefusedError } from "./remoteLogin";
import { placeOwnKey } from "./sshPassword";

/**
 * That user's password, asked once when the Mac did not let the captain's
 * key in (docs/devices.md, "Adding a computer by its address"): it lets
 * Firstmate's own key in, goes only to the Mac whose check line it
 * remembers, and is kept nowhere, over a real SSH server that takes
 * passwords (`tests/helpers/remoteLoginHome.ts`).
 */

// Real processes: sshd, ssh, tar, curl and openssl (Mac slowest per-case
// fastest 2.1 s, docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 15_000 });

afterEach(closeEach);

describe.runIf(SSH_SERVER_AVAILABLE)("adding a Mac by its address over Remote Login", () => {
  /** An invented password: no person's, and nothing this test may find kept anywhere. */
  const INVENTED = "invented-pw-4c1f";

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
});
