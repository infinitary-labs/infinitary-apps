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
  handsDownToOthers,
  keepDataFolderPrivate,
  keepOwnerOnly,
  onlyOwnerReaches,
  othersCanChange,
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
  });

  it("finds who besides this account could move or replace what a folder holds", () => {
    // The profile's own folders: only this account, Windows and the administrators.
    expect(othersCanChange(readAccessList(IN_PROFILE), USER)).toBe(false);
    expect(othersCanChange(readAccessList(OTHERS_FOLDER), USER)).toBe(true);
    // At the top of the drive every signed-in account may change it; reading it, or a right only
    // handed down to what others make there, changes nothing in it.
    expect(othersCanChange(readAccessList(AT_DRIVE_TOP), USER)).toBe(true);
    const readOnly = AT_DRIVE_TOP.replace("(A;ID;0x1301bf;;;AU)", "");
    expect(othersCanChange(readAccessList(readOnly), USER)).toBe(false);
    expect(othersCanChange(readAccessList(NO_LIST), USER)).toBe(true);
  });

  it("refuses a reading it could not take whole, never judging the entries before the rest", () => {
    // A conditional entry carries brackets of its own; what follows it, here another account's
    // right to change the folder, would otherwise go unread.
    const conditional = IN_PROFILE.replace(
      `(A;OICIID;FA;;;${USER})`,
      `(A;OICIID;FA;;;${USER})(XA;;FA;;;${USER};(x))(A;;0x1301bf;;;${OTHER})`,
    );
    expect(readAccessList(conditional).entries).toBeNull();
    expect(othersCanChange(readAccessList(conditional), USER)).toBe(true);
    expect(onlyOwnerReaches(readAccessList(conditional), USER)).toBe(false);
    // No owner read is no owner that keeps the folder this account's.
    const ownerless = IN_PROFILE.replace(`O:${USER}`, "");
    expect(othersCanChange(readAccessList(ownerless), USER)).toBe(true);
    expect(onlyOwnerReaches(readAccessList(ownerless), USER)).toBe(false);
    expect(ownerOnlyVerdict(readAccessList(ownerless), USER)).toBe("unread");
    expect(ownerOnlyVerdict(readAccessList(conditional), USER)).toBe("unread");
    // A drive with no list is read whole: it has none, which is a different answer.
    expect(ownerOnlyVerdict(readAccessList(NO_LIST), USER)).toBe("no-list");
  });

  it("finds a folder that hands another account access to what is made in it", () => {
    expect(handsDownToOthers(readAccessList(IN_PROFILE), USER)).toBe(false);
    // At the top of the drive every signed-in account gets rights over what another makes there.
    expect(handsDownToOthers(readAccessList(AT_DRIVE_TOP), USER)).toBe(true);
    expect(handsDownToOthers(readAccessList(NO_LIST), USER)).toBe(true);
    // A list handing nothing down to new folders leaves a new folder the creating process's
    // default list, which this list does not decide.
    const nothingDown = `O:${USER}G:${GROUP}D:P(A;;FA;;;SY)(A;;FA;;;${USER})`;
    expect(handsDownToOthers(readAccessList(nothingDown), USER)).toBe(true);
    const filesOnly = `O:${USER}G:${GROUP}D:P(A;OI;FA;;;${USER})`;
    expect(handsDownToOthers(readAccessList(filesOnly), USER)).toBe(true);
  });

  it("writes a protected list for this account alone, keeping an app package's own grant", () => {
    const withCapability = `${AT_DRIVE_TOP}(A;OICI;FA;;;${CAPABILITY})`;
    const written = ownerOnlyAccessList(readAccessList(withCapability), USER);
    expect(written).toBe(`D:P(A;OICI;FA;;;${USER})(A;OICI;FA;;;${CAPABILITY})`);
    expect(ownerOnlyVerdict(readAccessList(`O:${USER}${written}`), USER)).toBe("owner-only");
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

  it("changes nothing on a data folder whose list it could not read whole, keeping its denies", async () => {
    // A deny another tool set, then a conditional entry this reading does not take apart.
    const dataDir = join(scratchDir("fm-owner-only-"), "infinitary");
    const temp = join(scratchDir("fm-owner-only-"), "Temp");
    await mkdir(dataDir, { recursive: true });
    const partial = `O:${USER}G:${GROUP}D:P(D;OICI;WD;;;${OTHER})(A;OICI;FA;;;${USER})(XA;;FA;;;${USER};(x))`;
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
    expect(dataFolderRefusal(dataDir, privacy)?.title).toBe(UNCHECKED_FOLDER_TITLE);
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
