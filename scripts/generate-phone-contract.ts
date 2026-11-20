import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { isMarked, openMarkingRunner, swiftWords } from "./phone-word-marks.ts";
import { assertPhoneReaderShapes } from "./phone-contract-shapes.ts";
import { staleGeneratedFile } from "./github-errors.ts";

/** Wire constants and feed-changing types come from their Mac owners, not native copies. */
const contract = JSON.parse(readFileSync(join(REPO_ROOT, "docs/contract.json"), "utf8"));
assertPhoneReaderShapes(contract);
const reads = { cards: "inf:cards:list", feed: "inf:feed:recent" };
for (const channel of Object.values(reads)) {
  const request = contract.requests[channel];
  if (request?.effect !== "read" || request.reach !== "views")
    throw new Error(`The phone cannot read ${channel}`);
}
const requests = {
  converse: "inf:converse", lastTurn: "inf:conversation:last-turn", board: "inf:tasks:board",
  detail: "inf:tasks:detail", search: "inf:tasks:search", crew: "inf:tasks:crewmate",
  live: "inf:tasks:crewmate:live", result: "inf:tasks:crewmate:result",
  run: "inf:task:run", pin: "inf:task:pin", steer: "inf:task:steer", interrupt: "inf:task:interrupt",
  notifications: "inf:settings:notifications:get",
  conversationState: "inf:conversation:state", computers: "inf:computers:presence",
  // INF-1109's phone approvals (docs/secrets.md, "Remote decisions").
  secretApprovals: "inf:secrets:approvals", secretEnroll: "inf:secrets:enroll", secretDecide: "inf:secrets:decide",
  // INF-4239 piece 4: Keep on Infinitary's own ask to keep a secret (docs/secrets.md, "Asking to keep a secret").
  secretKeep: "inf:secrets:keep",
  // INF-3454's phone part: Google's row in the phone's Settings (docs/ios.md, "Google in Settings").
  integrations: "inf:integrations:list", signIn: "inf:integrations:sign-in", signInReturn: "inf:integrations:sign-in-return",
  signInCancel: "inf:integrations:sign-in-cancel", integrationRemove: "inf:integrations:remove",
  // INF-3563: the phone's Settings pages read what the computer's Settings reads and change it through the
  // computer's own actions (docs/ios.md, "Settings pages in the computer's words").
  accounts: "inf:accounts:list", quota: "inf:quota:snapshot", providers: "inf:auth:providers",
  devicesShown: "inf:devices:shown", deviceSignIns: "inf:devices:sign-ins", firstmateAccount: "inf:settings:firstmate-account:get",
  automations: "inf:automation:list", automationHistory: "inf:automation:history", automationPreview: "inf:automation:preview",
  automationProjects: "inf:projects:list",
  automationState: "inf:automation:state", automationPauseAll: "inf:automation:pause-all", automationSave: "inf:automation:save",
  usageSummary: "inf:usage:summary", projects: "inf:repos:list", projectsFolder: "inf:repos:folder",
  projectConfigure: "inf:repos:configure", runbooks: "inf:settings:runbooks:get", runbookSet: "inf:settings:runbooks:set",
  // INF-4012's direction 1: the computer's own update, read and started from the phone on any major (src/shared/homeUpdate.ts).
  homeUpdate: "inf:home-update:status", homeUpdateInstall: "inf:home-update:install", homeUpdateLater: "inf:home-update:later",
  // INF-4794: the phone hands its computer where its cards are pushed, or null to stop (docs/phone-push.md).
  devicesPush: "inf:devices:push",
};
for (const channel of Object.values(requests)) {
  if (contract.requests[channel]?.reach !== "views") throw new Error(`The phone cannot ask ${channel}`);
}
const requestCases = Object.entries(requests).map(([name, channel]) => `    case ${name} = ${JSON.stringify(channel)}`).join("\n");
const changes = Object.entries(requests).filter(([, channel]) => contract.requests[channel].effect === "change")
  .map(([name]) => `.${name}`).join(", ");
const requestEnum = `\npublic enum PhoneRequest: String, Sendable {\n${requestCases}\n    public var changes: Bool {\n        switch self { case ${changes}: true; default: false }\n    }\n}\n`;
const imageSchema = contract.requests[requests.converse].request.prefixItems[0].anyOf[1].properties;
const limits = `\npublic enum PhoneLimits {\n    public static let images = ${imageSchema.images.maxItems}\n    public static let imageBase64 = ${imageSchema.images.items.properties.data.maxLength}\n    public static let text = ${imageSchema.text.maxLength}\n    public static let steer = ${contract.requests[requests.steer].request.prefixItems[1].maxLength}\n    public static let reply = ${contract.requests["inf:cards:reply"].request.prefixItems[1].anyOf.find((part: { type: string }) => part.type === "object").properties.text.maxLength}\n}\n`;
const cardRequests = {
  act: "inf:cards:act", close: "inf:cards:close", seen: "inf:cards:seen", seenUpdate: "inf:cards:seen-update",
  thread: "inf:cards:thread", past: "inf:cards:past", reply: "inf:cards:reply",
  picture: "inf:cards:picture", typeface: "inf:cards:typeface", media: "inf:cards:media", data: "inf:cards:data",
  // INF-3887: a merge card's proof log opens in the phone's log reader.
  log: "inf:cards:log",
  // INF-944 item 3: opening a minimized card on the phone brings it back on the Mac too.
  minimize: "inf:cards:minimize",
  // INF-2794: every live note's one button, Done or Got it.
  noteDone: "inf:cards:note-done",
  // INF-5445 piece 2: each open card's unsent draft, read at each welcome and changed once the captain pauses.
  drafts: "inf:cards:drafts", draft: "inf:cards:draft",
};
for (const channel of Object.values(cardRequests)) {
  if (contract.requests[channel]?.reach !== "views") throw new Error(`The phone cannot ask ${channel}`);
}
const cardCases = Object.entries(cardRequests).map(([name, channel]) => `    case \`${name}\` = ${JSON.stringify(channel)}`).join("\n");
const cardChanges = Object.entries(cardRequests).filter(([, channel]) => contract.requests[channel].effect === "change")
  .map(([name]) => `.${name}`).join(", ");
