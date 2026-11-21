import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import { hostPlatform } from "@core/platform";
import * as m from "@shared/i18n/messages.generated";
import { languageOverride, startLanguage } from "@shared/i18n/start";
import type { MessageBoxOptions } from "electron";
import {
  endWithRequester,
  PERSON_WORD_ARG,
  type PersonReply,
  type PersonWord,
  readReply,
  replyLine,
} from "./personWordArg";

/*
 * A word a window launch refused the folder's lock says to the person
 * (docs/run.md, "Opened while it runs"). Electron never becomes ready in a
 * process refused that lock before it was ready, as every window launch asks
 * for it, so the refused launch shows no box itself: it starts a copy of this
 * program that shows the one word and says which button was pressed
 * (`askPersonWord`). That copy asks for no lock, opens no first mate and
 * keeps its own throwaway profile, so it touches nothing of the folder.
 */

export {
  PERSON_WORD_ARG,
  type PersonReply,
  type PersonWord,
  personWordArg,
  wordLauncher,
} from "./personWordArg";

/** The question's Open here, after its Leave it, the first and closing answer. */
export const OPEN_ONCE_CLOSED = 1;

/**
 * The box for a word, in the language a launch speaks at its start, before
 * any choice in Settings is read (`startLanguage`): that Infinitary is open
 * and to click it in the Dock, or whether to open it here once the holder
 * that showed nothing closes, Leave it first and the answer to a box closed
 * any other way.
 */
export function personWordBox(word: PersonWord, preferred: readonly string[], packaged: boolean) {
  startLanguage(preferred, languageOverride(process.env, packaged));
  const box: MessageBoxOptions =
    word === "dock"
      ? {
          type: "info",
          title: "Infinitary",
          message: m.dialogOpenInDock(),
          detail: m.dialogOpenInDockDetail(),
        }
      : {
          type: "info",
          title: "Infinitary",
          message: m.dialogOpenInDock(),
          detail: m.dialogOnceClosedDetail(),
          buttons: [m.dialogLeaveIt(), m.dialogOpenOnceClosed()],
          defaultId: 0,
          cancelId: 0,
        };
  return box;
}

/**
 * The copy that shows one word: it keeps out of the Dock, so the Infinitary the word names there is
 * the only one to click, and ends with the launch that asked for it (`endWithRequester`). Once
 * Electron is ready it shows the box in front of whatever the person uses now and writes the button
 * pressed, or that the box could not be shown, and ends.
 */
export async function showPersonWord(word: PersonWord): Promise<void> {
  const { app, dialog } = await import("electron");
  if (hostPlatform() === "darwin") app.setActivationPolicy("accessory");
  endWithRequester(process.stdin, () => app.exit(0));
  await app.whenReady();
  const box = personWordBox(word, app.getPreferredSystemLanguages(), app.isPackaged);
  let reply: PersonReply = "unshown";
  try {
    app.focus({ steal: true });
    reply = (await dialog.showMessageBox(box)).response;
  } catch (error) {
    console.warn(`[app] could not show a word to the person: ${(error as Error).message}`);
  }
  process.stdout.write(replyLine(reply), () => app.exit(0));
}

/**
 * Shows a word through a copy of this program (`showPersonWord`) and gives its reply (`readReply`)
 * once the copy has ended and said all it had: null where the word was taken away (`signal`),
 * which ends that copy and its box, and unshown where the copy could not be made, started or show
 * its box. The copy's input stays open while this launch lives, so the copy ends with it too. Its
 * throwaway profile goes once the copy has ended, and a profile that cannot go changes no reply.
 * `launcher` starts this app as it was started (`wordLauncher`).
 */
export function askPersonWord(
  word: PersonWord,
  options: { launcher: { execPath: string; args: readonly string[] }; signal?: AbortSignal },
): Promise<PersonReply | null> {
  const { signal } = options;
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((done) => {
    let settled = false;
    let takeAway = () => {};
    const settle = (reply: PersonReply | null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", takeAway);
      done(reply);
    };
    let profile: string | null = null;
    const cleanUp = () => {
      if (profile === null) return;
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch (error) {
        console.warn(`[app] could not remove a word's profile: ${(error as Error).message}`);
      }
    };
    let copy: ChildProcess;
    try {
      profile = mkdtempSync(join(tmpdir(), "infinitary-word-"));
      copy = spawn(
        options.launcher.execPath,
        [...options.launcher.args, `${PERSON_WORD_ARG}=${word}`, `--user-data-dir=${profile}`],
        { env: hostEnv(), stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch (error) {
      console.warn(`[app] could not show a word to the person: ${(error as Error).message}`);
      cleanUp();
      settle("unshown");
      return;
    }
    let said = "";
    takeAway = () => {
      // Closing its input ends the copy on its own, should this end not reach it.
      copy.stdin?.end();
      if (!copy.kill()) console.warn("[app] could not end a word taken away; it ends on its own");
      settle(null);
    };
    signal?.addEventListener("abort", takeAway, { once: true });
    // A copy already gone leaves its input closed; writing nothing, the launch only holds it open.
    copy.stdin?.on("error", () => {});
    copy.stdout?.setEncoding("utf8");
    copy.stdout?.on("data", (chunk: string) => {
      said += chunk;
    });
    copy.once("error", (error) => {
      console.warn(`[app] could not show a word to the person: ${error.message}`);
      cleanUp();
      settle("unshown");
    });
    // Close, not exit: only once the copy's output is all read.
    copy.once("close", (code, ended) => {
      cleanUp();
      settle(signal?.aborted ? null : readReply(said, code, ended));
    });
  });
}
