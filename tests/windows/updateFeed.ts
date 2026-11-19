import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { join } from "node:path";
import type { UpdateChannel } from "@shared/update";
import { PUBLIC_RELEASE_NAMES, releaseSource } from "../../src/core/update/releaseSource";
import {
  type BuildsFile,
  buildDownloadUrl,
  releasesPageFor,
  WINDOWS_INSTALLER,
} from "../../src/core/update/updateChannels";
import {
  installerName,
  UPDATE_FEED_BASE,
  UPDATE_FEED_PORT,
  UPDATE_VERSIONS,
} from "./updateVersions";
import { ps } from "./windowsMachine";

/**
 * The Windows update check's own release feed (docs/windows.md, "The update
 * check"). windows.yml builds two unsigned test versions per channel whose
 * release source names this feed on the clean machine itself, so the
 * installed app reads its builds file and downloads its installer over
 * HTTPS from here, with no published release and no change to how it reads
 * them. The machine's person trusts the feed's own certificate, and only
 * for this check.
 */

/**
 * What the feed serves for the newer version's installer: the published
 * bytes, a builds file whose checksum is another file's, or a download that
 * stops partway.
 */
export type FeedMode = "published" | "wrong-checksum" | "interrupted";

export type UpdateFeed = {
  mode: FeedMode;
  /** Each request the feed answered, in order. */
  readonly asked: string[];
  close(): Promise<void>;
};

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * Serves `channel`'s builds file, naming its newer version's Windows
 * installer from `installers`, and that installer, on this machine's
 * loopback addresses only.
 */
export async function startUpdateFeed(options: {
  channel: UpdateChannel;
  installers: string;
  pfx: Buffer;
  passphrase: string;
}): Promise<UpdateFeed> {
  if (releaseSource.downloadBase !== UPDATE_FEED_BASE) {
    throw new Error(
      `the release source names ${releaseSource.downloadBase}, not this check's feed: run scripts/windows-update-source.ts first`,
    );
  }
  const [older, newer] = UPDATE_VERSIONS[options.channel];
  const name = installerName(newer);
  const file = join(options.installers, name);
  const url = buildDownloadUrl(newer, name, PUBLIC_RELEASE_NAMES);
  const prefix = new URL(url).pathname;
  const published = sha256(file);
  // A real file's checksum, the older installer's, which the newer one's bytes never match.
  const other = sha256(join(options.installers, installerName(older)));
  const feed: UpdateFeed = { mode: "published", asked: [], close: async () => {} };
  const builds = (): BuildsFile => ({
    schemaVersion: 1,
    channels: {
      [options.channel]: {
        version: newer,
        releaseUrl: releasesPageFor(options.channel, PUBLIC_RELEASE_NAMES),
        sourceCommit: "0".repeat(40),
        systems: {
          windows: {
            x64: {
              [WINDOWS_INSTALLER]: {
                url,
                sha256: feed.mode === "wrong-checksum" ? other : published,
              },
            },
          },
        },
      },
    },
  });
  const handler: Parameters<typeof createServer>[1] = (request, response) => {
    const path = new URL(request.url ?? "/", UPDATE_FEED_BASE).pathname;
    feed.asked.push(`${request.method} ${path} (${feed.mode})`);
    if (path === new URL(PUBLIC_RELEASE_NAMES.buildsFile, releaseSource.feedUrl).pathname) {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(builds()));
      return;
    }
    if (path !== prefix) {
      response.writeHead(404).end();
      return;
    }
    const size = statSync(file).size;
    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": size,
    });
    const bytes = readFileSync(file);
    if (feed.mode === "interrupted") {
      // A connection that drops a quarter of the way through.
      response.write(bytes.subarray(0, Math.floor(size / 4)), () => response.destroy());
      return;
    }
    response.end(bytes);
  };
  // Loopback only, on both addresses `localhost` may name, so Windows'
  // firewall asks the person nothing.
  const servers: Server[] = [];
  for (const host of ["127.0.0.1", "::1"]) {
    const server = createServer({ pfx: options.pfx, passphrase: options.passphrase }, handler);
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(UPDATE_FEED_PORT, host, () => done());
    });
    servers.push(server);
  }
  feed.close = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      ),
    );
  };
  return feed;
}

/**
 * The feed's certificate, made in this person's own certificate store and
 * trusted for this person alone (Trusted People, which needs no
 * administrator and asks nothing), with its PFX for the feed. Node reads
 * the Windows store when `NODE_USE_SYSTEM_CA` is 1, which `trustFeed` sets
 * in this person's environment, where Task Scheduler's command reads it.
 */
export function makeFeedCertificate(
  pfxFile: string,
  passphrase: string,
): { thumbprint: string; pfx: Buffer } {
  const thumbprint = ps<string>(
    `
    $ErrorActionPreference = 'Stop'
    $c = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(2) -KeyExportPolicy Exportable -FriendlyName 'Infinitary update check feed'
    $null = Export-PfxCertificate -Cert $c -FilePath $env:FEED_PFX -Password (ConvertTo-SecureString $env:FEED_PASS -AsPlainText -Force)
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('TrustedPeople', 'CurrentUser')
    $store.Open('ReadWrite'); $store.Add($c); $store.Close()
    $c.Thumbprint`,
    { FEED_PFX: pfxFile, FEED_PASS: passphrase },
  );
  return { thumbprint, pfx: readFileSync(pfxFile) };
}

/** Sets `NODE_USE_SYSTEM_CA=1` in this person's environment, as the person's own setting. */
export function trustSystemStore(on: boolean): void {
  ps(`[Environment]::SetEnvironmentVariable('NODE_USE_SYSTEM_CA', $env:VALUE, 'User'); $true`, {
    VALUE: on ? "1" : "",
  });
}

/** Takes the feed's certificate out of every store `makeFeedCertificate` put it in. */
export function removeFeedCertificate(thumbprint: string): void {
  ps(
    `
    foreach ($name in 'TrustedPeople', 'My') {
      $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($name, 'CurrentUser')
      $store.Open('ReadWrite')
      foreach ($c in @($store.Certificates | Where-Object { $_.Thumbprint -eq $env:THUMB })) { $store.Remove($c) }
      $store.Close()
    }
    $true`,
    { THUMB: thumbprint },
  );
}