const cardEnum = `\npublic enum PhoneCardRequest: String, Sendable {\n${cardCases}\n    public var changes: Bool {\n        switch self { case ${cardChanges}: true; default: false }\n    }\n}\n`;
// INF-2631: the phone's usage events and their one field come from the request the computer answers.
const diagnosticsRequest = "inf:settings:sharing:phone";
const diagnosticsChange = "phone-diagnostics";
const diagnostic = contract.requests[diagnosticsRequest];
if (diagnostic?.reach !== "views") throw new Error(`The phone cannot ask ${diagnosticsRequest}`);
const diagnosticEvent = diagnostic.request.prefixItems[0].properties;
const diagnosticCases = (diagnosticEvent.name.enum as string[]).map((name) => {
  const swift = name.replace(/^ios_/, "").replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (!/^[a-z][A-Za-z0-9]*$/.test(swift)) throw new Error(`Cannot generate a Swift case for ${name}`);
  return `    case \`${swift}\` = ${JSON.stringify(name)}`;
}).join("\n");
const deviceCases = (diagnosticEvent.data.properties.device.enum as string[]).map((device) => `    case \`${device}\` = ${JSON.stringify(device)}`).join("\n");
const diagnosticsEnum = `\npublic enum PhoneDiagnosticEvent: String, Sendable, CaseIterable {\n${diagnosticCases}\n    public static let request = ${JSON.stringify(diagnosticsRequest)}\n    public static let change = ${JSON.stringify(diagnosticsChange)}\n}\n\npublic enum PhoneDiagnosticDevice: String, Sendable {\n${deviceCases}\n}\n`;
// The Mac's word owners load with each catalog message answering its mark, so a word from the catalog becomes a
// `PhoneMessages` call worded in the phone's language (scripts/phone-word-marks.ts, docs/i18n.md "On the phone").
const runner = await openMarkingRunner();
/** Words a heading leads with a capital, as the Mac's lowercase group names read on the phone. */
const capitalized = (words: string) =>
  isMarked(words) ? `PhoneWords.sentence(${swiftWords(words)})` : JSON.stringify(words.charAt(0).toUpperCase() + words.slice(1));
