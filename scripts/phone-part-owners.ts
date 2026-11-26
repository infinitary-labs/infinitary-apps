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
    // Each language's InfoPlist.strings, the words of the permission prompts every part can raise.
    "ios/Infinitary/InfinitaryApp/ar.lproj/",
    "ios/Infinitary/InfinitaryApp/de.lproj/",
    "ios/Infinitary/InfinitaryApp/en.lproj/",
    "ios/Infinitary/InfinitaryApp/es.lproj/",
    "ios/Infinitary/InfinitaryApp/fr.lproj/",
    "ios/Infinitary/InfinitaryApp/ja.lproj/",
    "ios/Infinitary/InfinitaryApp/ko.lproj/",
    "ios/Infinitary/InfinitaryApp/pt-BR.lproj/",
    "ios/Infinitary/InfinitaryApp/zh-Hans.lproj/",
    "ios/Infinitary/InfinitaryApp/zh-Hant.lproj/",
    "ios/Infinitary/InfinitaryApp/InfinitaryApp.swift",
    "ios/Infinitary/InfinitaryApp/MessageComposer.swift",
    "ios/Infinitary/InfinitaryApp/PhoneConversationSheet.swift",
    // The conversation's rounds every part's strip reads (ReadOnlySession.swift).
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneConversation.swift",
    "ios/Infinitary/InfinitaryApp/Notices/swift-asn1-LICENSE.txt",
    "ios/Infinitary/InfinitaryApp/Notices/swift-asn1-NOTICE.txt",
    "ios/Infinitary/InfinitaryApp/Notices/swift-certificates-LICENSE.txt",
    "ios/Infinitary/InfinitaryApp/Notices/swift-certificates-NOTICE.txt",
    "ios/Infinitary/InfinitaryApp/Notices/swift-crypto-LICENSE.txt",
    "ios/Infinitary/InfinitaryApp/Notices/swift-crypto-NOTICE.txt",
    "ios/Infinitary/InfinitaryApp/PhoneAppearance.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardBodies.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardRow.swift",
    // The Maximize card control in every card head beside a side panel (PhoneCards.swift).
    "ios/Infinitary/InfinitaryApp/PhoneCardSize.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardWords.generated.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCards.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardFoot.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardActions.swift",
    "ios/Infinitary/InfinitaryApp/PhoneFont.swift",
    // The computer's own update under every part's message box and in Settings (MessageComposer.swift).
    "ios/Infinitary/InfinitaryApp/PhoneHomeUpdateViews.swift",
    "ios/Infinitary/InfinitaryApp/PhoneModel.swift",
    // INF-5265: the kept computers every part's model restores.
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneKeptMacs.swift",
    // Home's pages and the one-row bar every tab and sheet asks for (PhoneWorkspace.swift, PhoneStyle.swift).
    "ios/Infinitary/InfinitaryApp/PhonePages.swift",
    // The Apple Pencil watch and placement under every part's Home and message box (PhoneWorkspace.swift).
    "ios/Infinitary/InfinitaryApp/PhonePencilWatch.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhonePencil.swift",
    "ios/Infinitary/InfinitaryApp/PhoneQuestionBubble.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSettingsSheet.swift",
    "ios/Infinitary/InfinitaryApp/PhoneStyle.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSymbol.swift",
    "ios/Infinitary/InfinitaryApp/PhoneTheme.generated.swift",
    "ios/Infinitary/InfinitaryApp/PhoneWorkspace.swift",
    "ios/Infinitary/InfinitaryKit/Package.resolved",
    "ios/Infinitary/InfinitaryKit/Package.swift",
    // The version its hello tells its computer, which every part's connection says.
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneAppVersion.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneContract.generated.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneDiagnostics.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneFormats.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneFrame.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneHomeMove.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneHomeUpdate.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneIntents.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneLook.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneMessages.generated.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneRecordRules.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneWords.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/ReadOnlySession.swift",
    // INF-5445 piece 2: every card's draft, which the session reads at each welcome and every card on Home writes.
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneCardDrafts.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneDraftSync.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/Resources/",
    // The last turn's whole-word cut, which every part's message box draws (MessageComposer.swift).
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/WholeWords.swift",
    "ios/Infinitary/Info.plist",
    "ios/Infinitary/PhoneLoadClock/PhoneOrbitPace.swift",
    "ios/Infinitary/PhoneLoadClock/PhoneWaitDeadline.swift",
    "ios/Infinitary/Simulator.entitlements",
    "ios/Infinitary/SimulatorTests.xcconfig",
    // INF-4794: the app's delegate owns the model every part drives, and its entitlements sign every build.
    "ios/Infinitary/InfinitaryApp/PhonePushApp.swift",
    "ios/Infinitary/Infinitary.entitlements",
  ] },
  // INF-4794: card pushes, their Settings row and the notification part that opens each one.
  { parts: family("push"), files: [
    "ios/Infinitary/InfinitaryApp/PhonePushSection.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhonePush.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryPush/PhonePushSeal.swift",
    "ios/Infinitary/InfinitaryNotifications.entitlements",
    "ios/Infinitary/InfinitaryNotifications/NotificationService.swift",
    "ios/Infinitary/NotificationsInfo.plist",
    "ios/Infinitary/SimulatorNotifications.entitlements",
    "tests/helpers/phonePushRelay.ts",
  ] },
  // INF-5265: the kept computers, the computer sheet that switches them and the second computer beside the test home.
  { parts: family("homes"), files: [
    "tests/helpers/phoneSecondHome.ts",
    "tests/helpers/phoneSecondHomeProcess.ts",
  ] },
  // INF-5608's plan, piece 2: the cards-carried part's card on the test home.
  { parts: ["cards-carried"], files: ["tests/helpers/phoneCarried.ts"] },
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
    "ios/Infinitary/InfinitaryApp/CardLogView.swift",
    "ios/Infinitary/InfinitaryApp/CardMediaView.swift",
    "ios/Infinitary/InfinitaryApp/CardWebView.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardCarry.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardNotes.swift",
    "ios/Infinitary/InfinitaryApp/PhoneCardParts.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/CardValues.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneCardDeparture.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneChoiceCarry.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneSecretAsk.swift",
  ] },
  // INF-5531 piece 2: the reads a card's page and a panel's page run, and the test home's live card.
  { parts: [...family("cards"), ...family("panels")], files: ["ios/Infinitary/CardRuntime/phoneReads.ts"] },
  { parts: ["cards-reads"], files: ["tests/helpers/phoneCardReads.ts"] },
  // A card's sound strip: the cards-media part plays, pauses and leaves a clip.
  { parts: ["cards-media"], files: ["ios/Infinitary/InfinitaryApp/CardSoundStrip.swift"] },
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
    "ios/Infinitary/InfinitaryApp/CharacterSupernova.swift",
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
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/JoinLink.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneIdentity.swift",
  ] },
  // INF-4207 piece 9: Take over on the computer's sheet, the link to a computer that keeps a copy and the test home's
  // computer that keeps a copy beside it; join-activity draws the sheet out of reach, without a copy kept. INF-5265:
  // the homes part lists the other kept computers on it and adds one.
  { parts: [...family("take"), ...family("join"), ...family("homes")], files: [
    "ios/Infinitary/InfinitaryApp/PhoneComputerSheet.swift",
    "ios/Infinitary/InfinitaryApp/PhoneTakeOverSection.swift",
  ] },
  { parts: family("take"), files: [
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneTakeOver.swift",
    "tests/helpers/phoneTakeOver.ts",
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
  // INF-3830 pieces 2 and 3: the Panels tab, its frames and the panel order; a panel's title-row buttons and its cards on Home;
  // where a panel's point.openSettings opens Settings; the status mark by a panel's title.
  { parts: family("panels"), files: [
    "ios/Infinitary/CardRuntime/panelHost.ts",
    "ios/Infinitary/InfinitaryApp/CardAssets/PanelHost.generated.js",
    "ios/Infinitary/InfinitaryApp/PanelWebView.swift",
    "ios/Infinitary/InfinitaryApp/PhonePanelCardPane.swift",
    "ios/Infinitary/InfinitaryApp/PhonePanelStatusMark.swift",
    "ios/Infinitary/InfinitaryApp/PhonePanels.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhonePanelCards.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhonePanels.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneSettingsPlace.swift",
  ] },
  // INF-3563: the Settings list reads its five computer rows in the join-read part too, so what answers them is
  // both parts'; each page's own drawing is the settings part's.
  { parts: [...family("settings"), "join-read"], files: [
    "ios/Infinitary/InfinitaryApp/SettingsWords.generated.js",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneSettings.swift",
    "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneSettingsWords.swift",
  ] },
  { parts: family("settings"), files: [
    "ios/Infinitary/InfinitaryApp/PhoneAutomationPage.swift",
    "ios/Infinitary/InfinitaryApp/PhoneIntelligencePage.swift",
    "ios/Infinitary/InfinitaryApp/PhoneProjectsPage.swift",
    "ios/Infinitary/InfinitaryApp/PhoneRunbooksPage.swift",
    "ios/Infinitary/InfinitaryApp/PhoneSettingsParts.swift",
    "ios/Infinitary/InfinitaryApp/PhoneUsagePage.swift",
    "ios/Infinitary/SettingsRuntime/settingsWords.ts",
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
  { parts: [...family("cards"), ...family("panels")], files: ["scripts/generate-phone-cards.ts"] },
  // A held press: both the cards and panels parts draw pictures in frames that carry the rule, and both scroll their
  // frames natively under the watch that tells the frame a press moved.
  { parts: [...family("cards"), ...family("panels")], files: [
    "ios/Infinitary/CardRuntime/pressRule.ts",
    "ios/Infinitary/InfinitaryApp/PressMoveWatch.swift",
  ] },
  // The device's Text Size on cards and panels: the cards and panels parts draw at it, and join-read checks a card
  // grows at iOS's largest standard size.
  { parts: [...family("cards"), ...family("panels"), "join-read"], files: [
    "ios/Infinitary/CardRuntime/textSize.ts",
    "ios/Infinitary/InfinitaryApp/PhoneTextSize.swift",
  ] },
  { parts: family("settings"), files: ["scripts/generate-phone-settings.ts", "tests/helpers/phoneSettings.ts"] },
  // Every native gate runs the Swift package tests before its part. One smoke part owns their inputs; the weak-link
  // part's own package target (INF-4326) is its test code, read in affected-phone.
  { parts: ["join-read"], files: ["ios/Infinitary/InfinitaryKit/Tests/InfinitaryKitTests/"] },
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
