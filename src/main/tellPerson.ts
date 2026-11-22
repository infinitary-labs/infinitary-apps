import { hostPlatform } from "@core/platform";
import { app } from "electron";
import {
  askPersonWord,
  oneWordAtATime,
  type PersonReply,
  type PersonWord,
  personWordBox,
  wordLauncher,
  wordProfilePrivate,
} from "./personWord";
import { TOLD_THE_PERSON } from "./runReopen";

/** What a launch refused the lock says to the person through: one word at a time. */
export type TellPerson = (
  word: PersonWord,
  signal?: AbortSignal,
  wanted?: () => boolean,
) => Promise<PersonReply | null>;

/**
 * A word to the person from a launch refused the lock (`askPersonWord`): Electron never becomes
 * ready in that launch, refused the lock before it was, so a copy of this program shows the word,
 * and is ended when the word is taken away. A word taken away or no longer wanted (`wanted`) is
 * never shown. A check's hidden launch shows none and says its words in its output instead, as a
 * launch does whose copy could not show it or that made none, its profile having nowhere private
 * to go, so a launch from a terminal still tells: null for the first.
 *
 * One word at a time (`oneWordAtATime`): a word taken away answers only once its copy has ended
 * and let the profile go (`askPersonWord`), so the next word waits for that, then asks again
 * whether it is still wanted, and takes the profile itself rather than finding it held and showing
 * nothing. Two launches refused at once each ask their own question, the second through the next
 * recorded profile; a second Dock word is said in that launch's output.
 */
export function personTeller(options: {
  /** A check's hidden launch, which says its words in its output. */
  hideWindow: boolean;
  dataDir: string;
  /** What keeping the data folder private found, null where it was never judged. */
  privacy: { readonly refused: unknown } | null;
}): TellPerson {
  const sayInOutput = (word: PersonWord) => {
    const box = personWordBox(word, app.getPreferredSystemLanguages(), app.isPackaged);
    console.warn(`${TOLD_THE_PERSON} ${box.message} ${box.detail ?? ""}`.trimEnd());
  };
  const tellNow = async (
    word: PersonWord,
    signal: AbortSignal | undefined,
    wanted: () => boolean,
  ): Promise<PersonReply | null> => {
    if (signal?.aborted || !wanted()) return null;
    if (options.hideWindow) {
      sayInOutput(word);
      return null;
    }
    const reply = await askPersonWord(word, {
      launcher: wordLauncher({
        packaged: app.isPackaged,
        platform: hostPlatform(),
        execPath: process.execPath,
        appPath: app.getAppPath(),
        resourcesDir: process.resourcesPath,
        env: process.env,
      }),
      // Kept in the data folder, away from the temporary folder its holder clears; on Windows
      // only where the data folder was kept private.
      dataDir: wordProfilePrivate(hostPlatform(), options.privacy) ? options.dataDir : null,
      signal,
    });
    if (reply === "unshown" && !signal?.aborted) sayInOutput(word);
    return reply;
  };
  const inTurn = oneWordAtATime();
  return (word, signal, wanted = () => true) => inTurn(() => tellNow(word, signal, wanted));
}