try {
  // Retained for older homes/views; major 15 absorbed the named change.
  const { FRAME_PARTS: partsChange } = await runner.import<typeof import("../src/core/connection/frameParts.ts")>(join(REPO_ROOT, "src/core/connection/frameParts.ts"));
  // INF-3296's phone piece: typed notes on a card's reply and thread, which the phone offers once its home has them.
  // Major 16 folded this name and the three below in; each is retained for a home on major 15, which lists it.
  const annotationsChange = "card-annotations";
  // INF-3764: the board read without its closed rows, which the phone asks first once its home has it.
  const boardWithoutClosedChange = "board-without-closed";
  // INF-4239 piece 4: the phone draws an ask's masked fields, so its hello lists the change and the home sends Keep.
  const secretsAskChange = "secrets-ask";
  if (!existsSync(join(REPO_ROOT, `src/shared/contract-changes/${secretsAskChange}.md`))) throw new Error(`No contract change ${secretsAskChange}`);
  // INF-4425: a skipped question's answer marked skipped, which the phone reads and sends once its home lists it.
  const answerSkippedChange = "card-answer-skipped";
  if (!existsSync(join(REPO_ROOT, `src/shared/contract-changes/${answerSkippedChange}.md`))) throw new Error(`No contract change ${answerSkippedChange}`);
  // INF-4794: the computer pushes cards to a phone that hands it a registration once its welcome lists this change.
  // INF-5445 piece 2: each open card's unsent draft follows the captain to and from the phone once both list this change,
  // sent once they pause for the Mac's own quiet period.
  const { CARD_DRAFTS: cardDraftsChange } = await runner.import<typeof import("../src/shared/cardDrafts.ts")>(join(REPO_ROOT, "src/shared/cardDrafts.ts"));
  if (!existsSync(join(REPO_ROOT, `src/shared/contract-changes/${cardDraftsChange}.md`))) throw new Error(`No contract change ${cardDraftsChange}`);
  const { DRAFT_QUIET_MS } = await runner.import<typeof import("../src/renderer/src/app/draftSync.ts")>(join(REPO_ROOT, "src/renderer/src/app/draftSync.ts"));
  const phonePushChange = "phone-push";
  if (!existsSync(join(REPO_ROOT, `src/shared/contract-changes/${phonePushChange}.md`))) throw new Error(`No contract change ${phonePushChange}`);
  const phonePushWithdrawChange = "phone-push-withdraw";
  if (!existsSync(join(REPO_ROOT, `src/shared/contract-changes/${phonePushWithdrawChange}.md`))) throw new Error(`No contract change ${phonePushWithdrawChange}`);
  const { PHONE_PUSH_RELAY } = await runner.import<typeof import("../src/shared/phonePush.ts")>(join(REPO_ROOT, "src/shared/phonePush.ts"));
  const { FEED_EVENT_TYPES } = await runner.import<typeof import("../src/shared/feed.ts")>(join(REPO_ROOT, "src/shared/feed.ts"));
  const cases = FEED_EVENT_TYPES.map((type) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) throw new Error(`Cannot generate a Swift feed case for ${type}`);
    return `    case \`${type}\` = ${JSON.stringify(type)}`;
  }).join("\n");
  // INF-209's five groups use the Mac's rule, including required actions and starts in flight.
  // A finite table keeps Swift from owning another implementation of that rule.
  const { NOW_GROUPS, NOW_GROUP_TITLES, nowGroupOf } = await runner.import<typeof import("../src/shared/nowPanel.ts")>(join(REPO_ROOT, "src/shared/nowPanel.ts"));
  const statuses = ["open", "active", "done", "dropped"] as const;
  // INF-1517: a minimized card's task (`minimizedCardId`, src/shared/taskWaiting.ts) is the sixth input.
  // INF-2928 piece 1: started work sent back to the backlog (`backlogSince`) is the seventh.
  const groups = statuses.flatMap((status) => Array.from({ length: 128 }, (_, bits) => nowGroupOf({
    status, ...(bits & 64 ? { backlogSince: 1 } : {}),
    minimizedCardId: bits & 32 ? "card" : undefined, kind: bits & 16 ? "work" : "operation",
    requiredAction: bits & 8 ? {} : undefined,
    waitingCardId: bits & 4 ? "card" : null,
    startAttempt: bits & 2 ? { phase: "preparing" } : undefined,
    startPolicy: bits & 1 ? "on-request" : "when-ready", activity: null,
  } as Parameters<typeof nowGroupOf>[0])));
  const groupRows = Array.from({ length: groups.length / 8 }, (_, row) => "        " + groups.slice(row * 8, row * 8 + 8).map((group) => group ? `.${group}` : "nil").join(", ")).join(",\n");
  const groupEnum = `\npublic enum PhoneTaskGroup: String, CaseIterable, Sendable {\n    case ${NOW_GROUPS.join(", ")}\n    public var title: String {\n        switch self {\n${NOW_GROUPS.map((group) => `        case .${group}: ${capitalized(NOW_GROUP_TITLES[group])}`).join("\n")}\n        }\n    }\n    public static func reading(status: String, work: Bool, required: Bool, waiting: Bool, starting: Bool, onRequest: Bool, minimized: Bool = false, backlog: Bool = false) -> Self? {\n        guard let state = ${JSON.stringify(statuses)}.firstIndex(of: status) else { return nil }\n        let bits = (backlog ? 64 : 0) + (minimized ? 32 : 0) + (work ? 16 : 0) + (required ? 8 : 0) + (waiting ? 4 : 0) + (starting ? 2 : 0) + (onRequest ? 1 : 0)\n        return readings[state * 128 + bits]\n    }\n    private static let readings: [Self?] = [\n${groupRows}\n    ]\n}\n`;
  // A phone reads the scene from a home on this major or later without its change name.
  const { CARD_SEEN_UPDATE_SINCE, FOLDED_INTO_16_SINCE, HOME_UPDATE_FOLDED, MESSAGES_WHILE_READING, PHONE_DIAGNOSTICS_SINCE, SCENE_OBSERVATIONS_SINCE } = await runner.import<typeof import("../src/shared/contractFeatures.ts")>(join(REPO_ROOT, "src/shared/contractFeatures.ts"));
  const { HOME_UPDATE } = await runner.import<typeof import("../src/shared/homeUpdate.ts")>(join(REPO_ROOT, "src/shared/homeUpdate.ts"));
  if (!existsSync(join(REPO_ROOT, `src/shared/contract-changes/${HOME_UPDATE}.md`))) throw new Error(`No contract change ${HOME_UPDATE}`);
  // A line in the Mac's own words names that Mac where it says this computer (docs/view.md, "The first mate's own words").
  // The welcome card's title in the phone's language, as the Mac's `wordedTitle` (src/shared/welcome.ts): its body's
  // mark, and the English a saved card keeps, read from the catalog since the marked owner answers marks.
  const { WELCOME_BODY_MARK } = await runner.import<typeof import("../src/shared/welcome.ts")>(join(REPO_ROOT, "src/shared/welcome.ts"));
  const { CARD_WORDS_MARK } = await runner.import<typeof import("../src/shared/i18n/said.ts")>(join(REPO_ROOT, "src/shared/i18n/said.ts"));
  const welcomeTitle = (JSON.parse(readFileSync(join(REPO_ROOT, "src/shared/i18n/messages/en/welcome.json"), "utf8")) as Record<string, unknown>).welcomeTitle;
  if (typeof welcomeTitle !== "string") throw new Error("The catalog has no welcomeTitle");
  const { HERE, PLACE_SAID, placesAs } = await runner.import<typeof import("../src/shared/deviceNames.ts")>(join(REPO_ROOT, "src/shared/deviceNames.ts"));
  const text = `// Generated by scripts/generate-phone-contract.ts from docs/contract.json, src/shared/feed.ts, src/shared/deviceNames.ts, src/shared/nowPanel.ts, src/panels/now/words.ts, the task record's word owners, src/shared/pastCard.ts, src/shared/secrets.ts, src/shared/phoneLink.ts, src/shared/contractFeatures.ts, src/shared/homeUpdate.ts, src/core/secrets/approvals.ts, src/shared/integrations.ts, src/renderer/src/devices/viewWords.ts, src/core/signInReturns.ts, src/shared/reads.ts, src/shared/personal/manifest.ts, src/shared/phonePush.ts, src/shared/cardDrafts.ts, src/renderer/src/app/draftSync.ts and the message catalog.\npublic enum PhoneContract {\n    public static let cardCurrentUpdateSeen = "card-current-update-seen"\n    public static let cardCurrentUpdateSeenSince = ${Number(CARD_SEEN_UPDATE_SINCE.split(".")[0])}\n    public static let sceneObservations = "native-scene-observations"\n    public static let sceneObservationsSince = ${Number(SCENE_OBSERVATIONS_SINCE.split(".")[0])}\n    public static let phoneDiagnosticsSince = ${Number(PHONE_DIAGNOSTICS_SINCE.split(".")[0])}\n    public static let foldedInto16Since = ${Number(FOLDED_INTO_16_SINCE.split(".")[0])}\n    public static let version = ${JSON.stringify(contract.protocolVersion)}\n    public static let viewFloor = ${contract.versionRule.viewFloor}\n    public static let pairPath = ${JSON.stringify(contract.connection.pair.path)}\n    public static let connectionPath = ${JSON.stringify(contract.connection.path)}\n    public static let maxFrameBytes = ${contract.connection.maxFrameBytes}\n    public static let frameParts = ${JSON.stringify(partsChange)}\n    public static let cardAnnotations = ${JSON.stringify(annotationsChange)}\n    public static let boardWithoutClosed = ${JSON.stringify(boardWithoutClosedChange)}\n    public static let secretsAsk = ${JSON.stringify(secretsAskChange)}\n    public static let cardAnswerSkipped = ${JSON.stringify(answerSkippedChange)}\n    public static let cardDrafts = ${JSON.stringify(cardDraftsChange)}\n    public static let draftQuietMs = ${DRAFT_QUIET_MS}\n    public static let phonePush = ${JSON.stringify(phonePushChange)}\n    public static let phonePushWithdraw = ${JSON.stringify(phonePushWithdrawChange)}\n    public static let pushRelay = ${JSON.stringify(PHONE_PUSH_RELAY)}\n    public static let messagesWhileReading = ${JSON.stringify(MESSAGES_WHILE_READING)}\n    public static let homeUpdate = ${JSON.stringify(HOME_UPDATE)}\n    public static let homeUpdateFolded = ${HOME_UPDATE_FOLDED}\n    public static let cards = ${JSON.stringify(reads.cards)}\n    public static let feed = ${JSON.stringify(reads.feed)}\n    public static let hereWords = ${JSON.stringify([HERE.This, HERE.this])}\n    public static let placeThis = ${JSON.stringify(PLACE_SAID.this.m)}\n    public static let placeHere = ${JSON.stringify(PLACE_SAID.here.m)}\n    public static let welcomeBodyMark = ${JSON.stringify(WELCOME_BODY_MARK)}\n    public static let welcomeTitle = ${JSON.stringify(welcomeTitle)}\n    public static let cardWordsMark = ${JSON.stringify(CARD_WORDS_MARK)}\n    public static let placeOn = ${JSON.stringify((placesAs({ m: "x", a: { place: PLACE_SAID.here } }, "N").a?.place as { m: string }).m)}\n}\n\nenum FeedChange: String {\n${cases}\n}\n`;
  // INF-499 #2: past-card attribution uses the shared wording owner for every published ending.
  const { pastEndingWords } = await runner.import<typeof import("../src/shared/pastCard.ts")>(join(REPO_ROOT, "src/shared/pastCard.ts"));
  const catalog = await runner.import<typeof import("../src/shared/i18n/messages.generated.ts")>(join(REPO_ROOT, "src/shared/i18n/messages.generated.ts"));
  type Ending = Parameters<typeof pastEndingWords>[0];
  const ending = contract.requests["inf:cards:past"].response.anyOf.find((part: { type: string }) => part.type === "object").properties.ending.properties;
  const endingCases = ending.how.enum.map((how: Ending["how"]) => {
    const variants = new Map<string, string[]>();
    for (const by of ending.by.enum as NonNullable<Ending["by"]>[]) {
      const words = pastEndingWords({ how, by, at: 0, label: "{label}" });
      variants.set(words, [...(variants.get(words) ?? []), by]);
    }
    const fallback = pastEndingWords({ how, at: 0, label: "{label}" });
    return [...variants].sort(([left], [right]) => Number(left === fallback) - Number(right === fallback)).map(([words, authors]) => {
      const match = words === fallback ? `(${JSON.stringify(how)}, _)` : authors.map((by) => `(${JSON.stringify(how)}, ${JSON.stringify(by)})`).join(", ");
      return `        case ${match}: ${swiftWords(words, words.includes("{label}") ? { "{label}": "label" } : {})}`;
    }).join("\n");
  }).join("\n");
  const pastWords = `\npublic enum PhonePastEnding {\n    public static func words(_ ending: PhoneJSON) -> String {\n        let label = ending["label"].text ?? ${swiftWords(catalog.pastEndingAnOption())}\n        return switch (ending["how"].text ?? "unknown", ending["by"].text ?? "captain") {\n${endingCases}\n        default: ${swiftWords(pastEndingWords({ how: "unknown", at: 0 }))}\n        }\n    }\n}\n`;
  // INF-1183: the fixed commands a phone runs over SSH come from the home's door owner, never a native copy.
  const link = await runner.import<typeof import("../src/shared/phoneLink.ts")>(join(REPO_ROOT, "src/shared/phoneLink.ts"));
  const sshCommands = `\npublic enum PhoneSSHCommand {\n    public static let header = ${JSON.stringify(link.PHONE_LINK_HEADER)}\n    public static let version = ${JSON.stringify(link.PHONE_LINK_VERSION)}\n    public static let link = ${JSON.stringify(link.PHONE_LINK_COMMAND)}\n    public static let placeKey = ${JSON.stringify(link.PHONE_PLACE_KEY_COMMAND)}\n    public static let placed = ${JSON.stringify(link.PHONE_KEY_PLACED)}\n    public static let notOpen = ${JSON.stringify(link.PHONE_LINK_NONE.notOpen)}\n    public static let tooOld = ${JSON.stringify(link.PHONE_LINK_NONE.tooOld)}\n    public static let noCurl = ${JSON.stringify(link.PHONE_LINK_NONE.noCurl)}\n}\n`;
  // INF-2928 piece 1: a Tasks row's dim word, its reach and its header's counts, in the Mac's own words (src/panels/now/words.ts).
  const rowWords = await runner.import<typeof import("../src/panels/now/words.ts")>(join(REPO_ROOT, "src/panels/now/words.ts"));
  const rowWordsEnum = `\npublic enum PhoneTaskRowWords {\n${Object.entries(rowWords.ROW_WORDS).map(([name, words]) => `    public static let ${name} = ${swiftWords(words)}`).join("\n")}\n${Object.entries(rowWords.ROW_REACH_WORDS).map(([name, words]) => `    public static let reach${name.charAt(0).toUpperCase() + name.slice(1)} = ${swiftWords(words)}`).join("\n")}\n    public static let earlier = ${capitalized(rowWords.EARLIER_LABEL)}\n    public static let pinned = ${capitalized(rowWords.PINNED_LABEL)}\n    public static let start = ${swiftWords(rowWords.ROW_START_LABEL)}\n    public static let tryAgain = ${swiftWords(rowWords.ROW_TRY_AGAIN_LABEL)}\n    public static func foundOn(_ key: String) -> String { ${swiftWords(rowWords.foundOnWords("INF-7"), { "INF-7": "key" })} }\n    public static func newCount(_ count: Int) -> String { ${swiftWords(rowWords.newCountWords(7), { 7: "count" })} }\n    public static func failedCount(_ count: Int) -> String { ${swiftWords(rowWords.failedCountWords(7), { 7: "count" })} }\n}\n`;
  // INF-2928 piece 3: the task board's menu and its asks name their moves in these words (src/panels/now/boardMoves.ts).
  const boardMoves = await runner.import<{ QUEUE_LABEL: string; UNQUEUE_LABEL: string; START_LABEL: string; START_NOW_LABEL: string;
    STARTED_BACKLOG_TEXT: string; PIN_DETAIL: string; UNPIN_DETAIL: string }>(join(REPO_ROOT, "src/panels/now/boardMoves.ts"));
  // INF-3127: Pin and Unpin, the board menu's and the row's own words (src/shared/taskPin.ts).
  const pinWords = await runner.import<typeof import("../src/shared/taskPin.ts")>(join(REPO_ROOT, "src/shared/taskPin.ts"));
  const rowMoveWordsEnum = `\npublic enum PhoneRowMoveWords {\n    public static let queue = ${swiftWords(boardMoves.QUEUE_LABEL)}\n    public static let unqueue = ${swiftWords(boardMoves.UNQUEUE_LABEL)}\n    public static let start = ${swiftWords(boardMoves.START_LABEL)}\n    public static let startNow = ${swiftWords(boardMoves.START_NOW_LABEL)}\n    public static let startedBacklog = ${swiftWords(boardMoves.STARTED_BACKLOG_TEXT)}\n    public static let pin = ${swiftWords(pinWords.PIN_WORDS.pin)}\n    public static let unpin = ${swiftWords(pinWords.PIN_WORDS.unpin)}\n    public static let pinDetail = ${swiftWords(boardMoves.PIN_DETAIL)}\n    public static let unpinDetail = ${swiftWords(boardMoves.UNPIN_DETAIL)}\n}\n`;
  // INF-2935 (INF-2928 piece 2): the task record's own words on the Mac - its tabs, its bar's buttons, Drop task's
  // question, the Crewmate tab's status line and the More row's policies - from their owners.
  const bar = await runner.import<typeof import("../src/shared/recordBar.ts")>(join(REPO_ROOT, "src/shared/recordBar.ts"));
  const drop = await runner.import<typeof import("../src/shared/recordDrop.ts")>(join(REPO_ROOT, "src/shared/recordDrop.ts"));
  const tabWords = await runner.import<typeof import("../src/shared/taskBrowser.ts")>(join(REPO_ROOT, "src/shared/taskBrowser.ts"));
  const crewWords = await runner.import<typeof import("../src/shared/crewTranscript.ts")>(join(REPO_ROOT, "src/shared/crewTranscript.ts"));
  const policyWords = await runner.import<typeof import("../src/shared/taskPolicies.ts")>(join(REPO_ROOT, "src/shared/taskPolicies.ts"));
  const { RIGOR_LABELS } = await runner.import<typeof import("../src/shared/vocabulary.ts")>(join(REPO_ROOT, "src/shared/vocabulary.ts"));
  const swiftTable = (record: Readonly<Record<string, string>>) => `[${Object.entries(record).map(([key, words]) => `${JSON.stringify(key)}: ${swiftWords(words)}`).join(", ")}]`;
  const crewNames = ["working", "stop", "stopping", "idle", "waiting", "paused", "closed", "field", "placeholderWorking",
    "placeholderIdle", "empty", "unreadable", "brief", "firstmate", "app"] as const;
  const recordWordsEnum = `\npublic enum PhoneRecordWords {\n    public static let info = ${swiftWords(tabWords.INFO_TAB_LABEL)}\n    public static let cards = ${swiftWords(tabWords.CARDS_TAB_LABEL)}\n    public static let activity = ${swiftWords(tabWords.ACTIVITY_TAB_LABEL)}\n    public static let crewmate = ${swiftWords(crewWords.CREWMATE_TAB_LABEL)}\n    public static let next = ${swiftTable(bar.RECORD_NEXT_LABELS)}\n    public static let dropTask = ${swiftWords(drop.DROP_TASK_LABEL)}\n    public static let dropCancel = ${swiftWords(drop.DROP_CANCEL_LABEL)}\n    public static let dropReviewStale = ${swiftWords(drop.DROP_REVIEW_STALE)}\n${crewNames.map((name) => `    public static let crew${name.charAt(0).toUpperCase() + name.slice(1)} = ${swiftWords(crewWords.CREWMATE_WORDS[name])}`).join("\n")}\n    public static let care = ${swiftTable(RIGOR_LABELS)}\n    public static let policyDelivery = ${swiftTable(policyWords.POLICY_LABELS.delivery)}\n    public static let policyMergesOn = ${swiftWords(policyWords.POLICY_LABELS.merging.on)}\n    public static let policyMergesOff = ${swiftWords(policyWords.POLICY_LABELS.merging.off)}\n    public static let policySource = ${swiftTable(policyWords.POLICY_LABELS.source)}\n    public static let policyHelper = ${swiftWords(policyWords.POLICY_LABELS.helper)}\n    public static let policyCareBound = ${swiftWords(policyWords.POLICY_LABELS.careBound)}\n}\n`;
  const cardWords = await phoneCardWords(runner);
  const wordsPath = join(REPO_ROOT, "ios/Infinitary/InfinitaryApp/PhoneCardWords.generated.swift");
  if (process.argv.includes("--check")) {
    if (readFileSync(wordsPath, "utf8") !== cardWords) throw staleGeneratedFile(relative(REPO_ROOT, wordsPath), "node scripts/generate-phone-contract.ts");
  } else writeFileSync(wordsPath, cardWords);
  // The bytes a phone signs come from the verifier's own layout, so the order has one owner.
  const { DECISION_FORMAT, DECISION_BINDINGS, DECISION_ALLOW } = await runner.import<typeof import("../src/core/secrets/approvals.ts")>(join(REPO_ROOT, "src/core/secrets/approvals.ts"));
  const decisionTypes: Record<(typeof DECISION_BINDINGS)[number], string> = {
    home: "String", device: "String", generation: "Int", request: "String", digest: "String", nonce: "String", expires: "Int64",
  };
  const decisionParameters = DECISION_BINDINGS.map((binding) => `${binding}: ${decisionTypes[binding]}`).join(", ");
  const decisionLines = DECISION_BINDINGS.map((binding) => `${JSON.stringify(`${binding}:`).slice(0, -1)}\\(${binding})"`).join(", ");
  // The approval card's own words, so the phone's Allow and Deny read as the Mac's.
  const { SECRETS_WORDS } = await runner.import<typeof import("../src/shared/secrets.ts")>(join(REPO_ROOT, "src/shared/secrets.ts"));
  const decision = `\npublic enum PhoneDecision {\n    public static let format = ${JSON.stringify(DECISION_FORMAT)}\n    public static let allow = ${JSON.stringify(DECISION_ALLOW)}\n    public static let allowWords = ${swiftWords(SECRETS_WORDS.once)}\n    public static let denyWords = ${swiftWords(SECRETS_WORDS.deny)}\n    /// The exact bytes the home's verifier checks, one binding per line in its order.\n    public static func message(${decisionParameters}) -> String {\n        [format, ${decisionLines}, allow].joined(separator: "\\n")\n    }\n}\n`;
  // INF-3454's phone part: Google's notice, its waiting words and the pasted return say what the Mac's Settings says,
  // and the phone lists the same contract change before a sign-in's return may cross (docs/ios.md, "Google in Settings").
  for (const push of ["inf:app:sign-in-page", "inf:app:sign-in-ended"]) {
    if (!contract.pushes[push]) throw new Error(`The phone cannot hear ${push}`);
  }
  const { SIGN_IN_RETURN } = await runner.import<typeof import("../src/core/signInReturns.ts")>(join(REPO_ROOT, "src/core/signInReturns.ts"));
  const integrationWords = await runner.import<typeof import("../src/shared/integrations.ts")>(join(REPO_ROOT, "src/shared/integrations.ts"));
  const view = await runner.import<typeof import("../src/renderer/src/devices/viewWords.ts")>(join(REPO_ROOT, "src/renderer/src/devices/viewWords.ts"));
  const notice = integrationWords.INTEGRATION_NOTICES.google;
  if (!notice) throw new Error("Google has no notice to show");
  const google = integrationWords.INTEGRATION_KIND_NAMES.google;
  const sampleMac = { name: "{mac}" } as Parameters<typeof view.googleUpdateThereWords>[0];
  // The notice keeps the English Google reviewed; the words around it come from the catalog.
  const noticeGroups = notice.groups.map((group) => `        .init(heading: ${JSON.stringify(group.heading)}, items: [${group.items.map((item) => `.init(name: ${item.name ? JSON.stringify(item.name) : "nil"}, text: ${JSON.stringify(item.text)})`).join(", ")}])`).join(",\n");
  const googleWords = `\npublic enum PhoneGoogleWords {\n    public static let signInReturn = ${JSON.stringify(SIGN_IN_RETURN)}\n    public static let kind = "google"\n    public static let name = ${JSON.stringify(google)}\n    public struct Item: Sendable { public let name: String?; public let text: String }\n    public struct Group: Sendable { public let heading: String; public let items: [Item] }\n    public static let noticeTitle = ${JSON.stringify(notice.title)}\n    public static let noticeLead = ${JSON.stringify(notice.lead)}\n    public static let noticeGroups: [Group] = [\n${noticeGroups}\n    ]\n    public static let noticeClosing = ${JSON.stringify(notice.closing)}\n    public static let accept = ${JSON.stringify(notice.accept)}\n    public static let cancel = ${JSON.stringify(notice.cancel)}\n    public static let waiting = ${swiftWords(integrationWords.INTEGRATIONS_BROWSER_SIGN_IN_WORDS.waiting(google), { [google]: "name" })}\n    public static let again = ${swiftWords(integrationWords.INTEGRATIONS_BROWSER_SIGN_IN_WORDS.again)}\n    public static let stop = ${swiftWords(integrationWords.INTEGRATIONS_BROWSER_SIGN_IN_WORDS.cancel)}\n    public static let pasteLead = ${swiftWords(view.RETURN_PASTE_WORDS.lead(google), { [google]: "name" })}\n    public static let pasteLabel = ${swiftWords(view.RETURN_PASTE_WORDS.label(google), { [google]: "name" })}\n    public static let pastePlaceholder = ${swiftWords(view.RETURN_PASTE_WORDS.placeholder)}\n    public static let pasteRefused = ${swiftWords(view.RETURN_PASTE_WORDS.refused)}\n    public static func send(_ mac: String) -> String { ${swiftWords(view.RETURN_PASTE_WORDS.send(sampleMac), { "{mac}": "mac" })} }\n    public static func updateThere(_ mac: String) -> String { ${swiftWords(view.googleUpdateThereWords(sampleMac), { "{mac}": "mac" })} }\n}\n`;
  // INF-3830 piece 2: the channels a panel on the phone may ask for and hear, from the read catalog every panel reads
  // through and the requests the desktop's panel host sends (docs/ios.md, "Panels"). Native code passes no other.
  const panelsChange = "panels-on-the-phone";
  const { readCatalog } = await runner.import<typeof import("../src/shared/reads.ts")>(join(REPO_ROOT, "src/shared/reads.ts"));
  type Invalidation = { pushes?: readonly string[]; valueFromPush?: string; deltaFromPush?: { channel: string } };
  const reading = Object.values(readCatalog) as unknown as { channel: string; invalidate: Invalidation }[];
  const panelHostRequests = ["inf:plugins:invoke", "inf:plugins:db", "inf:plugins:integrations", "inf:plugins:fetch",
    "inf:plugins:retry", "inf:plugins:library", "inf:plugins:files", "inf:plugins:personal:list", "inf:shell:preferences", "inf:cards:list"];
  // A read only the computer's own window may ask, such as Observe's, stays out: the phone could never be answered.
  const panelChannels = [...new Set([...reading.map((read) => read.channel), ...panelHostRequests])]
    .filter((channel) => contract.requests[channel]?.reach === "views" || panelHostRequests.includes(channel)).sort();
  for (const channel of panelChannels) {
    if (contract.requests[channel]?.reach !== "views") throw new Error(`The phone cannot ask ${channel}`);
  }
  const panelPushes = [...new Set(["inf:event", "inf:cards", "inf:plugins:db", "inf:plugins:personal", "inf:shell:preferences",
    ...reading.flatMap((read) => [...(read.invalidate.pushes ?? []), ...(read.invalidate.valueFromPush ? [read.invalidate.valueFromPush] : []),
      ...(read.invalidate.deltaFromPush ? [read.invalidate.deltaFromPush.channel] : [])])])].sort();
  for (const push of panelPushes) if (!contract.pushes[push]) throw new Error(`The phone cannot hear ${push}`);
  const caseName = (channel: string) => channel.replace(/^inf:/, "").replace(/[:-]([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const panelCases = panelChannels.map((channel) => `    case \`${caseName(channel)}\` = ${JSON.stringify(channel)}`).join("\n");
  const panelChanges = panelChannels.filter((channel) => contract.requests[channel].effect === "change").map((channel) => `.${caseName(channel)}`).join(", ");
  const { PERSONAL_ATTRIBUTION } = await runner.import<typeof import("../src/shared/personal/manifest.ts")>(join(REPO_ROOT, "src/shared/personal/manifest.ts"));
  // INF-3830 piece 3: a panel's cards on Home and its header's buttons keep the desktop's bounds and icons.
  const cardBounds = await runner.import<typeof import("../src/shared/plugins/panelCards.ts")>(join(REPO_ROOT, "src/shared/plugins/panelCards.ts"));
  const panelCardWords = `    public static let openCardsMax = ${cardBounds.PANEL_OPEN_CARDS_MAX}\n    public static let defaultCardWidth = ${JSON.stringify(cardBounds.DEFAULT_PANEL_CARD_WIDTH)}\n    public static let defaultCardHeight = ${JSON.stringify(cardBounds.DEFAULT_PANEL_CARD_HEIGHT)}\n    public static let headerIcons = [${cardBounds.PANEL_HEADER_ICONS.map((icon) => JSON.stringify(icon)).join(", ")}]\n`;
  const panelEnum = `\npublic enum PhonePanelRequest: String, Sendable, CaseIterable {\n${panelCases}\n    public var changes: Bool {\n        switch self { case ${panelChanges}: true; default: false }\n    }\n    /// The pushes a panel's page hears: what its reads re-read on, and its store's and the panel list's own.\n    public static let pushes: Set<String> = [${panelPushes.map((push) => JSON.stringify(push)).join(", ")}]\n    public static let change = ${JSON.stringify(panelsChange)}\n}\n\npublic enum PhonePanelWords {\n    public static let yours = ${swiftWords(PERSONAL_ATTRIBUTION)}\n    public static let backgroundStopped = ${swiftWords(catalog.panelBackgroundStopped())}\n    public static let backgroundExited = ${swiftWords(catalog.panelBackgroundExited())}\n    public static let retry = ${swiftWords(catalog.panelRetry())}\n    public static let unresponsive = ${swiftWords(catalog.panelUnresponsiveLine())}\n    public static func couldNotOpen(_ failure: String) -> String { ${swiftWords(catalog.panelCouldNotOpen({ failure: "{failure}" }), { "{failure}": "failure" })} }\n${panelCardWords}}\n`;
  const path = join(REPO_ROOT, "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneContract.generated.swift");
  // INF-4207 piece 9: taking over from the phone (docs/devices.md, "Taking over from a phone"; src/shared/standbyPhone.ts).
  const standbyPhone = await runner.import<typeof import("../src/shared/standbyPhone.ts")>(join(REPO_ROOT, "src/shared/standbyPhone.ts"));
  const { HOME_ROUTES_LIVE } = await runner.import<typeof import("../src/shared/standby.ts")>(join(REPO_ROOT, "src/shared/standby.ts"));
  if (!existsSync(join(REPO_ROOT, `src/shared/contract-changes/${standbyPhone.STANDBY_PHONE_CHANGE}.md`))) throw new Error(`No contract change ${standbyPhone.STANDBY_PHONE_CHANGE}`);
  const standbyEnum = `\npublic enum PhoneStandbyContract {\n    public static let change = ${JSON.stringify(standbyPhone.STANDBY_PHONE_CHANGE)}\n    public static let path = ${JSON.stringify(standbyPhone.STANDBY_PHONE_PATH)}\n    public static let maxFrameBytes = ${standbyPhone.STANDBY_PHONE_FRAME_BYTES}\n    public static let offer = ${JSON.stringify(standbyPhone.STANDBY_PHONE_OFFER)}\n    public static let takeOver = ${JSON.stringify(standbyPhone.STANDBY_PHONE_TAKE_OVER)}\n    public static let routes = ${JSON.stringify(HOME_ROUTES_LIVE)}\n}\n`;
  const generated = text + cardEnum + requestEnum + limits + groupEnum + rowWordsEnum + rowMoveWordsEnum + recordWordsEnum + pastWords + sshCommands + diagnosticsEnum + decision + googleWords + panelEnum + standbyEnum;
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== generated) throw staleGeneratedFile(relative(REPO_ROOT, path), "node scripts/generate-phone-contract.ts");
  } else writeFileSync(path, generated);
} finally { await runner.close(); }

