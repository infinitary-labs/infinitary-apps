import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deviceLabel } from "@shared/devices";
import { remoteLoginWords } from "@shared/remoteLogin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { macRelease } from "../../../tests/helpers/macRelease";
import { reachMark } from "../../../tests/helpers/reachMark";
import {
  addChecked,
  closeEach,
  home,
  otherUser,
  server,
  standInBundle,
  THEIR_UID,
} from "../../../tests/helpers/remoteLoginHome";
import { scratchDir } from "../../../tests/helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE } from "../../../tests/helpers/sshServer";
import { addStandInPayload, standInFirstmate } from "../../../tests/helpers/standInFirstmate";
import { hostEnv } from "../hostEnv";
import { packApp } from "./appArchive";
import { FarBuilds } from "./farBuilds";
import { LINUX, MACOS } from "./farSystems";
import { PublishedBuilds, standInTapFetch } from "./publishedBuilds";
import {
  DOWNLOAD_READY,
  MAC_DOWNLOAD_UPDATE,
  RELEASE_REQUIREMENT,
  readDownloadCount,
  UPDATE_STARTING,
  VERIFY_MAC_APP,
} from "./remoteDownload";
import { RemoteLoginRefusedError } from "./remoteLogin";
import { shellWord } from "./shellWord";
import { runSsh } from "./ssh";

/**
 * An addressed Mac downloads its own copy of Firstmate (docs/devices.md,
 * "Adding a computer by its address"): Add and Update download, check and
 * start it there, and the home sends its own copy only when that fails.
 * macOS only, so it is on the Mac lane's list (`scripts/mac-unit-tests.ts`).
 */

// Real processes: sshd, ssh, tar, curl and openssl (Mac slowest per-case
// fastest 2.1 s, docs/test-cohorts.md "Budgets").
vi.setConfig({ testTimeout: 15_000 });

afterEach(closeEach);

