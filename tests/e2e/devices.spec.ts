import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellWord } from "@core/devices/joinCommand";
import { writeInstalled } from "@core/helper/background";
import { joinHome, keepApp } from "@core/helper/join";
import { catalogRefreshesSettled } from "@core/pi/modelRuntime";
import { expect, test } from "@playwright/test";
import { type DeviceView, deviceLabel, PAIRING_LINK_PREFIX } from "@shared/devices";
import type { FmEvent } from "@shared/events";
import * as m from "@shared/i18n/messages.generated";
import { remoteLoginWords } from "@shared/remoteLogin";
import { macRelease } from "../helpers/macRelease";
import { scratchDir } from "../helpers/scratchDirs";
import { SSH_SERVER_AVAILABLE } from "../helpers/sshServer";
import { addStandInPayload } from "../helpers/standInFirstmate";
import { startDemo } from "./demo";
import {
  addByAddress,
  BUILDER,
  linkInTab,
  openDevices,
  otherMacOverSsh,
  reachDot,
  selectDevice,
} from "./deviceFixtures";
import { type HelperRun, startHelper } from "./helperRun";
import { feedLine, feedLineOf } from "./rails";
import { MAC_ONLY_TAG } from "./tags";
import { pressKey } from "./windowKeys";

/**
 * A Mac downloads its own copy of Infinitary (docs/devices.md, "Adding a
 * computer by its address"): one a command added updates by download, and
 * one added by its address adds and updates by download, each with its count
 * and its fallback to this Mac's copy. macOS only, so every test here carries
 * the Mac tag; the other device journeys are `devices-*.spec.ts`.
 */

const appPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

/** INF-322 direction B, with Add as well as Update (INF-330). Promise: Devices'
 * command for another Mac names this computer's published version, and a Mac
 * a command added, on a contract that takes the download order, downloads it
 * itself once it connects on an older version, with nothing pressed (the
 * app updates it by itself), its count toward the release's own size in its
 * row and in one feed line rewritten in place; one whose download does not
 * match is sent this computer's copy at once, counted. Data: real
 * universal zips of stand-in apps, one listed in a stand-in tap over local
 * HTTPS, the computer's run in this test's own process joined as from
 * another Mac, with a stand-in publisher check. Completion: that run ends
 * updated with the expected copy kept, and is back on this computer's
 * version. macOS only (its zip tools); no real computer, release, signing
 * key or shared port is used.
 */
