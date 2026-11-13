import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PHONE_PARTS } from "./phone-test-plan.ts";

// The approved phone-check cuts: explicit ownership for production files; new files
// must acquire owners rather than silently dropping out of branch coverage.
const ALL = PHONE_PARTS.map(({ name }) => name);
const family = (name: string) => ALL.filter((part) => part.split("-")[0] === name);
const GROUPS: { parts: readonly string[]; files: readonly string[] }[] = [
  { parts: ALL, files: [
    "ios/ExportOptions.plist",
    "ios/Infinitary/Infinitary.xcodeproj/project.pbxproj",
    "ios/Infinitary/Infinitary.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved",
    "ios/Infinitary/Infinitary.xcodeproj/xcshareddata/xcschemes/Infinitary.xcscheme",
    "ios/Infinitary/InfinitaryApp/Assets.xcassets/AppIcon.appiconset/AppIcon.png",
    "ios/Infinitary/InfinitaryApp/Assets.xcassets/AppIcon.appiconset/Contents.json",
    "ios/Infinitary/InfinitaryApp/Assets.xcassets/Contents.json",
    "ios/Infinitary/InfinitaryApp/Assets.xcassets/LaunchBackground.colorset/Contents.json",
    "ios/Infinitary/InfinitaryApp/Fonts/Font-licenses.txt",
    "ios/Infinitary/InfinitaryApp/Fonts/JetBrainsMono.ttf",
    "ios/Infinitary/InfinitaryApp/Fonts/SpaceGrotesk.ttf",
    "ios/Infinitary/InfinitaryApp/InfinitaryApp.swift",
    "ios/Infinitary/InfinitaryApp/MessageComposer.swift",
    "ios/Infinitary/InfinitaryApp/Notices/swift-asn1-LICENSE.txt",
    "ios/Infinitary/InfinitaryApp/Notices/swift-asn1-NOTICE.txt",
    "ios/Infinitary/InfinitaryApp/Notices/swift-certificates-LICENSE.txt",
    "ios/Infinitary/InfinitaryApp/Notices/swift-certificates-NOTICE.txt",
    "ios/Infinitary/InfinitaryApp/Notices/swift-crypto-LICENSE.txt",
    "ios/Infinitary/InfinitaryApp/Notices/swift-crypto-NOTICE.txt",
    "ios/Infinitary/InfinitaryApp/PhoneAppearance.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardBodies.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardRow.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardWords.generated.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCards.swift",
    "ios/Infinitary/InfinitaryApp/PhoneFont.swift",
    "ios/Infinitary/InfinitaryApp/PhoneModel.swift",
    "ios/Infinitary/InfinitaryApp/PhoneQuestionBubble.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSettingsSheet.swift",
    "ios/Infinitary/InfinitaryApp/PhoneStyle.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSymbol.swift",
    "ios/Infinitary/InfinitaryApp/PhoneTheme.generated.swift",
    "ios/Infinitary/InfinitaryApp/PhoneWorkspace.swift",
    "ios/Infinitary/InfinitaryKit/Package.resolved",
    "ios/Infinitary/InfinitaryKit/Package.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneContract.generated.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneDiagnostics.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneFormats.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneFrame.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneIntents.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneLook.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneMessages.generated.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneRecordRules.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneWords.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/ReadOnlySession.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/Resources/",
    // The last turn's whole-word cut, which every part's message box draws (MessageComposer.swift).
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/WholeWords.swift",
    "ios/Infinitary/Info.plist",
    "ios/Infinitary/PhoneLoadClock/PhoneOrbitPace.swift",
    "ios/Infinitary/PhoneLoadClock/PhoneWaitDeadline.swift",
    "ios/Infinitary/Simulator.entitlements",
    "ios/Infinitary/SimulatorTests.xcconfig",
  ] },
  { parts: family("cards"), files: [
    "ios/Infinitary/CardRuntime/cardHost.ts",
    "ios/Infinitary/InfinitaryApp/CardAssets/CardHost.generated.js",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-italic-cyrillic-ext.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-italic-cyrillic.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-italic-greek.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-italic-latin-ext.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-italic-latin.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-italic-vietnamese.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-normal-cyrillic-ext.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-normal-cyrillic.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-normal-greek.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-normal-latin-ext.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-normal-latin.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/jetbrainsmono-normal-vietnamese.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/spacegrotesk-latin-ext.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/spacegrotesk-latin.woff2",
    "ios/Infinitary/InfinitaryApp/CardAssets/spacegrotesk-vietnamese.woff2",
    "ios/Infinitary/InfinitaryApp/CardMediaView.swift",
    "ios/Infinitary/InfinitaryApp/CardWebView.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardNotes.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardParts.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/CardValues.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneCardDeparture.swift",
  ] },
  { parts: family("rest"), files: [
    "ios/Infinitary/InfinitaryApp/CharacterCatalog.swift",
    "ios/Infinitary/InfinitaryApp/CharacterCinch.swift",
    "ios/Infinitary/InfinitaryApp/CharacterDisplayClock.swift",
    "ios/Infinitary/InfinitaryApp/CharacterFlicker.swift",
    "ios/Infinitary/InfinitaryApp/CharacterFrameMetrics.swift",
    "ios/Infinitary/InfinitaryApp/CharacterGarnish.swift",
    "ios/Infinitary/InfinitaryApp/CharacterMachine.swift",
    "ios/Infinitary/InfinitaryApp/CharacterReply.swift",
    "ios/Infinitary/InfinitaryApp/CharacterSky.swift",
    "ios/Infinitary/InfinitaryApp/CharacterWarp.swift",
    "ios/Infinitary/InfinitaryApp/PenBatch.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCharacter.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCrewPainter.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCrewScene.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCrewSummary.swift",
    "ios/Infinitary/InfinitaryApp/PhoneFixedStars.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSceneCompanions.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSceneData.generated.json",
    "ios/Infinitary/InfinitaryApp/PhoneSceneRate.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSceneRenderer.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSceneRoster.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSceneSeats.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSceneTouches.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSceneViewport.swift",
    "ios/Infinitary/InfinitaryApp/ScenePen.swift",
    "ios/Infinitary/InfinitaryApp/ScenePenGPU.swift",
    "ios/Infinitary/InfinitaryApp/ScenePenShaders.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneSceneFacts.swift",
    // Secrets setup, exact approvals and damaged-key recovery, plus ApprovalKeyTests, run in rest.
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/ApprovalKey.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneSecrets.swift",
  ] },
  { parts: family("join"), files: [
    "ios/Infinitary/InfinitaryApp/CodeScanner.swift",
    "ios/Infinitary/InfinitaryApp/NearbyComputers.swift",
    "ios/Infinitary/InfinitaryApp/NearbyMacs.swift",
    "ios/Infinitary/InfinitaryApp/PhoneComputerSheet.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/JoinLink.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneIdentity.swift",
  ] },
  { parts: family("address"), files: [
    "ios/Infinitary/InfinitaryApp/PhoneAddressSheet.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneSSHKey.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/SSHJoin.swift",
  ] },
  { parts: family("keyboard"), files: [
    "ios/Infinitary/InfinitaryApp/PhoneHideKeyboard.swift",
  ] },
  { parts: family("google"), files: [
    "ios/Infinitary/InfinitaryApp/PhoneGoogleSection.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneGoogle.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneSignInReturn.swift",
  ] },
  { parts: family("pick"), files: [
    "ios/Infinitary/InfinitaryApp/PhoneMenuTapProbe.swift",
  ] },
  { parts: family("talk"), files: [
    "ios/Infinitary/InfinitaryApp/PhoneTaskRecord.swift",
    "ios/Infinitary/InfinitaryApp/PhoneTasks.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneRowMoves.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneTaskFacts.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneTaskList.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneWork.swift",
  ] },
  { parts: ALL, files: [
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PinnedTransport.swift",
  ] },
  { parts: family("cards"), files: ["scripts/generate-phone-cards.ts"] },
  // Every native gate runs the Swift package tests before its part. One smoke part owns their inputs.
  { parts: ["join-read"], files: ["ios/Infinitary/InfinitaryKit/Tests/"] },
];
export const PART_OWNERS: Record<string, readonly string[]> = Object.fromEntries(
  ALL.map((part) => [part, GROUPS.filter((group) => group.parts.includes(part)).flatMap((group) => group.files)]),
);
export function phoneFileOwners(path: string): string[] {
  return ALL.filter((part) => PART_OWNERS[part]!.some((owned) => owned.endsWith("/") ? path.startsWith(owned) : path === owned));
}
/** Test files are owned by their declaration consumers in affected-phone, never a broad app exemption. */
export function unownedPhoneFiles(paths: readonly string[]): string[] {
  return paths.filter((path) => path.startsWith("ios/") &&
    !/\/(?:InfinitaryUITests|InfinitaryTests|Tests)\//.test(path) && !phoneFileOwners(path).length);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = execFileSync("git", ["ls-files", "-z", "--", "ios/"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const missing = unownedPhoneFiles(paths);
  if (missing.length) { console.error(`Phone files need owning parts:\n${missing.join("\n")}`); process.exitCode = 1; }
}
