import koffi from "koffi";
import { hostPlatform } from "../../core/platform";
import type { SecretClipboard } from "../../core/secrets/clipboard";

/**
 * Copy value's clipboard writer on macOS (docs/secrets.md, "Copying a
 * value"), through AppKit's NSPasteboard in the app's own process. One write
 * prepares the pasteboard for this Mac alone, so Universal Clipboard never
 * carries the value to another device, and puts the text beside the
 * nspasteboard.org markers that tell clipboard history tools it is concealed
 * and transient. Electron's own clipboard calls each replace the whole
 * pasteboard, so they cannot carry the markers with the text.
 */

/** NSPasteboardContentsCurrentHostOnly */
const CURRENT_HOST_ONLY = 1;
/** NSUTF8StringEncoding */
const UTF8 = 4;
const TEXT = "public.utf8-plain-text";
const CONCEALED = "org.nspasteboard.ConcealedType";
const TRANSIENT = "org.nspasteboard.TransientType";

type Pasteboard = {
  /** Replaces the contents with the text and its markers; the change count after, or undefined. */
  write(value: Buffer): number | undefined;
  changeCount(): number;
  clearContents(): void;
  /** The text and the types on it now: for a check on its own uniquely named pasteboard only. */
  contents(): { text: string | null; types: string[] };
  /** Drops a uniquely named pasteboard; never the general one. */
  release(): void;
};

/**
 * The writer over the general pasteboard, or `name`d one for a check that
 * never touches the person's clipboard. Undefined off macOS or where AppKit
 * cannot load.
 */
export function createDarwinSecretClipboard(
  options: { name?: string } = {},
): (SecretClipboard & { pasteboard: Pasteboard }) | undefined {
  if (hostPlatform() !== "darwin") return undefined;
  let pasteboard: Pasteboard;
  try {
    binding ??= bindAppKit();
    pasteboard = binding(options.name);
  } catch {
    return undefined;
  }
  /** The change count right after the last write, while it may still be there. */
  let written: number | undefined;
  return {
    concealed: true,
    pasteboard,
    write: async (value) => {
      written = undefined;
      try {
        written = pasteboard.write(value);
      } catch {
        return false;
      }
      return written !== undefined;
    },
    // Synchronous inside, so a clear the app starts as it quits finishes first.
    clear: async () => {
      const last = written;
      written = undefined;
      if (last !== undefined && pasteboard.changeCount() === last) pasteboard.clearContents();
    },
  };
}

/** One binding per process: koffi declares each signature once. */
let binding: ((name?: string) => Pasteboard) | undefined;

function bindAppKit(): (name?: string) => Pasteboard {
  const objc = koffi.load("/usr/lib/libobjc.A.dylib");
  koffi.load("/System/Library/Frameworks/AppKit.framework/AppKit");
  const getClass = objc.func("objc_getClass", "void *", ["str"]);
  const selector = objc.func("sel_registerName", "void *", ["str"]);
  const send = objc.func("objc_msgSend", "void *", ["void *", "void *"]);
  const sendLong = objc.func("objc_msgSend", "long", ["void *", "void *"]);
  const sendObject = objc.func("objc_msgSend", "void *", ["void *", "void *", "void *"]);
  const sendUnsigned = objc.func("objc_msgSend", "long", ["void *", "void *", "ulong"]);
  const sendCString = objc.func("objc_msgSend", "void *", ["void *", "void *", "str"]);
  const sendBytes = objc.func("objc_msgSend", "void *", [
    "void *",
    "void *",
    "void *",
    "ulong",
    "ulong",
  ]);
  const sendSet = objc.func("objc_msgSend", "uint8", ["void *", "void *", "void *", "void *"]);
  const sendIndex = objc.func("objc_msgSend", "void *", ["void *", "void *", "ulong"]);
  const utf8 = objc.func("objc_msgSend", "str", ["void *", "void *"]);

  const NSString = getClass("NSString");
  const string = (text: string) =>
    sendCString(send(NSString, selector("alloc")), selector("initWithUTF8String:"), text);
  const release = (object: unknown) => {
    if (object != null) send(object, selector("release"));
  };
  // Type names live as long as the binding, as AppKit's own constants do.
  const types = { text: string(TEXT), concealed: string(CONCEALED), transient: string(TRANSIENT) };

  return (name) => {
    const NSPasteboard = getClass("NSPasteboard");
    const board =
      name === undefined
        ? send(NSPasteboard, selector("generalPasteboard"))
        : (() => {
            const text = string(name);
            try {
              return sendObject(NSPasteboard, selector("pasteboardWithName:"), text);
            } finally {
              release(text);
            }
          })();
    if (board == null) throw new Error("AppKit gave no pasteboard");
    return {
      write: (value) => {
        const text = sendBytes(
          send(NSString, selector("alloc")),
          selector("initWithBytes:length:encoding:"),
          value,
          value.length,
          UTF8,
        );
        // A value that is not UTF-8 makes no string: nothing is written, and
        // what the person had on the clipboard stays.
        if (text == null) return undefined;
        sendUnsigned(board, selector("prepareForNewContentsWithOptions:"), CURRENT_HOST_ONLY);
        const empty = string("");
        try {
          const set = (object: unknown, type: unknown) =>
            sendSet(board, selector("setString:forType:"), object, type) === 1;
          if (!set(text, types.text)) return undefined;
          set(empty, types.concealed);
          set(empty, types.transient);
        } finally {
          release(text);
          release(empty);
        }
        return Number(sendLong(board, selector("changeCount")));
      },
      changeCount: () => Number(sendLong(board, selector("changeCount"))),
      clearContents: () => {
        sendLong(board, selector("clearContents"));
      },
      contents: () => {
        const text = sendObject(board, selector("stringForType:"), types.text);
        const list = send(board, selector("types"));
        const count = list == null ? 0 : Number(sendLong(list, selector("count")));
        const names: string[] = [];
        for (let at = 0; at < count; at++)
          names.push(
            String(utf8(sendIndex(list, selector("objectAtIndex:"), at), selector("UTF8String"))),
          );
        return {
          text: text == null ? null : String(utf8(text, selector("UTF8String"))),
          types: names,
        };
      },
      release: () => {
        if (name === undefined) throw new Error("The general pasteboard is never released.");
        send(board, selector("releaseGlobally"));
      },
    };
  };
}
