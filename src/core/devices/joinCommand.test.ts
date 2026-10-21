import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileSizeWords } from "@shared/attachments";
import { FETCH_APP_PATH } from "@shared/connection";
import {
  buildPairingLink,
  DOWNLOAD_COMMAND_LINK_TTL_MS,
  deviceInviteSchema,
  parsePairingLink,
} from "@shared/devices";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimedPort } from "../../../tests/helpers/claimedPort";
import { macRelease } from "../../../tests/helpers/macRelease";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { type HomeConnection, startConnection } from "../connection/connection";
import type { CoreDispatch } from "../dispatcher";
import { CoreEventBus } from "../events";
import {
  COMMAND_DOWNLOADING,
  commandClosed,
  commandDownloadFallback,
  commandExpired,
  commandUsed,
  macAsk,
  sandboxOff,
} from "../helper/words";
import { claimLink } from "./dial";
import { createKeyIdentity } from "./identity";
import { joinCommand, shellWord } from "./joinCommand";
import { DevicePairing } from "./pairing";

/**
 * The one command that joins a computer to this home (docs/devices.md,
 * "Joining by a command"), run as a person runs it: by the Mac's own
 * `/bin/sh`, its own curl and tar, against the real pairing and connection,
 * with a stand-in Firstmate bundle the home sends. The stand-in's program
 * writes down how it was started and what it found beside it, so the test
 * reads whether the command asked first, got the right app, started it with
 * the link, and left nothing behind. The real app joining from a fetched
 * copy is `tests/e2e/run-work.spec.ts`.
 */

// Real processes: sh, curl, tar, and the home's own tar; on a Mac, a local
// HTTPS release with shasum, ditto and a stand-in codesign.
vi.setConfig({ testTimeout: 30_000 });

const standIn = (async (channel) => {
  throw new Error(`Rejected ${channel}`);
}) as CoreDispatch;

const connections: HomeConnection[] = [];
const pairings: DevicePairing[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const pairing of pairings.splice(0)) pairing.dispose();
});

