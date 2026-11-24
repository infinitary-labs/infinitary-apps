import { describe, expect, it } from "vitest";
import { createWindowsSecretClipboard, type WindowsClipboardCalls } from "./windowsSecretClipboard";

// Intent: INF-6315's approved plan - Copy value puts the value on this
// computer's clipboard with the formats that keep it out of clipboard history
// and off the cloud clipboard, never leaves the text without them, and clears
// it after its time only while the clipboard still holds it
// (docs/secrets.md, "Copying a value"). The stand-in plays user32's clipboard
// as Windows keeps it: a sequence number that moves on each change, formats
// that stay until the next empty, and an open another program can hold.
const TOKEN = "ghp_invented0WindowsCopy7Q2xV9mK4tR8wL1nB6cZ3";
const TEXT = 13;
const MARKERS = [0xc101, 0xc102, 0xc103] as const;

function standIn(options: { busyFor?: number; failMarker?: number } = {}) {
  let busy = options.busyFor ?? 0;
  const board = {
    formats: new Map<number, string>([[TEXT, "what the person copied before"]]),
    sequence: 1,
    opened: false,
    freed: 0,
    /** Another program replaces the clipboard, as a person's next copy does. */
    copyElsewhere(text: string) {
      board.formats = new Map([[TEXT, text]]);
      board.sequence += 1;
    },
  };
  const calls: WindowsClipboardCalls = {
    open: () => {
      if (busy > 0) {
        busy -= 1;
        return false;
      }
      board.opened = true;
      return true;
    },
    close: () => {
      board.opened = false;
    },
    empty: () => {
      board.formats.clear();
      board.sequence += 1;
      return true;
    },
    put: (format, memory) => {
      if (format === options.failMarker) return false;
      board.formats.set(format, String(memory));
      board.sequence += 1;
      return true;
    },
    text: (value) => {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(value);
      return Buffer.from(text, "utf8").equals(value) ? text : undefined;
    },
    zero: () => "0",
    free: () => {
      board.freed += 1;
    },
    sequence: () => board.sequence,
    markers: MARKERS,
  };
  return { board, calls };
}

describe("Windows clipboard writer", () => {
  it("writes the text with every marker, then clears it while the clipboard still holds it", async () => {
    const { board, calls } = standIn();
    const writer = createWindowsSecretClipboard(calls);
    expect(await writer?.write(Buffer.from(TOKEN))).toBe(true);
    expect(Object.fromEntries(board.formats)).toEqual({
      [TEXT]: TOKEN,
      [MARKERS[0]]: "0",
      [MARKERS[1]]: "0",
      [MARKERS[2]]: "0",
    });
    expect(board.opened).toBe(false);
    await writer?.clear();
    expect(board.formats.size).toBe(0);
  });

  it("leaves alone what the person copied afterwards", async () => {
    const { board, calls } = standIn();
    const writer = createWindowsSecretClipboard(calls);
    await writer?.write(Buffer.from(TOKEN));
    board.copyElsewhere("a note the person copied later");
    await writer?.clear();
    expect(board.formats.get(TEXT)).toBe("a note the person copied later");
  });

  it("waits out a clipboard another program holds for a moment, and gives up on one it keeps", async () => {
    const brief = standIn({ busyFor: 3 });
    expect(await createWindowsSecretClipboard(brief.calls)?.write(Buffer.from(TOKEN))).toBe(true);
    expect(brief.board.formats.get(TEXT)).toBe(TOKEN);

    const held = standIn({ busyFor: 100 });
    expect(await createWindowsSecretClipboard(held.calls)?.write(Buffer.from(TOKEN))).toBe(false);
    expect(held.board.formats.get(TEXT)).toBe("what the person copied before");
    expect(held.board.freed).toBe(1);
  });

  it("never leaves the text without the formats that keep it on this computer", async () => {
    const { board, calls } = standIn({ failMarker: MARKERS[2] });
    const writer = createWindowsSecretClipboard(calls);
    expect(await writer?.write(Buffer.from(TOKEN))).toBe(false);
    expect(board.formats.size).toBe(0);
    expect(board.opened).toBe(false);
  });

  it("keeps clearing an earlier copy after a later copy fails to write", async () => {
    const { board, calls } = standIn();
    const writer = createWindowsSecretClipboard(calls);
    await writer?.write(Buffer.from(TOKEN));
    expect(await writer?.write(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
    expect(board.formats.get(TEXT)).toBe(TOKEN);
    await writer?.clear();
    expect(board.formats.size).toBe(0);
  });
});
