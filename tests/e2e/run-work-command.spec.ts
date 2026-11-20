import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import electronPath from "electron";
import { joinCommand, shellWord } from "../../src/core/devices/joinCommand";
import { JoinedHome } from "../../src/core/devices/joinedHome";
import { readInstalled } from "../../src/core/helper/background";
import { afterLogout, helperWords, macAsk } from "../../src/core/helper/words";
import { NO_SCREEN_WORDS } from "../../src/main/noScreen";
import { macRelease } from "../helpers/macRelease";
import { scratchDir } from "../helpers/scratchDirs";
import { trackChildTree } from "../helpers/stopChildTree";
import { builtAppDir } from "./launch";
import {
  appVersion,
  children,
  endRunWork,
  home,
  ME,
  noUbuntuPackage,
  onLinuxThatRunsIt,
  THIS_MAC,
  terminal,
  user,
  work,
} from "./runWork";
import { MAC_ONLY_TAG } from "./tags";

/**
 * The command a home gives for a computer that runs its work
 * (src/core/devices/joinCommand.ts, docs/helper.md), typed into Terminal:
 * for another user on this Mac, for another Mac that gets Infinitary from the
 * home or downloads the published version, and on Linux with no screen,
 * where the window says to use that command instead.
 */

test.afterEach(endRunWork);

/** This Mac's own network address, as `os.networkInterfaces()` lists it. */
const ownNetwork = (address: string): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
  en0: [
    {
      address,
      netmask: "255.255.255.0",
      family: "IPv4",
      mac: "00:00:00:00:00:00",
      internal: false,
      cidr: `${address}/24`,
    },
  ],
});

test("the command for another user on this Mac starts this Mac's app, which asks, joins, runs in the background, and stays in reach when this Mac's address changes", async () => {
  let address = "192.168.65.2";
  const at = await home(ME.uid + 1, undefined, () => ownNetwork(address));
  const me = user();
  const command = joinCommand({
    for: "another-user",
    link: await at.command(),
    homeName: "MacBook Pro",
    launcher: { executable: electronPath as unknown as string, args: [builtAppDir()] },
    version: appVersion(),
  });
  const ran = terminal(command, me.env, "yes\n");
  expect(await ran.exited).toBe(0);
  expect(ran.lines()).toEqual([
    ...helperWords.ask(THIS_MAC, ME.name, process.platform),
    `${helperWords.prompt}yes`,
    ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
  ]);
  const [device] = at.pairing.list();
  expect(device).toMatchObject({ kind: "work", user: ME.name, onThisMac: true });
  expect(me.managerAsked().slice(-me.background.started.length)).toEqual(me.background.started);

  await test.step("this Mac's network address changes, and its run comes back with no new command", async () => {
    // That user dials from this Mac itself, so its grant names loopback, not 192.168.65.2.
    expect(new JoinedHome(me.dataDir).read()?.grant.at).toBe(at.at());
    const running = work(["run"], me.env);
    const inReach = helperWords.inReach(THIS_MAC, "MacBook Pro")[0];
    await expect.poll(running.lines).toContain(inReach);
    // This Mac moves to another network, and the home listens anew there.
    address = "192.168.65.77";
    await at.quit();
    await expect
      .poll(() => running.lines().at(-1))
      .toBe(helperWords.quit(THIS_MAC, "MacBook Pro")[0]);
    await at.reopen();
    await expect.poll(() => running.lines().at(-1)).toBe(inReach);
    expect(at.pairing.list()).toEqual([device]);
    expect(new JoinedHome(me.dataDir).read()?.grant.at).toBe(at.at());
  });
});

