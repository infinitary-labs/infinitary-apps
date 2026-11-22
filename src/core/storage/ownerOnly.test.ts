import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import {
  dataFolderRefusal,
  UNCHECKED_FOLDER_TITLE,
  UNFINISHED_FOLDER_TITLE,
  UNSAFE_FOLDER_TITLE,
} from "./dataFolderRefusal";
import {
  type AccessAnswer,
  type AccessAsk,
  type AccessRun,
  clearPrivateTemp,
  keepDataFolderPrivate,
  keepOwnerOnly,
  keepsToOwner,
  onlyOwnerReaches,
  ownerOnlyAccessList,
  ownerOnlyVerdict,
  PRIVATE_TEMP_DIR,
  readAccessList,
} from "./ownerOnly";

// The piece of the Windows plan this serves: every private folder the app
// writes gets an owner-only access list, an unsafe place is refused, and a
// second ordinary account cannot read them, including outside the profile.

const USER = "S-1-5-21-1004336348-1177238915-682003330-1001";
const OTHER = "S-1-5-21-1004336348-1177238915-682003330-1002";
const GROUP = "S-1-5-21-1004336348-1177238915-682003330-513";

/** A folder under the person's profile, as Windows hands its list down from `C:\Users\<name>`. */
const IN_PROFILE = `O:${USER}G:${GROUP}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIID;FA;;;${USER})`;
/**
 * A folder a standard account made at the top of `C:\` on Windows 11, as
 * `Get-Acl` read it there (account numbers replaced): every signed-in account
 * reads it, and another account read a file in it.
 */
const AT_DRIVE_TOP = `O:${USER}G:${GROUP}D:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)`;
/** A folder another standard account made there, read the same way. */
const OTHERS_FOLDER = `O:${OTHER}G:${GROUP}D:AI(A;OICIID;FA;;;BA)(A;OICIID;FA;;;SY)(A;OICIID;0x1200a9;;;BU)(A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)`;
/** What `Get-Acl` reads on a drive with no access lists. */
const NO_LIST = `O:${USER}D:NO_ACCESS_CONTROL`;
/** Chromium's network service's own grant on its profile folder: an app package's capability. */
const CAPABILITY =
  "S-1-15-3-1024-2302894289-466761758-1166120688-1039016420-2430351297-4240214049-4028510897-3317428798";

/**
 * Windows as `ACCESS_SCRIPT` sees it: each folder's descriptor, and a set
 * that takes the new list as Windows stores it (`P` with `AI`). A folder
 * named in `refuses` fails its set, as a drive with no access lists does.
 */
function windows(
  folders: Record<string, string>,
  refuses: readonly string[] = [],
  {
    printed = (path: string) => path,
    failsPartWay = [],
  }: {
    /** How the path comes back in the answer. */
    printed?: (path: string) => string;
    /** Folders whose list is set but whose hand-down to the files fails. */
    failsPartWay?: readonly string[];
  } = {},
): { run: AccessRun; asks: AccessAsk[]; folders: Record<string, string> } {
  const asks: AccessAsk[] = [];
  const run: AccessRun = async (ask) => {
    asks.push(ask);
    const answer: AccessAnswer = {
      user: USER,
      set: ask.set.map((set) => {
        if (refuses.includes(set.path))
          return {
            path: printed(set.path),
            error: "Attempted to perform an unauthorized operation.",
          };
        const owner = /^O:[^D]*/.exec(folders[set.path] ?? "")?.[0] ?? "";
        folders[set.path] = `${owner}${set.sddl.replace(/^D:P/, "D:PAI")}`;
        if (failsPartWay.includes(set.path))
          return {
            path: printed(set.path),
            error:
              "The process cannot access the file because it is being used by another process.",
          };
        return { path: printed(set.path), error: null };
      }),
      read: ask.read.map((path) => ({
        path: printed(path),
        sddl: folders[path] ?? null,
        error: null,
      })),
    };
    return answer;
  };
  return { run, asks, folders };
}