for (const operation of ["download", "fallback"] as const) {
  test(
    `a Mac a command added downloads its update by itself with progress: ${operation}`,
    { tag: MAC_ONLY_TAG },
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
    async ({}, testInfo) => {
      test.skip(process.platform !== "darwin", "needs macOS zip tools");
      test.setTimeout(120_000);
      process.env.PI_OFFLINE = "1";
      /** A stand-in app with a payload, its marker saying whose copy it is. */
      const standIn = (marker: string) => {
        const bundle = join(scratchDir("infinitary-e2e-command-app-"), "Infinitary.app");
        mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
        mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
        writeFileSync(join(bundle, "Contents", "MacOS", "Infinitary"), "#!/bin/sh\n", {
          mode: 0o755,
        });
        writeFileSync(join(bundle, "Contents", "Resources", "marker"), `${marker}\n`);
        addStandInPayload(bundle, randomBytes(8_000_000));
        return bundle;
      };
      const release = await macRelease(standIn("the published copy"), appPackage.version, 150);
      if (operation === "fallback") release.mode("corrupt");
      const demo = await startDemo({
        withMockProvider: true,
        size: { width: 1280, height: 800 },
        env: {
          INFINITARY_APP_BUNDLE: standIn("the home's own copy"),
          INFINITARY_JOINS_FROM_ANOTHER_MAC: "1",
          INFINITARY_PUBLISHED_TAP: release.dir,
        },
      });
      const app = demo.launched;
      let runner: HelperRun | undefined;
      try {
        const { page } = app;
        const thisVersion = await app.app.evaluate(({ app: electron }) => electron.getVersion());
        await openDevices(page);
        await pressKey(page.locator('[data-device-add="mac"]'), "Enter");
        await pressKey(
          page.getByRole("button", { name: "Run a command there", exact: true }),
          "Enter",
        );
        const command = (await linkInTab(page).textContent()) ?? "";
        // Its command downloads the same published version there first.
        expect(command).toContain(shellWord(release.publicUrl));
        expect(command).toContain(shellWord(release.sha256));
        // The computer's run is this process: its curl reaches the stand-in
        // release at the public address, through the release's tunnel, and
        // trusts its certificate alone. The app started without them.
        process.env.HTTPS_PROXY = release.proxy;
        process.env.CURL_CA_BUNDLE = release.cert;
        const dataDir = scratchDir("infinitary-e2e-command-mini-");
        const at = command.indexOf(PAIRING_LINK_PREFIX);
        const joined = await joinHome({
          text: command.slice(at, command.indexOf("'", at)),
          dataDir,
          io: { say: () => {}, ask: async () => "yes" },
          device: { name: "Mac mini", user: BUILDER },
          timeoutMs: 5_000,
        });
        if (!joined.ok) throw new Error(joined.reason);
        const deviceId = joined.grant.deviceId;
        await pressKey(page.getByRole("button", { name: "Done", exact: true }), "Enter");
        // What its command kept there, and the background that starts it.
        const kept = keepApp(standIn("the copy it kept"), dataDir);
        writeInstalled(dataDir, {
          service: {
            label: "com.kunchenguid.firstmate3000.dev.work",
            file: join(dataDir, "agent.plist"),
          },
          app: kept,
        });
        const start = (appVersion: string) => {
          const started = startHelper({
            dataDir,
            appVersion,
            say: () => {},
            retryMs: [50],
            log: () => {},
            verifier: release.programs["/usr/bin/codesign"],
          });
          if (!started.ok) throw new Error(started.reason);
          runner = started.run;
          return started.run;
        };
        const row = await selectDevice(page, deviceId);
        const label = "Mac mini";
        await page.evaluate(() => {
          const seen = window as Window & { __updateEvents?: unknown[] };
          seen.__updateEvents = [];
          window.infinitary.events.on((event) => {
            if (event.type === "device_update") seen.__updateEvents?.push(event);
          });
        });
        await demo.record(
          "A Mac a command added updates by itself, with its download's count",
          "window",
          async () => {
            // Its run connects on an older version: the app updates it by
            // itself, and its row follows the download.
            const older = start("0.0.1");
            await expect(row).toContainText(
              remoteLoginWords.downloading(label, 0).split("…")[0] ?? label,
              { timeout: 30_000 },
            );
            await expect(row).not.toContainText("%");
            await expect(row).toContainText(remoteLoginWords.startingRow(label), {
              timeout: 30_000,
            });
            await demo.step(async () => {
              await expect(row).toContainText(remoteLoginWords.startingRow(label));
            });
            expect(await older.ended).toBe("updated");
            start(thisVersion);
            await expect(row).not.toHaveAttribute("data-other-version", /.+/, { timeout: 30_000 });
            await demo.step(async () => {
              await expect(reachDot(row)).toHaveAttribute("data-tone", "ok");
            });
          },
        );
        expect(readFileSync(join(kept, "Contents", "Resources", "marker"), "utf8").trim()).toBe(
          operation === "download" ? "the published copy" : "the home's own copy",
        );
        const said = (await page.evaluate(
          () => (window as Window & { __updateEvents?: unknown[] }).__updateEvents ?? [],
        )) as Extract<FmEvent, { type: "device_update" }>[];
        const downloads = said.filter((event) => event.copy?.download);
        expect(downloads.length).toBeGreaterThan(1);
        expect(downloads.at(-1)?.copy?.download).toEqual({
          received: release.size,
          total: release.size,
        });
        expect(new Set(downloads.map((event) => event.run?.id)).size).toBe(1);
        const sent = said.filter((event) => event.copy?.state === "sending");
        await page.keyboard.press("Escape");
        if (operation === "fallback") {
          expect(sent.at(-1)?.copy?.sent).toBeGreaterThan(8_000_000);
          await expect(feedLineOf(page, sent.at(-1) as FmEvent)).toBeVisible();
          await expect(
            feedLine(page, remoteLoginWords.downloadFallback(label, true)).first(),
          ).toBeVisible();
        } else expect(sent).toEqual([]);
        // The count's line was rewritten in place: its last count stands, its first does not.
        await expect(feedLineOf(page, downloads.at(-1) as FmEvent)).toHaveCount(1);
        await expect(feedLineOf(page, downloads[0] as FmEvent)).toHaveCount(0);
        await expect(
          feedLine(page, remoteLoginWords.updated({ name: label }, "running")).first(),
        ).toBeVisible();
        writeFileSync(testInfo.outputPath("update-events.json"), JSON.stringify(said, null, 2));
        await demo.finish({
          dir: testInfo.outputPath("demo"),
          name: `command-${operation}-after`,
          poster: "last",
        });
      } finally {
        delete process.env.HTTPS_PROXY;
        delete process.env.CURL_CA_BUNDLE;
        await runner?.stop();
        await catalogRefreshesSettled();
        await app.close();
        await app.mockProvider?.close();
        await release.stop();
      }
    },
  );
}