/** A stand-in Firstmate bundle: its program writes down its words and its bundle's marker, then answers `exit`. */
function standInBundle(record: string, exit = 0): string {
  const bundle = join(scratchDir("infinitary-command-app-"), "Firstmate 3000.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "Resources", "marker"), "the home's own copy\n");
  const program = join(bundle, "Contents", "MacOS", "Firstmate 3000");
  writeFileSync(
    program,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${shellWord(record)}`,
      `cat "$4/Contents/Resources/marker" >> ${shellWord(record)}`,
      `echo "Joined (stand-in)."`,
      `exit ${exit}`,
      "",
    ].join("\n"),
  );
  chmodSync(program, 0o755);
  return bundle;
}

async function home(options: { now?: () => number; bundle?: string | null } = {}) {
  const pairing = new DevicePairing({
    dir: join(scratchDir("infinitary-command-home-"), "devices"),
    onProblem: () => {},
    interfaces: () => ({}),
    ...(options.now ? { now: options.now } : {}),
  });
  pairings.push(pairing);
  const port = await claimedPort();
  const at = `127.0.0.1:${port}`;
  let fetched = 0;
  const connection = startConnection({
    dispatch: standIn,
    events: new CoreEventBus(),
    devices: pairing,
    port,
    name: () => "MacBook Pro",
    app: () => {
      fetched += 1;
      return options.bundle ?? null;
    },
  });
  connections.push(connection);
  return {
    pairing,
    at,
    fetched: () => fetched,
    /** A link, of the usual lifetime unless the test makes it last as a command that downloads does. */
    invite: async (lastsMs?: number) => {
      const invite = pairing.invite({ kind: "work", at }, lastsMs ? { lastsMs } : {});
      await connection.settled();
      return invite;
    },
  };
}

const LAUNCHER = {
  executable: "/Applications/Firstmate 3000.app/Contents/MacOS/Firstmate 3000",
  args: [],
};

/** Runs a command as Terminal would, typing `answer` when it asks; answers its words and exit. */
/** A folder whose `uname` says Darwin, first on the search path; none on a Mac. */
function macUname(): string {
  if (process.platform === "darwin") return "";
  const bin = scratchDir("infinitary-command-mac-bin-");
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n", { mode: 0o755 });
  return `${bin}:`;
}

/**
 * A folder that stands in a Linux computer on x64, first on the search path:
 * its `uname`, and the `unshare` the AppImage's launcher probes, which makes
 * a user namespace only where `namespaces` says this user may.
 */
function linuxTools(namespaces: boolean): string {
  const bin = scratchDir("infinitary-command-linux-bin-");
  writeFileSync(
    join(bin, "uname"),
    '#!/bin/sh\nif [ "$1" = -m ]; then echo x86_64; else echo Linux; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "unshare"), `#!/bin/sh\nexit ${namespaces ? 0 : 1}\n`, { mode: 0o755 });
  return `${bin}:`;
}

function run(
  command: string,
  answer: string,
  tools = macUname(),
  env: Record<string, string> = {},
  /** Hears what it has written so far, each time it writes more. */
  onOut?: (out: string) => void,
): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      // A person's Terminal: the Mac's own programs first, in a UTF-8 locale.
      // The command stops at once on a computer that is not a Mac, so on any
      // other system a stand-in `uname` says Darwin, as the bundle the home
      // sends stands in a Mac's app.
      env: {
        PATH: `${tools}/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: scratchDir("infinitary-command-user-"),
        LANG: "en_US.UTF-8",
        ...env,
      },
      cwd: scratchDir("infinitary-command-cwd-"),
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      onOut?.(out);
    });
    child.stderr.on("data", (chunk) => {
      out += String(chunk);
    });
    // A command that finishes without reading its answer (one that asks nothing, or stops
    // before asking) can close the pipe before this write lands; its words and exit are the answer.
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.stdin.end(answer);
    child.once("close", (code) => resolve({ out, code }));
  });
}

const ME = userInfo().username;

describe("the command that adds another Mac", () => {
  it("asks first, then gets Firstmate from this Mac with the link, starts it to join, and leaves nothing behind", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const command = joinCommand({
      for: "another-mac",
      link: invite.link,
      homeName: "MacBook Pro",
      launcher: LAUNCHER,
    });
    // One line, with the link in it and nothing from the shell's own words.
    expect(command).not.toContain("\n");
    expect(command.startsWith("'/bin/sh' '-c' ")).toBe(true);

    const { out, code } = await run(command, "yes\n");
    expect(code).toBe(0);
    expect(out).toBe(
      [
        ...macAsk("MacBook Pro", ME),
        "Type yes to agree: Getting Infinitary from MacBook Pro… done.",
        "Joined (stand-in).",
        "",
      ].join("\n"),
    );
    const [work, join_, fetched, bundle, link, marker] = readFileSync(record, "utf8").split("\n");
    expect([work, join_, fetched, link, marker]).toEqual([
      "work",
      "join",
      "--fetched",
      invite.link,
      "the home's own copy",
    ]);
    expect(bundle?.endsWith("/Firstmate 3000.app")).toBe(true);
    // What it unpacked is gone, and the link is still open for the join to use.
    expect(existsSync(bundle ?? "")).toBe(false);
    expect(at.fetched()).toBe(1);
    expect(at.pairing.opened({ code: parsePairingLink(invite.link).code })).toBeNull();
  });

  it("changes nothing on a no, and asks nothing of a Mac that is out of reach or is not that Mac", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const command = (link: string) =>
      joinCommand({ for: "another-mac", link, homeName: "MacBook Pro", launcher: LAUNCHER });

    const no = await run(command(invite.link), "no\n");
    expect(no.code).toBe(1);
    expect(no.out).toBe(
      [
        ...macAsk("MacBook Pro", ME),
        "Type yes to agree: Nothing changed on this computer.",
        "",
      ].join("\n"),
    );

    const link = parsePairingLink(invite.link);
    const nobody = buildPairingLink({ ...link, at: `127.0.0.1:${await claimedPort()}` });
    const away = await run(command(nobody), "yes\n");
    expect(away.code).toBe(1);
    expect(away.out).toBe(
      "Could not reach MacBook Pro at 127.0.0.1.\nBoth computers need the same network, or the same private network.\n",
    );

    const impostor = buildPairingLink({ ...link, key: createKeyIdentity("x").pin });
    const other = await run(command(impostor), "yes\n");
    expect(other.code).toBe(1);
    expect(other.out).toBe(
      "Something answered at 127.0.0.1, but not the computer that made this command.\nNothing was sent to it.\n",
    );
    expect(at.fetched()).toBe(0);
    expect(existsSync(record)).toBe(false);
  });

  it("says a command was used, expired or stopped, and gets nothing", async () => {
    let now = 1_000_000;
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ now: () => now, bundle: standInBundle(record) });
    const command = (link: string) =>
      joinCommand({ for: "another-mac", link, homeName: "MacBook Pro", launcher: LAUNCHER });
    const tail = (lines: readonly string[]) => [
      ...macAsk("MacBook Pro", ME),
      "Type yes to agree: Getting Infinitary from MacBook Pro… ",
      ...lines,
      "",
    ];

    const used = await at.invite();
    await claimLink(used.link, {
      kind: "work",
      name: "Another Mac",
      user: { name: "sam", uid: (process.getuid?.() ?? 0) + 1000 },
    });
    expect((await run(command(used.link), "yes\n")).out).toBe(
      tail(commandUsed("MacBook Pro")).join("\n"),
    );

    const stopped = await at.invite();
    at.pairing.stop(stopped.id);
    expect((await run(command(stopped.link), "yes\n")).out).toBe(
      tail(commandClosed("MacBook Pro")).join("\n"),
    );

    const late = await at.invite();
    now += 10 * 60 * 1000;
    expect((await run(command(late.link), "yes\n")).out).toBe(
      tail(commandExpired("MacBook Pro")).join("\n"),
    );
    expect(existsSync(record)).toBe(false);
  });

  it("reads every value as words, so a Mac's name cannot change what runs", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const name = `Sam's "$(touch /tmp/x)" \`id\` Mac`;
    const { out } = await run(
      joinCommand({ for: "another-mac", link: invite.link, homeName: name, launcher: LAUNCHER }),
      "no\n",
    );
    expect(out.split("\n")[0]).toBe(macAsk(name, ME)[0]);
  });
});

