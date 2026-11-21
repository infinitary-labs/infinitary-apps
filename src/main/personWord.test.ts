import { setCurrentLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import * as m from "@shared/i18n/messages.generated";
import { afterEach, describe, expect, it } from "vitest";
import {
  askPersonWord,
  OPEN_ONCE_CLOSED,
  PERSON_WORD_ARG,
  personWordArg,
  personWordBox,
  wordLauncher,
} from "./personWord";
import { readReply, replyLine } from "./personWordArg";

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
  });

  it("starts no copy for a word taken away before it is shown", async () => {
    const taken = new AbortController();
    taken.abort();
    // A copy started from a program that is not there would answer unshown, not null.
    expect(
      await askPersonWord("once-closed", {
        launcher: { execPath: "/nonexistent/infinitary", args: [] },
        signal: taken.signal,
      }),
    ).toBeNull();
  });

  it("reads a press only from a whole reply of a copy that ended cleanly", () => {
    expect(readReply(replyLine(OPEN_ONCE_CLOSED), 0, null)).toBe(OPEN_ONCE_CLOSED);
    expect(readReply(replyLine(0), 0, null)).toBe(0);
    expect(readReply(replyLine("unshown"), 0, null)).toBe("unshown");
    // Cut short, more than one line, or not a press.
    for (const said of [
      "",
      "pressed:",
      "pressed:1",
      "pressed:1\npressed:0\n",
      "1\n",
      "pressed:-1\n",
    ])
      expect(readReply(said, 0, null)).toBe("unshown");
    // A copy that failed or was ended says nothing the person chose.
    expect(readReply(replyLine(OPEN_ONCE_CLOSED), 1, null)).toBe("unshown");
    expect(readReply(replyLine(OPEN_ONCE_CLOSED), null, "SIGKILL")).toBe("unshown");
  });

  it("starts the copy as the launch was started, an AppImage through its own file", () => {
    const appPath = "/src/app";
    expect(wordLauncher({ packaged: false, execPath: "/electron", appPath })).toEqual({
      execPath: "/electron",
      args: [appPath],
    });
    expect(
      wordLauncher({ packaged: true, execPath: "/opt/Infinitary/infinitary", appPath }),
    ).toEqual({ execPath: "/opt/Infinitary/infinitary", args: [] });
    expect(
      wordLauncher({
        packaged: true,
        execPath: "/tmp/.mount_Infini/infinitary",
        appPath,
        appImage: "/home/a/Infinitary.AppImage",
      }),
    ).toEqual({ execPath: "/home/a/Infinitary.AppImage", args: [] });
  });
});
