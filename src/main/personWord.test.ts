import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { AccessAsk, AccessRun } from "@core/storage/ownerOnly";
import { setCurrentLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import * as m from "@shared/i18n/messages.generated";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import {
  askPersonWord,
  OPEN_ONCE_CLOSED,
  ownProfilesFolder,
  PERSON_WORD_ARG,
  personWordArg,
  personWordBox,
  wordLauncher,
  wordProfilePrivate,
} from "./personWord";
import {
  claimWordProfile,
  readReply,
  replyLine,
  WORD_BUTTONS,
  WORD_OWNER_FILE,
  WORD_PROFILES_RESERVED,
  WORD_REMOVING_PREFIX,
  WORD_TEMP_DIR,
  wordProfilesMark,
} from "./personWordArg";

/**
 * A file system that gives no birth time, as some do: while `noBirth.on`, every folder read here
 * answers a birth of zero, and while `noBirth.fromChange` its last change in place of one, as
 * Node may answer where the system has none; nothing else about it changes. Entries whose path
 * starts with `noBirth.still` answer their birth as their last change too, as a change clock too
 * coarse to move between them would; `noBirth.reading` runs before each read, and
 * `noBirth.number` and `noBirth.birth` give the number and birth a path answers in place of its
 * own. A number is given again only as the system gives one: never while a file or folder that has
 * it is held open (`noBirth.held`). The folder `noBirth.fresh` names alone answers its last change as
 * its birth, as a new folder not yet changed does, and `noBirth.opening` runs before each path
 * opened is opened.
 */
const noBirth = vi.hoisted(() => ({
  on: false,
  fromChange: false,
  still: null as string | null,
  reading: null as ((path: string) => void) | null,
  number: new Map<string, bigint>(),
  birth: new Map<string, bigint>(),
  held: new Map<number, bigint>(),
  fresh: null as string | null,
  opening: null as ((path: string) => void) | null,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const lstatSync = ((path: string, options?: { bigint?: boolean }) => {
    noBirth.reading?.(path);
    const found = fs.lstatSync(path, options as never) as unknown as {
      birthtimeNs?: bigint;
      ctimeNs?: bigint;
      ino?: bigint;
    };
    if (found && typeof found.birthtimeNs === "bigint") {
      const number = noBirth.number.get(path);
      if (number !== undefined && ![...noBirth.held.values()].includes(number)) found.ino = number;
      const birth = noBirth.birth.get(path);
      if (birth !== undefined) found.birthtimeNs = birth;
      if ((noBirth.still !== null && path.startsWith(noBirth.still)) || path === noBirth.fresh)
        found.ctimeNs = found.birthtimeNs;
      if (noBirth.on) found.birthtimeNs = 0n;
      else if (noBirth.fromChange && typeof found.ctimeNs === "bigint")
        found.birthtimeNs = found.ctimeNs;
    }
    return found;
  }) as typeof fs.lstatSync;
  const openSync = ((...args: Parameters<typeof fs.openSync>) => {
    noBirth.opening?.(String(args[0]));
    const fd = fs.openSync(...args);
    noBirth.held.set(fd, fs.fstatSync(fd, { bigint: true }).ino);
    return fd;
  }) as typeof fs.openSync;
  const closeSync = ((fd: number) => {
    noBirth.held.delete(fd);
    fs.closeSync(fd);
  }) as typeof fs.closeSync;
  const own = { lstatSync, openSync, closeSync };
  return { ...fs, default: { ...fs, ...own }, ...own };
});

/**
 * The review of INF-5409: a window launch refused the folder's lock never sees Electron become
 * ready, so its words to the person come from a copy of the program that shows one word. The copy
 * is started by its own word alone, the boxes keep the question's Leave it as its first and
 * closing answer, and a word taken away before it is shown starts no copy at all.
 */
describe("a refused launch's word to the person", () => {
  afterEach(() => setCurrentLanguage(SOURCE_LANGUAGE));

  it("starts the copy that shows one word only by its own argument", () => {
    expect(personWordArg(["/app", `${PERSON_WORD_ARG}=dock`])).toBe("dock");
    expect(personWordArg(["/app", "--user-data-dir=/x", `${PERSON_WORD_ARG}=once-closed`])).toBe(
      "once-closed",
    );
    expect(personWordArg(["/app", `${PERSON_WORD_ARG}=other`, "run"])).toBeNull();
    expect(personWordArg(["/app"])).toBeNull();
  });

  it("asks whether to open here with Leave it first, and names the Dock otherwise", () => {
    const question = personWordBox("once-closed", ["en-US"], false);
    expect(question.buttons).toEqual([m.dialogLeaveIt(), m.dialogOpenOnceClosed()]);
    expect(question.cancelId).toBe(0);
    expect(question.defaultId).toBe(0);
    expect(question.buttons?.[OPEN_ONCE_CLOSED]).toBe(m.dialogOpenOnceClosed());
    const dock = personWordBox("dock", ["en-US"], false);
    expect(dock.message).toBe(m.dialogOpenInDock());
    expect(dock.detail).toBe(m.dialogOpenInDockDetail());
    // The replies each box can say: the question's two buttons, and the one Electron draws for a
    // box that names none.
    expect(WORD_BUTTONS["once-closed"]).toBe(question.buttons?.length);
    expect(dock.buttons).toBeUndefined();
    expect(WORD_BUTTONS.dock).toBe(1);
  });

  it("starts no copy for a word taken away before it is shown", async () => {
    const taken = new AbortController();
    taken.abort();
    // A copy started from a program that is not there would answer unshown, not null.
    expect(
      await askPersonWord("once-closed", {
        launcher: { execPath: "/nonexistent/infinitary", args: [] },
        profiles: "/nonexistent/word-profiles",
        signal: taken.signal,
      }),
    ).toBeNull();
  });

  it("reads a press only from a whole reply its box could say, of a copy that ended cleanly", () => {
    expect(readReply("once-closed", replyLine(OPEN_ONCE_CLOSED), 0, null)).toBe(OPEN_ONCE_CLOSED);
    expect(readReply("once-closed", replyLine(0), 0, null)).toBe(0);
    expect(readReply("dock", replyLine(0), 0, null)).toBe(0);
    expect(readReply("once-closed", replyLine("unshown"), 0, null)).toBe("unshown");
    // Cut short, more than one line, padded, or not a press.
    for (const said of [
      "",
      "pressed:",
      "pressed:1",
      "pressed:1\npressed:0\n",
      "1\n",
      "pressed:-1\n",
      "pressed:01\n",
      "pressed: 1\n",
    ])
      expect(readReply("once-closed", said, 0, null)).toBe("unshown");
    // A button the box does not have: the Dock word's box has one, the question two.
    expect(readReply("dock", replyLine(1), 0, null)).toBe("unshown");
    expect(readReply("once-closed", replyLine(2), 0, null)).toBe("unshown");
    // A copy that failed or was ended says nothing the person chose.
    expect(readReply("once-closed", replyLine(OPEN_ONCE_CLOSED), 1, null)).toBe("unshown");
    expect(readReply("once-closed", replyLine(OPEN_ONCE_CLOSED), null, "SIGKILL")).toBe("unshown");
  });

  it("starts the copy as the launch was started, an AppImage only through the file it runs from", () => {
    const appPath = "/src/app";
    const resourcesDir = scratchDir("person-word-resources-");
    const base = { packaged: true, appPath, resourcesDir };
    expect(
      wordLauncher({
        ...base,
        packaged: false,
        platform: "darwin",
        execPath: "/electron",
        env: {},
      }),
    ).toEqual({ execPath: "/electron", args: [appPath] });
    // An AppImage the runtime mounted this program from.
    const appImage = join(scratchDir("person-word-appimage-"), "Infinitary.AppImage");
    writeFileSync(appImage, "");
    const mounted = "/tmp/.mount_Infini";
    expect(
      wordLauncher({
        ...base,
        platform: "linux",
        execPath: `${mounted}/infinitary`,
        env: { APPIMAGE: appImage, APPDIR: mounted },
      }),
    ).toEqual({ execPath: appImage, args: [] });
    // An APPIMAGE this launch only inherited, from another AppImage that started it, or on a Mac.
    for (const [platform, execPath] of [
      ["linux", "/opt/Infinitary/infinitary"],
      ["darwin", "/Applications/Infinitary.app/Contents/MacOS/Infinitary"],
    ] as const)
      expect(
        wordLauncher({
          ...base,
          platform,
          execPath,
          env: { APPIMAGE: appImage, APPDIR: mounted },
        }),
      ).toEqual({ execPath, args: [] });
  });

  it("makes the copy's profile only where it stays private", () => {
    expect(wordProfilePrivate("darwin", null)).toBe(true);
    expect(wordProfilePrivate("linux", null)).toBe(true);
    expect(wordProfilePrivate("win32", { refused: null })).toBe(true);
    // A Windows data folder refused, or never judged, makes no profile in it.
    expect(wordProfilePrivate("win32", { refused: { kind: "unsafe" } })).toBe(false);
    expect(wordProfilePrivate("win32", null)).toBe(false);
  });

  it("has the copy name itself in the profile it was started with, and only there", () => {
    const profiles = scratchDir("person-word-claim-");
    const profile = join(profiles, "infinitary-word-one");
    // Its launch made the profile for it; the copy names itself there, its record ending its line.
    mkdirSync(profile);
    expect(claimWordProfile(["/app", `--user-data-dir=${profile}`])).toBe(true);
    expect(readFileSync(join(profile, WORD_OWNER_FILE), "utf8")).toBe(`${process.pid}\n`);
    expect(existsSync(join(profile, WORD_TEMP_DIR))).toBe(true);
    // Never twice, nor over a file it did not make, nor for a profile not of a word, nor none.
    expect(claimWordProfile(["/app", `--user-data-dir=${profile}`])).toBe(false);
    expect(claimWordProfile(["/app", `--user-data-dir=${join(profiles, "other")}`])).toBe(false);
    expect(existsSync(join(profiles, "other"))).toBe(false);
    expect(claimWordProfile(["/app"])).toBe(false);
    // A profile it cannot name itself in: one inside a plain file.
    writeFileSync(join(profiles, "file"), "");
    expect(
      claimWordProfile(["/app", `--user-data-dir=${join(profiles, "file", "infinitary-word-x")}`]),
    ).toBe(false);
  });

  it("keeps a Windows profiles' folder only with an owner-only access list of its own", async () => {
    const user = "S-1-5-21-1-2-3-1001";
    const group = "S-1-5-21-1-2-3-513";
    const other = "S-1-5-21-9-9-9-1002";
    const ownList = `O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})`;
    // Every folder above the profiles' folder answers as this account's alone unless `above`
    // says otherwise; the profiles' folder and what it holds answer `at`.
    const answering = (
      sddl: string,
      at: (path: string) => string = () => sddl,
      above: (path: string) => string = () => ownList,
    ): AccessRun & { asks: AccessAsk[] } => {
      const asks: AccessAsk[] = [];
      return Object.assign(
        async (ask: AccessAsk) => {
          asks.push(ask);
          return {
            user,
            set: ask.set.map((each) => ({ path: each.path, error: null })),
            read: ask.read.map((path) => ({
              path,
              sddl: path.includes("word-profiles") ? at(path) : above(path),
              error: null,
            })),
          };
        },
        { asks },
      );
    };
    const sets = (run: { asks: AccessAsk[] }) =>
      run.asks.flatMap((ask) => ask.set.map((each) => each.path));
    const touched = (run: { asks: AccessAsk[] }) =>
      run.asks.flatMap((ask) => [...ask.read, ...ask.set.map((each) => each.path)]);
    const root = () => join(realpathSync(scratchDir("person-word-windows-")), "word-profiles");
    const own = answering(ownList);
    const ownRoot = root();
    const kept = (await ownProfilesFolder(ownRoot, "win32", own))?.path ?? "";
    expect(kept.startsWith(`${ownRoot}.`)).toBe(true);
    expect(touched(own)).toContain(kept);
    // Reserved at the name by its own mark, naming that folder, linked there once the folder was
    // private and marked.
    expect(readFileSync(ownRoot, "utf8")).toBe(
      wordProfilesMark(kept.slice(ownRoot.length + 1), lstatSync(kept, { bigint: true })),
    );
    expect(readdirSync(kept)).toEqual([WORD_PROFILES_RESERVED]);
    // Found again by a later launch, which reads the reservation and its folder and sets nothing.
    const again = answering(ownList);
    expect((await ownProfilesFolder(ownRoot, "win32", again))?.path).toBe(kept);
    expect(sets(again)).toEqual([]);
    expect(touched(again)).toContain(ownRoot);
    expect(touched(again)).toContain(kept);
    // A reservation whose folder is not owner-only, or whose mark another account could have
    // written, is only read: no access list is set on it, and the next name is reserved instead.
    const reserved = async () => {
      const name = root();
      const folder = (await ownProfilesFolder(name, "win32", answering(ownList)))?.path ?? "";
      return { name, folder };
    };
    // Owner-only lists that hand nothing of this account's down to what a copy makes in the folder,
    // or only one level down, would leave its profiles the creating process's default list.
    for (const list of [
      `O:${user}G:${group}D:AI(A;OICI;FA;;;${user})`,
      `O:${user}G:${group}D:PAI(A;;FA;;;${user})`,
      `O:${user}G:${group}D:PAI(A;OICINP;FA;;;${user})`,
    ]) {
      const shared = await reserved();
      const inherited = answering(ownList, (path) => (path === shared.folder ? list : ownList));
      const instead = (await ownProfilesFolder(shared.name, "win32", inherited))?.path ?? "";
      expect(instead.startsWith(`${shared.name}-2.`)).toBe(true);
      expect(sets(inherited)).not.toContain(shared.folder);
    }
    // A folder newly made whose owner-only list, read back once set, hands this account's access
    // only one level down is not marked or reserved: no name is reserved and nothing is left.
    const flat = root();
    const madeFlat = answering(ownList, (path) =>
      /\.[0-9a-f]{8}-[0-9a-f-]{27}$/.test(path)
        ? `O:${user}G:${group}D:PAI(A;OICINP;FA;;;${user})`
        : ownList,
    );
    expect(await ownProfilesFolder(flat, "win32", madeFlat)).toBeNull();
    expect(sets(madeFlat)).toEqual([]);
    expect(touched(madeFlat).some((path) => path.startsWith(`${flat}.`))).toBe(true);
    expect(
      readdirSync(join(flat, "..")).filter((entry) => entry.startsWith("word-profiles")),
    ).toEqual([]);
    const planted = await reserved();
    const foreignMark = answering(ownList, (path) =>
      path === planted.name
        ? `O:${other}G:${group}D:AI(A;;FA;;;${other})(A;;FA;;;${user})`
        : ownList,
    );
    const next = (await ownProfilesFolder(planted.name, "win32", foreignMark))?.path ?? "";
    expect(next.startsWith(`${planted.name}-2.`)).toBe(true);
    expect(sets(foreignMark)).not.toContain(planted.folder);
    // A copy of the reserved folder beside it that kept the mark's link is never looked at, and a
    // mark replaced inside the folder while Windows is read leaves the reservation not ours.
    const copied = await reserved();
    mkdirSync(`${copied.name}.0-copy`);
    linkSync(
      join(copied.folder, WORD_PROFILES_RESERVED),
      join(`${copied.name}.0-copy`, WORD_PROFILES_RESERVED),
    );
    const looked = answering(ownList);
    expect((await ownProfilesFolder(copied.name, "win32", looked))?.path).toBe(copied.folder);
    expect(touched(looked)).not.toContain(`${copied.name}.0-copy`);
    // A folder put back at the reserved folder's path holding the same mark is not the folder the
    // mark was written in: it is not read, and the next name is reserved.
    const restored = await reserved();
    renameSync(restored.folder, `${restored.folder}-was`);
    mkdirSync(restored.folder);
    linkSync(
      join(`${restored.folder}-was`, WORD_PROFILES_RESERVED),
      join(restored.folder, WORD_PROFILES_RESERVED),
    );
    writeFileSync(join(restored.folder, "theirs"), "");
    const putBack = answering(ownList);
    const beside = (await ownProfilesFolder(restored.name, "win32", putBack))?.path ?? "";
    expect(beside.startsWith(`${restored.name}-2.`)).toBe(true);
    expect(touched(putBack)).not.toContain(restored.folder);
    expect(readdirSync(restored.folder).sort()).toEqual([WORD_PROFILES_RESERVED, "theirs"]);
    const swapped = await reserved();
    const swapping = answering(ownList, (path) => {
      if (path === swapped.folder) {
        const inside = join(swapped.folder, WORD_PROFILES_RESERVED);
        const text = readFileSync(inside, "utf8");
        rmSync(inside);
        writeFileSync(inside, text);
      }
      return ownList;
    });
    const past = (await ownProfilesFolder(swapped.name, "win32", swapping))?.path ?? "";
    expect(past.startsWith(`${swapped.name}-2.`)).toBe(true);
    // Anything else at the name - a file saying something else, a folder of this account's that is
    // empty, or another account's - is never read into or changed, and the next name is reserved.
    const marked = root();
    writeFileSync(marked, "someone else's\n");
    const empty = root();
    mkdirSync(empty, { recursive: true });
    const theirs = root();
    mkdirSync(theirs, { recursive: true });
    for (const [name, list] of [
      [marked, ownList],
      [empty, ownList],
      [theirs, `O:${other}G:${group}D:PAI(A;OICI;FA;;;${other})`],
    ] as const) {
      const run = answering(ownList, (path) => (path === name ? list : ownList));
      const used = (await ownProfilesFolder(name, "win32", run))?.path ?? "";
      expect(used.startsWith(`${name}-2.`)).toBe(true);
      expect(touched(run)).not.toContain(name);
    }
    expect(readFileSync(marked, "utf8")).toBe("someone else's\n");
    expect(readdirSync(empty)).toEqual([]);
    // A folder above it another account could change, one whose list or owner could not be read
    // whole, or a folder it goes in that hands another account access to what is made there:
    // nothing is made or set.
    const inParent = (list: string) => (name: string) =>
      answering(ownList, undefined, (path) => (path === join(name, "..") ? list : ownList));
    const inAncestor = (list: string) => (name: string) =>
      answering(ownList, undefined, (path) => (path === join(name, "..", "..") ? list : ownList));
    for (const parent of [
      inParent(`O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})(A;OICI;0x1301bf;;;${other})`),
      inParent(`O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})(A;OICI;0x1200a9;;;${other})`),
      inParent(
        `O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})(XA;;FA;;;${user};(x))(A;OICI;0x1301bf;;;${other})`,
      ),
      inParent(`G:${group}D:PAI(A;OICI;FA;;;${user})`),
      // A folder handing nothing down to new folders: Windows would give a new one the creating
      // process's default list instead.
      inParent(`O:${user}G:${group}D:PAI(A;;FA;;;${user})(A;OI;FA;;;${user})`),
      // A folder further up giving another account all of a key's rights, which take in deleting
      // and re-permitting, whether written as letters or as their number.
      inAncestor(`O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})(A;;KA;;;${other})`),
      inAncestor(`O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})(A;;0xF003F;;;${other})`),
    ]) {
      const exposed = root();
      const run = parent(exposed);
      expect(await ownProfilesFolder(exposed, "win32", run)).toBeNull();
      expect(sets(run)).toEqual([]);
      expect(readdirSync(join(exposed, ".."))).toEqual([]);
    }
    // A folder made that cannot be made private, or whose mark cannot go in, is removed only
    // while empty: what something else put in it meanwhile, a folder or a file at the mark's name
    // included, stays as it was, set aside under a removal's own name, and nothing is reserved.
    for (const failing of ["private", "mark", "mark-file"]) {
      const made = root();
      const fails: AccessRun = async (ask) => {
        const folder = ask.read.find((path) => path.startsWith(`${made}.`));
        if (folder && failing === "private") writeFileSync(join(folder, "theirs"), "");
        if (folder && failing === "mark")
          mkdirSync(join(folder, WORD_PROFILES_RESERVED), { recursive: true });
        if (folder && failing === "mark-file")
          writeFileSync(join(folder, WORD_PROFILES_RESERVED), "not this launch's\n");
        return {
          user,
          set: ask.set.map((each) => ({ path: each.path, error: "refused" })),
          read: ask.read.map((path) => ({
            path,
            sddl:
              path.startsWith(`${made}.`) && failing === "private"
                ? `O:${user}G:${group}D:AI(A;OICI;FA;;;${user})`
                : ownList,
            error: null,
          })),
        };
      };
      expect(await ownProfilesFolder(made, "win32", fails)).toBeNull();
      expect(existsSync(made)).toBe(false);
      const [left] = readdirSync(join(made, "..")).filter((name) =>
        name.startsWith(WORD_REMOVING_PREFIX),
      );
      expect(left).toBeDefined();
      expect(readdirSync(join(made, "..", left ?? ""))).toContain(
        failing === "private" ? "theirs" : WORD_PROFILES_RESERVED,
      );
      if (failing === "mark-file")
        expect(readFileSync(join(made, "..", left ?? "", WORD_PROFILES_RESERVED), "utf8")).toBe(
          "not this launch's\n",
        );
    }
    // Where the system gives no birth time, a reservation naming none is never used - its folder
    // is not read, set or changed - and no new one is made, since device and number alone can name
    // another folder later.
    const unborn = await reserved();
    const id = unborn.folder.slice(unborn.name.length + 1);
    writeFileSync(
      unborn.name,
      wordProfilesMark(id, { ...lstatSync(unborn.folder, { bigint: true }), birthtimeNs: 0n }),
    );
    noBirth.on = true;
    try {
      const birthless = answering(ownList);
      expect(await ownProfilesFolder(unborn.name, "win32", birthless)).toBeNull();
      expect(touched(birthless)).not.toContain(unborn.folder);
      expect(readdirSync(unborn.folder)).toEqual([WORD_PROFILES_RESERVED]);
      expect(
        readdirSync(join(unborn.name, "..")).filter((entry) => entry.startsWith("word-profiles-")),
      ).toEqual([]);
    } finally {
      noBirth.on = false;
    }
    // Where the system gives the last change in place of a birth, the mark going in moves it: the
    // folder names no one folder, so it is removed again, nothing is reserved and no name is taken.
    const changing = root();
    noBirth.fromChange = true;
    try {
      expect(await ownProfilesFolder(changing, "win32", answering(ownList))).toBeNull();
    } finally {
      noBirth.fromChange = false;
    }
    expect(existsSync(changing)).toBe(false);
    expect(readdirSync(join(changing, ".."))).toEqual([]);
    // On a change clock too coarse to move as the mark goes in, a birth that is the last change
    // reads the same before and after: no folder shows a birth kept apart from its last change,
    // so nothing is reserved and the folder made is removed again.
    const coarse = root();
    noBirth.fromChange = true;
    noBirth.still = "/";
    try {
      expect(await ownProfilesFolder(coarse, "win32", answering(ownList))).toBeNull();
    } finally {
      noBirth.fromChange = false;
      noBirth.still = null;
    }
    expect(readdirSync(join(coarse, ".."))).toEqual([]);
    // A new folder to go in, not yet changed since it was made, shows its birth and last change
    // alike; the folders above it on the same device show its births kept, so one is made there.
    const fresh = root();
    noBirth.fresh = join(fresh, "..");
    try {
      const made = await ownProfilesFolder(fresh, "win32", answering(ownList));
      expect(made?.path.startsWith(`${fresh}.`)).toBe(true);
    } finally {
      noBirth.fresh = null;
    }
    // A folder put at the new folder's name before it is held, holding anything, is never held,
    // set, marked or removed, and nothing is reserved.
    const heldTheirs = root();
    let putTheirs: string | null = null;
    noBirth.opening = (path) => {
      if (putTheirs !== null || dirname(path) !== dirname(heldTheirs)) return;
      if (!basename(path).startsWith(`${basename(heldTheirs)}.`)) return;
      putTheirs = path;
      renameSync(path, `${heldTheirs}-made`);
      mkdirSync(path);
      writeFileSync(join(path, "theirs"), "kept");
    };
    const heldTheirsAsk = answering(ownList);
    try {
      expect(await ownProfilesFolder(heldTheirs, "win32", heldTheirsAsk)).toBeNull();
    } finally {
      noBirth.opening = null;
    }
    expect(putTheirs).not.toBeNull();
    expect(readdirSync(putTheirs ?? "")).toEqual(["theirs"]);
    expect(touched(heldTheirsAsk)).not.toContain(putTheirs);
    expect(existsSync(heldTheirs)).toBe(false);
    // A birth the system keeps is relied on even where the new folder's last change still reads
    // as its birth, as the folder it goes in shows the two apart.
    const coarseKept = root();
    noBirth.still = `${coarseKept}.`;
    try {
      const kept = await ownProfilesFolder(coarseKept, "win32", answering(ownList));
      expect(kept?.path.startsWith(`${coarseKept}.`)).toBe(true);
      expect((await ownProfilesFolder(coarseKept, "win32", answering(ownList)))?.path).toBe(
        kept?.path,
      );
    } finally {
      noBirth.still = null;
    }
    // A folder put in place of the new one as its mark goes in, answering its number and birth -
    // as one given the number of a folder no longer held would, on any clock - is no longer that
    // folder: nothing is reserved, and the empty folder put there stays.
    const putInPlace = root();
    let putAt: string | null = null;
    noBirth.reading = (path) => {
      if (
        putAt === null &&
        path.startsWith(`${putInPlace}.`) &&
        !path.endsWith(WORD_PROFILES_RESERVED) &&
        existsSync(join(path, WORD_PROFILES_RESERVED))
      ) {
        putAt = path;
        const { ino, birthtimeNs } = lstatSync(path, { bigint: true });
        renameSync(path, `${putInPlace}-aside`);
        mkdirSync(path);
        noBirth.number.set(path, ino);
        noBirth.birth.set(path, birthtimeNs);
      }
    };
    try {
      expect(await ownProfilesFolder(putInPlace, "win32", answering(ownList))).toBeNull();
    } finally {
      noBirth.reading = null;
      noBirth.number.clear();
      noBirth.birth.clear();
    }
    expect(putAt).not.toBeNull();
    expect(readdirSync(putAt ?? "")).toEqual([]);
    expect(existsSync(putInPlace)).toBe(false);
    // A new folder whose read-back fails, after it was made private, is removed again while empty.
    const unreadBack = root();
    let readsOfNew = 0;
    const failsBack: AccessRun = async (ask) => {
      if (ask.read.some((path) => path.startsWith(`${unreadBack}.`)) && ++readsOfNew === 2)
        throw new Error("PowerShell ended with 1");
      return answering(ownList)(ask);
    };
    expect(await ownProfilesFolder(unreadBack, "win32", failsBack)).toBeNull();
    expect(readsOfNew).toBe(2);
    expect(readdirSync(join(unreadBack, ".."))).toEqual([]);
    // A folder made that another account owns is never taken as private, nor reserved.
    const owned = root();
    expect(
      await ownProfilesFolder(
        owned,
        "win32",
        answering(`O:${other}G:${group}D:PAI(A;OICI;FA;;;${other})`),
      ),
    ).toBeNull();
    expect(existsSync(owned)).toBe(false);
    // Nor one Windows could not be asked about.
    const unread: AccessRun = async () => {
      throw new Error("no PowerShell");
    };
    expect(await ownProfilesFolder(root(), "win32", unread)).toBeNull();
    // Nor a link to a folder elsewhere, which is never asked about.
    if (process.platform !== "win32") {
      const linked = root();
      mkdirSync(join(linked, ".."), { recursive: true });
      symlinkSync(scratchDir("person-word-elsewhere-"), linked);
      const asked = answering(ownList);
      const used = (await ownProfilesFolder(linked, "win32", asked))?.path ?? "";
      expect(used.startsWith(`${linked}-2.`)).toBe(true);
      expect(touched(asked)).not.toContain(linked);
    }
  });
});