/**
 * The command downloads this Mac's published version there first (INF-322,
 * the captain's direction B with Add as well as Update): from a stand-in
 * release over local HTTPS, which the Mac's own curl trusts here alone, its
 * SHA-256 and unpacking real, and the publisher check, which no stand-in app
 * passes, stood in where the command names codesign. Only a Mac downloads;
 * the words and the check before it are the command's own.
 */
describe.runIf(process.platform === "darwin")(
  "the command that adds another Mac, when this Mac's version is published",
  () => {
    /** This Mac's version as its release publishes it, its app marked so a test tells it from the home's. */
    async function published(record: string, paceMs = 0, payload = 0) {
      const app = standInBundle(record);
      writeFileSync(join(app, "Contents", "Resources", "marker"), "the published copy\n");
      // Incompressible bytes, so the release states a size worth reserving time for.
      if (payload)
        writeFileSync(join(app, "Contents", "Resources", "payload"), randomBytes(payload));
      const release = await macRelease(app, "0.13.0", paceMs);
      releases.push(release);
      return release;
    }
    const releases: Awaited<ReturnType<typeof macRelease>>[] = [];
    afterEach(async () => {
      await Promise.all(releases.splice(0).map((release) => release.stop()));
    });

    /** The command for an invite, downloading from `release` until `expiresAt`, its publisher check stood in. */
    function command(
      link: string,
      release: Awaited<ReturnType<typeof macRelease>>,
      expiresAt = Date.now() + 10 * 60_000,
    ): string {
      const text = joinCommand({
        for: "another-mac",
        link,
        homeName: "MacBook Pro",
        launcher: LAUNCHER,
        download: {
          url: release.downloads[release.publicUrl] ?? "",
          sha256: release.sha256,
          expiresAt,
        },
      });
      let stoodIn = text;
      for (const [from, to] of Object.entries(release.programs))
        stoodIn = stoodIn.split(from).join(to);
      return stoodIn;
    }
    const trusting = (release: { cert: string }) => ({ CURL_CA_BUNDLE: release.cert });
    /** What Terminal shows once each count rewrote the line before it. */
    const shown = (out: string) =>
      out
        .split("\n")
        .map((line) => line.split("\r").at(-1)?.replace("\x1b[K", "") ?? "")
        .join("\n");

    it("asks first, downloads it there with its count, checks it, and joins with it, getting nothing from this Mac", async () => {
      const record = join(scratchDir("infinitary-command-record-"), "started");
      const at = await home({
        bundle: standInBundle(join(scratchDir("infinitary-command-home-"), "x")),
      });
      const release = await published(record, 100);
      const invite = await at.invite();
      const text = command(invite.link, release);
      // As long as a command may be, and still one line.
      expect(() =>
        deviceInviteSchema.parse({ ...invite, command: { for: "another-mac", text } }),
      ).not.toThrow();
      expect(text).not.toContain("\n");

      const { out, code } = await run(text, "yes\n", macUname(), trusting(release));
      expect(code).toBe(0);
      const total = fileSizeWords(release.size);
      expect(shown(out)).toBe(
        [
          ...macAsk("MacBook Pro", ME),
          `${COMMAND_DOWNLOADING} ${total} of ${total}, done.`,
          "Joined (stand-in).",
          "",
        ].join("\n"),
      );
      // Each count rewrote the one line, toward the release's own size.
      const erase = "\x1b[K";
      const counts = out
        .split("\r")
        .filter((piece) => piece.startsWith(erase))
        .map((piece) => piece.slice(erase.length).split("\n")[0] ?? "");
      expect(counts.length).toBeGreaterThan(1);
      for (const count of counts) {
        expect(count.startsWith(`${COMMAND_DOWNLOADING} `)).toBe(true);
        expect(count).toContain(` of ${total}`);
      }
      const [, , , bundle, link, marker] = readFileSync(record, "utf8").split("\n");
      expect([link, marker]).toEqual([invite.link, "the published copy"]);
      expect(existsSync(bundle ?? "")).toBe(false);
      // The home only said its code was open: nothing of it was sent, and the code is unspent.
      expect(at.fetched()).toBe(0);
      expect(release.requests()).toBe(1);
      expect(release.verifications()).toHaveLength(1);
      expect(at.pairing.opened({ code: parsePairingLink(invite.link).code })).toBeNull();
    });

    it.each([
      ["did not match", "corrupt", true],
      ["could not be got", "fail", false],
    ] as const)("gets this Mac's copy at once when the download %s", async (_, mode, mismatch) => {
      const record = join(scratchDir("infinitary-command-record-"), "started");
      const at = await home({ bundle: standInBundle(record) });
      const release = await published(join(scratchDir("infinitary-command-release-"), "x"));
      release.mode(mode);
      const invite = await at.invite();
      const { out, code } = await run(
        command(invite.link, release),
        "yes\n",
        macUname(),
        trusting(release),
      );
      expect(code).toBe(0);
      const lines = shown(out).split("\n");
      expect(lines.slice(-4)).toEqual([
        commandDownloadFallback("MacBook Pro", mismatch),
        "Getting Infinitary from MacBook Pro… done.",
        "Joined (stand-in).",
        "",
      ]);
      expect(readFileSync(record, "utf8").split("\n")[5]).toBe("the home's own copy");
      expect(at.fetched()).toBe(1);
    });

    // INF-369 F2, the captain's choice: reserve time sized to the copy, so a slow network still finishes.
    describe("keeps time sized to the copy for getting it from this Mac", () => {
      /** A minute to join, and 20 MiB at the slowest copy rate the reserve allows for: 80 seconds in all. */
      const SIZE = 20 * 1024 * 1024;
      const RESERVE_MS = (60 + SIZE / (1024 * 1024)) * 1000;

      it("stops downloading once only that is left of its link, and gets this Mac's copy in time", async () => {
        const record = join(scratchDir("infinitary-command-record-"), "started");
        const at = await home({ bundle: standInBundle(record) });
        const release = await published(
          join(scratchDir("infinitary-command-release-"), "x"),
          0,
          SIZE,
        );
        release.mode("hang");
        const invite = await at.invite();
        // Ten seconds short of the reserve: its download stops once it hears the size.
        const { out, code } = await run(
          command(invite.link, release, Date.now() + RESERVE_MS - 10_000),
          "yes\n",
          macUname(),
          trusting(release),
        );
        expect(code).toBe(0);
        expect(shown(out)).toContain(
          [
            commandDownloadFallback("MacBook Pro", false),
            "Getting Infinitary from MacBook Pro… done.",
          ].join("\n"),
        );
        // The stalled transfer went with the command's downloader.
        await expect.poll(() => release.active()).toBe(0);
      });

      it("downloads while more is left than a copy of its size needs, though under two minutes", async () => {
        const record = join(scratchDir("infinitary-command-record-"), "started");
        const at = await home({
          bundle: standInBundle(join(scratchDir("infinitary-command-home-"), "x")),
        });
        const release = await published(record, 0, SIZE);
        const invite = await at.invite();
        // Thirty seconds beyond the reserve, and under the two minutes a fixed reserve kept.
        const { out, code } = await run(
          command(invite.link, release, Date.now() + RESERVE_MS + 30_000),
          "yes\n",
          macUname(),
          trusting(release),
        );
        expect(code).toBe(0);
        const total = fileSizeWords(release.size);
        expect(shown(out)).toContain(`${COMMAND_DOWNLOADING} ${total} of ${total}, done.`);
        expect(readFileSync(record, "utf8").split("\n")[5]).toBe("the published copy");
        expect(at.fetched()).toBe(0);
      });
    });

    // INF-369 N1, the captain's choice: links for commands that download last longer from the start.
    it("downloads today's 401 MB app where a ten-minute link would already have fallen back", async () => {
      /** Infinitary 0.4.2-alpha.3's universal zip, as its release states it (INF-322). */
      const TODAYS_APP_BYTES = 420_615_960;
      // Made 140 seconds ago: a ten-minute link would keep too little of what
      // is left for a copy of this size from this Mac, so it would stop at once.
      const at = await home({
        now: () => Date.now() - 140_000,
        bundle: standInBundle(join(scratchDir("infinitary-command-home-"), "x")),
      });
      const release = await published(join(scratchDir("infinitary-command-release-"), "x"));
      release.mode("hang");
      release.stateSize(TODAYS_APP_BYTES);
      const invite = await at.invite(DOWNLOAD_COMMAND_LINK_TTL_MS);
      const total = fileSizeWords(TODAYS_APP_BYTES);
      let counts = 0;
      const ran = run(
        command(invite.link, release, invite.expiresAt),
        "yes\n",
        macUname(),
        trusting(release),
        (out) => {
          counts = out.split("\r").filter((piece) => piece.includes(` of ${total}`)).length;
        },
      );
      // It goes on counting toward the app's own size, with no fallback yet.
      await expect.poll(() => counts, { timeout: 8_000 }).toBeGreaterThan(2);
      // The download stops here, as a dropped connection would end it.
      await release.stop();
      const { out, code } = await ran;
      expect(code).toBe(0);
      const said = shown(out).split("\n");
      expect(said).toContain(commandDownloadFallback("MacBook Pro", false));
      expect(out.indexOf(commandDownloadFallback("MacBook Pro", false))).toBeGreaterThan(
        out.lastIndexOf(` of ${total}`),
      );
    });

    it("says a command was used or expired before it downloads anything", async () => {
      let now = 1_000_000;
      const record = join(scratchDir("infinitary-command-record-"), "started");
      const at = await home({ now: () => now, bundle: standInBundle(record) });
      const release = await published(join(scratchDir("infinitary-command-release-"), "x"));
      const said = (lines: readonly string[]) =>
        [
          ...macAsk("MacBook Pro", ME),
          `Type yes to agree: ${lines[0]}`,
          ...lines.slice(1),
          "",
        ].join("\n");

      const used = await at.invite();
      await claimLink(used.link, {
        kind: "work",
        name: "Another Mac",
        user: { name: "sam", uid: (process.getuid?.() ?? 0) + 1000 },
      });
      expect(
        (await run(command(used.link, release), "yes\n", macUname(), trusting(release))).out,
      ).toBe(said(commandUsed("MacBook Pro")));

      // A command that downloads carries a link that lasts longer, and says so once it expired.
      const late = await at.invite(DOWNLOAD_COMMAND_LINK_TTL_MS);
      now += DOWNLOAD_COMMAND_LINK_TTL_MS;
      expect(
        (await run(command(late.link, release), "yes\n", macUname(), trusting(release))).out,
      ).toBe(said(commandExpired("MacBook Pro", DOWNLOAD_COMMAND_LINK_TTL_MS)));
      expect(release.requests()).toBe(0);
      expect(at.fetched()).toBe(0);
      expect(existsSync(record)).toBe(false);
    });
  },
);

