import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setCurrentLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import * as m from "@shared/i18n/messages.generated";
import { afterEach, describe, expect, it } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import {
  askPersonWord,
  OPEN_ONCE_CLOSED,
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
  WORD_PROFILES,
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
        dataDir: "/nonexistent/infinitary",
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

  it("has the copy take its kept profile for itself alone, and only a profile of a word", () => {
    const dataDir = scratchDir("person-word-claim-");
    let held = 0;
    const hold = (free: boolean) => () => {
      held += 1;
      return free;
    };
    for (const name of WORD_PROFILES) {
      const profile = `--user-data-dir=${join(dataDir, name)}`;
      expect(claimWordProfile(["/app", profile], hold(true))).toBe(true);
      // Another copy holding it shows nothing: two words never share one profile.
      expect(claimWordProfile(["/app", profile], hold(false))).toBe(false);
    }
    expect(held).toBe(WORD_PROFILES.length * 2);
    // A profile not of a word, or none, is never even held.
    expect(claimWordProfile(["/app", `--user-data-dir=${dataDir}`], hold(true))).toBe(false);
    expect(
      claimWordProfile(["/app", `--user-data-dir=${join(dataDir, "other")}`], hold(true)),
    ).toBe(false);
    expect(claimWordProfile(["/app"], hold(true))).toBe(false);
    expect(held).toBe(WORD_PROFILES.length * 2);
  });
});