// Accepted INF-322: Add and Update download on an older addressed Mac,
// report real byte observations, and send the home bundle only on failure.
// Its slowest cases add and update over SSH against a release of their own,
// and each download waits out at least one of the script's once-a-second
// counts (Mac slowest per-case fastest 5.7 s).
describe.runIf(SSH_SERVER_AVAILABLE && process.platform === "darwin")(
  "an addressed Mac downloads its own copy",
  { timeout: 30_000 },
  () => {
    async function fixture(
      paceMs = 0,
      idleTimeoutMs?: number,
      options: {
        here?: boolean;
        fetchHere?: boolean;
        realVerifier?: boolean;
        backstopMs?: number;
        gate?: { when: "update" | "join"; ready: string; resume: string };
      } = {},
    ) {
      const sshd = await server();
      const them = otherUser();
      const record = join(scratchDir("infinitary-download-record-"), "started");
      const bundle = standInFirstmate(record, THEIR_UID, {
        joined: "at-login",
        updated: "running",
        ...(options.gate ? { startGate: options.gate } : {}),
      });
      addStandInPayload(bundle, randomBytes(128_000));
      const release = await macRelease(bundle, "0.13.0", paceMs);
      const fetched: string[] = [];
      const tap = standInTapFetch(release.dir);
      const builds = new FarBuilds({
        own: () => (options.fetchHere ? null : bundle),
        chip: "arm64",
        published: new PublishedBuilds({
          version: "0.13.0",
          dir: join(them.home, "builds"),
          fetchImpl: async (input, init) => {
            fetched.push(String(input));
            return tap(input, init);
          },
        }),
      });
      const ssh = sshd.ssh({
        remote: {
          ...them.env,
          CFFIXED_USER_HOME: them.home,
          INFINITARY_LOCAL_CODESIGN_DIR: join(them.home, "unused-signing"),
          TMPDIR: them.home,
          CURL_CA_BUNDLE: release.cert,
        },
        downloads: release.downloads,
        programs: options.realVerifier ? {} : release.programs,
        elsewhere: !options.here,
      });
      const at = await home({
        ssh,
        bundle,
        builds,
        idleTimeoutMs,
        sendTimeoutMs: options.backstopMs,
      });
      return { at, release, record, fetched, address: sshd.address, ssh, them, bundle };
    }

    it("downloads, checks and starts Add and Update, with counts from the final response and no app sent here", async () => {
      const { at, release, record, fetched, address } = await fixture(60);
      try {
        const device = await addChecked(at.remote, address);
        expect(device).toMatchObject({ name: "Mac mini" });
        for (const doing of ["add", "update"] as const) {
          if (doing === "update") {
            at.said.splice(0);
            await at.remote.update(device.id);
          }
          const downloads = at.said.filter((event) => event.copy?.download);
          const counts = downloads.map((event) => event.copy?.download?.received ?? -1);
          expect(
            downloads.every(
              (event) =>
                (event.copy?.download?.received ?? 0) > 0 ||
                event.copy?.download?.total !== undefined,
            ),
          ).toBe(true);
          expect(counts.at(-1)).toBe(release.size);
          expect(counts.some((count) => count > 0 && count < release.size)).toBe(true);
          expect(downloads.at(-1)?.copy?.download?.total).toBe(release.size);
          expect(new Set(downloads.map((event) => event.run?.id)).size).toBe(1);
          expect(at.sending()).toEqual([]);
        }
        expect(release.requests()).toBe(2);
        expect(fetched.some((url) => url.endsWith(".zip"))).toBe(false);
        const started = readFileSync(record, "utf8");
        expect(started).toContain("work join --fetched");
        expect(started).toContain("work update --fetched");
        for (const match of started.matchAll(/--fetched (.+?) --from-home/g))
          expect(existsSync(match[1] ?? "")).toBe(false);
      } finally {
        await release.stop();
      }
    });

    it.each([
      ["download", "fail"],
      ["checksum", "corrupt"],
    ] as const)(
      "immediately sends its counted copy on %s failure, for Add and Update",
      async (_what, failure) => {
        const { at, release, record, address } = await fixture();
        release.mode(failure);
        try {
          const device = await addChecked(at.remote, address);
          for (const doing of ["add", "update"] as const) {
            if (doing === "update") {
              at.said.splice(0);
              await at.remote.update(device.id);
            }
            expect(at.lines()).toContain(
              remoteLoginWords.downloadFallback(
                doing === "add" ? "Mac mini" : deviceLabel(device),
                failure === "corrupt",
              ),
            );
            expect(at.sending().at(-1)?.copy?.sent).toBeGreaterThan(128_000);
            expect(at.said.at(-1)?.stage).toBe("done");
          }
          // Corrupt bytes never execute; only the fallback enters each operation.
          const started = readFileSync(record, "utf8");
          expect(started.match(/started: work update /g)).toHaveLength(1);
        } finally {
          await release.stop();
        }
      },
    );

    it("reports bytes so far without inventing a total when release storage sends no size", async () => {
      const { at, release, address } = await fixture();
      release.knownSize(false);
      try {
        await addChecked(at.remote, address);
        const last = at.said.filter((event) => event.copy?.download).at(-1);
        expect(last?.copy?.download).toEqual({ received: release.size });
        expect(last?.text).toBe(remoteLoginWords.downloading("Mac mini", release.size));
        expect(last?.text).toContain("so far");
      } finally {
        await release.stop();
      }
    });

    it("does not start an update without the home's acknowledgement when its download session stops", async () => {
      const { release, record, address, ssh, them } = await fixture();
      let ready: () => void = () => {};
      const downloaded = new Promise<void>((resolve) => {
        ready = resolve;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const ran = runSsh({
          ssh,
          address,
          command: [
            "/bin/sh",
            "-c",
            MAC_DOWNLOAD_UPDATE,
            "infinitary",
            "fixture-home",
            "fixture-device",
            "false",
            release.sha256,
            release.publicUrl,
          ],
          idleTimeoutMs: 120_000,
          stdin: async (sink) => {
            await new Promise<void>((resolve) => sink.once("close", resolve));
          },
          onLine: (line) => {
            if (line === DOWNLOAD_READY) ready();
            return readDownloadCount(line) !== null;
          },
        });
        await downloaded;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(await ran).toMatchObject({ stopped: "inactive" });
        expect(existsSync(record)).toBe(false);
        vi.useRealTimers();
        await expect
          .poll(() => readdirSync(them.home).filter((name) => name.startsWith("firstmate.")))
          .toEqual([]);
      } finally {
        vi.useRealTimers();
        await release.stop();
      }
    });

    it("keeps another user on this Mac on the local-copy path without a public lookup", async () => {
      const { at, release, address, fetched } = await fixture(0, undefined, { here: true });
      try {
        const device = await addChecked(at.remote, address);
        expect(device.onThisMac).toBe(true);
        await at.remote.update(device.id);
        expect(fetched).toEqual([]);
        expect(release.requests()).toBe(0);
        expect(at.sending().length).toBeGreaterThan(0);
      } finally {
        await release.stop();
      }
    });

    it.each(["invalid", "wrong-team"] as const)(
      "rejects a %s publisher signature before Add and Update and sends the local copy",
      async (signature) => {
        const { at, release, address } = await fixture();
        release.signature(signature);
        try {
          const device = await addChecked(at.remote, address);
          for (const doing of ["add", "update"] as const) {
            if (doing === "update") {
              at.said.splice(0);
              await at.remote.update(device.id);
            }
            expect(at.lines()).toContain(remoteLoginWords.downloadFallback("Mac mini", true));
            expect(at.sending().length).toBeGreaterThan(0);
          }
          expect(release.verifications()).toHaveLength(2);
        } finally {
          await release.stop();
        }
      },
    );

    // INF-344 F1/F2: preserve the production argv shape; substitute only the Apple fixture's requirement expression.
    it("the native verifier accepts an inline Apple requirement using the production invocation", () => {
      const home = scratchDir("infinitary-native-requirement-");
      const verifier = join(home, "verify-apple");
      const argsFile = join(home, "argv.json");
      writeFileSync(
        verifier,
        `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
const at = args.indexOf('-R') + 1;
args[at] = args[at].replace(${JSON.stringify(RELEASE_REQUIREMENT)}, 'anchor apple');
const ran = spawnSync('/usr/bin/codesign', args, { stdio: 'inherit' });
process.exit(ran.status ?? 1);
`,
        { mode: 0o755 },
      );
      const env = hostEnv({
        HOME: home,
        CFFIXED_USER_HOME: home,
        INFINITARY_LOCAL_CODESIGN_DIR: join(home, "signing"),
      });
      const ran = spawnSync(
        "/bin/sh",
        [
          "-c",
          `B="$1"; ${VERIFY_MAC_APP.replace("/usr/bin/codesign", shellWord(verifier))}`,
          "infinitary",
          "/System/Applications/Calculator.app",
        ],
        { env, encoding: "utf8" },
      );
      expect(ran.status, ran.stderr).toBe(0);
      expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual([
        "--verify",
        "--deep",
        "--strict",
        "-R",
        "=" + RELEASE_REQUIREMENT,
        "/System/Applications/Calculator.app",
      ]);
      const unsigned = standInFirstmate(join(home, "started"), THEIR_UID);
      const rejected = spawnSync(
        "/bin/sh",
        ["-c", `B="$1"; ${VERIFY_MAC_APP}`, "infinitary", unsigned],
        { env, encoding: "utf8" },
      );
      expect(rejected.status).toBe(7);
      expect(rejected.stderr).toContain("not signed");
    });

    // INF-344 F3: a held fallback fetch must not retain a failed download's observation.
    it.each(["add", "update"] as const)(
      "%s clears failed download progress while preparing the fallback build",
      async (doing) => {
        const { at, release, address } = await fixture(0, undefined, { fetchHere: true });
        const device = doing === "update" ? await addChecked(at.remote, address) : undefined;
        at.said.splice(0);
        release.mode("corrupt");
        let resume = () => {};
        let fetching = () => {};
        const prepared = new Promise<void>((resolve) => {
          fetching = resolve;
        });
        const get = vi.spyOn(PublishedBuilds.prototype, "get").mockImplementation(
          () =>
            new Promise((resolve) => {
              resume = () => resolve({ path: release.zip, sha256: release.sha256 });
              fetching();
            }),
        );
        const operation = device ? at.remote.update(device.id) : addChecked(at.remote, address);
        const settled = operation.catch((error: unknown) => error);
        try {
          await prepared;
          const fallback = at.said.find(
            (event) => event.text === remoteLoginWords.downloadFallback("Mac mini", true),
          );
          expect(fallback?.copy).toEqual({ state: "preparing" });
          expect(at.said.at(-1)?.copy).toEqual({ state: "preparing" });
          resume();
          expect(await settled).toMatchObject({ name: "Mac mini" });
        } finally {
          resume();
          await settled;
          get.mockRestore();
          await release.stop();
        }
      },
    );

    it("the native verifier rejects an unsigned downloaded bundle under a scratch HOME", async () => {
      const { at, release, address } = await fixture(0, undefined, { realVerifier: true });
      try {
        await addChecked(at.remote, address);
        expect(at.lines()).toContain(remoteLoginWords.downloadFallback("Mac mini", true));
        expect(at.sending().length).toBeGreaterThan(0);
      } finally {
        await release.stop();
      }
    });

    it("bounds the metadata lookup and keeps the local bundle available when it aborts", async () => {
      const controller = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      let requested: () => void = () => {};
      const reading = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const published = new PublishedBuilds({
        version: "0.13.0",
        dir: scratchDir("infinitary-lookup-"),
        fetchImpl: async (_input, init) => {
          expect(init?.signal).toBe(controller.signal);
          requested();
          return new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            }),
          );
        },
      });
      const bundle = standInBundle(join(scratchDir("infinitary-lookup-app-"), "started"));
      const builds = new FarBuilds({ own: () => bundle, chip: "arm64", published });
      try {
        const lookup = builds.downloadFor(MACOS, "arm64");
        await reading;
        expect(timeout).toHaveBeenCalledWith(5_000);
        controller.abort(new DOMException("Lookup timed out", "TimeoutError"));
        expect(await lookup).toBeNull();
        expect(await builds.for(MACOS, "arm64")).toEqual({ form: "bundle", path: bundle });
      } finally {
        timeout.mockRestore();
      }
    });

    it("a Linux home's fallback fetch uses the preparation backstop, not transfer inactivity", async () => {
      const { at, release, address } = await fixture(0, 120_000, { fetchHere: true });
      release.mode("fail");
      let fetched: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        fetched = resolve;
      });
      let complete: (value: { path: string; sha256: string }) => void = () => {};
      const waiting = new Promise<{ path: string; sha256: string }>((resolve) => {
        complete = resolve;
      });
      const get = vi.spyOn(PublishedBuilds.prototype, "get").mockImplementation(() => {
        fetched();
        return waiting;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let ended = false;
        const operation = addChecked(at.remote, address);
        void operation.then(
          () => {
            ended = true;
          },
          () => {
            ended = true;
          },
        );
        await started;
        await vi.advanceTimersByTimeAsync(180_000);
        expect(ended).toBe(false);
        complete({ path: release.zip, sha256: release.sha256 });
        expect(await operation).toMatchObject({ name: "Mac mini" });
      } finally {
        vi.useRealTimers();
        get.mockRestore();
        await release.stop();
      }
    });

    it("sent update scripts reject malformed archives and mismatched checksums before the start marker", async () => {
      const { release, address, ssh, record, bundle } = await fixture();
      const archive = readFileSync(release.zip);
      const tar = packApp(bundle);
      const packed = new Promise<number | null>((resolve) => tar.once("close", resolve));
      const chunks: Buffer[] = [];
      for await (const chunk of tar.stdout) chunks.push(chunk as Buffer);
      expect(await packed).toBe(0);
      const truncatedTar = Buffer.concat(chunks).subarray(0, 8);
      const truncated = archive.subarray(0, 64);
      const cases = [
        { script: MACOS.update.bundle, bytes: truncatedTar, sha256: release.sha256 },
        {
          script: MACOS.update.zip,
          bytes: truncated,
          sha256: createHash("sha256").update(truncated).digest("hex"),
        },
        { script: LINUX.update.appimage, bytes: archive, sha256: "0".repeat(64) },
      ];
      try {
        for (const each of cases) {
          if (!each.script) throw new Error("No update script.");
          const result = await runSsh({
            ssh,
            address,
            command: [
              "/bin/sh",
              "-c",
              each.script,
              "infinitary",
              "fixture-home",
              "fixture-device",
              "false",
              each.sha256,
            ],
            stdin: async (sink) => {
              sink.write(each.bytes);
            },
          });
          expect(result.code).toBe(4);
          expect(result.stdout.split("\n")).not.toContain(UPDATE_STARTING);
        }
        expect(existsSync(record)).toBe(false);
        expect(release.verifications()).toEqual([]);
      } finally {
        await release.stop();
      }
    });

    // INF-333 N2: bytes sent is not permission to announce that the app started.
    it.each(["valid", "invalid", "wrong-team"] as const)(
      "a sent zip stays before starting until its %s signature result",
      async (signature) => {
        const { at, release, address, record } = await fixture(0, undefined, { fetchHere: true });
        const device = await addChecked(at.remote, address);
        release.mode("fail");
        release.signature("hold");
        at.said.splice(0);
        const get = vi
          .spyOn(PublishedBuilds.prototype, "get")
          .mockResolvedValue({ path: release.zip, sha256: release.sha256 });
        const ready = reachMark(release.verificationReady);
        try {
          const operation = at.remote.update(device.id).catch((error: unknown) => error);
          await ready;
          expect(at.sending().length).toBeGreaterThan(0);
          expect(at.said.filter((event) => event.copy?.state === "starting")).toEqual([]);
          release.signature(signature);
          const result = await operation;
          if (signature === "valid") {
            expect(result).toMatchObject({ id: device.id });
            expect(at.said.filter((event) => event.copy?.state === "starting")).toHaveLength(1);
            expect(readFileSync(record, "utf8")).toContain("started: work update");
          } else {
            expect(result).toBeInstanceOf(RemoteLoginRefusedError);
            expect((result as Error).message).toBe(
              remoteLoginWords
                .refused("failed", { address, name: "Mac mini", doing: "update" })
                .join("\n"),
            );
            expect(at.said.filter((event) => event.copy?.state === "starting")).toEqual([]);
            expect(readFileSync(record, "utf8")).not.toContain("started: work update");
          }
        } finally {
          release.signature("valid");
          get.mockRestore();
          await release.stop();
        }
      },
    );

    // Review F1/F2/F7: transfer inactivity is not a timer on silent start work.
    for (const mode of ["download", "send"] as const) {
      for (const when of ["join", "update"] as const) {
        it(`${mode}: lets silent ${when} work finish after the transfer deadline and says it is starting`, async () => {
          const dir = scratchDir("infinitary-start-gate-");
          const gate = { when, ready: join(dir, "ready"), resume: join(dir, "resume") };
          const { at, release, address } = await fixture(0, 120_000, {
            gate,
            here: mode === "send",
            backstopMs: 30 * 60_000,
          });
          const device = when === "update" ? await addChecked(at.remote, address) : undefined;
          const ready = reachMark(gate.ready);
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          try {
            let ended = false;
            const operation = device ? at.remote.update(device.id) : addChecked(at.remote, address);
            void operation.then(
              () => {
                ended = true;
              },
              () => {
                ended = true;
              },
            );
            await ready;
            await vi.advanceTimersByTimeAsync(180_000);
            expect(ended).toBe(false);
            expect(
              at.said.filter((event) => event.copy?.state === "starting").length,
            ).toBeGreaterThan(0);
            writeFileSync(gate.resume, "resume");
            expect(await operation).toMatchObject({ name: "Mac mini" });
          } finally {
            vi.useRealTimers();
            writeFileSync(gate.resume, "resume");
            await release.stop();
          }
        });
      }
    }

    it("a lost update outcome after acknowledgement is uncertain, not an invitation to retry", async () => {
      const dir = scratchDir("infinitary-uncertain-update-");
      const gate = {
        when: "update" as const,
        ready: join(dir, "ready"),
        resume: join(dir, "resume"),
      };
      const { at, release, address, record } = await fixture(0, 120_000, {
        gate,
        backstopMs: 300_000,
      });
      const device = await addChecked(at.remote, address);
      at.said.splice(0);
      const ready = reachMark(gate.ready);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const operation = at.remote.update(device.id).catch((error: unknown) => error);
        await ready;
        await vi.advanceTimersByTimeAsync(300_000);
        const refused = await operation;
        expect(refused).toBeInstanceOf(RemoteLoginRefusedError);
        expect((refused as Error).message).toBe(remoteLoginWords.uncertain("Mac mini").join("\n"));
        expect(at.sending()).toEqual([]);
        expect(readFileSync(record, "utf8").match(/started: work update /g)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
        writeFileSync(gate.resume, "resume");
        await release.stop();
      }
    });

    it("a stalled download falls back instead of calling a reachable Mac unreachable", async () => {
      const { at, release, address } = await fixture(0, 1_500);
      release.mode("hang");
      try {
        const device = await addChecked(at.remote, address);
        expect(device.name).toBe("Mac mini");
        expect(at.lines()).toContain(remoteLoginWords.downloadFallback("Mac mini", false));
        expect(at.sending().length).toBeGreaterThan(0);
        expect(at.said.every((event) => event.stage !== "refused")).toBe(true);
        await expect.poll(() => release.active()).toBe(0);
      } finally {
        await release.stop();
      }
    });
  },
);
