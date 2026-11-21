import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccessAsk, AccessRun } from "@core/storage/ownerOnly";
import { setCurrentLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import * as m from "@shared/i18n/messages.generated";
import { afterEach, describe, expect, it } from "vitest";
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
  WORD_PROFILES_MARK,
  WORD_PROFILES_RESERVED,
  WORD_TEMP_DIR,
} from "./personWordArg";

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
    const answering = (
      sddl: string,
      at: (path: string) => string = () => sddl,
    ): AccessRun & { asks: AccessAsk[] } => {
      const asks: AccessAsk[] = [];
      return Object.assign(
        async (ask: AccessAsk) => {
          asks.push(ask);
          return {
            user,
            set: ask.set.map((each) => ({ path: each.path, error: null })),
            read: ask.read.map((path) => ({ path, sddl: at(path), error: null })),
          };
        },
        { asks },
      );
    };
    const root = () => join(scratchDir("person-word-windows-"), "word-profiles");
    const own = answering(`O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})`);
    const ownRoot = root();
    expect((await ownProfilesFolder(ownRoot, "win32", own))?.path).toBe(ownRoot);
    expect(own.asks[0]?.read).toEqual([ownRoot]);
    // Found again by a later launch through one read, with nothing set on it.
    const again = answering(`O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})`);
    expect((await ownProfilesFolder(ownRoot, "win32", again))?.path).toBe(ownRoot);
    expect(again.asks).toEqual([{ set: [], read: [ownRoot] }]);
    // One already there that is not owner-only, or whose mark is not the app's, is only read:
    // no access list is set on it, and a folder at the next name is made instead.
    const shared = root();
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, WORD_PROFILES_RESERVED), WORD_PROFILES_MARK);
    const inherited = answering(`O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})`, (path) =>
      path === shared
        ? `O:${user}G:${group}D:AI(A;OICI;FA;;;${user})`
        : `O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})`,
    );
    expect((await ownProfilesFolder(shared, "win32", inherited))?.path).toBe(`${shared}-2`);
    expect(inherited.asks.flatMap((ask) => ask.set.map((each) => each.path))).not.toContain(shared);
    const marked = root();
    mkdirSync(marked, { recursive: true });
    writeFileSync(join(marked, WORD_PROFILES_RESERVED), "someone else's\n");
    const malformed = answering(`O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})`);
    expect((await ownProfilesFolder(marked, "win32", malformed))?.path).toBe(`${marked}-2`);
    expect(malformed.asks.flatMap((ask) => ask.set.map((each) => each.path))).not.toContain(marked);
    expect(readFileSync(join(marked, WORD_PROFILES_RESERVED), "utf8")).toBe("someone else's\n");
    // A folder already there that another account owns is never taken as private.
    expect(
      await ownProfilesFolder(
        root(),
        "win32",
        answering(`O:${other}G:${group}D:PAI(A;OICI;FA;;;${other})`),
      ),
    ).toBeNull();
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
      const asked = answering(`O:${user}G:${group}D:PAI(A;OICI;FA;;;${user})`);
      expect((await ownProfilesFolder(linked, "win32", asked))?.path).toBe(`${linked}-2`);
      expect(
        asked.asks.flatMap((ask) => [...ask.read, ...ask.set.map((each) => each.path)]),
      ).toEqual([`${linked}-2`]);
    }
  });
});