/**
 * INF-1524: a phone card says what the Mac's card says, read from the Mac's own word owners. A count, a key or a time
 * is a sample here, swapped for the Swift value it stands for; every other word is the owner's own.
 */
async function phoneCardWords(runner: Awaited<ReturnType<typeof openModuleRunner>>): Promise<string> {
  const load = <T>(file: string) => runner.import<T>(join(REPO_ROOT, file));
  const cards = await load<typeof import("../src/shared/cards.ts")>("src/shared/cards.ts");
  const risk = await load<typeof import("../src/shared/risk.ts")>("src/shared/risk.ts");
  const browser = await load<typeof import("../src/shared/taskBrowser.ts")>("src/shared/taskBrowser.ts");
  const leave = await load<typeof import("../src/shared/cardLeave.ts")>("src/shared/cardLeave.ts");
  const required = await load<typeof import("../src/renderer/src/cards/requiredActionsWords.ts")>("src/renderer/src/cards/requiredActionsWords.ts");
  const afterMerge = await load<typeof import("../src/shared/afterMerge.ts")>("src/shared/afterMerge.ts");
  const thread = await load<typeof import("../src/renderer/src/cards/threadWords.ts")>("src/renderer/src/cards/threadWords.ts");
  const answers = await load<typeof import("../src/renderer/src/cards/answersLine.ts")>("src/renderer/src/cards/answersLine.ts");
  const revised = await load<typeof import("../src/renderer/src/cards/revisedLine.ts")>("src/renderer/src/cards/revisedLine.ts");
  const notes = await load<typeof import("../src/shared/cardNotes.ts")>("src/shared/cardNotes.ts");
  const formats = await load<typeof import("../src/shared/i18n/format.ts")>("src/shared/i18n/format.ts");
  const text = (words: string) => swiftWords(words);
  /** The owner's words with each sample swapped for the Swift value it stands for; a sample must appear exactly once. */
  const fill = (words: string, samples: Record<string, string> | [string, string][]) =>
    swiftWords(words, Array.isArray(samples) ? Object.fromEntries(samples) : samples);
  // A preview counts its settings answered and has no defaults; a decision says how many required
  // questions wait, else how many are picked, then how many are left to their Default (INF-4425).
  const answerCases = [false, true].flatMap((preview) => (preview ? [0] : [0, 6]).flatMap((unanswered) =>
    (preview ? [0] : [0, 2]).flatMap((defaults) => [0, 4].map((changed) => {
      const words = answers.answersLine({ answered: 3, of: 5, changed, unanswered, defaults }, preview);
      const samples: Record<string, string> = {
        ...(unanswered ? { 6: "toAnswer" } : { 3: "answered", 5: "of" }),
        ...(defaults ? { 2: "defaults" } : {}),
        ...(changed ? { 4: "changed" } : {}),
      };
      return `        case (${preview}, ${preview ? "_" : unanswered > 0}, ${preview ? "_" : defaults > 0}, ${changed > 0}): ${fill(words, samples)}`;
    }))));
  const at = new Date(2026, 0, 2, 9, 41).getTime();
  const time = revised.clock(at, at);
  const revisedCases = [0, 1, 7].flatMap((added) => [0, 1, 9].map((removed) => {
    const words = revised.revisedLine({ at, added, removed, rewritten: false, marks: [] }, at);
    const samples: [string, string][] = [[time, "time"]];
    if (added === 7) samples.push(["7", "added"]);
    if (removed === 9) samples.push(["9", "removed"]);
    return `        case (${added === 7 ? "_" : added}, ${removed === 9 ? "_" : removed}): ${fill(words, samples)}`;
  }));
  const rewritten = fill(revised.revisedLine({ at, added: 0, removed: 0, rewritten: true, marks: [] }, at), { [time]: "time" });
  const dimensions = risk.RISK_DIMENSIONS.map((dimension) => {
    const words = risk.RISK_LABELS[dimension];
    const levels = risk.RISK_LEVELS.map((level) => `${JSON.stringify(level)}: ${text(words.levels[level])}`).join(", ");
    return `        Dimension(id: ${JSON.stringify(dimension)}, label: ${text(words.label)}, levels: [${levels}]),`;
  }).join("\n");
  const tones = risk.RISK_LEVELS.map((level) => `${JSON.stringify(level)}: ${JSON.stringify(risk.riskTone(level))}`).join(", ");
  // The crew's wait line: how many keys, and the keys joined as the phone's language lists them.
  const waitKeys = ["KEY-A", "KEY-B", "KEY-C", "KEY-D", "KEY-E", "KEY-F", "KEY-G"];
  const waitWords = fill(afterMerge.afterMergeWaitWords(waitKeys), { 7: "keys.count", [formats.formatList(waitKeys)]: "PhoneFormats.list(keys)" });
  const table = (record: Record<string, string>) => `[${Object.entries(record).map(([key, words]) => `${JSON.stringify(key)}: ${text(words)}`).join(", ")}]`;
  return `// Generated by scripts/generate-phone-contract.ts from src/shared/cards.ts, src/shared/risk.ts, src/shared/taskBrowser.ts,
// src/shared/afterMerge.ts, src/shared/cardNotes.ts and src/renderer/src/cards/
// (requiredActionsWords.ts, threadWords.ts, answersLine.ts, revisedLine.ts).
import InfinitaryKit

enum PhoneCardWords {
    static let replyHint = ${text(cards.CARD_REPLY_HINT)}
    static let anythingElse = ${JSON.stringify(cards.ANYTHING_ELSE_ANSWER)}
    static let sentWithChoice = ${text(cards.PAST_CARD_WORDS_LEAD)}
    static let reviewFinding = ${text(cards.REVIEW_FINDING_LABEL)}
    static let panelLeave = ${text(leave.CARD_LEAVE["window-panel"].label)}
    static let panelLeaveRest = ${text(leave.CARD_LEAVE["window-panel"].restWords)}
    static let recordLeave = ${text(leave.CARD_LEAVE.record.label)}
    static let recordLeaveRest = ${text(leave.CARD_LEAVE.record.restWords)}
    static let done = ${text(leave.ANSWER_DONE_LABEL)}
    static func doneRest(_ taskKey: String) -> String {
        ${fill(leave.answerDoneRest("__TASK_KEY__"), { __TASK_KEY__: "taskKey" })}
    }
    static let decline = ${text(leave.DECLINE_LABEL)}
    static let putAside = ${text(leave.CARD_LEAVE.decision.label)}
    static let putAsideRest = ${text(leave.CARD_LEAVE.decision.restWords)}
    static let requiredActionsLead = ${text(required.REQUIRED_ACTIONS_LEAD)}
    static let afterMergeLead = ${text(afterMerge.AFTER_MERGE_LEAD)}
    static let afterMergeDoer = ${table(afterMerge.AFTER_MERGE_DOER_WORDS)}
    static let threadWho = ${table(thread.THREAD_WHO_LABELS)}
    static let threadWorking = ${text(thread.THREAD_WORKING)}
    static let threadCard = ${isMarked(thread.THREAD_CARD) ? `PhoneWords.sentence(${text(thread.THREAD_CARD)})` : JSON.stringify(thread.THREAD_CARD.charAt(0).toUpperCase() + thread.THREAD_CARD.slice(1))}
    static let threadCardUpdated = ${text(thread.THREAD_CARD_UPDATED)}
    static let driverWords = ${table(browser.DRIVER_WORDS)}
    static let stopLineWords = ${table(browser.STOP_LINE_WORDS)}
    static let staleBrowser = ${text(browser.STALE_ATTACHMENT_LINE)}
    static let pointAt = ${text(notes.POINT_AT)}
    static let pointedAt = ${text(notes.POINTED_AT)}
    static let annotate = ${text(notes.ANNOTATE)}
    static let queueNote = ${text(notes.QUEUE_NOTE)}
    static let noteCommentLabel = ${text(notes.NOTE_COMMENT_LABEL)}
    static let noteCancel = ${text(notes.NOTE_CANCEL)}
    static let noteEdit = ${text(notes.NOTE_EDIT)}
    static let noteRemove = ${text(notes.NOTE_REMOVE)}
    static let notePlaceholder = ${text(notes.NOTE_PLACEHOLDER)}
    static let noteDiscardHint = ${text(notes.NOTE_DISCARD_HINT)}
    static let staleNote = ${text(notes.STALE_NOTE)}
    static let unavailableNote = ${text(notes.UNAVAILABLE_NOTE)}
    static let emptyNote = ${text(notes.EMPTY_NOTE)}
    static func queuedNotes(_ count: Int) -> String {
        ${fill(notes.queuedNotesWords(7), { 7: "count" })}
    }
    /** The Mac's noteLabel: what a note points at, as a reader reads it. */
    static func noteLabel(kind: String, excerpt: String) -> String {
        ${fill(notes.noteLabel({ kind: "KIND-1", excerpt: "EXCERPT-1" }), { "KIND-1": "kind", "EXCERPT-1": "excerpt" })}
    }

    static func afterMergeWait(_ keys: [String]) -> String {
        ${waitWords}
    }
    static func settingsCount(_ count: Int) -> String {
        ${fill(thread.settingsCountWords(7), { 7: "count" })}
    }
    static func messageCount(_ count: Int) -> String {
        ${fill(thread.messageCountWords(7), { 7: "count" })}
    }
    static func newCount(_ count: Int) -> String { ${fill(thread.newCountWords(7), { 7: "count" })} }
    static func threadCount(_ count: Int) -> String { ${fill(thread.threadCountWords(7), { 7: "count" })} }
    static func threadJump(_ count: Int) -> String {
        count == 0 ? ${text(thread.threadJumpWords(0))} : ${fill(thread.threadJumpWords(7), { 7: "count" })}
    }
    /** Who really wrote a thread line, and whether it came after the card closed ("Shared cards"). */
    static func contributor(host: Bool, label: String?, clarification: Bool) -> String {
        switch (host, label, clarification) {
        case (true, let label?, false): ${fill(thread.contributorWords({ host: true, label: "LABEL-1" }), { "LABEL-1": "label" })}
        case (true, let label?, true): ${fill(thread.contributorWords({ host: true, label: "LABEL-1", clarification: true }), { "LABEL-1": "label" })}
        case (false, let label?, false): ${fill(thread.contributorWords({ host: false, label: "LABEL-1" }), { "LABEL-1": "label" })}
        case (false, let label?, true): ${fill(thread.contributorWords({ host: false, label: "LABEL-1", clarification: true }), { "LABEL-1": "label" })}
        case (_, nil, true): ${text(thread.contributorWords({ host: false, clarification: true }))}
        default: ""
        }
    }
    static func answersLine(answered: Int, of: Int, changed: Int, toAnswer: Int, defaults: Int, preview: Bool) -> String {
        switch (preview, toAnswer > 0, defaults > 0, changed > 0) {
${answerCases.join("\n")}
        }
    }
    /** \`time\` is the time of day, with the date in front when it was not today, as the Mac's clock writes it. */
    static func revisedLine(time: String, added: Int, removed: Int, rewritten: Bool) -> String {
        if rewritten { return ${rewritten} }
        return switch (min(added, 2) == 2 ? -1 : added, min(removed, 2) == 2 ? -1 : removed) {
${revisedCases.map((line) => line.replaceAll("_,", "-1,").replace(", _)", ", -1)")).join("\n")}
        default: ""
        }
    }

    struct Dimension { let id: String; let label: String; let levels: [String: String] }
    /** The seven dimensions in the Mac's order, each with its name and what each level means. */
    static let riskDimensions: [Dimension] = [
${dimensions}
    ]
    /** A level's color, in the checks' language. */
    static let riskTone: [String: String] = [${tones}]
}
`;
}
