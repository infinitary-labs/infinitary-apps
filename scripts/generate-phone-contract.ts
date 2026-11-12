import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openModuleRunner, REPO_ROOT } from "./moduleRunner.ts";
import { assertPhoneReaderShapes } from "./phone-contract-shapes.ts";

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
  // INF-3454's phone part: Google's row in the phone's Settings (docs/ios.md, "Google in Settings").
  integrations: "inf:integrations:list", signIn: "inf:integrations:sign-in", signInReturn: "inf:integrations:sign-in-return",
  signInCancel: "inf:integrations:sign-in-cancel", integrationRemove: "inf:integrations:remove",
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
  picture: "inf:cards:picture", typeface: "inf:cards:typeface", media: "inf:cards:media",
  // INF-944 item 3: opening a minimized card on the phone brings it back on the Mac too.
  minimize: "inf:cards:minimize",
  // INF-2794: every live note's one button, Done or Got it.
  noteDone: "inf:cards:note-done",
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
const runner = await openModuleRunner();
try {
  // Retained for older homes/views; major 15 absorbed the named change.
  const { FRAME_PARTS: partsChange } = await runner.import<typeof import("../src/core/connection/frameParts.ts")>(join(REPO_ROOT, "src/core/connection/frameParts.ts"));
  // INF-3296's phone piece: typed notes on a card's reply and thread, which the phone offers once its home lists them.
  const annotationsChange = "card-annotations";
  if (!existsSync(join(REPO_ROOT, `src/shared/contract-changes/${annotationsChange}.md`))) throw new Error(`No contract change ${annotationsChange}`);
  const { FEED_EVENT_TYPES } = await runner.import<typeof import("../src/shared/feed.ts")>(join(REPO_ROOT, "src/shared/feed.ts"));
  const cases = FEED_EVENT_TYPES.map((type) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(type)) throw new Error(`Cannot generate a Swift feed case for ${type}`);
    return `    case \`${type}\` = ${JSON.stringify(type)}`;
  }).join("\n");
  // INF-209's five groups use the Mac's rule, including required actions and starts in flight.
  // A finite table keeps Swift from owning another implementation of that rule.
  const { NOW_GROUPS, NOW_GROUP_LABELS, nowGroupOf } = await runner.import<typeof import("../src/shared/nowPanel.ts")>(join(REPO_ROOT, "src/shared/nowPanel.ts"));
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
  const groupEnum = `\npublic enum PhoneTaskGroup: String, CaseIterable, Sendable {\n    case ${NOW_GROUPS.join(", ")}\n    public var title: String {\n        switch self {\n${NOW_GROUPS.map((group) => `        case .${group}: ${JSON.stringify(NOW_GROUP_LABELS[group].charAt(0).toUpperCase() + NOW_GROUP_LABELS[group].slice(1))}`).join("\n")}\n        }\n    }\n    public static func reading(status: String, work: Bool, required: Bool, waiting: Bool, starting: Bool, onRequest: Bool, minimized: Bool = false, backlog: Bool = false) -> Self? {\n        guard let state = ${JSON.stringify(statuses)}.firstIndex(of: status) else { return nil }\n        let bits = (backlog ? 64 : 0) + (minimized ? 32 : 0) + (work ? 16 : 0) + (required ? 8 : 0) + (waiting ? 4 : 0) + (starting ? 2 : 0) + (onRequest ? 1 : 0)\n        return readings[state * 128 + bits]\n    }\n    private static let readings: [Self?] = [\n${groupRows}\n    ]\n}\n`;
  // A phone reads the scene from a home on this major or later without its change name.
  const { CARD_SEEN_UPDATE_SINCE, PHONE_DIAGNOSTICS_SINCE, SCENE_OBSERVATIONS_SINCE } = await runner.import<typeof import("../src/shared/contractFeatures.ts")>(join(REPO_ROOT, "src/shared/contractFeatures.ts"));
  const text = `// Generated by scripts/generate-phone-contract.ts from docs/contract.json, src/shared/feed.ts, src/shared/nowPanel.ts, src/panels/now/words.ts, the task record's word owners, src/shared/pastCard.ts, src/shared/secrets.ts, src/shared/phoneLink.ts, src/shared/contractFeatures.ts, src/core/secrets/approvals.ts, src/shared/integrations.ts, src/renderer/src/devices/viewWords.ts and src/core/signInReturns.ts.\npublic enum PhoneContract {\n    public static let cardCurrentUpdateSeen = "card-current-update-seen"\n    public static let cardCurrentUpdateSeenSince = ${Number(CARD_SEEN_UPDATE_SINCE.split(".")[0])}\n    public static let sceneObservations = "native-scene-observations"\n    public static let sceneObservationsSince = ${Number(SCENE_OBSERVATIONS_SINCE.split(".")[0])}\n    public static let phoneDiagnosticsSince = ${Number(PHONE_DIAGNOSTICS_SINCE.split(".")[0])}\n    public static let version = ${JSON.stringify(contract.protocolVersion)}\n    public static let viewFloor = ${contract.versionRule.viewFloor}\n    public static let pairPath = ${JSON.stringify(contract.connection.pair.path)}\n    public static let connectionPath = ${JSON.stringify(contract.connection.path)}\n    public static let maxFrameBytes = ${contract.connection.maxFrameBytes}\n    public static let frameParts = ${JSON.stringify(partsChange)}\n    public static let cardAnnotations = ${JSON.stringify(annotationsChange)}\n    public static let cards = ${JSON.stringify(reads.cards)}\n    public static let feed = ${JSON.stringify(reads.feed)}\n}\n\nenum FeedChange: String {\n${cases}\n}\n`;
  // INF-499 #2: past-card attribution uses the shared wording owner for every published ending.
  const { pastEndingWords } = await runner.import<typeof import("../src/shared/pastCard.ts")>(join(REPO_ROOT, "src/shared/pastCard.ts"));
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
      return `        case ${match}: ${JSON.stringify(words).replace("{label}", "\\(label)")}`;
    }).join("\n");
  }).join("\n");
  const pastWords = `\npublic enum PhonePastEnding {\n    public static func words(_ ending: PhoneJSON) -> String {\n        let label = ending["label"].text ?? "an option"\n        return switch (ending["how"].text ?? "unknown", ending["by"].text ?? "captain") {\n${endingCases}\n        default: ${JSON.stringify(pastEndingWords({ how: "unknown", at: 0 }))}\n        }\n    }\n}\n`;
  // INF-1183: the fixed commands a phone runs over SSH come from the home's door owner, never a native copy.
  const link = await runner.import<typeof import("../src/shared/phoneLink.ts")>(join(REPO_ROOT, "src/shared/phoneLink.ts"));
  const sshCommands = `\npublic enum PhoneSSHCommand {\n    public static let header = ${JSON.stringify(link.PHONE_LINK_HEADER)}\n    public static let version = ${JSON.stringify(link.PHONE_LINK_VERSION)}\n    public static let link = ${JSON.stringify(link.PHONE_LINK_COMMAND)}\n    public static let placeKey = ${JSON.stringify(link.PHONE_PLACE_KEY_COMMAND)}\n    public static let placed = ${JSON.stringify(link.PHONE_KEY_PLACED)}\n    public static let notOpen = ${JSON.stringify(link.PHONE_LINK_NONE.notOpen)}\n    public static let tooOld = ${JSON.stringify(link.PHONE_LINK_NONE.tooOld)}\n    public static let noCurl = ${JSON.stringify(link.PHONE_LINK_NONE.noCurl)}\n}\n`;
  // INF-2928 piece 1: a Tasks row's dim word, its reach and its header's counts, in the Mac's own words (src/panels/now/words.ts).
  const rowWords = await runner.import<typeof import("../src/panels/now/words.ts")>(join(REPO_ROOT, "src/panels/now/words.ts"));
  const sample = (words: string, value: string, swift: string) => {
    const literal = JSON.stringify(words);
    if (literal.split(value).length !== 2) throw new Error(`The sample ${value} is not once in ${words}`);
    return literal.replace(value, `\\(${swift})`);
  };
  const rowWordsEnum = `\npublic enum PhoneTaskRowWords {\n${Object.entries(rowWords.ROW_WORDS).map(([name, words]) => `    public static let ${name} = ${JSON.stringify(words)}`).join("\n")}\n${Object.entries(rowWords.ROW_REACH_WORDS).map(([name, words]) => `    public static let reach${name.charAt(0).toUpperCase() + name.slice(1)} = ${JSON.stringify(words)}`).join("\n")}\n    public static let earlier = ${JSON.stringify(rowWords.EARLIER_LABEL.charAt(0).toUpperCase() + rowWords.EARLIER_LABEL.slice(1))}\n    public static let pinned = ${JSON.stringify(rowWords.PINNED_LABEL.charAt(0).toUpperCase() + rowWords.PINNED_LABEL.slice(1))}\n    public static let start = ${JSON.stringify(rowWords.ROW_START_LABEL)}\n    public static let tryAgain = ${JSON.stringify(rowWords.ROW_TRY_AGAIN_LABEL)}\n    public static func foundOn(_ key: String) -> String { ${sample(rowWords.foundOnWords("INF-7"), "INF-7", "key")} }\n    public static func newCount(_ count: Int) -> String { ${sample(rowWords.newCountWords(7), "7", "count")} }\n    public static func failedCount(_ count: Int) -> String { ${sample(rowWords.failedCountWords(7), "7", "count")} }\n}\n`;
  // INF-2928 piece 3: the task board's menu and its asks name their moves in these words (src/panels/now/boardMoves.ts).
  const boardMoves = await runner.import<{ QUEUE_LABEL: string; UNQUEUE_LABEL: string; START_LABEL: string; START_NOW_LABEL: string;
    STARTED_BACKLOG_TEXT: string; PIN_DETAIL: string; UNPIN_DETAIL: string }>(join(REPO_ROOT, "src/panels/now/boardMoves.ts"));
  // INF-3127: Pin and Unpin, the board menu's and the row's own words (src/shared/taskPin.ts).
  const pinWords = await runner.import<typeof import("../src/shared/taskPin.ts")>(join(REPO_ROOT, "src/shared/taskPin.ts"));
  const rowMoveWordsEnum = `\npublic enum PhoneRowMoveWords {\n    public static let queue = ${JSON.stringify(boardMoves.QUEUE_LABEL)}\n    public static let unqueue = ${JSON.stringify(boardMoves.UNQUEUE_LABEL)}\n    public static let start = ${JSON.stringify(boardMoves.START_LABEL)}\n    public static let startNow = ${JSON.stringify(boardMoves.START_NOW_LABEL)}\n    public static let startedBacklog = ${JSON.stringify(boardMoves.STARTED_BACKLOG_TEXT)}\n    public static let pin = ${JSON.stringify(pinWords.PIN_LABEL)}\n    public static let unpin = ${JSON.stringify(pinWords.UNPIN_LABEL)}\n    public static let pinDetail = ${JSON.stringify(boardMoves.PIN_DETAIL)}\n    public static let unpinDetail = ${JSON.stringify(boardMoves.UNPIN_DETAIL)}\n}\n`;
  // INF-2935 (INF-2928 piece 2): the task record's own words on the Mac - its tabs, its bar's buttons, Drop task's
  // question, the Crewmate tab's status line and the More row's policies - from their owners.
  const bar = await runner.import<typeof import("../src/shared/recordBar.ts")>(join(REPO_ROOT, "src/shared/recordBar.ts"));
  const drop = await runner.import<typeof import("../src/shared/recordDrop.ts")>(join(REPO_ROOT, "src/shared/recordDrop.ts"));
  const tabWords = await runner.import<typeof import("../src/shared/taskBrowser.ts")>(join(REPO_ROOT, "src/shared/taskBrowser.ts"));
  const crewWords = await runner.import<typeof import("../src/shared/crewTranscript.ts")>(join(REPO_ROOT, "src/shared/crewTranscript.ts"));
  const policyWords = await runner.import<typeof import("../src/shared/taskPolicies.ts")>(join(REPO_ROOT, "src/shared/taskPolicies.ts"));
  const { CARE_WORDS } = await runner.import<typeof import("../src/shared/vocabulary.ts")>(join(REPO_ROOT, "src/shared/vocabulary.ts"));
  const swiftTable = (record: Readonly<Record<string, string | undefined>>) => `[${Object.entries(record).map(([key, words]) => `${JSON.stringify(key)}: ${JSON.stringify(words)}`).join(", ")}]`;
  const crewNames = ["working", "stop", "stopping", "idle", "waiting", "paused", "closed", "field", "placeholderWorking",
    "placeholderIdle", "empty", "unreadable", "brief", "firstmate", "app"] as const;
  const recordWordsEnum = `\npublic enum PhoneRecordWords {\n    public static let info = ${JSON.stringify(tabWords.INFO_TAB_LABEL)}\n    public static let cards = ${JSON.stringify(tabWords.CARDS_TAB_LABEL)}\n    public static let activity = ${JSON.stringify(tabWords.ACTIVITY_TAB_LABEL)}\n    public static let crewmate = ${JSON.stringify(crewWords.CREWMATE_TAB_LABEL)}\n    public static let next = ${swiftTable(bar.RECORD_NEXT_LABELS)}\n    public static let dropTask = ${JSON.stringify(drop.DROP_TASK_LABEL)}\n    public static let dropCancel = ${JSON.stringify(drop.DROP_CANCEL_LABEL)}\n    public static let dropReviewStale = ${JSON.stringify(drop.DROP_REVIEW_STALE)}\n${crewNames.map((name) => `    public static let crew${name.charAt(0).toUpperCase() + name.slice(1)} = ${JSON.stringify(crewWords.CREWMATE_WORDS[name])}`).join("\n")}\n    public static let care = ${swiftTable(CARE_WORDS)}\n    public static let policyDelivery = ${swiftTable(policyWords.POLICY_DELIVERY_WORDS)}\n    public static let policyMergesOn = ${JSON.stringify(policyWords.POLICY_MERGING_WORDS.on)}\n    public static let policyMergesOff = ${JSON.stringify(policyWords.POLICY_MERGING_WORDS.off)}\n    public static let policySource = ${swiftTable(policyWords.RUNS_ON_SOURCE_WORDS)}\n    public static let policyHelper = ${JSON.stringify(policyWords.POLICY_HELPER)}\n    public static let policyCareBound = ${JSON.stringify(policyWords.POLICY_CARE_BOUND)}\n}\n`;
  const cardWords = await phoneCardWords(runner);
  const wordsPath = join(REPO_ROOT, "ios/Infinitary/InfinitaryApp/PhoneCardWords.generated.swift");
  if (process.argv.includes("--check")) {
    if (readFileSync(wordsPath, "utf8") !== cardWords) throw new Error("Run node scripts/generate-phone-contract.ts");
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
  const decision = `\npublic enum PhoneDecision {\n    public static let format = ${JSON.stringify(DECISION_FORMAT)}\n    public static let allow = ${JSON.stringify(DECISION_ALLOW)}\n    public static let allowWords = ${JSON.stringify(SECRETS_WORDS.once)}\n    public static let denyWords = ${JSON.stringify(SECRETS_WORDS.deny)}\n    /// The exact bytes the home's verifier checks, one binding per line in its order.\n    public static func message(${decisionParameters}) -> String {\n        [format, ${decisionLines}, allow].joined(separator: "\\n")\n    }\n}\n`;
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
  const noticeGroups = notice.groups.map((group) => `        .init(heading: ${JSON.stringify(group.heading)}, items: [${group.items.map((item) => `.init(name: ${item.name ? JSON.stringify(item.name) : "nil"}, text: ${JSON.stringify(item.text)})`).join(", ")}])`).join(",\n");
  const googleWords = `\npublic enum PhoneGoogleWords {\n    public static let signInReturn = ${JSON.stringify(SIGN_IN_RETURN)}\n    public static let kind = "google"\n    public static let name = ${JSON.stringify(google)}\n    public struct Item: Sendable { public let name: String?; public let text: String }\n    public struct Group: Sendable { public let heading: String; public let items: [Item] }\n    public static let noticeTitle = ${JSON.stringify(notice.title)}\n    public static let noticeLead = ${JSON.stringify(notice.lead)}\n    public static let noticeGroups: [Group] = [\n${noticeGroups}\n    ]\n    public static let noticeClosing = ${JSON.stringify(notice.closing)}\n    public static let accept = ${JSON.stringify(notice.accept)}\n    public static let cancel = ${JSON.stringify(notice.cancel)}\n    public static let waiting = ${JSON.stringify(integrationWords.INTEGRATIONS_BROWSER_SIGN_IN_WORDS.waiting(google))}\n    public static let again = ${JSON.stringify(integrationWords.INTEGRATIONS_BROWSER_SIGN_IN_WORDS.again)}\n    public static let stop = ${JSON.stringify(integrationWords.INTEGRATIONS_BROWSER_SIGN_IN_WORDS.cancel)}\n    public static let pasteLead = ${JSON.stringify(view.RETURN_PASTE_WORDS.lead(google))}\n    public static let pasteLabel = ${JSON.stringify(view.RETURN_PASTE_WORDS.label(google))}\n    public static let pastePlaceholder = ${JSON.stringify(view.RETURN_PASTE_WORDS.placeholder)}\n    public static let pasteRefused = ${JSON.stringify(view.RETURN_PASTE_WORDS.refused)}\n    public static func send(_ mac: String) -> String { ${sample(view.RETURN_PASTE_WORDS.send(sampleMac), "{mac}", "mac")} }\n    public static func updateThere(_ mac: String) -> String { ${sample(view.googleUpdateThereWords(sampleMac), "{mac}", "mac")} }\n}\n`;
  const path = join(REPO_ROOT, "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneContract.generated.swift");
  const generated = text + cardEnum + requestEnum + limits + groupEnum + rowWordsEnum + rowMoveWordsEnum + recordWordsEnum + pastWords + sshCommands + diagnosticsEnum + decision + googleWords;
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== generated) throw new Error("Run node scripts/generate-phone-contract.ts");
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
  const text = (words: string) => JSON.stringify(words);
  /** The owner's words with each sample swapped for a Swift interpolation; a sample must appear exactly once. */
  const fill = (words: string, samples: Record<string, string> | [string, string][]) => {
    let literal = text(words);
    for (const [sample, swift] of Array.isArray(samples) ? samples : Object.entries(samples)) {
      if (literal.split(sample).length !== 2) throw new Error(`The sample ${sample} is not once in ${words}`);
      literal = literal.replace(sample, `\\(${swift})`);
    }
    return literal;
  };
  const answerCases = [false, true].flatMap((preview) => [0, 4].map((changed) => {
    const words = answers.answersLine({ answered: 3, of: 5, changed }, preview);
    return `        case (${preview}, ${changed > 0}): ${fill(words, { 3: "answered", 5: "of", ...(changed ? { 4: "changed" } : {}) })}`;
  }));
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
    const words = risk.RISK_WORDS[dimension];
    const levels = risk.RISK_LEVELS.map((level) => `${text(level)}: ${text(words.levels[level])}`).join(", ");
    return `        Dimension(id: ${text(dimension)}, label: ${text(words.label)}, levels: [${levels}]),`;
  }).join("\n");
  const tones = risk.RISK_LEVELS.map((level) => `${text(level)}: ${text(risk.riskTone(level))}`).join(", ");
  // The crew's wait line joins its keys with the owner's own separator.
  const twoKeys = afterMerge.afterMergeWaitWords(["KEY-1", "KEY-2"]);
  const keySeparator = twoKeys.slice(twoKeys.indexOf("KEY-1") + "KEY-1".length, twoKeys.indexOf("KEY-2"));
  const joinedKeys = `keys.joined(separator: ${JSON.stringify(keySeparator)})`;
  const table = (record: Record<string, string>) => `[${Object.entries(record).map(([key, words]) => `${text(key)}: ${text(words)}`).join(", ")}]`;
  return `// Generated by scripts/generate-phone-contract.ts from src/shared/cards.ts, src/shared/risk.ts, src/shared/taskBrowser.ts,
// src/shared/afterMerge.ts, src/shared/cardNotes.ts and src/renderer/src/cards/
// (requiredActionsWords.ts, threadWords.ts, answersLine.ts, revisedLine.ts).
enum PhoneCardWords {
    static let replyHint = ${text(cards.CARD_REPLY_HINT)}
    static let anythingElse = ${text(cards.ANYTHING_ELSE_ANSWER)}
    static let sentWithChoice = ${text(cards.PAST_CARD_WORDS_LEAD)}
    static let reviewFinding = ${text(cards.REVIEW_FINDING_LABEL)}
    static let panelLeave = ${text(leave.CARD_LEAVE["window-panel"].label)}
    static let panelLeaveRest = ${text(leave.CARD_LEAVE["window-panel"].restWords)}
    static let recordLeave = ${text(leave.CARD_LEAVE.record.label)}
    static let recordLeaveRest = ${text(leave.CARD_LEAVE.record.restWords)}
    static let done = ${text(leave.ANSWER_DONE_LABEL)}
    static func doneRest(_ taskKey: String) -> String {
        ${text(leave.answerDoneRest("__TASK_KEY__")).replace("__TASK_KEY__", "\\(taskKey)")}
    }
    static let decline = ${text(leave.DECLINE_LABEL)}
    static let putAside = ${text(leave.CARD_LEAVE.decision.label)}
    static let putAsideRest = ${text(leave.CARD_LEAVE.decision.restWords)}
    static let requiredActionsLead = ${text(required.REQUIRED_ACTIONS_LEAD)}
    static let afterMergeLead = ${text(afterMerge.AFTER_MERGE_LEAD)}
    static let afterMergeDoer = ${table(afterMerge.AFTER_MERGE_DOER_WORDS)}
    static let threadWho = ${table(thread.THREAD_WHO_LABELS)}
    static let threadWorking = ${text(thread.THREAD_WORKING)}
    static let threadCard = ${text(thread.THREAD_CARD.charAt(0).toUpperCase() + thread.THREAD_CARD.slice(1))}
    static let threadCardUpdated = ${text(thread.THREAD_CARD_UPDATED)}
    static let driverWords = ${table(browser.DRIVER_WORDS)}
    static let stopLineWords = ${table(browser.STOP_LINE_WORDS)}
    static let staleBrowser = ${JSON.stringify(browser.STALE_ATTACHMENT_LINE)}
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
        count == 1 ? ${text(notes.queuedNotesWords(1))} : ${fill(notes.queuedNotesWords(7), { 7: "count" })}
    }
    /** The Mac's noteLabel: what a note points at, as a reader reads it. */
    static func noteLabel(kind: String, excerpt: String) -> String {
        ${fill(notes.noteLabel({ kind: "KIND-1", excerpt: "EXCERPT-1" }), { "KIND-1": "kind", "EXCERPT-1": "excerpt" })}
    }

    static func afterMergeWait(_ keys: [String]) -> String {
        keys.count > 1 ? ${fill(twoKeys, { [`KEY-1${keySeparator}KEY-2`]: joinedKeys })} : ${fill(afterMerge.afterMergeWaitWords(["KEY-1"]), { "KEY-1": joinedKeys })}
    }
    static func settingsCount(_ count: Int) -> String {
        count == 1 ? ${text(thread.settingsCountWords(1))} : ${fill(thread.settingsCountWords(7), { 7: "count" })}
    }
    static func messageCount(_ count: Int) -> String {
        count == 1 ? ${text(thread.messageCountWords(1))} : ${fill(thread.messageCountWords(7), { 7: "count" })}
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
    static func answersLine(answered: Int, of: Int, changed: Int, preview: Bool) -> String {
        switch (preview, changed > 0) {
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