describe("reading a folder's access list", () => {
  it("lets the profile's own list reach only this account, though it is inherited", () => {
    const list = readAccessList(IN_PROFILE);
    expect(list.owner).toBe(USER);
    expect(list.protected).toBe(false);
    expect(ownerOnlyVerdict(list, USER)).toBe("inherited");
  });

  it("finds every signed-in account reaching a folder at the top of the drive", () => {
    expect(ownerOnlyVerdict(readAccessList(AT_DRIVE_TOP), USER)).toBe("others");
  });

  it("finds a folder another account owns, and a drive with no list", () => {
    expect(ownerOnlyVerdict(readAccessList(OTHERS_FOLDER), USER)).toBe("other-owner");
    expect(ownerOnlyVerdict(readAccessList(NO_LIST), USER)).toBe("no-list");
    // A folder with no list that another account owns is that account's, not one to set a list on.
    expect(ownerOnlyVerdict(readAccessList(`O:${OTHER}G:${GROUP}D:NO_ACCESS_CONTROL`), USER)).toBe(
      "other-owner",
    );
  });

  it("refuses a reading it could not take whole, never judging the entries before the rest", () => {
    // A conditional entry carries brackets of its own; what follows it, here another account's
    // right to change the folder, would otherwise go unread.
    const conditional = IN_PROFILE.replace(
      `(A;OICIID;FA;;;${USER})`,
      `(A;OICIID;FA;;;${USER})(XA;;FA;;;${USER};(x))(A;;0x1301bf;;;${OTHER})`,
    );
    expect(readAccessList(conditional).entries).toBeNull();
    expect(onlyOwnerReaches(readAccessList(conditional), USER)).toBe(false);
    // No owner read is no owner that keeps the folder this account's.
    const ownerless = IN_PROFILE.replace(`O:${USER}`, "");
    expect(onlyOwnerReaches(readAccessList(ownerless), USER)).toBe(false);
    expect(ownerOnlyVerdict(readAccessList(ownerless), USER)).toBe("unread");
    expect(ownerOnlyVerdict(readAccessList(conditional), USER)).toBe("unread");
    // A drive with no list is read whole: it has none, which is a different answer.
    expect(ownerOnlyVerdict(readAccessList(NO_LIST), USER)).toBe("no-list");
    // No access list section at all, or the no-list word where the list is more than it, is not
    // Windows saying the folder has no list.
    expect(ownerOnlyVerdict(readAccessList(`O:${USER}G:${GROUP}`), USER)).toBe("unread");
    expect(
      ownerOnlyVerdict(
        readAccessList(`O:${USER}G:${GROUP}D:NO_ACCESS_CONTROL(A;OICI;FA;;;${OTHER})`),
        USER,
      ),
    ).toBe("unread");
    // An entry missing its account or its rights, of a kind this reading does not judge, or
    // whose account, rights or flags are not in Windows' own form - an account number cut short,
    // rights no letters name, flags no pairs name - is not read whole either: an account read as
    // nothing, or half read, is no account to judge.
    for (const entry of [
      `(A;OICI;FA;;)`,
      `(A;OICI;FA;;;)`,
      `(A;OICI;;;;${OTHER})`,
      `(Q;OICI;FA;;;${OTHER})`,
      `(A;OICI;FA;;;S-1-5-21-)`,
      `(A;OICI;FA;;;S-1)`,
      `(A;OICI;FA;;;QQ)`,
      `(A;OICI;ZZ;;;${OTHER})`,
      `(A;OICI;0x;;;${OTHER})`,
      `(A;XXIO;FA;;;${OTHER})`,
      `(A;OICI;FA;x;;${OTHER})`,
      `(A;OICI;FA;;bf967aba-0de6-11d0-a285-00aa003049e2;${OTHER})`,
      `(OA;OICI;FA;not-an-object;;${OTHER})`,
      `(A;OICI;FA;;;S-1-5-21-4294967296)`,
      `(A;OICI;FA;;;S-1-5-021)`,
      // An authority Windows writes in decimal below 2^32, and in twelve digits of hex from it up.
      `(A;OICI;FA;;;S-1-0x00000000FFFF-1)`,
      `(A;OICI;FA;;;S-1-0x100000000-1)`,
      `(A;OICI;FA;;;S-1-4294967296-1)`,
      `(A;OICI;FA;;;S-1-5${"-1".repeat(16)})`,
    ]) {
      const reading = readAccessList(`O:${USER}G:${GROUP}D:P(A;OICI;FA;;;${USER})${entry}`);
      expect(reading).toMatchObject({ entries: null, whole: false });
      expect(ownerOnlyVerdict(reading, USER)).toBe("unread");
    }
    // Nor is a descriptor whose owner or group is not an account Windows writes, even one saying
    // the folder has no list.
    for (const descriptor of [
      `O:S-1-5-21-99999999999G:${GROUP}D:NO_ACCESS_CONTROL`,
      `O:QQG:${GROUP}D:NO_ACCESS_CONTROL`,
      `O:${USER}G:S-1D:P(A;OICI;FA;;;${USER})`,
    ])
      expect(ownerOnlyVerdict(readAccessList(descriptor), USER)).toBe("unread");
    // An account whose authority is past 32 bits, written as Windows writes it, is read whole, as
    // an entry's account and as the owner.
    for (const wide of ["S-1-0x000100000000-1", "S-1-0x0001000000aB-5-21"]) {
      const reading = readAccessList(
        `O:${wide}G:${GROUP}D:P(A;OICI;FA;;;${USER})(A;;FR;;;${wide})`,
      );
      expect(reading.whole).toBe(true);
      expect(reading.entries?.[1]?.account).toBe(wide);
    }
    // An object entry naming one object's number is read whole.
    expect(
      readAccessList(
        `O:${USER}G:${GROUP}D:P(A;OICI;FA;;;${USER})(OD;;WD;bf967aba-0de6-11d0-a285-00aa003049e2;;${OTHER})`,
      ).whole,
    ).toBe(true);
    // Nor is a list whose own flags are not Windows' (`P`, `AI`, `AR`).
    expect(readAccessList(`O:${USER}G:${GROUP}D:XP(A;OICI;FA;;;${USER})`).whole).toBe(false);
    // The word only in what follows the list leaves the list itself to be judged.
    const audited = `${IN_PROFILE}S:(AU;SA;FA;;;WD)`;
    expect(readAccessList(audited).entries).toHaveLength(3);
    expect(readAccessList(`${audited}D:NO_ACCESS_CONTROL`).entries).toHaveLength(3);
  });

  it("writes a protected list for this account alone, keeping an app package's own grant", () => {
    const withCapability = `${AT_DRIVE_TOP}(A;OICI;FA;;;${CAPABILITY})`;
    const written = ownerOnlyAccessList(readAccessList(withCapability), USER);
    expect(written).toBe(`D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;${CAPABILITY})`);
    expect(ownerOnlyVerdict(readAccessList(`O:${USER}${written}`), USER)).toBe("owner-only");
  });
});

