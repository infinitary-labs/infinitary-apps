// INF-1258's accepted mac-unit-only option: Linux runs the complete Vitest
// suite; the full-check Mac lane runs only cases/readings Linux cannot cover.
// INF-2273 separately requires local rounds for every edited unit file,
// including portable files; this list does not exclude those local rounds.
// Keep mixed files whole: their platform-independent cases may run twice, but
// their Mac-only cases must not disappear. Mock-only macOS tests stay on Linux.
// This is a reviewed list, not a guess from filenames or test-source strings.
export const MAC_UNIT_FILES = [
  // Native LocalAuthentication; the two scratch Keychain probes keep their
  // existing opt-in gates (listing them does not enable either probe).
  "src/main/host/darwinFreshAuthentication.test.ts",
  // Native NSPasteboard writes for Copy value, on uniquely named pasteboards only.
  "src/main/host/darwinSecretClipboard.test.ts",
  "src/main/host/darwinKeychain.scratch.test.ts",
  "src/main/host/darwinSecretCustody.scratch.test.ts",
  "src/main/host/claudeKeychainAccess.integration.test.ts",
  // APFS cloning and macOS filesystem behavior.
  "src/core/folderMove/copy.test.ts",
  "src/core/folderMove/move.test.ts",
  "tests/install-clones.test.ts",
  // macOS's second path to every folder on its data volume (/System/Volumes/Data).
  "src/core/files/fileReach.test.ts",
  // Real macOS tools: taskpolicy, nc, bundled git, and Mac remote commands.
  "src/core/utilityQos.test.ts",
  "src/core/jobs/jobManager.test.ts",
  "src/core/workspace/git.test.ts",
  "src/core/devices/relay.test.ts",
  "src/core/devices/remoteLogin.test.ts",
  "src/core/devices/remoteLoginDownload.test.ts",
  "src/core/devices/remoteLoginForward.test.ts",
  "src/core/devices/remoteLoginFound.test.ts",
  "src/core/devices/remoteLoginLink.test.ts",
  "src/core/devices/remoteLoginPassword.test.ts",
  "src/core/devices/remoteLoginUbuntu.test.ts",
  "src/core/devices/remoteLoginUpdate.test.ts",
  "src/core/devices/joinCommand.test.ts",
  "src/core/devices/computerUpdate.test.ts",
  // Native same-group fork/exec, macOS birth identities and receipt cancellation.
  "src/core/placed/loadLine.integration.test.ts",
  // A word's profile refused by a real macOS access list its mode does not show (chmod +a, ls -le).
  "src/main/personWord.integration.test.ts",
  // The run guard's real lsof readings, including unlinked scratch and /private/tmp.
  "tests/run-temp-root.test.ts",
  // A local phone gate's place in the load line: the gate needs Xcode on a Mac.
  "tests/heavy-run-place-phone.test.ts",
  // The real shell's Mac app-folder lookup (Linux uses AppImage paths).
  "src/core/devices/farSystems.test.ts",
  "tests/starve-check.test.ts",
  // Signing stand-ins, bundle tools and real Homebrew (where installed).
  "tests/local-codesign.test.ts",
  "tests/release-contract.test.ts",
  "tests/cask-consumers.test.ts",
  // LaunchServices and Apple's compiler: the app's own executables.
  "tests/mac-app-launcher.test.ts",
  // The live Mac catalog retains its existing offline/opt-in behavior.
  "src/core/pi/piCatalogProbe.test.ts",
] as const;

// Shell command substitution in verify.yml passes these exact file filters to
// the existing runner, preserving each file's cohort, isolation and setup.
if (import.meta.main) console.log(MAC_UNIT_FILES.join("\n"));
