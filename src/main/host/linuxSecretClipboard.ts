import { createHmac, randomBytes } from "node:crypto";
import type { SecretClipboard } from "../../core/secrets/clipboard";

/** The part of Electron's clipboard the Linux writer uses. */
export type TextClipboard = {
  writeText(text: string): void;
  readText(): string;
  clear(): void;
};

/**
 * Copy value's clipboard writer on Linux (docs/secrets.md, "Copying a
 * value"), through Electron's clipboard in the app's own process. Electron
 * writes the text alone, so no marker tells a clipboard history tool to skip
 * it (`concealed` false), and the row says one may keep it. Linux has no
 * change count, so the clear compares a keyed digest of what the clipboard
 * holds now with the one this write made, never the value itself.
 */
export function createLinuxSecretClipboard(clipboard: TextClipboard): SecretClipboard {
  const key = randomBytes(32);
  const digest = (text: string) => createHmac("sha256", key).update(text).digest("hex");
  let written: string | undefined;
  return {
    concealed: false,
    // The last write's digest stays until a new write lands, so a failed copy
    // never strands the earlier value past its clear.
    write: async (value) => {
      const text = value.toString("utf8");
      // A value that is not UTF-8 decodes with replacement characters: nothing is written.
      const back = Buffer.from(text, "utf8");
      const same = back.equals(value);
      back.fill(0);
      if (!same) return false;
      try {
        clipboard.writeText(text);
      } catch {
        return false;
      }
      written = digest(text);
      return true;
    },
    // Synchronous inside, so a clear the app starts as it quits finishes first.
    clear: async () => {
      const last = written;
      written = undefined;
      if (last !== undefined && digest(clipboard.readText()) === last) clipboard.clear();
    },
  };
}