/** INF-322, accepted Add and Update choices. Promise: an Add from the
 * keyboard, and the update the app starts by itself once the Mac connects on
 * an older version, download with their count in the Devices row and replace
 * one feed count in place.
 * Data: a real universal zip of the existing stand-in app, local HTTPS
 * release storage, disposable SSH and helper homes. Completion: the checked
 * app joins/updates, and the last count persists in the feed. macOS only;
 * no real computer, provider, release, signing key or shared port is used.
 */
for (const operation of ["add", "update", "fallback"] as const) {
  test(
    `an addressed Mac downloads with progress ${operation === "add" ? "when added from the keyboard" : "when it updates by itself"}: ${operation}`,
    { tag: MAC_ONLY_TAG },
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured fixture signature.
    async ({}, testInfo) => {
      test.skip(
        !SSH_SERVER_AVAILABLE || process.platform !== "darwin",
        "needs macOS zip tools and isolated SSH",
      );
      test.setTimeout(120_000);
      process.env.PI_OFFLINE = "1";
      const gateDir = scratchDir("infinitary-download-start-");
      const gate = {
        when: operation === "add" ? ("join" as const) : ("update" as const),
        ready: join(gateDir, "ready"),
        resume: join(gateDir, "resume"),
      };
      const { sshd, them, work, bundle } = await otherMacOverSsh(undefined, gate);
      addStandInPayload(bundle, randomBytes(8_000_000));
      const release = await macRelease(bundle, appPackage.version, 150);
      const ssh = sshd.ssh({
        remote: {
          HOME: them,
          CFFIXED_USER_HOME: them,
          TMPDIR: them,
          INFINITARY_HELPER_DATA_DIR: work,
          INFINITARY_DEVICE_NAME: "Mac mini",
          ELECTRON_RENDERER_URL: "",
          PI_OFFLINE: "1",
          CURL_CA_BUNDLE: release.cert,
        },
        downloads: release.downloads,
        programs: release.programs,
        elsewhere: true,
      });
      const demo = await startDemo({
        withMockProvider: true,
        size: { width: 1280, height: 800 },
        env: {
          INFINITARY_SSH: ssh.program,
          INFINITARY_APP_BUNDLE: bundle,
          INFINITARY_PUBLISHED_TAP: release.dir,
        },
      });
      const app = demo.launched;
      let runner: HelperRun | undefined;
      try {
        const { page } = app;
        await openDevices(page);
        await page.evaluate(() => {
          const seen = window as Window & { __downloadEvents?: unknown[] };
          seen.__downloadEvents = [];
          window.infinitary.events.on((event) => {
            if (event.type === "device_setup") seen.__downloadEvents?.push(event);
          });
        });
        let device: DeviceView | undefined;
        if (operation === "add") {
          await demo.record("Add a Mac with download progress", "window", async () => {
            const joining = addByAddress(page, sshd.address, 30_000);
            await expect(page.locator("[data-device-adding]")).toContainText(
              remoteLoginWords.startingRow("Mac mini"),
              { timeout: 30_000 },
            );
            await demo.step(async () => {
              await expect(page.locator("[data-device-adding]")).toContainText(
                remoteLoginWords.startingRow("Mac mini"),
              );
            });
            writeFileSync(gate.resume, "resume");
            device = await joining;
          });
        } else {
          device = await addByAddress(page, sshd.address, 30_000);
          const updatingDevice = device;
          const row = await selectDevice(page, device.id);
          const label = deviceLabel(device);
          const update = row.getByRole("button", {
            name: m.settingsDevicesMatchNamed({ device: label }),
            exact: true,
          });
          if (operation === "fallback") release.mode("corrupt");
          await page.evaluate(() => {
            (window as Window & { __downloadEvents?: unknown[] }).__downloadEvents = [];
          });
          await demo.record(
            "A Mac updates by itself with download progress",
            "window",
            async () => {
              // Its run connects on an older version: the app updates it by
              // itself, and its row follows the download.
              const started = startHelper({
                dataDir: work,
                appVersion: "0.0.1",
                say: () => {},
                retryMs: [50],
                log: () => {},
              });
              if (!started.ok) throw new Error(started.reason);
              runner = started.run;
              await expect(row).toContainText(
                remoteLoginWords.downloading(label, 0).split("…")[0] ?? label,
                { timeout: 30_000 },
              );

              await expect(row).not.toContainText("%");
              await expect(row).toContainText(remoteLoginWords.startingRow(label), {
                timeout: 30_000,
              });
              await demo.step(async () => {
                await expect(row).toContainText(remoteLoginWords.startingRow(label));
              });
              writeFileSync(gate.resume, "resume");
              // The older test helper deliberately keeps reporting its old version,
              // so Update shows again once the update is over.
              // Remote Login already checked the new app's work-update outcome.
              await expect(update).toBeVisible({ timeout: 30_000 });
              await page.keyboard.press("Escape");
              await expect(
                feedLine(page, remoteLoginWords.updated(updatingDevice, "running")).first(),
              ).toBeVisible();
            },
          );
        }
        const said = (await page.evaluate(
          () => (window as Window & { __downloadEvents?: unknown[] }).__downloadEvents ?? [],
        )) as Extract<FmEvent, { type: "device_setup" }>[];
        const downloads = said.filter((event) => event.copy?.download);
        expect(downloads.length).toBeGreaterThan(2);
        expect(downloads.at(-1)?.copy?.download).toEqual({
          received: release.size,
          total: release.size,
        });
        expect(new Set(downloads.map((event) => event.run?.id)).size).toBe(1);
        const sent = said.filter((event) => event.copy?.state === "sending");
        if (operation === "fallback") {
          expect(sent.at(-1)?.copy?.sent).toBeGreaterThan(8_000_000);
          await expect(feedLineOf(page, sent.at(-1) as FmEvent)).toBeVisible();
          await expect(
            feedLine(
              page,
              remoteLoginWords.downloadFallback(deviceLabel(device ?? { name: "Mac mini" }), true),
            ).first(),
          ).toBeVisible();
        } else expect(sent).toEqual([]);
        await page.keyboard.press("Escape");
        const finalDownload = feedLineOf(page, downloads.at(-1) as FmEvent);
        // Add and Update each retain their own completed run with the same words.
        await expect(finalDownload).toHaveCount(operation === "add" ? 1 : 2);
        await expect(finalDownload.last()).toBeVisible();
        await expect(feedLineOf(page, downloads[0] as FmEvent)).toHaveCount(0);
        writeFileSync(testInfo.outputPath("download-events.json"), JSON.stringify(said, null, 2));
        await demo.finish({
          dir: testInfo.outputPath("demo"),
          name: `${operation}-after`,
          poster: "last",
        });
      } finally {
        writeFileSync(gate.resume, "resume");
        await runner?.stop();
        await catalogRefreshesSettled();
        await app.close();
        await app.mockProvider?.close();
        await sshd.stop();
        await release.stop();
      }
    },
  );
}
