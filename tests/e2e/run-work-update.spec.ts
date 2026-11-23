import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import electronPath from "electron";
import { joinCommand, shellWord } from "../../src/core/devices/joinCommand";
import { readInstalled } from "../../src/core/helper/background";
import { helperWords } from "../../src/core/helper/words";
import { macRelease } from "../helpers/macRelease";
import { scratchDir } from "../helpers/scratchDirs";
import { builtAppDir } from "./launch";
import { appVersion, endRunWork, home, ME, THIS_MAC, terminal, user } from "./runWork";
import { MAC_ONLY_TAG } from "./tags";

/**
 * A computer a command joined, updated by its home over the connection
 * (docs/helper.md): the copy kept there gets the home's Infinitary, or
 * downloads the published version itself, keeps it in its place, and ends
 * for its background to start it again.
 */

test.afterEach(endRunWork);

/**
 * The environment a command for another Mac runs in as if on a Mac: on any
 * other system its script stops at once, since it gets a Mac's Firstmate
 * (src/core/devices/joinCommand.ts), so a stand-in `uname` says Darwin, as
 * the bundle the home sends here stands in a Mac's app.
 */
function onAMac(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform === "darwin") return env;
  const bin = scratchDir("infinitary-run-work-mac-bin-");
  writeFileSync(join(bin, "uname"), "#!/bin/sh\necho Darwin\n");
  chmodSync(join(bin, "uname"), 0o755);
  return { ...env, PATH: `${bin}:${env.PATH ?? ""}` };
}

test("updated over the connection: the copy a command kept gets the home's Firstmate with its own key, keeps it, and ends for its background to start it again", async () => {
  // The home sends a bundle whose program starts the built app, as an
  // installed Firstmate's own program is the app itself.
  const bundle = join(scratchDir("infinitary-run-work-bundle-"), "Firstmate 3000.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(bundle, "Contents", "Resources"), { recursive: true });
  const program = join(bundle, "Contents", "MacOS", "Firstmate 3000");
  writeFileSync(
    program,
    `#!/bin/sh\nexec ${shellWord(electronPath as unknown as string)} ${shellWord(builtAppDir())} "$@"\n`,
  );
  chmodSync(program, 0o755);
  writeFileSync(join(bundle, "Contents", "Resources", "marker"), "the copy the command got\n");
  const at = await home(ME.uid + 1, bundle);
  const me = user();
  const command = joinCommand({
    for: "another-mac",
    link: await at.link(),
    homeName: "MacBook Pro",
    launcher: { executable: "/unused", args: [] },
    version: appVersion(),
  });
  expect(await terminal(command, onAMac(me.env), "yes\n").exited).toBe(0);
  const [device] = at.pairing.list();
  const kept = join(me.dataDir, "app", "Firstmate 3000.app");
  const marker = () => readFileSync(join(kept, "Contents", "Resources", "marker"), "utf8").trim();
  expect(marker()).toBe("the copy the command got");

  // The home's Firstmate moves on; the background starts the copy kept there.
  writeFileSync(join(bundle, "Contents", "Resources", "marker"), "the home's newer copy\n");
  const started = () =>
    terminal(
      `${shellWord(join(kept, "Contents", "MacOS", "Firstmate 3000"))} work run`,
      me.env,
      "",
    );
  const before = started();
  const inReach = helperWords.inReach(THIS_MAC, "MacBook Pro")[0];
  await expect.poll(before.lines).toContain(inReach);

  expect(
    await at.connection().ask(device?.id ?? "", "fm:firstmate:update", [], { anyVersion: true }),
  ).toEqual({ restarts: true });
  expect(await before.exited).toBe(0);
  expect(before.lines()).toEqual(
    expect.arrayContaining(helperWords.updated(THIS_MAC, "MacBook Pro", true)),
  );
  expect(marker()).toBe("the home's newer copy");
  expect(readInstalled(me.dataDir).app).toBe(kept);
  expect(readdirSync(me.dataDir).filter((entry) => entry.startsWith("update-"))).toEqual([]);

  const after = started();
  await expect.poll(after.lines).toContain(inReach);
});

/**
 * INF-322 direction B, Update over the connection (INF-330). Promise: the
 * built app's work mode, asked the download order, downloads the published
 * version itself, says how far it got, keeps it in place of its copy and
 * ends for its background to start it again; asked again with a download
 * that does not match, it changes nothing and answers the fallback. Data: a
 * real universal zip over local HTTPS which curl trusts here alone, and a
 * development run's stand-in publisher check (`INFINITARY_CODESIGN`), as an
 * installed app never reads. Completion: the run exits, and the copy kept
 * there is the downloaded one. macOS only: it downloads a Mac's app.
 */
test("updated over the connection, the copy a command kept downloads the published version itself, keeps it, and ends", {
  tag: MAC_ONLY_TAG,
}, async () => {
  test.skip(process.platform !== "darwin", "a Mac downloads a Mac's app");
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
    const at = await home(ME.uid + 1, app("the copy the command got"));
    const me = user();
    const command = joinCommand({
      for: "another-mac",
      link: await at.link(),
      homeName: "MacBook Pro",
      launcher: { executable: "/unused", args: [] },
      version: appVersion(),
    });
    expect(await terminal(command, onAMac(me.env), "yes\n").exited).toBe(0);
    const [device] = at.pairing.list();
    const kept = join(me.dataDir, "app", "Firstmate 3000.app");
    const marker = () => readFileSync(join(kept, "Contents", "Resources", "marker"), "utf8").trim();
    const env = {
      ...me.env,
      CURL_CA_BUNDLE: release.cert,
      INFINITARY_CODESIGN: release.programs["/usr/bin/codesign"] ?? "",
    };
    const started = () => terminal(`${shellWord(program(kept))} work run`, env, "");
    const inReach = helperWords.inReach(THIS_MAC, "MacBook Pro")[0];
    const ask = (channel: string, args: unknown) =>
      at.connection().ask(device?.id ?? "", channel, args, { anyVersion: true });
    const download = {
      url: release.downloads[release.publicUrl] ?? "",
      sha256: release.sha256,
    };

    const first = started();
    await expect.poll(first.lines).toContain(inReach);
    release.mode("corrupt");
    expect(await ask("fm:firstmate:update-download", [download])).toEqual({
      fallback: "mismatch",
      received: release.size,
      total: release.size,
    });
    expect(marker()).toBe("the copy the command got");
    expect(await ask("fm:firstmate:update-progress", [])).toEqual({
      received: release.size,
      total: release.size,
      state: "mismatch",
    });

    release.mode("success");
    expect(await ask("fm:firstmate:update-download", [download])).toEqual({
      restarts: true,
      received: release.size,
      total: release.size,
    });
    expect(await first.exited).toBe(0);
    expect(first.lines()).toEqual(
      expect.arrayContaining(helperWords.updated(THIS_MAC, "MacBook Pro", true)),
    );
    expect(marker()).toBe("the published copy");
    expect(readInstalled(me.dataDir).app).toBe(kept);
    expect(readdirSync(me.dataDir).filter((entry) => entry.startsWith("update-"))).toEqual([]);
    expect(release.verifications()).toHaveLength(1);

    const after = started();
    await expect.poll(after.lines).toContain(inReach);
  } finally {
    await release.stop();
  }
});