describe("the command run on a Linux computer", () => {
  it("stops before anything where the AppImage would run without its sandbox, and asks as before where it would not", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const command = joinCommand({
      for: "another-mac",
      link: invite.link,
      homeName: "MacBook Pro",
      launcher: LAUNCHER,
    });

    const off = await run(command, "yes\n", linuxTools(false));
    expect(off.code).toBe(1);
    expect(off.out).toBe([...sandboxOff("MacBook Pro"), ""].join("\n"));
    expect(at.fetched()).toBe(0);
    expect(existsSync(record)).toBe(false);

    const on = await run(command, "no\n", linuxTools(true));
    expect(on.code).toBe(1);
    expect(on.out).toBe(
      [
        ...macAsk("MacBook Pro", ME),
        "Type yes to agree: Nothing changed on this computer.",
        "",
      ].join("\n"),
    );
    expect(at.fetched()).toBe(0);
  });
});

describe("the command that runs work as another user on this Mac", () => {
  it("starts this Mac's own app in its work mode with the link", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const bundle = standInBundle(record);
    const at = await home();
    const invite = await at.invite();
    const command = joinCommand({
      for: "another-user",
      link: invite.link,
      homeName: "MacBook Pro",
      launcher: { executable: join(bundle, "Contents", "MacOS", "Firstmate 3000"), args: [] },
    });
    expect(command).toBe(
      [join(bundle, "Contents", "MacOS", "Firstmate 3000"), "work", "join", invite.link]
        .map(shellWord)
        .join(" "),
    );
    const { code } = await run(command, "");
    expect(code).toBe(0);
    expect(readFileSync(record, "utf8").split("\n").slice(0, 3)).toEqual([
      "work",
      "join",
      invite.link,
    ]);
    expect(at.fetched()).toBe(0);
  });
});

