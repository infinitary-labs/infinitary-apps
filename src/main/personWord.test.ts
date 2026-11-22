import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setCurrentLanguage } from "@shared/i18n/current";
import { SOURCE_LANGUAGE } from "@shared/i18n/languages";
import * as m from "@shared/i18n/messages.generated";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scratchDir } from "../../tests/helpers/scratchDirs";
import {
  askPersonWord,
  keptToOwner,
  OPEN_ONCE_CLOSED,
  oneWordAtATime,
  PERSON_WORD_ARG,
  personWordArg,
  personWordBox,
  wordLauncher,
  wordProfilePrivate,
} from "./personWord";
import {
  claimWordProfile,
  endWithRequesterGone,
  HELD_LINE,
  readReply,
  replyLine,
  requesterOf,
  saidHeld,
  WORD_BUTTONS,
  WORD_REQUESTER_ARG,
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
    // Electron on Windows writes an empty line of its own to a copy's output, as a copy there that
    // wrote nothing said "\r\n" (the Windows check of INF-4930): a press beside it still counts,
    // and it alone is no press.
    expect(readReply("once-closed", `\r\n${replyLine(0)}`, 0, null)).toBe(0);
    expect(readReply("once-closed", `${replyLine(OPEN_ONCE_CLOSED)}\r\n`, 0, null)).toBe(
      OPEN_ONCE_CLOSED,
    );
    expect(readReply("once-closed", "\r\n", 0, null)).toBe("unshown");
    expect(saidHeld(`\r\n${HELD_LINE}`, 0, null)).toBe(true);
  });

  it("ends the copy on Windows once the launch that asked, named by its process number, is gone", () => {
    vi.useFakeTimers();
    try {
      expect(requesterOf(["app", `${WORD_REQUESTER_ARG}=4242`])).toBe(4242);
      for (const arg of [`${WORD_REQUESTER_ARG}=`, `${WORD_REQUESTER_ARG}=-1`, "other"])
        expect(requesterOf(["app", arg])).toBe(null);
      let running = true;
      let ended = 0;
      endWithRequesterGone(
        4242,
        () => ended++,
        (pid) => pid === 4242 && running,
      );
      vi.advanceTimersByTime(5_000);
      expect(ended).toBe(0);
      running = false;
      vi.advanceTimersByTime(500);
      vi.advanceTimersByTime(5_000);
      expect(ended).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
    const profile = `--user-data-dir=${join(dataDir, "word-profile-Ab12Cd")}`;
    expect(claimWordProfile(["/app", profile], hold(true))).toBe(true);
    // Another copy holding it shows nothing: two words never share one profile.
    expect(claimWordProfile(["/app", profile], hold(false))).toBe(false);
    expect(held).toBe(2);
    // A profile not of a word, or none, is never even held.
    for (const other of [dataDir, join(dataDir, "other"), join(dataDir, "word-profile")])
      expect(claimWordProfile(["/app", `--user-data-dir=${other}`], hold(true))).toBe(false);
    expect(claimWordProfile(["/app"], hold(true))).toBe(false);
    expect(held).toBe(2);
  });

  it("starts the next word only once the one before it, taken away, has answered", async () => {
    const inTurn = oneWordAtATime();
    let endFirst = () => {};
    const order: string[] = [];
    const first = inTurn(
      () =>
        new Promise<null>((resolve) => {
          order.push("first shown");
          endFirst = () => {
            order.push("first ended");
            resolve(null);
          };
        }),
    );
    const second = inTurn(async () => {
      order.push("second shown");
      return 0;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first shown"]);
    endFirst();
    expect(await first).toBeNull();
    expect(await second).toBe(0);
    expect(order).toEqual(["first shown", "first ended", "second shown"]);
    // One that failed still lets the next start.
    const failed = inTurn(async () => {
      throw new Error("no copy");
    });
    await expect(failed).rejects.toThrow("no copy");
    expect(await inTurn(async () => "after")).toBe("after");
  });

  it("reads Windows' lists of a word's profile and its temporary folder by the order asked", async () => {
    const user = "S-1-5-21-1-2-3-1001";
    const kept = `O:${user}D:(A;OICIID;FA;;;${user})`;
    const notHanded = `O:${user}D:P(A;;FA;;;${user})`;
    const answer =
      (...sddl: (string | null)[]) =>
      async () => ({
        user,
        set: [],
        // Printed back in another spelling: matched by order, never by path.
        read: sddl.map((each, index) => ({ path: `X:\\${index}`, sddl: each, error: null })),
      });
    const paths = ["C:\\data\\word-profile-Ab12Cd", "C:\\data\\word-profile-Ab12Cd\\temp"];
    expect(await keptToOwner(paths, "win32", answer(kept, kept))).toBe(true);
    expect(await keptToOwner(paths, "win32", answer(kept, notHanded))).toBe(false);
    expect(await keptToOwner(paths, "win32", answer(kept, null))).toBe(false);
    expect(await keptToOwner(paths, "win32", answer(kept))).toBe(false);
    expect(
      await keptToOwner(paths, "win32", async () => {
        throw new Error("PowerShell could not start");
      }),
    ).toBe(false);
  });
});
