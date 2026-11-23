import koffi from "koffi";
import { hostPlatform } from "../../core/platform";
import type { SecretClipboard } from "../../core/secrets/clipboard";

/**
 * Copy value's clipboard writer on Windows (docs/secrets.md, "Copying a
 * value"), through user32 in the app's own process. One open of the
 * clipboard puts the text beside the formats that keep it out of clipboard
 * history and off the cloud clipboard, and that tell clipboard monitors to
 * skip it. Electron's own clipboard calls each replace the whole clipboard,
 * so they cannot carry those formats with the text.
 */

/** CF_UNICODETEXT */
const UNICODE_TEXT = 13;
/**
 * GMEM_MOVEABLE | GMEM_ZEROINIT: the clipboard takes only movable memory, and
 * zeroed memory ends the text and makes each marker's DWORD 0.
 */
const MOVEABLE_ZEROED = 0x0042;
const UTF8 = 65001;
/** MB_ERR_INVALID_CHARS: a value that is not UTF-8 converts to nothing. */
const INVALID_CHARS = 0x8;
/** HWND_MESSAGE */
const MESSAGE_ONLY = -3;
/** Each marker's data is a DWORD 0: "no" for history and cloud, ignored for the monitor format. */
const MARKERS = [
  "ExcludeClipboardContentFromMonitorProcessing",
  "CanIncludeInClipboardHistory",
  "CanUploadToCloudClipboard",
];
/** Another program can hold the clipboard open for a moment; each try waits this long. */
const OPEN_TRIES = 10;
const OPEN_WAIT_MS = 10;

type User32 = {
  /** Writes the text and markers; the clipboard's sequence number after, or undefined. */
  write(value: Buffer): Promise<number | undefined>;
  sequence(): number;
  /** Empties the clipboard if it opens now; synchronous, for a clear the app starts as it quits. */
  empty(): void;
};

export function createWindowsSecretClipboard(): SecretClipboard | undefined {
  if (hostPlatform() !== "win32") return undefined;
  let user32: User32;
  try {
    binding ??= bindUser32();
    user32 = binding;
  } catch {
    return undefined;
  }
  /** The sequence number right after the last write, while it may still be there. */
  let written: number | undefined;
  return {
    concealed: true,
    write: async (value) => {
      written = undefined;
      try {
        written = await user32.write(value);
      } catch {
        return false;
      }
      return written !== undefined;
    },
    clear: async () => {
      const last = written;
      written = undefined;
      if (last !== undefined && user32.sequence() === last) user32.empty();
    },
  };
}

let binding: User32 | undefined;

function bindUser32(): User32 {
  const user = koffi.load("user32.dll");
  const kernel = koffi.load("kernel32.dll");
  const openClipboard = user.func("OpenClipboard", "bool", ["void *"]);
  const closeClipboard = user.func("CloseClipboard", "bool", []);
  const emptyClipboard = user.func("EmptyClipboard", "bool", []);
  const setClipboardData = user.func("SetClipboardData", "void *", ["uint32", "void *"]);
  const registerFormat = user.func("RegisterClipboardFormatW", "uint32", ["str16"]);
  const sequence = user.func("GetClipboardSequenceNumber", "uint32", []);
  const createWindow = user.func("CreateWindowExW", "void *", [
    "uint32",
    "str16",
    "str16",
    "uint32",
    "int",
    "int",
    "int",
    "int",
    "intptr",
    "void *",
    "void *",
    "void *",
  ]);
  const globalAlloc = kernel.func("GlobalAlloc", "void *", ["uint32", "size_t"]);
  const globalLock = kernel.func("GlobalLock", "void *", ["void *"]);
  const globalUnlock = kernel.func("GlobalUnlock", "bool", ["void *"]);
  const globalFree = kernel.func("GlobalFree", "void *", ["void *"]);
  const toWide = kernel.func("MultiByteToWideChar", "int", [
    "uint32",
    "uint32",
    "void *",
    "int",
    "void *",
    "int",
  ]);

  // A clipboard opened with no window has no owner, and Windows then refuses
  // SetClipboardData, so the writes belong to a message-only window of its own.
  const owner = createWindow(0, "STATIC", "", 0, 0, 0, 0, 0, MESSAGE_ONLY, null, null, null);
  if (owner == null) throw new Error("Windows made no clipboard window");
  const markers = MARKERS.map((name) => registerFormat(name));
  if (markers.some((format) => format === 0)) throw new Error("Windows registered no format");

  /** Zeroed movable memory of `size` bytes, after `fill` writes into it. */
  const memory = (size: number, fill: (at: unknown) => boolean) => {
    const handle = globalAlloc(MOVEABLE_ZEROED, size);
    if (handle == null) return undefined;
    const at = globalLock(handle);
    const filled = at != null && fill(at);
    globalUnlock(handle);
    if (filled) return handle;
    globalFree(handle);
    return undefined;
  };
  const put = (format: number, handle: unknown) => {
    if (setClipboardData(format, handle) != null) return true;
    globalFree(handle);
    return false;
  };
  const open = async () => {
    for (let tried = 1; ; tried++) {
      if (openClipboard(owner)) return true;
      if (tried === OPEN_TRIES) return false;
      await new Promise((resolve) => setTimeout(resolve, OPEN_WAIT_MS));
    }
  };

  return {
    write: async (value) => {
      // Straight from the value's bytes into Windows' memory: no string of it
      // is made in this process.
      const units = toWide(UTF8, INVALID_CHARS, value, value.length, null, 0);
      if (units <= 0) return undefined;
      const text = memory(
        (units + 1) * 2,
        (at) => toWide(UTF8, INVALID_CHARS, value, value.length, at, units) === units,
      );
      if (!text) return undefined;
      if (!(await open())) {
        globalFree(text);
        return undefined;
      }
      try {
        if (!emptyClipboard()) {
          globalFree(text);
          return undefined;
        }
        if (!put(UNICODE_TEXT, text)) return undefined;
        for (const format of markers) {
          const zero = memory(4, () => true);
          if (!zero || !put(format, zero)) {
            // The text must not stay without the formats that keep it here.
            emptyClipboard();
            return undefined;
          }
        }
      } finally {
        closeClipboard();
      }
      return sequence();
    },
    sequence: () => sequence(),
    empty: () => {
      if (!openClipboard(owner)) return;
      try {
        emptyClipboard();
      } finally {
        closeClipboard();
      }
    },
  };
}