describe("getting Firstmate from this Mac", () => {
  /** One request to the fetch path, as a client that checks nothing; answers its status and body. */
  function fetchApp(
    at: string,
    options: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: string }> {
    const [host, port] = at.split(":");
    return new Promise((resolve, reject) => {
      const asked = request(
        {
          host,
          port: Number(port),
          method: options.method ?? "POST",
          path: FETCH_APP_PATH,
          rejectUnauthorized: false,
          headers: { "content-type": "application/json", ...options.headers },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("latin1"),
            }),
          );
        },
      );
      asked.once("error", reject);
      asked.end(options.body ?? "");
    });
  }

  it("sends the app only for an open link made for a computer that runs work, and never spends it", async () => {
    const record = join(scratchDir("infinitary-command-record-"), "started");
    const at = await home({ bundle: standInBundle(record) });
    const invite = await at.invite();
    const code = parsePairingLink(invite.link).code;
    const sent = await fetchApp(at.at, { body: JSON.stringify({ code }) });
    expect(sent.status).toBe(200);
    // A gzip stream: its first two bytes.
    expect(sent.body.charCodeAt(0)).toBe(0x1f);
    expect(sent.body.charCodeAt(1)).toBe(0x8b);
    expect(at.pairing.opened({ code })).toBeNull();

    const view = at.pairing.invite({ kind: "view", at: at.at });
    const viewCode = parsePairingLink(view.link).code;
    expect(await fetchApp(at.at, { body: JSON.stringify({ code: viewCode }) })).toMatchObject({
      status: 409,
    });
    expect(await fetchApp(at.at, { body: JSON.stringify({ code: "C".repeat(43) }) })).toMatchObject(
      { status: 401 },
    );
    expect(await fetchApp(at.at, { body: JSON.stringify({ code: 7 }) })).toMatchObject({
      status: 400,
    });
    // With no code, only a computer already on the list gets it, by its key.
    expect(await fetchApp(at.at, { body: "{}" })).toMatchObject({ status: 401 });
    expect(await fetchApp(at.at, { method: "GET" })).toMatchObject({ status: 405 });
    expect(
      await fetchApp(at.at, { body: JSON.stringify({ code }), headers: { origin: "https://x" } }),
    ).toMatchObject({ status: 403 });
    expect(
      await fetchApp(at.at, {
        body: JSON.stringify({ code }),
        headers: { "content-type": "text/plain" },
      }),
    ).toMatchObject({ status: 415 });
    // No refusal echoes the code.
    for (const body of [
      JSON.stringify({ code: viewCode }),
      JSON.stringify({ code: "C".repeat(43) }),
    ])
      expect((await fetchApp(at.at, { body })).body).not.toContain(viewCode);
  });

  it("says when this copy cannot send itself", async () => {
    const at = await home({ bundle: null });
    const invite = await at.invite();
    const answer = await fetchApp(at.at, {
      body: JSON.stringify({ code: parsePairingLink(invite.link).code }),
    });
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ refused: "none" });
  });
});
