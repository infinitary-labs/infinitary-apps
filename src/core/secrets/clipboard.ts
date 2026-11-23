/**
 * The host's private clipboard writer for Copy value (docs/secrets.md,
 * "Copying a value"). It runs in the app's own process, never the window's
 * page, and keeps the value on this computer alone: on a Mac off Universal
 * Clipboard, on Windows off the cloud clipboard and clipboard history.
 */
export type SecretClipboard = {
  /**
   * Puts the value on this computer's clipboard in one write, replacing what
   * was there, and remembers that write. False when nothing was written. The
   * caller fills the buffer with zeros afterwards; the writer keeps no copy.
   */
  write(value: Buffer): Promise<boolean>;
  /**
   * Takes the last written value off the clipboard, only while the clipboard
   * still holds that write: something the person copied since stays.
   */
  clear(): Promise<void>;
  /**
   * Whether the one write also tells clipboard history tools that honor the
   * mark to skip it. False where the platform's write carries the text alone.
   */
  readonly concealed: boolean;
};