describe("a folder the app made inside its private data folder", () => {
  // The review of INF-5409: a word's profile and its temporary folder are used only where their
  // own lists keep to this account and hand that down to what is made in them.
  it("keeps to this account only where it lets no one else in and hands that down at every depth", () => {
    const inherited = `O:${USER}G:${GROUP}D:(A;OICIID;FA;;;SY)(A;OICIID;FA;;;${USER})`;
    expect(keepsToOwner(readAccessList(inherited), USER)).toBe(true);
    // Its own entry only, handed to nothing made in it: Windows would make up a list for those.
    expect(keepsToOwner(readAccessList(`O:${USER}G:${GROUP}D:P(A;;FA;;;${USER})`), USER)).toBe(
      false,
    );
    // Handed down to folders but not files, or only to the next level.
    expect(keepsToOwner(readAccessList(`O:${USER}G:${GROUP}D:P(A;CI;FA;;;${USER})`), USER)).toBe(
      false,
    );
    expect(
      keepsToOwner(readAccessList(`O:${USER}G:${GROUP}D:P(A;OICINP;FA;;;${USER})`), USER),
    ).toBe(false);
    // Another account let in, a folder another account owns, and a reading not taken whole.
    expect(keepsToOwner(readAccessList(AT_DRIVE_TOP), USER)).toBe(false);
    expect(keepsToOwner(readAccessList(OTHERS_FOLDER), USER)).toBe(false);
    expect(keepsToOwner(readAccessList(`O:${USER}G:${GROUP}D:XP(A;OICI;FA;;;${USER})`), USER)).toBe(
      false,
    );
  });
});

