import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { sha256OfFile } from "./handoverFiles";

/** Task-owned evidence only: no archive path or caller-chosen destination enters this writer. */
export async function evidenceDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("The evidence folder is not a plain directory.");
}

/** Publish only a complete, verified stream; never overwrite an existing piece of evidence. */
export async function writeEvidenceFile(
  dir: string,
  name: string,
  chunks: AsyncIterable<Uint8Array>,
): Promise<{ path: string; bytes: number; sha256: string }> {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(name))
    throw new Error("Evidence needs a host-owned file name.");
  await evidenceDirectory(dir);
  const path = join(dir, name);
  const part = join(dir, `.${randomUUID()}.part`);
  const file = await open(
    part,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    // Fail before fetching a second copy, including when the destination is a broken link.
    const present = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (present) throw Object.assign(new Error("Evidence already exists."), { code: "EEXIST" });
    for await (const chunk of chunks) {
      await file.writeFile(chunk);
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
    await file.sync();
    await file.close();
    // A hard link atomically creates the final name without replacing a concurrent writer.
    await link(part, path);
    return { path, bytes, sha256: hash.digest("hex") };
  } finally {
    await file.close();
    await rm(part, { force: true });
  }
}

/** The existing source-file transport's evidence destination, one bounded piece at a time. */
export async function receiveEvidenceFile(
  dir: string,
  temp: string,
  piece: { name: string; size: number; sha256: string; offset: number; data: string },
): Promise<{ file: string; complete: boolean }> {
  await evidenceDirectory(dir);
  await evidenceDirectory(temp);
  const file = join(dir, piece.name);
  const part = join(
    temp,
    `evidence-${createHash("sha256").update(piece.name).digest("hex")}-${piece.sha256}.part`,
  );
  const existing = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing) {
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.size !== piece.size ||
      (await sha256OfFile(file)) !== piece.sha256
    )
      throw Object.assign(new Error("Evidence already exists."), { code: "EEXIST" });
    return { file, complete: true };
  }
  const handle = await open(
    part,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const bytes = Buffer.from(piece.data, "base64");
    const held = (await handle.stat()).size;
    if (piece.offset > held || piece.offset + bytes.length > piece.size)
      throw new Error("The evidence file's pieces are incomplete or exceed its size.");
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(
        bytes,
        written,
        bytes.length - written,
        piece.offset + written,
      );
      if (!result.bytesWritten) throw new Error("The evidence file could not be written.");
      written += result.bytesWritten;
    }
    if ((await handle.stat()).size !== piece.size) return { file, complete: false };
    await handle.sync();
    await handle.close();
    if ((await sha256OfFile(part)) !== piece.sha256)
      throw new Error("The evidence file did not arrive unchanged.");
    await link(part, file);
    await rm(part, { force: true });
    return { file, complete: true };
  } catch (error) {
    await rm(part, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}
