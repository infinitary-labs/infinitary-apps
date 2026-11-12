import { describe, expect, it } from "vitest";
import type { CustodyRead, CustodySlot, SecretCustody } from "../../core/secrets/custody";
import type { UserDataChoice } from "../userDataDir";
import type { KeychainFile, KeychainLockState } from "./keychainProcess";
import {
  type DarwinSecretsHost,
  darwinUnlock,
  type HostSecrets,
  interactiveUnlock,
  type NativeSecretsPlatforms,
  nativeSecrets,
  SECRETS_CUSTODY_NAMES,
} from "./nativeSecrets";

// Intent: INF-1659, the captain's "Turn it on" - the person's own app builds
// protected Secrets on macOS and Linux with the platform's native custody,
// each flavor under its own custody name so a development run never reads the
// release's root, and a run on a throwaway or chosen folder opens no native
// store (docs/secrets.md, "Native custody").

/** Records which platform composed custody for which name; never a native store. */
function platforms() {
  const composed: string[] = [];
  const hosts: DarwinSecretsHost[] = [];
  const compose =
    (platform: string) =>
    (name: string, host?: DarwinSecretsHost): HostSecrets => {
      composed.push(`${platform}:${name}`);
      if (host) hosts.push(host);
      return { custody: { read: async () => ({ kind: "absent" }), write: async () => "stored" } };
    };
  const stand: NativeSecretsPlatforms = { darwin: compose("darwin"), linux: compose("linux") };
  return { stand, composed, hosts };
}

/** A keychain file no test opens: composing custody must never touch it. */
const noFile: KeychainFile = {
  status: async () => "unknown",
  unlock: async () => ({ kind: "failed", message: "not opened" }),
};

const own = (flavor: "release" | "dev"): UserDataChoice => ({
  kind: "flavor",
  flavor,
  dir: `/data/${flavor}`,
});

describe("nativeSecrets", () => {
  it("composes the platform's custody for the person's own folder, one name per flavor", () => {
    const { stand, composed, hosts } = platforms();
    for (const platform of ["darwin", "linux"] as const)
      for (const flavor of ["release", "dev"] as const)
        expect(
          nativeSecrets({ platform, choice: own(flavor), keychainFile: noFile }, stand),
        ).toBeDefined();
    expect(composed).toEqual([
      `darwin:${SECRETS_CUSTODY_NAMES.release}`,
      `darwin:${SECRETS_CUSTODY_NAMES.dev}`,
      `linux:${SECRETS_CUSTODY_NAMES.release}`,
      `linux:${SECRETS_CUSTODY_NAMES.dev}`,
    ]);
    expect(SECRETS_CUSTODY_NAMES.dev).not.toBe(SECRETS_CUSTODY_NAMES.release);
    // Installed apps keep their root under this name: renaming it would leave
    // every kept secret's sealed file beside no root.
    expect(SECRETS_CUSTODY_NAMES.release).toBe("Infinitary Secrets");
    // The Mac's custody opens the account's own login keychain, not one a caller names.
    expect(hosts).toEqual([{ keychainFile: noFile }, { keychainFile: noFile }]);
  });

  it("opens no native store for an isolated or chosen folder, or off macOS and Linux", () => {
    const { stand, composed } = platforms();
    const elsewhere: UserDataChoice[] = [{ kind: "isolated", dir: "/scratch" }, { kind: "switch" }];
    for (const platform of ["darwin", "linux"] as const)
      for (const choice of elsewhere)
        expect(nativeSecrets({ platform, choice, keychainFile: noFile }, stand)).toBe(undefined);
    expect(
      nativeSecrets({ platform: "win32", choice: own("release"), keychainFile: noFile }, stand),
    ).toBe(undefined);
    expect(composed).toEqual([]);
  });
});

