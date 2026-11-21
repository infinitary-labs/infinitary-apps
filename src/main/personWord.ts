import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostEnv } from "@core/hostEnv";
import * as m from "@shared/i18n/messages.generated";
import { languageOverride, startLanguage } from "@shared/i18n/start";
import type { MessageBoxOptions } from "electron";
import { PERSON_WORD_ARG, type PersonWord } from "./personWordArg";

/*
 * A word a window launch refused the folder's lock says to the person
 * (docs/run.md, "Opened while it runs"). Electron never becomes ready in a
 * process refused that lock before it was ready, as every window launch asks
 * for it, so the refused launch shows no box itself: it starts a copy of this
 * program that shows the one word and says which button was pressed
 * (`askPersonWord`). That copy asks for no lock, opens no first mate and
 * keeps its own throwaway profile, so it touches nothing of the folder.
 */

export { PERSON_WORD_ARG, type PersonWord, personWordArg } from "./personWordArg";

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
 * The copy that shows one word: once Electron is ready it shows the box in
 * front of whatever the person uses now, writes the button pressed and ends.
 * A box that cannot be shown is answered as closed (`cancelId`).
 */
export async function showPersonWord(word: PersonWord): Promise<void> {
  const { app, dialog } = await import("electron");
  await app.whenReady();
  const box = personWordBox(word, app.getPreferredSystemLanguages(), app.isPackaged);
  let response = box.cancelId ?? 0;
  try {
    app.focus({ steal: true });
    response = (await dialog.showMessageBox(box)).response;
  } catch (error) {
    console.warn(`[app] could not show a word to the person: ${(error as Error).message}`);
  }
  process.stdout.write(`${response}\n`, () => app.exit(0));
}

/**
 * Shows a word through a copy of this program (`showPersonWord`) and gives
 * the button pressed: null where the word was taken away (`signal`), which
 * ends that copy and its box, and the box's closing answer where the copy
 * could not show it. `args` start this app: none for an installed app, the
 * app's folder for a development run of Electron.
 */
export function askPersonWord(
  word: PersonWord,
  options: { execPath: string; args: readonly string[]; signal?: AbortSignal },
): Promise<number | null> {
  if (options.signal?.aborted) return Promise.resolve(null);
  const profile = mkdtempSync(join(tmpdir(), "infinitary-word-"));
  // Leave it for the question, the one button of the Dock's word.
  const closed = 0;
  return new Promise((done) => {
    let said = "";
    let ended = false;
    const copy = spawn(
      options.execPath,
      [...options.args, `${PERSON_WORD_ARG}=${word}`, `--user-data-dir=${profile}`],
      { env: hostEnv(), stdio: ["ignore", "pipe", "ignore"] },
    );
    const takeAway = () => copy.kill();
    options.signal?.addEventListener("abort", takeAway, { once: true });
    copy.stdout?.on("data", (chunk) => {
      said += String(chunk);
    });
    const end = (answer: number | null) => {
      if (ended) return;
      ended = true;
      options.signal?.removeEventListener("abort", takeAway);
      rmSync(profile, { recursive: true, force: true });
      done(answer);
    };
    copy.once("error", (error) => {
      console.warn(`[app] could not show a word to the person: ${error.message}`);
      end(closed);
    });
    copy.once("exit", () => {
      if (options.signal?.aborted) return end(null);
      const pressed = Number.parseInt(said.trim(), 10);
      end(Number.isInteger(pressed) ? pressed : closed);
    });
  });
}
