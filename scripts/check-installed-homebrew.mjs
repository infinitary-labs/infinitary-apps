import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { assertInstallerEnvironment } from "./installer-environment.ts";
import { verifyInstallerTicket } from "./installer-ticket.ts";
import { installerHomebrewEnvironment } from "./installer-homebrew.ts";

// Called only inside the installed probe's disposable Mac and scratch HOME.
// The generated casks and signed ZIPs are real; only their cache and tap are local.
export async function checkInstalledHomebrew(world) {
  assertInstallerEnvironment();
  const { runner, root, work, home, data, installed, fixtures, versions, env, brewPath,
    run, launch, stopApp, status, install, feed, record, checkpoint, saved, installedVersion } = world;
  assert(env.HOME === home && env.CFFIXED_USER_HOME === home);
  assert(env.INFINITARY_LOCAL_CODESIGN_DIR.startsWith(`${home}/`));
  assert(existsSync(brewPath), "The disposable Mac must provide Homebrew for its installation check");
  const { renderCask } = await runner.import(join(root, "src/core/update/tapPublication.ts"));
  const { INFINITARY_TAP, FIRSTMATE_TAP, buildUpdateTarget, targetsUrlOf, upgradeCommandFor } =
    await runner.import(join(root, "src/core/update/updateChannels.ts"));
  const { MAC_INSTALLATION_ATTRIBUTE, MAC_INSTALLATION_RESOURCE, DIRECT_MAC_INSTALLATION,
    homebrewInstallationReceipt } = await runner.import(join(root, "src/core/update/macInstallation.ts"));
  const digests = JSON.parse(readFileSync(join(fixtures, "digests.json"), "utf8"));
  // Reuse keeps the signed app's original source, not the newer test setup's source.
  const sourceCommit = process.env.INSTALLER_SOURCE_COMMIT || run("/usr/bin/git", ["rev-parse", "HEAD"]);
  const brewEnv = installerHomebrewEnvironment(env, work);
  mkdirSync(brewEnv.HOMEBREW_TEMP, { recursive: true });
  function brew(args) {
    checkpoint(`Homebrew ${args[0]}`);
    const output = run(brewPath, args, { env: brewEnv, timeout: 180_000 });
    console.log(output);
    return output;
  }
  function verifySignedCopy(receipt, version) {
    assert.equal(installedVersion(), version);
    assert.equal(run("/usr/bin/xattr", ["-p", MAC_INSTALLATION_ATTRIBUTE, join(installed, MAC_INSTALLATION_RESOURCE)]), receipt);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed]);
    verifyInstallerTicket(installed, join(fixtures, `Infinitary-${version}-universal.zip`), run, record);
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", installed]);
    assert(saved.savedWorkPresent(data));
  }
  const seededQuarantine = "0083;68f6a000;Safari;83A1A181-41E4-4D37-8388-8584D849A851";
  const initialTaps = brew(["tap"]).split("\n");
  assert(initialTaps.includes("homebrew/core"), "The Homebrew prerequisite must be prepared before GitHub is redirected");
  await stopApp();
  rmSync(installed, { recursive: true, force: true });
  assert(saved.savedWorkPresent(data), "Switching methods must retain the direct installation's saved work");
  for (const tap of [INFINITARY_TAP, FIRSTMATE_TAP]) {
    assert(!initialTaps.includes(tap.tap), "The disposable image must not already contain the verification tap");
    const source = join(work, tap.tap.replaceAll("/", "-"));
    mkdirSync(join(source, "Casks"), { recursive: true });
    run("/usr/bin/git", ["init", source]);
    writeFileSync(join(source, "README.md"), "Disposable signed installation verification.\n");
    run("/usr/bin/git", ["-C", source, "add", "."]);
    run("/usr/bin/git", ["-C", source, "-c", "user.name=Installer verification", "-c", "user.email=installer@example.invalid", "commit", "-m", "test: prepare disposable cask verification"]);
    brew(["tap", tap.tap, source]);
    const checkout = brew(["--repository", tap.tap]).split("\n").at(-1);
    mkdirSync(join(checkout, "Casks"), { recursive: true });
    try {
      for (const channel of ["stable", "alpha"]) {
        const before = channel === "stable" ? versions.promotedStable : versions.alphaBefore;
        const after = channel === "stable" ? versions.nextStable : versions.alphaAfter;
        const token = tap.caskTokens[channel];
        const fullToken = `${tap.tap}/${token}`;
        function target(version) {
          const assetName = `Infinitary-${version}-universal.zip`;
          return buildUpdateTarget({ version, assetName, sha256: digests[assetName].sha256, sourceCommit }, tap);
        }
        function publishLocal(version) {
          const artifact = target(version);
          writeFileSync(join(checkout, "Casks", `${token}.rb`), renderCask(channel, artifact, "Signed installation verification.", tap));
          const archive = brew(["--cache", "--cask", fullToken]).split("\n").at(-1);
          mkdirSync(dirname(archive), { recursive: true });
          copyFileSync(join(fixtures, `Infinitary-${version}-universal.zip`), archive);
          run("/usr/bin/xattr", ["-w", "com.apple.quarantine", seededQuarantine, archive]);
        }
        const metadata = { [new URL(targetsUrlOf(tap)).pathname]: { schemaVersion: 1, targets: { [channel]: target(after) } } };
        feed({ metadata, mode: "normal" });
        publishLocal(before);
        brew(["install", "--cask", "--appdir=/Applications", fullToken]);
        try {
          const receipt = homebrewInstallationReceipt(channel, tap);
          verifySignedCopy(receipt, before);
          assert(run("/usr/bin/xattr", ["-p", "com.apple.quarantine", installed]), "Homebrew must retain quarantine on the installed app");
          let page = await launch();
          const offered = await status(page);
          assert.equal(offered.channel, channel);
          assert.equal(offered.latestVersion, after);
          assert.equal(offered.upgradeCommand, upgradeCommandFor(channel, tap));
          assert.equal(offered.channelChoice, undefined);
          assert.equal(offered.install, undefined);
          assert.equal((await install(page)).ok, false);
          assert.equal(installedVersion(), before);
          await stopApp();
          publishLocal(after);
          brew(["upgrade", "--cask", "--appdir=/Applications", fullToken]);
          verifySignedCopy(receipt, after);
          assert(run("/usr/bin/xattr", ["-p", "com.apple.quarantine", installed]));
          page = await launch();
          assert.equal((await status(page)).currentVersion, after);
          assert(saved.savedWorkPresent(data));
          await stopApp();
          record(`Signed Homebrew ${channel} through ${tap.tap}`, "Homebrew installed and upgraded the signed app; its receipt, quarantine, signature, saved task and draft survived, and the app refused native replacement.");
        } finally {
          await stopApp();
          brew(["uninstall", "--cask", fullToken]); // Never --zap: saved work belongs to the person.
        }
        assert(saved.savedWorkPresent(data));
        const direct = join(work, "switch-back-to-direct");
        rmSync(direct, { recursive: true, force: true });
        run("/usr/bin/ditto", ["-x", "-k", join(fixtures, `Infinitary-${after}-universal.zip`), direct]);
        run("/usr/bin/ditto", [join(direct, "Infinitary.app"), installed]);
        verifySignedCopy(DIRECT_MAC_INSTALLATION, after);
        const page = await launch();
        assert.equal((await status(page)).channelChoice, true);
        assert(saved.savedWorkPresent(data));
        await stopApp();
        rmSync(installed, { recursive: true, force: true });
        rmSync(direct, { recursive: true, force: true });
        record("Signed installation-method handover", "Removing the Homebrew app without deleting saved work and installing the direct copy restored direct ownership and in-app channels.");
      }
    } finally { brew(["untap", tap.tap]); }
  }
}
