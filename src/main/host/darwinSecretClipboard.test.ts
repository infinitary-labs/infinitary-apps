import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDarwinSecretClipboard } from "./darwinSecretClipboard";

const boards: { release(): void }[] = [];
afterEach(() => {
  for (const board of boards.splice(0)) board.release();
});

/** A writer on a pasteboard of its own name, so the check never reads or replaces the person's clipboard. */
function ownBoard(name: string) {
  const clipboard = createDarwinSecretClipboard({ name });
  if (!clipboard) throw new Error("AppKit did not load.");
  boards.push(clipboard.pasteboard);
  return clipboard;
}

// Intent: INF-6315's approved plan, the captain's answers "this computer only"
// and "clear after 90 seconds": Copy value writes the text with the concealed
// and transient markers in one write, and its clear takes it off only while the
// pasteboard still holds that write (docs/secrets.md, "Copying a value").
// Data: an invented value on a uniquely named pasteboard; never the general one.
describe.skipIf(process.platform !== "darwin")("macOS secret clipboard", () => {
  it("writes the value with its private markers, then clears it", async () => {
    const name = `app.infinitary.secret-clipboard-check.${randomUUID()}`;
    const clipboard = ownBoard(name);
    const value = Buffer.from("invented-copy-value ✓ 6315");
    expect(await clipboard.write(value)).toBe(true);
    const written = clipboard.pasteboard.contents();
    expect(written.text).toBe(value.toString("utf8"));
    expect(written.types).toEqual(
      expect.arrayContaining([
        "public.utf8-plain-text",
        "org.nspasteboard.ConcealedType",
        "org.nspasteboard.TransientType",
      ]),
    );
    await clipboard.clear();
    expect(clipboard.pasteboard.contents()).toEqual({ text: null, types: [] });
  });

  it("leaves what was copied after it", async () => {
    const name = `app.infinitary.secret-clipboard-check.${randomUUID()}`;
    const clipboard = ownBoard(name);
    expect(await clipboard.write(Buffer.from("invented-copy-value"))).toBe(true);
    // Another copy on the same pasteboard, as the person copying something else.
    const later = createDarwinSecretClipboard({ name });
    expect(await later?.write(Buffer.from("something copied after"))).toBe(true);
    await clipboard.clear();
    expect(clipboard.pasteboard.contents().text).toBe("something copied after");
  });

  it("writes nothing for a value that is not text, and keeps what was there", async () => {
    const name = `app.infinitary.secret-clipboard-check.${randomUUID()}`;
    const clipboard = ownBoard(name);
    expect(await createDarwinSecretClipboard({ name })?.write(Buffer.from("copied before"))).toBe(
      true,
    );
    expect(await clipboard.write(Buffer.from([0xff, 0xfe, 0xfd]))).toBe(false);
    expect(clipboard.pasteboard.contents().text).toBe("copied before");
  });
});