describe("keeping folders owner-only", () => {
  it("makes a folder outside the profile owner-only, and leaves it alone the next time", async () => {
    const folder = join(scratchDir("fm-owner-only-"), "Infinitary");
    const pc = windows({ [folder]: AT_DRIVE_TOP });
    const first = await keepOwnerOnly([folder], pc.run);
    expect(first.kept).toEqual([{ kind: "owner-only", path: folder, changed: true }]);
    expect(pc.asks[1]?.set).toEqual([{ path: folder, sddl: `D:P(A;OICI;FA;;;${USER})` }]);

    const again = await keepOwnerOnly([folder], pc.run);
    expect(again.kept).toEqual([{ kind: "owner-only", path: folder, changed: false }]);
    expect(pc.asks).toHaveLength(3);
  });

  it("refuses a folder another account owns, without changing it", async () => {
    const folder = join(scratchDir("fm-owner-only-"), "Infinitary");
    const pc = windows({ [folder]: OTHERS_FOLDER });
    const { kept } = await keepOwnerOnly([folder], pc.run);
    expect(kept).toEqual([{ kind: "unsafe", path: folder, why: "other-owner" }]);
    expect(pc.asks.every((ask) => ask.set.length === 0)).toBe(true);
  });

  it("refuses a folder on a drive that takes no access list", async () => {
    const folder = join(scratchDir("fm-owner-only-"), "Infinitary");
    const pc = windows({ [folder]: NO_LIST }, [folder]);
    const { kept } = await keepOwnerOnly([folder], pc.run);
    expect(kept[0]).toMatchObject({ kind: "unsafe", why: "no-list" });
  });

  it("keeps a folder whose path has letters outside English, however the path is printed back", async () => {
    // Windows PowerShell 5.1 prints in the console's old code page, so a
    // profile such as C:\Users\José came back with its letters replaced.
    const folder = join(scratchDir("fm-owner-only-"), "José", "Infinitary");
    const pc = windows({ [folder]: AT_DRIVE_TOP }, [], {
      printed: (path) => path.replace(/é/g, "\uFFFD"),
    });
    const { kept } = await keepOwnerOnly([folder], pc.run);
    expect(kept).toEqual([{ kind: "owner-only", path: folder, changed: true }]);
  });

  it("refuses a folder whose new list Windows handed down to only some of its files, and sets it again next time", async () => {
    const folder = join(scratchDir("fm-owner-only-"), "Infinitary");
    const failing = windows({ [folder]: AT_DRIVE_TOP }, [], { failsPartWay: [folder] });
    const { kept } = await keepOwnerOnly([folder], failing.run);
    expect(kept[0]).toMatchObject({ kind: "unsafe", why: "unfinished" });

    // The folder's own list now reads owner-only, but its files may not be.
    const pc = windows({ [folder]: failing.folders[folder] ?? "" });
    const again = await keepOwnerOnly([folder], pc.run);
    expect(again.kept).toEqual([{ kind: "owner-only", path: folder, changed: true }]);
    expect(pc.asks[1]?.set).toEqual([{ path: folder, sddl: `D:P(A;OICI;FA;;;${USER})` }]);

    const third = await keepOwnerOnly([folder], pc.run);
    expect(third.kept).toEqual([{ kind: "owner-only", path: folder, changed: false }]);
  });

  it("sets the list again when an earlier launch ended before the hand-down finished", async () => {
    const folder = join(scratchDir("fm-owner-only-"), "Infinitary");
    const pc = windows({ [folder]: AT_DRIVE_TOP });
    const ended = async () => {
      throw new Error("PowerShell ended with null");
    };
    const first = await keepOwnerOnly([folder], async (ask) =>
      ask.set.length > 0 ? ended() : pc.run(ask),
    );
    expect(first.kept[0]).toMatchObject({ kind: "unsafe", why: "unfinished" });
    // The app ended while Windows was handing the list down: the folder's own list changed.
    pc.folders[folder] = `O:${USER}G:${GROUP}D:PAI(A;OICI;FA;;;${USER})`;
    const again = await keepOwnerOnly([folder], pc.run);
    expect(again.kept).toEqual([{ kind: "owner-only", path: folder, changed: true }]);
  });

  it("refuses every folder when Windows cannot be asked", async () => {
    const folder = join(scratchDir("fm-owner-only-"), "Infinitary");
    const { kept } = await keepOwnerOnly([folder], async () => {
      throw new Error("PowerShell ended with 1");
    });
    expect(kept[0]).toMatchObject({ kind: "unsafe", why: "unread" });
  });
});

