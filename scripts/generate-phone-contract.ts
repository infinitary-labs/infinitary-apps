import { readFileSync, writeFileSync } from "node:fs";
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
  act: "inf:cards:act", close: "inf:cards:close", seen: "inf:cards:seen",
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
  const { SCENE_OBSERVATIONS_SINCE } = await runner.import<typeof import("../src/shared/ipc.ts")>(join(REPO_ROOT, "src/shared/ipc.ts"));
  const text = `// Generated by scripts/generate-phone-contract.ts from docs/contract.json, src/shared/feed.ts, src/shared/nowPanel.ts, src/shared/pastCard.ts, src/shared/phoneLink.ts and src/shared/ipc.ts.\npublic enum PhoneContract {\n    public static let sceneObservations = "native-scene-observations"\n    public static let sceneObservationsSince = ${Number(SCENE_OBSERVATIONS_SINCE.split(".")[0])}\n    public static let version = ${JSON.stringify(contract.protocolVersion)}\n    public static let viewFloor = ${contract.versionRule.viewFloor}\n    public static let pairPath = ${JSON.stringify(contract.connection.pair.path)}\n    public static let connectionPath = ${JSON.stringify(contract.connection.path)}\n    public static let maxFrameBytes = ${contract.connection.maxFrameBytes}\n    public static let cards = ${JSON.stringify(reads.cards)}\n    public static let feed = ${JSON.stringify(reads.feed)}\n}\n\nenum FeedChange: String {\n${cases}\n}\n`;
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
  const path = join(REPO_ROOT, "ios/Infinitary/InfinitaryKit/Sources/InfinitaryKit/PhoneContract.generated.swift");
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== text + cardEnum + requestEnum + limits + groupEnum + pastWords + sshCommands) throw new Error("Run node scripts/generate-phone-contract.ts");
  } else writeFileSync(path, text + cardEnum + requestEnum + limits + groupEnum + pastWords + sshCommands);
} finally { await runner.close(); }
