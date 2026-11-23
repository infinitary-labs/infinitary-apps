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

/** The user32 and kernel32 calls the writer makes; a check supplies a stand-in. */
export type WindowsClipboardCalls = {
  /** OpenClipboard for the writer's own window. */
  open(): boolean;
  close(): void;
  empty(): boolean;
  /** SetClipboardData; on success Windows owns the memory. */
  put(format: number, memory: unknown): boolean;
  /** Movable memory holding the value as UTF-16 text; undefined when it is not UTF-8 or none is left. */
  text(value: Buffer): unknown;
  /** Movable memory holding a DWORD 0. */
  zero(): unknown;
  free(memory: unknown): void;
  sequence(): number;
  /** The registered marker formats, in `MARKERS` order. */
  markers: readonly number[];
};

export function createWindowsSecretClipboard(
  calls?: WindowsClipboardCalls,
): SecretClipboard | undefined {
  let api = calls;
  if (!api) {
    if (hostPlatform() !== "win32") return undefined;
    try {
      binding ??= bindUser32();
      api = binding;
    } catch {
      return undefined;
    }
  }
  const user32 = api;
  /** The sequence number right after the last write that landed, while it may still be there. */
  let written: number | undefined;
  const open = async () => {
    for (let tried = 1; ; tried++) {
      if (user32.open()) return true;
      if (tried === OPEN_TRIES) return false;
      await new Promise((resolve) => setTimeout(resolve, OPEN_WAIT_MS));
    }
  };
  /** The sequence number after the text and every marker are on the clipboard, or undefined. */
  const write = async (value: Buffer): Promise<number | undefined> => {
    const text = user32.text(value);
    if (text == null) return undefined;
    if (!(await open())) {
      user32.free(text);
      return undefined;
    }
    try {
      if (!user32.empty()) {
        user32.free(text);
        return undefined;
      }
      if (!user32.put(UNICODE_TEXT, text)) {
        user32.free(text);
        return undefined;
      }
      for (const format of user32.markers) {
        const zero = user32.zero();
        if (zero == null || !user32.put(format, zero)) {
          if (zero != null) user32.free(zero);
          // The text must not stay without the formats that keep it here.
          user32.empty();
          return undefined;
        }
      }
    } finally {
      user32.close();
    }
    return user32.sequence();
  };
  return {
    concealed: true,
    // The last write's mark stays until a new write lands, so a failed copy
    // never strands the earlier value past its clear; the sequence number
    // keeps that clear from touching anything newer.
    write: async (value) => {
      let next: number | undefined;
      try {
        next = await write(value);
      } catch {
        return false;
      }
      if (next === undefined) return false;
      written = next;
      return true;
    },
    // Synchronous inside, so a clear the app starts as it quits finishes first.
    clear: async () => {
      const last = written;
      written = undefined;
      if (last === undefined || user32.sequence() !== last || !user32.open()) return;
      try {
        user32.empty();
      } finally {
        user32.close();
      }
    },
  };
}

let binding: WindowsClipboardCalls | undefined;

function bindUser32(): WindowsClipboardCalls {
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

  return {
    open: () => openClipboard(owner),
    close: () => {
      closeClipboard();
    },
    empty: () => emptyClipboard(),
    put: (format, handle) => setClipboardData(format, handle) != null,
    // Straight from the value's bytes into Windows' memory: no string of it
    // is made in this process.
    text: (value) => {
      const units = toWide(UTF8, INVALID_CHARS, value, value.length, null, 0);
      if (units <= 0) return undefined;
      return memory(
        (units + 1) * 2,
        (at) => toWide(UTF8, INVALID_CHARS, value, value.length, at, units) === units,
      );
    },
    zero: () => memory(4, () => true),
    free: (handle) => {
      globalFree(handle);
    },
    sequence: () => sequence(),
    markers,
  };
}
