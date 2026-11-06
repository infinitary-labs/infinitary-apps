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
  run: "inf:task:run", steer: "inf:task:steer", interrupt: "inf:task:interrupt",
  notifications: "inf:settings:notifications:get",
  conversationState: "inf:conversation:state", computers: "inf:computers:presence",
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
if (!existsSync(join(REPO_ROOT, "src/shared/contract-changes", `${diagnosticsChange}.md`))) throw new Error(`No contract change is named ${diagnosticsChange}`);
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
  const groups = statuses.flatMap((status) => Array.from({ length: 64 }, (_, bits) => nowGroupOf({
    status, minimizedCardId: bits & 32 ? "card" : undefined, kind: bits & 16 ? "work" : "operation",
    requiredAction: bits & 8 ? {} : undefined,
    waitingCardId: bits & 4 ? "card" : null,
    startAttempt: bits & 2 ? { phase: "preparing" } : undefined,
    startPolicy: bits & 1 ? "on-request" : "when-ready", activity: null,
  } as Parameters<typeof nowGroupOf>[0])));
  const groupRows = Array.from({ length: groups.length / 8 }, (_, row) => "        " + groups.slice(row * 8, row * 8 + 8).map((group) => group ? `.${group}` : "nil").join(", ")).join(",\n");
  const groupEnum = `\npublic enum PhoneTaskGroup: String, CaseIterable, Sendable {\n    case ${NOW_GROUPS.join(", ")}\n    public var title: String {\n        switch self {\n${NOW_GROUPS.map((group) => `        case .${group}: ${JSON.stringify(NOW_GROUP_LABELS[group].charAt(0).toUpperCase() + NOW_GROUP_LABELS[group].slice(1))}`).join("\n")}\n        }\n    }\n    public static func reading(status: String, work: Bool, required: Bool, waiting: Bool, starting: Bool, onRequest: Bool, minimized: Bool = false) -> Self? {\n        guard let state = ${JSON.stringify(statuses)}.firstIndex(of: status) else { return nil }\n        let bits = (minimized ? 32 : 0) + (work ? 16 : 0) + (required ? 8 : 0) + (waiting ? 4 : 0) + (starting ? 2 : 0) + (onRequest ? 1 : 0)\n        return readings[state * 64 + bits]\n    }\n    private static let readings: [Self?] = [\n${groupRows}\n    ]\n}\n`;
  // A phone reads the scene from a home on this major or later without its change name.
  const { CARD_SEEN_UPDATE_SINCE, SCENE_OBSERVATIONS_SINCE } = await runner.import<typeof import("../src/shared/contractFeatures.ts")>(join(REPO_ROOT, "src/shared/contractFeatures.ts"));
  const text = `// Generated by scripts/generate-phone-contract.ts from docs/contract.json, src/shared/feed.ts, src/shared/nowPanel.ts, src/shared/pastCard.ts, src/shared/phoneLink.ts and src/shared/contractFeatures.ts.\npublic enum PhoneContract {\n    public static let cardCurrentUpdateSeen = "card-current-update-seen"\n    public static let cardCurrentUpdateSeenSince = ${Number(CARD_SEEN_UPDATE_SINCE.split(".")[0])}\n    public static let sceneObservations = "native-scene-observations"\n    public static let sceneObservationsSince = ${Number(SCENE_OBSERVATIONS_SINCE.split(".")[0])}\n    public static let version = ${JSON.stringify(contract.protocolVersion)}\n    public static let viewFloor = ${contract.versionRule.viewFloor}\n    public static let pairPath = ${JSON.stringify(contract.connection.pair.path)}\n    public static let connectionPath = ${JSON.stringify(contract.connection.path)}\n    public static let maxFrameBytes = ${contract.connection.maxFrameBytes}\n    public static let cards = ${JSON.stringify(reads.cards)}\n    public static let feed = ${JSON.stringify(reads.feed)}\n}\n\nenum FeedChange: String {\n${cases}\n}\n`;
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
  const cardWords = await phoneCardWords(runner);
  const wordsPath = join(REPO_ROOT, "ios/Infinitary/InfinitaryApp/PhoneCardWords.generated.swift");
  if (process.argv.includes("--check")) {
    if (readFileSync(wordsPath, "utf8") !== cardWords) throw new Error("Run node scripts/generate-phone-contract.ts");
  } else writeFileSync(wordsPath, cardWords);
  const path = join(REPO_ROOT, "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneContract.generated.swift");
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== text + cardEnum + requestEnum + limits + groupEnum + pastWords + sshCommands + diagnosticsEnum) throw new Error("Run node scripts/generate-phone-contract.ts");
  } else writeFileSync(path, text + cardEnum + requestEnum + limits + groupEnum + pastWords + sshCommands + diagnosticsEnum);
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
  const size = await load<typeof import("../src/renderer/src/design/cards/cardSizeWords.ts")>("src/renderer/src/design/cards/cardSizeWords.ts");
  const required = await load<typeof import("../src/renderer/src/cards/requiredActionsWords.ts")>("src/renderer/src/cards/requiredActionsWords.ts");
  const thread = await load<typeof import("../src/renderer/src/cards/threadWords.ts")>("src/renderer/src/cards/threadWords.ts");
  const answers = await load<typeof import("../src/renderer/src/cards/answersLine.ts")>("src/renderer/src/cards/answersLine.ts");
  const revised = await load<typeof import("../src/renderer/src/cards/revisedLine.ts")>("src/renderer/src/cards/revisedLine.ts");
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
  const table = (record: Record<string, string>) => `[${Object.entries(record).map(([key, words]) => `${text(key)}: ${text(words)}`).join(", ")}]`;
  return `// Generated by scripts/generate-phone-contract.ts from src/shared/cards.ts, src/shared/risk.ts, src/shared/taskBrowser.ts,
// src/renderer/src/design/cards/cardSizeWords.ts and src/renderer/src/cards/
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
    static let putAside = ${text(leave.CARD_LEAVE.decision.label)}
    static let putAsideRest = ${text(leave.CARD_LEAVE.decision.restWords)}
    static let maximize = ${text(size.MAXIMIZE_LABEL)}
    static let restore = ${text(size.RESTORE_LABEL)}
    static let requiredActionsLead = ${text(required.REQUIRED_ACTIONS_LEAD)}
    static let threadWho = ${table(thread.THREAD_WHO_LABELS)}
    static let threadWorking = ${text(thread.THREAD_WORKING)}
    static let threadCard = ${text(thread.THREAD_CARD.charAt(0).toUpperCase() + thread.THREAD_CARD.slice(1))}
    static let threadCardUpdated = ${text(thread.THREAD_CARD_UPDATED)}
    static let driverWords = ${table(browser.DRIVER_WORDS)}
    static let stopLineWords = ${table(browser.STOP_LINE_WORDS)}
    static let staleBrowser = ${JSON.stringify(browser.STALE_ATTACHMENT_LINE)}

    static func requiredActionsCount(_ count: Int) -> String { ${fill(required.requiredActionsCount(7), { 7: "count" })} }
    static func settingsCount(_ count: Int) -> String {
        count == 1 ? ${text(thread.settingsCountWords(1))} : ${fill(thread.settingsCountWords(7), { 7: "count" })}
    }
    static func messageCount(_ count: Int) -> String {
        count == 1 ? ${text(thread.messageCountWords(1))} : ${fill(thread.messageCountWords(7), { 7: "count" })}
    }
    static func newCount(_ count: Int) -> String { ${fill(thread.newCountWords(7), { 7: "count" })} }
    static func threadCount(_ count: Int) -> String { ${fill(thread.threadCountWords(7), { 7: "count" })} }
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