describe("the data folder on Windows", () => {
  it("is refused as an unsafe place when it cannot be made owner-only", async () => {
    const dataDir = join(scratchDir("fm-owner-only-"), "infinitary");
    const temp = join(scratchDir("fm-owner-only-"), "Temp");
    const privacy = await keepDataFolderPrivate({
      platform: "win32",
      dataDir,
      env: {},
      tempDir: temp,
      run: windows({ [dataDir]: OTHERS_FOLDER, [temp]: IN_PROFILE }).run,
    });
    expect(dataFolderRefusal(dataDir, privacy)?.title).toBe(UNSAFE_FOLDER_TITLE);
  });

  it("changes nothing on a data folder whose list it could not read whole, keeping its denies, nor on another account's with no list", async () => {
    for (const partial of [
      // A deny another tool set, then a conditional entry this reading does not take apart.
      `O:${USER}G:${GROUP}D:P(D;OICI;WD;;;${OTHER})(A;OICI;FA;;;${USER})(XA;;FA;;;${USER};(x))`,
      // An owner read, and no access list section at all.
      `O:${USER}G:${GROUP}`,
      // The no-list word, with entries after it: not Windows saying the folder has no list.
      `O:${USER}G:${GROUP}D:NO_ACCESS_CONTROL(D;OICI;WD;;;${OTHER})`,
      // A deny, then an entry missing its account: not an account besides this one to remove.
      `O:${USER}G:${GROUP}D:P(D;OICI;WD;;;${OTHER})(A;OICI;FA;;;${USER})(A;OICI;FA;;)`,
      // A deny, then an allow whose account number is cut short: not an account to remove.
      `O:${USER}G:${GROUP}D:P(D;OICI;WD;;;${OTHER})(A;OICI;FA;;;${USER})(A;OICI;FA;;;S-1-5-21-)`,
      // A deny, then an allow whose rights no letters name.
      `O:${USER}G:${GROUP}D:P(D;OICI;WD;;;${OTHER})(A;OICI;FA;;;${USER})(A;OICI;ZZ;;;${OTHER})`,
      // A deny, then an allow carrying an object field a plain entry never has.
      `O:${USER}G:${GROUP}D:P(D;OICI;WD;;;${OTHER})(A;OICI;FA;;;${USER})(A;OICI;FA;x;;${OTHER})`,
      // No list, under an owner whose number is too large to be an account.
      `O:S-1-5-21-99999999999G:${GROUP}D:NO_ACCESS_CONTROL`,
      // No list, under another account: its folder, whatever list it has.
      `O:${OTHER}G:${GROUP}D:NO_ACCESS_CONTROL`,
    ]) {
      const dataDir = join(scratchDir("fm-owner-only-"), "infinitary");
      const temp = join(scratchDir("fm-owner-only-"), "Temp");
      await mkdir(dataDir, { recursive: true });
      const pc = windows({ [dataDir]: partial, [temp]: IN_PROFILE });
      const privacy = await keepDataFolderPrivate({
        platform: "win32",
        dataDir,
        env: {},
        tempDir: temp,
        run: pc.run,
      });
      expect(pc.asks.every((ask) => ask.set.length === 0)).toBe(true);
      expect(pc.folders[dataDir]).toBe(partial);
      expect(await readdir(dataDir)).toEqual([]);
      expect(dataFolderRefusal(dataDir, privacy)?.title).toBe(
        partial.startsWith(`O:${OTHER}`) ? UNSAFE_FOLDER_TITLE : UNCHECKED_FOLDER_TITLE,
      );
    }
  });

  it("says Windows could not check the folder when it cannot be asked, or could not finish", async () => {
    const dataDir = join(scratchDir("fm-owner-only-"), "infinitary");
    const temp = join(scratchDir("fm-owner-only-"), "Temp");
    const unchecked = await keepDataFolderPrivate({
      platform: "win32",
      dataDir,
      env: {},
      tempDir: temp,
      run: async () => {
        throw new Error("PowerShell ended with 1: blocked by policy");
      },
    });
    expect(dataFolderRefusal(dataDir, unchecked)?.title).toBe(UNCHECKED_FOLDER_TITLE);

    const unfinished = await keepDataFolderPrivate({
      platform: "win32",
      dataDir,
      env: {},
      tempDir: temp,
      run: windows({ [dataDir]: AT_DRIVE_TOP, [temp]: IN_PROFILE }, [], { failsPartWay: [dataDir] })
        .run,
    });
    expect(dataFolderRefusal(dataDir, unfinished)?.title).toBe(UNFINISHED_FOLDER_TITLE);
  });

  it("clears what earlier launches left in its own temporary folder, keeping the folder", async () => {
    const temp = join(scratchDir("fm-owner-only-"), "infinitary", PRIVATE_TEMP_DIR);
    await mkdir(join(temp, "helper-1"), { recursive: true });
    await writeFile(join(temp, "helper-1", "out.txt"), "left");
    await writeFile(join(temp, "attachment.png"), "left");
    await clearPrivateTemp(temp);
    expect(await readdir(temp)).toEqual([]);
  });

  it("moves temporary files into it when the system's temporary folder lets others in", async () => {
    const dataDir = join(scratchDir("fm-owner-only-"), "infinitary");
    const temp = join(scratchDir("fm-owner-only-"), "Temp");
    const env: NodeJS.ProcessEnv = { TEMP: temp, TMP: temp };
    const privacy = await keepDataFolderPrivate({
      platform: "win32",
      dataDir,
      env,
      tempDir: temp,
      run: windows({ [dataDir]: IN_PROFILE, [temp]: AT_DRIVE_TOP }).run,
    });
    expect(privacy).toEqual({ refused: null, temp: join(dataDir, PRIVATE_TEMP_DIR) });
    expect(env.TEMP).toBe(join(dataDir, PRIVATE_TEMP_DIR));
    expect(env.TMP).toBe(join(dataDir, PRIVATE_TEMP_DIR));
    expect(dataFolderRefusal(dataDir, privacy)).toBeNull();
  });

  it("keeps the profile's temporary folder, which no other account reaches", async () => {
    const dataDir = join(scratchDir("fm-owner-only-"), "infinitary");
    const temp = join(scratchDir("fm-owner-only-"), "Temp");
    const env: NodeJS.ProcessEnv = { TEMP: temp };
    const privacy = await keepDataFolderPrivate({
      platform: "win32",
      dataDir,
      env,
      tempDir: temp,
      run: windows({ [dataDir]: IN_PROFILE, [temp]: IN_PROFILE }).run,
    });
    expect(privacy).toEqual({ refused: null, temp: null });
    expect(env.TEMP).toBe(temp);
  });

  it("reads and changes nothing on a Mac or Linux, whose modes already keep it", async () => {
    const asks: AccessAsk[] = [];
    const privacy = await keepDataFolderPrivate({
      platform: "darwin",
      dataDir: "/nowhere",
      env: {},
      tempDir: "/tmp",
      run: async (ask) => {
        asks.push(ask);
        throw new Error("not on this system");
      },
    });
    expect(privacy).toEqual({ refused: null, temp: null });
    expect(asks).toEqual([]);
  });
});
