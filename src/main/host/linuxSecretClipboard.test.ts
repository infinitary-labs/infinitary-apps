import { describe, expect, it } from "vitest";
import { createLinuxSecretClipboard, type TextClipboard } from "./linuxSecretClipboard";

// Intent: INF-6315's approved plan - Copy value clears the clipboard after
// its time only while it still holds the value, and writes nothing for a
// value it cannot carry whole (docs/secrets.md, "Copying a value"). The
// stand-in plays Electron's clipboard, which a unit test must never touch.
const TOKEN = "ghp_invented0LinuxCopy7Q2xV9mK4tR8wL1nB6cZ3";

function standIn(): TextClipboard & { text: string } {
  const board = {
    text: "what the person copied before",
    writeText: (text: string) => {
      board.text = text;
    },
    readText: () => board.text,
    clear: () => {
      board.text = "";
    },
  };
  return board;
}

describe("Linux clipboard writer", () => {
  it("writes the value and clears it while the clipboard still holds it", async () => {
    const board = standIn();
    const writer = createLinuxSecretClipboard(board);
    expect(writer.concealed).toBe(false);
    expect(await writer.write(Buffer.from(TOKEN))).toBe(true);
    expect(board.text).toBe(TOKEN);
    await writer.clear();
    expect(board.text).toBe("");
  });

  it("leaves alone what the person copied afterwards", async () => {
    const board = standIn();
    const writer = createLinuxSecretClipboard(board);
    await writer.write(Buffer.from(TOKEN));
    board.writeText("a note the person copied later");
    await writer.clear();
    expect(board.text).toBe("a note the person copied later");
  });

  it("writes nothing for a value that is not UTF-8", async () => {
    const board = standIn();
    const writer = createLinuxSecretClipboard(board);
    expect(await writer.write(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
    expect(board.text).toBe("what the person copied before");
  });

  it("keeps clearing an earlier copy after a later copy fails to write", async () => {
    const board = standIn();
    const writer = createLinuxSecretClipboard(board);
    await writer.write(Buffer.from(TOKEN));
    expect(await writer.write(Buffer.from([0xff, 0xfe, 0x41]))).toBe(false);
    await writer.clear();
    expect(board.text).toBe("");
  });
});