describe("interactiveUnlock", () => {
  /** A custody whose slots answer as given, recording each read. */
  function custody(answers: Record<CustodySlot, CustodyRead["kind"]>) {
    const reads: CustodySlot[] = [];
    const handed: Buffer[] = [];
    const store: SecretCustody = {
      read: async (slot) => {
        reads.push(slot);
        if (answers[slot] !== "value") return { kind: answers[slot] } as CustodyRead;
        const bytes = Buffer.from([7, 7, 7]);
        handed.push(bytes);
        return { kind: "value", bytes };
      },
      write: async () => "stored",
    };
    return { store, reads, handed };
  }

  it("asks for both slots, so a rules item still untrusted keeps Secrets locked", async () => {
    const trusted = custody({ root: "value", "authority-head": "locked" });
    expect(await interactiveUnlock(trusted.store)()).toBe(false);
    expect(trusted.reads).toEqual(["root", "authority-head"]);
    expect(trusted.handed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  it("is unlocked once every slot answers, whether or not it holds an item yet", async () => {
    expect(
      await interactiveUnlock(custody({ root: "value", "authority-head": "value" }).store)(),
    ).toBe(true);
    expect(
      await interactiveUnlock(custody({ root: "absent", "authority-head": "absent" }).store)(),
    ).toBe(true);
    expect(
      await interactiveUnlock(custody({ root: "unavailable", "authority-head": "absent" }).store)(),
    ).toBe(false);
  });
});

// Intent: INF-3869's review of INF-1659, the captain's choice and the review's
// second round - the app's own process touched the store silently first, so
// only a fresh Keychain process may show macOS's unlock dialog
// (docs/architecture.md, "The latch"), and it unlocks the custody's own file
// by its path, never whichever store a search finds; the in-process read after
// it only re-trusts the app with an item.
describe("darwinUnlock", () => {
  const custodyPath = "/Users/someone/Library/Keychains/login.keychain-db";
  /** A keychain file whose lock reads as given, recording each child it would start. */
  function file(state: KeychainLockState, unlock: "unlocked" | "failed" = "unlocked") {
    const order: string[] = [];
    const paths: string[] = [];
    const stand: KeychainFile = {
      status: async (path) => {
        order.push("status");
        paths.push(path);
        return state;
      },
      unlock: async (path) => {
        order.push("unlock");
        paths.push(path);
        return unlock === "unlocked" ? { kind: "unlocked" } : { kind: "failed", message: "no" };
      },
    };
    const reads = (answer: boolean) => async () => {
      order.push("reads");
      return answer;
    };
    return { stand, order, paths, reads };
  }

  it("unlocks the custody's own file in a child first, then lets the in-process reads decide", async () => {
    const locked = file("locked");
    expect(await darwinUnlock(custodyPath, locked.stand, locked.reads(true))()).toBe(true);
    expect(locked.order).toEqual(["status", "unlock", "reads"]);
    expect(locked.paths).toEqual([custodyPath, custodyPath]);
    // A lock the silent child could not read still gets the dialog.
    const unread = file("unknown");
    await darwinUnlock(custodyPath, unread.stand, unread.reads(true))();
    expect(unread.order).toEqual(["status", "unlock", "reads"]);
    // A file that unlocked but an item that still trusts another app stays locked.
    const untrusted = file("locked");
    expect(await darwinUnlock(custodyPath, untrusted.stand, untrusted.reads(false))()).toBe(false);
    // The child's own failure is not the reading: the person may have unlocked it elsewhere.
    const refused = file("locked", "failed");
    expect(await darwinUnlock(custodyPath, refused.stand, refused.reads(true))()).toBe(true);
  });

  it("asks for no unlock dialog when the file is already open or missing", async () => {
    for (const state of ["unlocked", "absent"] as const) {
      const quiet = file(state);
      expect(await darwinUnlock(custodyPath, quiet.stand, quiet.reads(true))()).toBe(true);
      expect(quiet.order).toEqual(["status", "reads"]);
    }
  });
});
