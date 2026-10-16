import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

/** The existing card limit is in JS characters, not encoded bytes. */
export const MAX_CARD_BODY_LENGTH = 65_536;
const MAX_FILE_BYTES = MAX_CARD_BODY_LENGTH * 3;

/** Read one explicit snapshot; editing the author's file never shows a card. */
export async function readCardBodyFile(path: string, dir?: string): Promise<string> {
  if (!dir) throw new Error("Card body file refused: this task has no card body folder.");
  let root: string;
  let file: string;
  try {
    root = await realpath(dir);
    file = await realpath(resolve(dir, path));
  } catch {
    throw new Error("Card body file refused: file not found in the task's card body folder.");
  }
  const rel = relative(root, file);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("Card body file refused: path must stay inside the task's card body folder.");
  }
  if (!(await stat(file)).isFile()) {
    throw new Error("Card body file refused: body_file must be a regular file.");
  }
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new Error("Card body file refused: body_file must be a regular file.");
    if (info.size > MAX_FILE_BYTES)
      throw new Error("Card body too large (64KB max); emit a smaller card.");
    // Bound the read too, so a growing file cannot evade the pre-read limit.
    const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > MAX_FILE_BYTES)
      throw new Error("Card body too large (64KB max); emit a smaller card.");
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(0, size),
      );
    } catch {
      throw new Error("Card body file refused: body_file must contain UTF-8 HTML.");
    }
  } finally {
    await handle.close();
  }
}
