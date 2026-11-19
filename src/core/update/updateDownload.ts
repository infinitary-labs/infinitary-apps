import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { UpdateChannel } from "@shared/update";
import {
  type BuildDownload,
  UPDATE_CHANNEL_MARKER,
  type UpdateChannelMarker,
} from "./updateChannels";

/**
 * Why an update did not install, in words the update panel shows as they
 * are. Nothing was replaced when one is thrown.
 */
export class UpdateInstallProblem extends Error {
  override name = "UpdateInstallProblem";
}

/**
 * Downloads an offered build to `file` and keeps it only when its bytes
 * match the builds file's published SHA-256 (docs/alpha.md "Builds by
 * system and chip"): a download that fails, stops partway or does not
 * match is removed, and the problem says which.
 */
export async function downloadChecked(
  fetchImpl: typeof fetch,
  download: BuildDownload,
  file: string,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(download.url, {
      headers: { "User-Agent": "infinitary" },
      redirect: "follow",
    });
  } catch {
    throw new UpdateInstallProblem(
      "Infinitary could not reach the download. Check your connection and try again.",
    );
  }
  if (!response.ok || !response.body) {
    throw new UpdateInstallProblem(
      `The download did not start (the server answered ${response.status}). Try again later.`,
    );
  }
  const hash = createHash("sha256");
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      hashing,
      createWriteStream(file, { mode: 0o600 }),
    );
  } catch (caught) {
    await rm(file, { force: true });
    const code = (caught as NodeJS.ErrnoException).code;
    throw new UpdateInstallProblem(
      code === "EACCES" || code === "EROFS" || code === "EPERM"
        ? `Infinitary cannot write in ${dirname(file)}. Move the app to a folder you own, such as your home folder, and try again.`
        : "The download stopped before it finished. Try again.",
    );
  }
  if (hash.digest("hex") !== download.sha256) {
    await rm(file, { force: true });
    throw new UpdateInstallProblem(
      "The download did not match its published checksum, so nothing was installed.",
    );
  }
}

/**
 * Remembers the channel an update was installed from, for the version it
 * installed, so an alpha installation that took a stable version stays on
 * alpha (docs/alpha.md "Update channels"). The marker holds only while
 * that version runs.
 */
export async function rememberUpdateChannel(
  dataRoot: string,
  channel: UpdateChannel,
  version: string,
): Promise<void> {
  const marker: UpdateChannelMarker = { schemaVersion: 1, channel, version };
  const path = join(dataRoot, UPDATE_CHANNEL_MARKER);
  const temporary = `${path}.${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, `${JSON.stringify(marker)}\n`);
  await rename(temporary, path);
}
