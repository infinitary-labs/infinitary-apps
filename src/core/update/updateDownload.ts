import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as m from "@shared/i18n/messages.generated";
import type { UpdateChannel } from "@shared/update";
import type { BuildDownload } from "./releaseBuilds";
import { UPDATE_CHANNEL_MARKER, type UpdateChannelMarker } from "./updateChannels";

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
    throw new UpdateInstallProblem(m.updateDownloadUnreachable());
  }
  if (!response.ok || !response.body) {
    throw new UpdateInstallProblem(m.updateDownloadRefused({ status: String(response.status) }));
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
        ? m.updateDownloadNoWrite({ folder: dirname(file) })
        : m.updateDownloadStopped(),
    );
  }
  if (hash.digest("hex") !== download.sha256) {
    await rm(file, { force: true });
    throw new UpdateInstallProblem(m.updateDownloadChecksum());
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
  await replaceChannelMarker(dataRoot, `${JSON.stringify(marker)}\n`);
}

/** Writes the marker whole, through a file beside it, so a reader never sees half of it. */
async function replaceChannelMarker(dataRoot: string, text: string): Promise<void> {
  const path = join(dataRoot, UPDATE_CHANNEL_MARKER);
  const temporary = `${path}.${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, text);
    await rename(temporary, path);
  } catch (caught) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw caught;
  }
}

/**
 * The channel marker's text as it is now, for an update that may have to
 * put it back; null only when there is none. A marker that cannot be read
 * throws, so nothing replaces what could not be kept.
 */
export async function readChannelMarker(dataRoot: string): Promise<string | null> {
  try {
    return await readFile(join(dataRoot, UPDATE_CHANNEL_MARKER), "utf8");
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw caught;
  }
}

/** Puts back the marker `readChannelMarker` read, or takes it away when there was none. */
export async function restoreChannelMarker(
  dataRoot: string,
  earlier: string | null,
): Promise<void> {
  if (earlier === null) await rm(join(dataRoot, UPDATE_CHANNEL_MARKER), { force: true });
  else await replaceChannelMarker(dataRoot, earlier);
}