test("the command for another Mac gets Firstmate from the home, and the copy it got joins and runs in the background", {
  tag: MAC_ONLY_TAG,
}, async () => {
  // The command gets a Mac's app bundle from the home and starts it: a Linux
  // computer joins by a link pasted into its own Firstmate (docs/devices.md).
  test.skip(process.platform !== "darwin", "the command for another Mac gets a Mac's app");
  // The home sends a bundle whose program starts the built app, as an
  // installed Firstmate's own program is the app itself.
  const bundle = join(scratchDir("infinitary-run-work-bundle-"), "Firstmate 3000.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  const program = join(bundle, "Contents", "MacOS", "Firstmate 3000");
  writeFileSync(
    program,
    `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
  );
  chmodSync(program, 0o755);
  const at = await home(ME.uid + 1, bundle);
  const me = user();
  const link = await at.link();
  const command = joinCommand({
    for: "another-mac",
    link,
    homeName: "MacBook Pro",
    launcher: { executable: "/unused", args: [] },
    version: appVersion(),
  });
  const ran = terminal(command, me.env, "yes\n");
  expect(await ran.exited).toBe(0);
  // Asked once, before anything was fetched; the copy it got joined without asking again.
  expect(ran.lines()).toEqual([
    ...macAsk("MacBook Pro", ME.name),
    "Type yes to agree: Getting Infinitary from MacBook Pro… done.",
    ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
  ]);
  expect(at.pairing.list()).toEqual([
    expect.objectContaining({ kind: "work", name: "Studio Mac", user: ME.name }),
  ]);
  // It keeps the copy it got, and the background starts that copy.
  const kept = join(me.dataDir, "app", "Firstmate 3000.app");
  const installed = readInstalled(me.dataDir);
  expect(installed.app).toBe(kept);
  expect(readFileSync(installed.service?.file ?? "", "utf8")).toContain(
    `<string>${join(kept, "Contents", "MacOS", "Firstmate 3000")}</string>`,
  );
  expect(readFileSync(join(kept, "Contents", "MacOS", "Firstmate 3000"), "utf8")).toBe(
    readFileSync(program, "utf8"),
  );
});

/** This environment with no screen: neither an X nor a Wayland display. */
function noScreen(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPLAY: _x, WAYLAND_DISPLAY: _wayland, ...rest } = env;
  return rest;
}

/**
 * INF-1181's accepted plan: on Linux with no display, Infinitary's window
 * says in two plain lines to use Run a command there, and exits 1 without
 * Chromium's crash. Data: the built app started as its window, with the
 * display unset. Completion: the process exits. Linux only: a Mac always
 * has its screen.
 */
test("on Linux with no screen, the window says to use Run a command there and exits 1", async () => {
  test.skip(process.platform !== "linux", "only Linux starts with no screen");
  const me = user();
  const child = spawn(electronPath as unknown as string, [builtAppDir()], {
    env: noScreen(me.env),
    cwd: scratchDir("infinitary-run-work-cwd-"),
    detached: process.platform !== "win32",
  });
  children.push(trackChildTree(child));
  let error = "";
  child.stderr.on("data", (chunk) => {
    error += String(chunk);
  });
  const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  expect(code).toBe(1);
  expect(error).toBe(`${NO_SCREEN_WORDS.join("\n")}\n`);
});

/**
 * INF-1181's accepted plan and the captain's "linger" pick. Promise: on
 * Linux with no display, the command from Run a command there joins with
 * the Infinitary installed there - nothing downloaded or got from the home -
 * which asks its own yes and runs in the background, and the command's last
 * lines name the one sudo line that keeps the work on after logout where
 * systemd does not let this user. Data: the built app as the installed
 * program, the display unset, a home with nothing to send. Completion: the
 * command exits. Linux only: the command joins this way only there.
 */
test("on Linux with no screen, the command joins with the Infinitary installed there and names the line that keeps it on after logout", async () => {
  test.skip(process.platform !== "linux", "the command joins with an installed copy on Linux");
  const at = await home(ME.uid + 1);
  const me = user();
  const files = noUbuntuPackage();
  writeFileSync(
    files.packageBin,
    `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
    { mode: 0o755 },
  );
  const record = scratchDir("infinitary-run-work-linux-record-");
  const command = joinCommand({
    for: "another-mac",
    link: await at.link(),
    homeName: "MacBook Pro",
    launcher: { executable: "/unused", args: [] },
    version: appVersion(),
    linux: files,
  });
  const ran = terminal(command, noScreen(onLinuxThatRunsIt(me.env, record)), "yes\n");
  expect(await ran.exited, ran.error()).toBe(0);
  expect(ran.lines()).toEqual([
    ...helperWords.ask(THIS_MAC, ME.name, process.platform),
    `${helperWords.prompt}yes`,
    ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
    ...afterLogout(ME.name, false),
  ]);
  expect(at.pairing.list()).toEqual([expect.objectContaining({ kind: "work", user: ME.name })]);
  expect(me.managerAsked().slice(-me.background.started.length)).toEqual(me.background.started);
  // It asked systemd to keep the work on, without a password, and was refused.
  expect(readFileSync(join(record, "loginctl.asked"), "utf8")).toContain(
    `enable-linger --no-ask-password ${ME.name}`,
  );
});

/**
 * INF-322 direction B, adding by a command (INF-330). Promise: the command
 * for another Mac downloads this computer's published version there, checks
 * it and joins with it, so the copy it downloaded is the one kept and run in
 * the background. Data: a real universal zip of a bundle whose program starts
 * the built app, served over local HTTPS which curl trusts here alone, its
 * publisher check stood in where the command names codesign; the home's own
 * copy is another bundle that is never sent. Completion: the command exits,
 * the computer is on the home's list, and its background starts the
 * downloaded copy. macOS only: the command downloads a Mac's app.
 */
test("the command for another Mac downloads the published version, and the copy it downloaded joins and runs in the background", {
  tag: MAC_ONLY_TAG,
}, async () => {
  test.skip(process.platform !== "darwin", "the command downloads a Mac's app");
  const program = (bundle: string) => join(bundle, "Contents", "MacOS", "Firstmate 3000");
  const app = (marker: string) => {
    const bundle = join(scratchDir("infinitary-run-work-bundle-"), "Firstmate 3000.app");
    mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
    writeFileSync(
      program(bundle),
      `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
    );
    chmodSync(program(bundle), 0o755);
    writeFileSync(join(bundle, "Contents", "Resources", "marker"), `${marker}\n`);
    return bundle;
  };
  const release = await macRelease(app("the published copy"), "0.13.0");
  try {
    const at = await home(ME.uid + 1, app("the home's own copy"));
    const me = user();
    let command = joinCommand({
      for: "another-mac",
      link: await at.link(),
      homeName: "MacBook Pro",
      launcher: { executable: "/unused", args: [] },
      version: appVersion(),
      download: {
        url: release.downloads[release.publicUrl] ?? "",
        sha256: release.sha256,
        expiresAt: Date.now() + 10 * 60_000,
      },
    });
    for (const [from, to] of Object.entries(release.programs))
      command = command.split(from).join(to);
    const ran = terminal(command, { ...me.env, CURL_CA_BUNDLE: release.cert }, "yes\n");
    expect(await ran.exited).toBe(0);
    // Asked once, before anything was downloaded; each count rewrote the line it stands on.
    const shown = ran.lines().map((line) => line.split("\r").at(-1)?.replace("\x1b[K", "") ?? "");
    expect(shown).toEqual([
      ...macAsk("MacBook Pro", ME.name),
      expect.stringMatching(/^Downloading Infinitary… \S+ [KMG]?B of \S+ [KMG]?B, done\.$/),
      ...helperWords.joined(THIS_MAC, "MacBook Pro", ME.name, "running"),
    ]);
    expect(at.pairing.list()).toEqual([
      expect.objectContaining({ kind: "work", name: "Studio Mac", user: ME.name }),
    ]);
    // It keeps the copy it downloaded, and the background starts that copy.
    const kept = join(me.dataDir, "app", "Firstmate 3000.app");
    expect(readInstalled(me.dataDir).app).toBe(kept);
    expect(readFileSync(join(kept, "Contents", "Resources", "marker"), "utf8")).toBe(
      "the published copy\n",
    );
    expect(readFileSync(readInstalled(me.dataDir).service?.file ?? "", "utf8")).toContain(
      `<string>${program(kept)}</string>`,
    );
    expect(release.requests()).toBe(1);
    expect(release.verifications()).toHaveLength(1);
  } finally {
    await release.stop();
  }
});
