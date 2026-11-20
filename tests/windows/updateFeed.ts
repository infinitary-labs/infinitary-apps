import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { powershellPath, pressDialogButton, ps } from "./windowsMachine";

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
    // A reader that did not trust the certificate shows here, not as a request.
    server.on("tlsClientError", (error) => {
      feed.asked.push(`TLS refused on ${host}: ${error.message}`);
    });
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
 * trusted for this person alone as a root (their own Trusted Root
 * Certification Authorities, which needs no administrator), with its PFX for
 * the feed. Like the Mac's update check's, it is its own authority
 * (basic constraints CA true, allowed to sign certificates) naming localhost
 * and both loopback addresses. Node reads the Windows store when `NODE_USE_SYSTEM_CA` is 1,
 * which `trustSystemStore` sets in this person's environment, where Task
 * Scheduler's command reads it. Every Node reads this person's roots there;
 * the Node inside Electron reads no certificate this person trusts only as
 * Trusted People.
 */
export async function makeFeedCertificate(
  pfxFile: string,
  passphrase: string,
  wait: (done: () => boolean) => Promise<void>,
  treeFile?: string,
): Promise<{ thumbprint: string; pfx: Buffer }> {
  const thumbprint = ps<string>(
    `
    $ErrorActionPreference = 'Stop'
    $c = New-SelfSignedCertificate -Subject 'CN=localhost' -TextExtension @('2.5.29.19={critical}{text}ca=1', '2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1&IPAddress=::1') -KeyUsage CertSign, DigitalSignature, KeyEncipherment -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(2) -KeyExportPolicy Exportable -FriendlyName 'Infinitary update check feed'
    $c.Thumbprint`,
  );
  // From here the certificate is in this person's store: a step that fails
  // takes it out of every store it reached before the failure goes on.
  try {
    ps(
      `
      $ErrorActionPreference = 'Stop'
      $null = Export-PfxCertificate -Cert (Get-Item ('Cert:\\CurrentUser\\My\\' + $env:THUMB)) -FilePath $env:FEED_PFX -Password (ConvertTo-SecureString $env:FEED_PASS -AsPlainText -Force)
      $true`,
      { THUMB: thumbprint, FEED_PFX: pfxFile, FEED_PASS: passphrase },
    );
    await changeOwnRoots("add", thumbprint, wait, treeFile);
    return { thumbprint, pfx: readFileSync(pfxFile) };
  } catch (caught) {
    try {
      await removeFeedCertificate(thumbprint, wait);
    } catch (left) {
      throw new AggregateError(
        [caught, left],
        `making the feed's certificate failed, and taking it away again failed too: ${String(left)}`,
      );
    }
    throw caught;
  }
}

/**
 * Adds the certificate in this person's own store to their roots, or takes
 * it out of them. Windows asks the person first, in a Security Warning of
 * the process that changes the roots, and the check answers Yes as they would.
 */
async function changeOwnRoots(
  change: "add" | "remove",
  thumbprint: string,
  wait: (done: () => boolean) => Promise<void>,
  treeFile?: string,
): Promise<void> {
  const script = `
    $ErrorActionPreference = 'Stop'
    $mine = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')
    $mine.Open('ReadOnly')
    $c = @($mine.Certificates | Where-Object { $_.Thumbprint -eq $env:THUMB })[0]
    $mine.Close()
    $roots = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'CurrentUser')
    $roots.Open('ReadWrite')
    if ($env:CHANGE -eq 'add') { $roots.Add($c) } else {
      foreach ($r in @($roots.Certificates | Where-Object { $_.Thumbprint -eq $env:THUMB })) { $roots.Remove($r) }
    }
    $roots.Close()`;
  const child = spawn(powershellPath, ["-NoProfile", "-Command", script], {
    env: { ...process.env, THUMB: thumbprint, CHANGE: change },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const said: string[] = [];
  child.stdout?.on("data", (chunk) => said.push(String(chunk)));
  child.stderr?.on("data", (chunk) => said.push(String(chunk)));
  const ended = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
  let exited = false;
  void ended.then(() => {
    exited = true;
  });
  const pid = child.pid ?? 0;
  await wait(() => exited || pressDialogButton(pid, "Yes", treeFile));
  const code = await ended;
  if (code !== 0)
    throw new Error(
      `changing this person's roots (${change}) ended with ${code}: ${said.join("")}`,
    );
}

/**
 * Sets `NODE_USE_SYSTEM_CA=1` in this person's environment, as the person's
 * own setting, and answers what puts back the value it had before, or takes
 * it away when it had none.
 */
export function trustSystemStore(): () => void {
  const before = ps<string | null>(
    `[Environment]::GetEnvironmentVariable('NODE_USE_SYSTEM_CA', 'User')`,
  );
  const set = (value: string | null) =>
    ps(
      `[Environment]::SetEnvironmentVariable('NODE_USE_SYSTEM_CA', $(if ($env:REMOVE -eq '1') { $null } else { $env:VALUE }), 'User'); $true`,
      { VALUE: value ?? "", REMOVE: value === null ? "1" : "" },
    );
  set("1");
  return () => set(before);
}

/** Takes the feed's certificate out of every store `makeFeedCertificate` put it in. */
export async function removeFeedCertificate(
  thumbprint: string,
  wait: (done: () => boolean) => Promise<void>,
): Promise<void> {
  await changeOwnRoots("remove", thumbprint, wait);
  ps(
    `
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'CurrentUser')
    $store.Open('ReadWrite')
    foreach ($c in @($store.Certificates | Where-Object { $_.Thumbprint -eq $env:THUMB })) { $store.Remove($c) }
    $store.Close()
    $true`,
    { THUMB: thumbprint },
  );
}

/** What a Node that Task Scheduler started read from the feed, and the trust switch it was given. */
export type ScheduledReading = {
  readonly NODE_USE_SYSTEM_CA: string | null;
  readonly reading: string;
};

/**
 * Reads `url` from a Node that Task Scheduler starts for this person, as it
 * starts the app's command: a task of the check's own, run once and taken
 * away, whose answer says whether what Task Scheduler starts trusts the feed.
 */
export async function readThroughTaskScheduler(
  url: string,
  work: string,
  wait: (done: () => boolean) => Promise<void>,
): Promise<ScheduledReading> {
  const script = join(work, "scheduled-reading.cjs");
  const out = join(work, "scheduled-reading.json");
  writeFileSync(
    script,
    `const [url, out] = process.argv.slice(2);
fetch(url)
  .then((r) => String(r.status), (e) => String(e.cause ?? e))
  .then((reading) => require("node:fs").writeFileSync(out, JSON.stringify({ NODE_USE_SYSTEM_CA: process.env.NODE_USE_SYSTEM_CA ?? null, reading })));
`,
  );
  const env = {
    NODE: process.execPath,
    SCRIPT: script,
    URL: url,
    OUT: out,
    NAME: "Infinitary update check reading",
  };
  ps(
    `
    $ErrorActionPreference = 'Stop'
    $action = New-ScheduledTaskAction -Execute $env:NODE -Argument ('"' + $env:SCRIPT + '" "' + $env:URL + '" "' + $env:OUT + '"')
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive
    $null = Register-ScheduledTask -TaskName $env:NAME -Action $action -Principal $principal -Force
    Start-ScheduledTask -TaskName $env:NAME
    $true`,
    env,
  );
  try {
    await wait(() => existsSync(out));
    return JSON.parse(readFileSync(out, "utf8")) as ScheduledReading;
  } finally {
    ps(`Unregister-ScheduledTask -TaskName $env:NAME -Confirm:$false; $true`, env);
  }
}
