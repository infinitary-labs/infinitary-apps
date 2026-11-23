import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SKILL_TEXT } from "@core/axi/captainCommands";
import type { CustodyRemove, SecretCustody } from "@core/secrets/custody";
import { appIdOf } from "@shared/codeNames";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import type { DarwinCustodyApi } from "../host/darwinSecretCustody";
import type { LibsecretApi } from "../host/linuxSecretCustody";
import {
  SECRET_APPROVER_NAMES,
  SECRET_STANDBY_NAMES,
  SECRETS_CUSTODY_NAMES,
} from "../host/nativeSecrets";
import {
  appFilePaths,
  clearCommandLink,
  clearPasswordStore,
  clearPhoneKeys,
  clearSafeStorage,
  passwordStoreNames,
} from "./outside";

/**
 * What a reset clears outside the data folder (docs/reset.md, "Outside the
 * folder"): only this flavor's own items, and a store that cannot answer is
 * left for the next start.
 */

function custody(answers: Record<string, CustodyRemove | Error>) {
  const asked: string[] = [];
  const fake = {
    remove: async (slot: string) => {
      asked.push(slot);
      const answer = answers[slot];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as SecretCustody;
  return { asked, fake };
}

describe("the password store a reset clears", () => {
  it("names the flavor's Secrets and standby lock, and its approval key only on a Mac", () => {
    expect(passwordStoreNames("darwin", "release")).toEqual([
      SECRETS_CUSTODY_NAMES.release,
      SECRET_STANDBY_NAMES.release,
      SECRET_APPROVER_NAMES.release,
    ]);
    expect(passwordStoreNames("win32", "dev")).toEqual([
      SECRETS_CUSTODY_NAMES.dev,
      SECRET_STANDBY_NAMES.dev,
    ]);
  });

  it("is cleared once every slot answers removed or never there", async () => {
    const one = custody({ root: "removed", "authority-head": "absent" });
    expect(await clearPasswordStore([one.fake])).toBe(true);
    expect(one.asked).toEqual(["root", "authority-head"]);
  });

  it("is left for the next start when a slot is locked, throws, or the store cannot open", async () => {
    expect(
      await clearPasswordStore([
        custody({ root: "removed", "authority-head": "unavailable" }).fake,
      ]),
    ).toBe(false);
    expect(
      await clearPasswordStore([
        custody({ root: new Error("denied"), "authority-head": "absent" }).fake,
      ]),
    ).toBe(false);
    expect(await clearPasswordStore(undefined)).toBe(false);
  });
});

describe("the app's own files a reset clears", () => {
  it("names a Mac's files by the flavor's app id, and none elsewhere", () => {
    const paths = appFilePaths({ platform: "darwin", flavor: "dev", homeDir: "/Users/someone" });
    const library = join("/Users/someone", "Library");
    expect(paths).toContain(join(library, "Preferences", `${appIdOf("dev")}.plist`));
    expect(paths).toContain(join(library, "Caches", appIdOf("dev")));
    expect(paths.every((path) => path.startsWith(library))).toBe(true);
    expect(appFilePaths({ platform: "linux", flavor: "dev", homeDir: "/home/someone" })).toEqual(
      [],
    );
  });
});

describe("Chromium's window key a reset clears", () => {
  function keychain(status: number) {
    const removed: [string, string][] = [];
    const api = {
      setUserInteractionAllowed: () => {},
      remove: (service: string, account: string) => {
        removed.push([service, account]);
        return status;
      },
    } as unknown as DarwinCustodyApi;
    return { removed, darwin: () => api };
  }
  function folders(...beside: string[]) {
    const parent = scratchDir("inf-reset-safe-storage-");
    for (const name of beside) mkdirSync(join(parent, name));
    return join(parent, "infinitary");
  }

  it("deletes the Mac keychain item Chromium names after the app", async () => {
    const mac = keychain(0);
    const place = {
      platform: "darwin" as const,
      flavor: "release" as const,
      appName: "infinitary",
    };
    expect(await clearSafeStorage({ ...place, dataDir: folders() }, mac)).toBe(true);
    expect(mac.removed).toEqual([["infinitary Safe Storage", "infinitary"]]);
    // errSecItemNotFound: never there is cleared too.
    expect(await clearSafeStorage({ ...place, dataDir: folders() }, keychain(-25300))).toBe(true);
    // errSecInteractionNotAllowed: a locked keychain is left.
    expect(await clearSafeStorage({ ...place, dataDir: folders() }, keychain(-25308))).toBe(false);
  });

  it("leaves the key every flavor shares while another flavor's folder is beside", async () => {
    const mac = keychain(0);
    const dataDir = folders("infinitary-dev");
    expect(
      await clearSafeStorage(
        { platform: "darwin", flavor: "release", dataDir, appName: "infinitary" },
        mac,
      ),
    ).toBe(true);
    expect(mac.removed).toEqual([]);
  });

  it("asks a Linux store by the app's name, and counts a locked one as left", async () => {
    const asked: string[] = [];
    const linux = (answer: Awaited<ReturnType<LibsecretApi["removeSafeStorage"]>>) => ({
      linux: () =>
        ({
          removeSafeStorage: async (application: string) => {
            asked.push(application);
            return answer;
          },
        }) as unknown as LibsecretApi,
    });
    const place = { platform: "linux" as const, flavor: "dev" as const, appName: "infinitary" };
    expect(await clearSafeStorage({ ...place, dataDir: folders() }, linux("absent"))).toBe(true);
    expect(
      await clearSafeStorage(
        { ...place, dataDir: folders() },
        linux({ kind: "error", locked: true }),
      ),
    ).toBe(false);
    expect(asked).toEqual(["infinitary", "infinitary"]);
  });
});

describe("the phone keys a reset clears", () => {
  const PERSON = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPersonsOwnKey someone@laptop";
  const PHONE =
    "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYPhoneKey infinitary-phone";

  function account(lines: string[], beside: string[] = []) {
    const parent = scratchDir("inf-reset-phone-keys-");
    for (const name of beside) mkdirSync(join(parent, name));
    const homeDir = scratchDir("inf-reset-phone-home-");
    mkdirSync(join(homeDir, ".ssh"), { mode: 0o700 });
    const file = join(homeDir, ".ssh", "authorized_keys");
    writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
    return { file, homeDir, dataDir: join(parent, "infinitary") };
  }

  it("removes the phones' lines and keeps every other line and the file's permissions", () => {
    const at = account([PERSON, PHONE, `${PHONE.replace("PhoneKey", "OtherPhone")}`]);
    expect(clearPhoneKeys({ platform: "darwin", flavor: "release", ...at })).toBe(true);
    expect(readFileSync(at.file, "utf8")).toBe(`${PERSON}\n`);
    expect(statSync(at.file).mode & 0o777).toBe(0o600);
  });

  it("keeps a linked file a link, and clears the lines in the file it leads to", () => {
    const at = account([PERSON, PHONE]);
    const dotfiles = join(scratchDir("inf-reset-phone-dotfiles-"), "authorized_keys");
    renameSync(at.file, dotfiles);
    symlinkSync(dotfiles, at.file);
    expect(clearPhoneKeys({ platform: "darwin", flavor: "release", ...at })).toBe(true);
    expect(lstatSync(at.file).isSymbolicLink()).toBe(true);
    expect(readFileSync(dotfiles, "utf8")).toBe(`${PERSON}\n`);
    expect(statSync(dotfiles).mode & 0o777).toBe(0o600);
  });

  it("leaves the lines while another flavor's folder is beside, and finds nothing to do without the file", () => {
    const at = account([PERSON, PHONE], ["infinitary-dev"]);
    expect(clearPhoneKeys({ platform: "linux", flavor: "release", ...at })).toBe(true);
    expect(readFileSync(at.file, "utf8")).toContain(PHONE);
    const none = scratchDir("inf-reset-phone-none-");
    expect(
      clearPhoneKeys({
        platform: "darwin",
        flavor: "release",
        homeDir: none,
        dataDir: join(none, "infinitary"),
      }),
    ).toBe(true);
  });
});

describe("the command's link and skill a reset clears", () => {
  function place(beside: string[] = []) {
    const parent = scratchDir("inf-reset-command-");
    for (const name of beside) mkdirSync(join(parent, name));
    const linkDir = scratchDir("inf-reset-command-bin-");
    const homeDir = scratchDir("inf-reset-command-home-");
    const skillDir = join(homeDir, ".claude", "skills", "infinitary-axi");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), SKILL_TEXT);
    const command = join(parent, "Infinitary.app", "axi-bin", "infinitary-axi");
    return { linkDir, homeDir, skillDir, command, dataDir: join(parent, "infinitary") };
  }

  it("removes this copy's own link and the skill as the app wrote it", () => {
    const at = place();
    symlinkSync(at.command, join(at.linkDir, "infinitary-axi"));
    expect(clearCommandLink({ flavor: "release", ...at })).toBe(true);
    expect(() => lstatSync(join(at.linkDir, "infinitary-axi"))).toThrow();
    expect(existsSync(at.skillDir)).toBe(false);
  });

  it("keeps a link to another copy, a skill the person changed, and the shared skill beside another flavor", () => {
    const other = place();
    symlinkSync(
      "/Applications/Infinitary Dev.app/axi-bin/infinitary-axi",
      join(other.linkDir, "infinitary-axi"),
    );
    writeFileSync(join(other.skillDir, "SKILL.md"), `${SKILL_TEXT}\nMy own note.\n`);
    expect(clearCommandLink({ flavor: "release", ...other })).toBe(true);
    expect(lstatSync(join(other.linkDir, "infinitary-axi")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(other.skillDir, "SKILL.md"))).toBe(true);
    const beside = place(["infinitary-dev"]);
    expect(clearCommandLink({ flavor: "release", ...beside })).toBe(true);
    expect(existsSync(join(beside.skillDir, "SKILL.md"))).toBe(true);
  });
});
