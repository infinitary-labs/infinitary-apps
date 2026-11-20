import { HOME_UPDATE, HOME_UPDATE_INSTALL, HOME_UPDATE_LATER } from "./homeUpdate";
import { PROTOCOL_MAJORS_BEHIND, PROTOCOL_VERSION, VIEW_FLOOR } from "./ipc";
import { RESOURCE_OBSERVATIONS_SINCE } from "./resources";

/**
 * The version rule as a home applies it, and the features a computer or a
 * home speaks from a contract version on (docs/contract.md, "The version
 * rule"). The version itself and the floor stay in ./ipc.ts beside the
 * channels they number.
 */

/** What a client may ask of a home under the version rule: everything, or the reads alone. */
export type ContractAccess = "full" | "read";

/**
 * The version rule, as the home applies it to a client's hello. Only the
 * majors count: a minor is additive, so a client on an older or newer minor
 * of an answered major keeps everything it knows. A version that does not
 * read as `major.minor.patch` is answered its reads only.
 *
 * A computer that runs work changes things only on the home's own major.
 * A view (`view` set) changes things from the home's floor up to the home's
 * major, and on an older home when the floor its hello said reaches that
 * home's major; a view that said no floor is answered as before it had one.
 * The home sets `view` only for a view that reads the open lists: one whose
 * hello says its floor, or a phone, which reads closed lists as text. A
 * computer viewing from before the floor reads them strictly, so it is
 * answered as work is (INF-1649 review R4).
 */
export function contractAccess(
  clientVersion: string,
  homeVersion: string = PROTOCOL_VERSION,
  view?: { clientFloor?: number; homeFloor?: number },
): ContractAccess {
  const client = majorOf(clientVersion);
  const home = majorOf(homeVersion);
  const behind = home - client;
  if (behind >= 0 && behind <= PROTOCOL_MAJORS_BEHIND) return "full";
  if (!view) return "read";
  if (behind > 0) return client >= (view.homeFloor ?? VIEW_FLOOR) ? "full" : "read";
  return behind < 0 && view.clientFloor !== undefined && view.clientFloor <= home ? "full" : "read";
}

/**
 * What a paired view may still ask of a home while the version rule lets it
 * only read (major 16, once named `messages-while-reading`), each by a shape
 * no major changes: a plain-text message to the first mate, `inf:converse`
 * with one string, so the captain keeps talking to the first mate across a
 * version split. A message with pictures, files or hints is an object, and
 * stays refused.
 */
export const READ_ONLY_ASKS: Readonly<Record<string, (args: readonly unknown[]) => boolean>> = {
  "inf:converse": (args) =>
    args.length === 1 && typeof args[0] === "string" && args[0].trim().length > 0,
  // The home's own update, started and let go from any paired view
  // (`home-update.md`): the one way out of a split from afar.
  [HOME_UPDATE_INSTALL]: (args) => args.length === 0,
  [HOME_UPDATE_LATER]: (args) => args.length === 0,
};

/**
 * The first major whose every home answers the update requests whether its
 * welcome lists `home-update` or not: the major that folds the name in.
 * A major removes every name (`src/shared/contract-changes/README.md`), so a
 * view reads an older home by the name and a home from here on by its number,
 * typed once and never moved, as a feature asked across majors is.
 */
export const HOME_UPDATE_FOLDED = 17;

/**
 * Whether a home answers the update requests (`src/shared/homeUpdate.ts`):
 * its welcome lists `home-update`, or it speaks the major that folded the
 * name in or a later one.
 */
export function homeAnswersUpdate(
  homeVersion: string | null | undefined,
  homeChanges: readonly string[] | null | undefined,
): boolean {
  if (homeChanges?.includes(HOME_UPDATE)) return true;
  if (!homeVersion) return false;
  return majorOf(homeVersion) >= HOME_UPDATE_FOLDED;
}

/** Whether a paired view reading only may ask this request with these arguments (`READ_ONLY_ASKS`). */
export function asksWhileReading(channel: string, args: unknown): boolean {
  return (
    Array.isArray(args) &&
    Object.hasOwn(READ_ONLY_ASKS, channel) &&
    READ_ONLY_ASKS[channel]?.(args) === true
  );
}

/**
 * Whether a view reading only may send a home its plain-text messages: the
 * home speaks major 16 or later, which folded `messages-while-reading` in
 * (`FOLDED_INTO_16_SINCE`), or an older home lists that name, or the home
 * speaks a newer major than the view. A view on a later major than its home
 * reads an older home by that number or that name.
 */
export function homeHearsWhileReading(
  homeVersion: string | undefined,
  homeChanges: readonly string[] | null | undefined,
  viewVersion: string = PROTOCOL_VERSION,
): boolean {
  if (homeChanges?.includes(MESSAGES_WHILE_READING)) return true;
  if (homeVersion === undefined) return false;
  return (
    speaksSince(homeVersion, FOLDED_INTO_16_SINCE) || majorOf(homeVersion) > majorOf(viewVersion)
  );
}

/**
 * The name a home before major 16 lists when it lets a view's plain-text
 * messages through while the view reads only; major 16 folded it in.
 */
export const MESSAGES_WHILE_READING = "messages-while-reading";

/**
 * The first contract that has every addition named before it without
 * listing its name: major 16 folded those names in and kept views, so a
 * view on it may still meet a home on major 15, and a home on it a view on
 * major 15, which lists by name what it has.
 */
export const FOLDED_INTO_16_SINCE = "16.0.0";

/**
 * The additions major 16 folded in that a home still checks of a view, or a
 * view of its home, by their historical names.
 */
export type FoldedInto16 =
  | "browser-from-any-view"
  | "card-annotations"
  | "card-files"
  | "computer-readings-live"
  | "custom-token-command"
  | "devices-from-a-view"
  | "every-view-asks"
  | "font-choice"
  | "from-the-command"
  | "keep-going-on-credits"
  | "language-choice"
  | "panels-in-every-window"
  | "sign-in-return"
  | "streamed-events-live";

/**
 * Whether the other side has an addition major 16 folded in: it speaks
 * major 16 or later (`FOLDED_INTO_16_SINCE`), or it is older and lists the
 * addition's historical name. A side whose version is unknown has only what
 * it lists.
 */
export function hasSince16(
  version: string | null | undefined,
  changes: readonly string[] | null | undefined,
  name: FoldedInto16,
): boolean {
  return (
    (typeof version === "string" && speaksSince(version, FOLDED_INTO_16_SINCE)) ||
    (changes?.includes(name) ?? false)
  );
}

/**
 * Which side a view outside the window updates to change things again:
 * `this` when the home is newer, `home` when the home is older. Null while
 * the view may change things, or when either version does not read.
 */
export function sideToUpdate(
  access: ContractAccess,
  viewVersion: string,
  homeVersion: string,
): "this" | "home" | null {
  if (access !== "read") return null;
  const view = majorOf(viewVersion);
  const home = majorOf(homeVersion);
  if (Number.isNaN(view) || Number.isNaN(home)) return null;
  return home < view ? "home" : "this";
}

/**
 * The first contract a computer that runs work can hold a crewmate's
 * conversation on, in a working copy of its own (src/shared/work.ts): it
 * answers the home's orders, the working copy's among them, and asks the
 * work requests. One that speaks an older one joins and stays in reach,
 * and takes no work.
 */
export const PLACED_WORK_SINCE = "1.64.0";

/**
 * The first contract a computer that runs work signs in to its own
 * subscriptions on (src/shared/signIns.ts): it answers the home's sign-in
 * orders and asks the sign-in work requests. One that speaks an older one
 * runs work with what it is already signed in to.
 */
export const SIGN_INS_SINCE = "1.62.0";

/**
 * The first contract a computer that runs work signs in where projects live
 * on (`inf:sign-ins:forge`, src/shared/signIns.ts), for its own clones and
 * pushes, and signs in to Claude with a code pasted back from its home. One
 * that speaks an older one says no forges with its sign-ins, so the home
 * offers it no such sign-in.
 */
export const FORGE_SIGN_INS_SINCE = "1.63.0";

/**
 * The first contract a computer that runs work adds a custom API connection
 * on (`inf:sign-ins:custom-*`, src/shared/signIns.ts), and says which models
 * its own sign-ins serve. One that speaks an older one has no such chip.
 */
export const CUSTOM_API_SIGN_INS_SINCE = "2.6.0";

/**
 * The first contract a computer that runs work takes a task with no project
 * (`inf:working-copy:seed`, src/shared/work.ts): the home sends its default
 * workspace first, and the working copy there starts from it. One that
 * speaks an older one takes such a task only once it is updated.
 */
export const PLACED_SEED_SINCE = "3.1.0";

/**
 * The first contract a computer that runs work keeps its tasks' own
 * browsers on (`browserOrders`, src/shared/workBrowsers.ts; docs/task-browser.md,
 * "On another computer"): its roster says so, its crewmates are given
 * `infinitary-browser-axi`, and it answers the captain's side of each browser. One
 * that speaks an older one gives its tasks no browser.
 */
export const TASK_BROWSERS_THERE_SINCE = "4.1.0";

/**
 * The first contract a computer that runs work gives its crewmates the
 * home's knowledge on (`inf:work:knowledge`, `inf:work:record-knowledge`,
 * src/shared/work.ts; docs/knowledge.md, "Who has it"): the home names the
 * pair among a task's tools and writes its knowledge lines into the brief.
 * One that speaks an older one gives its tasks no knowledge.
 */
export const KNOWLEDGE_THERE_SINCE = "5.5.0";

/** Work computers stage saved change stories and pass their revision on completion cards. */
export const CHANGE_PRESENTATIONS_SINCE = "8.13.0";
export function speaksChangePresentations(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, CHANGE_PRESENTATIONS_SINCE);
}

/**
 * The first contract a computer that runs work is updated on over the
 * connection (docs/devices.md, "Updating over the connection"): its hello
 * says the version of Firstmate it runs, it takes the update order
 * (`fm:firstmate:update`, src/shared/work.ts) whatever its major, and it
 * gets Firstmate from its home with its own key. One that speaks an older
 * one is updated by a new command run there instead.
 */
export const WORK_UPDATE_SINCE = "1.76.0";

/**
 * Whether a computer that runs work takes the update order: on any major,
 * from `WORK_UPDATE_SINCE` on, because that order and the way the computer
 * gets Firstmate from its home never change across majors. A version that
 * does not read as `major.minor.patch` takes none.
 */
export function takesUpdate(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, WORK_UPDATE_SINCE);
}

/**
 * The first contract a computer that runs work downloads its own update on
 * (docs/devices.md, "Downloading over the connection"): it takes the
 * download order (`fm:firstmate:update-download`, src/shared/work.ts)
 * whatever its major, gets the home's published version itself and checks
 * it, and answers how far it got (`fm:firstmate:update-progress`). One that
 * speaks an older one is updated with the update order alone.
 */
export const WORK_DOWNLOAD_SINCE = "8.15.0";

/**
 * Whether a computer that runs work takes the download order: on any major,
 * from `WORK_DOWNLOAD_SINCE` on, because that order's name and shape never
 * change across majors either.
 */
export function takesDownload(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, WORK_DOWNLOAD_SINCE);
}

/**
 * The first contract whose home reads the asking computer's `system` and
 * `chip` where it gets Firstmate (`fetchAppRequestSchema`, src/shared/connection.ts):
 * it answers the Firstmate published for them. An older home refuses them as
 * `malformed`, so a computer names them only to a home on this contract or later.
 */
export const FETCH_APP_SYSTEM_SINCE = "5.1.0";

/** Whether a home reads the asking computer's system where it gets Firstmate (`FETCH_APP_SYSTEM_SINCE`). */
export function readsFetchAppSystem(homeVersion: string): boolean {
  return speaksSince(homeVersion, FETCH_APP_SYSTEM_SINCE);
}

/**
 * The first contract whose home answers the native scene's reads,
 * `inf:conversation:state` and `inf:computers:presence`, without naming
 * `native-scene-observations`: major 12 folded that name in. A phone asks an
 * older home for them only when its welcome names the change (docs/ios.md).
 */
export const SCENE_OBSERVATIONS_SINCE = "12.0.0";

/**
 * The first contract whose home answers `inf:cards:seen-update` without
 * naming `card-current-update-seen`: major 13 folded that name in. A view
 * reports the exact update it drew to such a home, or to an older home whose
 * changes name it, and the offer sighting to any other.
 */
export const CARD_SEEN_UPDATE_SINCE = "13.0.0";

/**
 * The first contract whose home takes the phone's usage events,
 * `inf:settings:sharing:phone`, without naming `phone-diagnostics`: major 14
 * folded that name in. A phone hands them to such a home, or to an older home
 * whose welcome names the change (docs/sharing.md).
 */
export const PHONE_DIAGNOSTICS_SINCE = "14.0.0";

/**
 * The first contract whose views read a thread line's contributor fields
 * without naming `shared-cards`: major 14 folded that name in. An older
 * view that names it reads them too; any other reads the lines without who
 * wrote them.
 */
export const SHARED_CARDS_SINCE = "14.0.0";

/** Whether a view reads a thread line's contributor fields (`SHARED_CARDS_SINCE`, or its older name). */
export function readsSharedCards(
  version: string | undefined,
  changes: readonly string[] | undefined,
): boolean {
  return (
    (version !== undefined && speaksSince(version, SHARED_CARDS_SINCE)) ||
    (changes?.includes("shared-cards") ?? false)
  );
}

/** Major 15 includes ended-card decoding without the older `ended-cards` name. */
export const ENDED_CARDS_SINCE = "15.0.0";

/** Whether a view reads an ended card's app line, by major or its older named addition. */
export function readsEndedCards(
  version: string | undefined,
  changes: readonly string[] | undefined,
): boolean {
  return (
    (version !== undefined && speaksSince(version, ENDED_CARDS_SINCE)) ||
    (changes?.includes("ended-cards") ?? false)
  );
}

/** Whether a home answers current-update sightings (`CARD_SEEN_UPDATE_SINCE`, or its older name). */
export function readsSeenUpdate(
  homeVersion: string | undefined,
  homeChanges: readonly string[] | undefined,
): boolean {
  return (
    (homeVersion !== undefined && speaksSince(homeVersion, CARD_SEEN_UPDATE_SINCE)) ||
    (homeChanges?.includes("card-current-update-seen") ?? false)
  );
}

/** Whether a computer takes a task with no project (`PLACED_SEED_SINCE`). */
export function speaksSeed(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, PLACED_SEED_SINCE);
}

/** Whether a computer gives its crewmates the home's knowledge (`KNOWLEDGE_THERE_SINCE`). */
export function speaksKnowledge(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, KNOWLEDGE_THERE_SINCE);
}

/** Whether a computer speaks the custom API sign-in orders. */
export function speaksCustomApi(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, CUSTOM_API_SIGN_INS_SINCE);
}

/** Whether a work computer answers bounded, read-only resource observations. */
export function speaksResources(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, RESOURCE_OBSERVATIONS_SINCE);
}

/**
 * The first contract a computer that runs work knows the code names of the
 * Infinitary rename on (step 8 of FI3-1780's plan): a task's starting work
 * fetched into `refs/infinitary/sources/`, from a kept ref under
 * `refs/infinitary/kept/` (`inf:working-copy:source-ref`, src/shared/work.ts).
 * One that speaks an older one knows only Firstmate 3000's names (`refs/fm3000/`),
 * so the home names those to it. The browser command is not
 * swapped: `fm-browser-axi`, Firstmate 3000's command, stays an alias of
 * `infinitary-browser-axi` (src/core/axi/names.ts).
 */
export const INFINITARY_NAMES_SINCE = "8.4.0";

/** A copy order may refresh the executing computer's client-owned session tail first. */
const SESSION_RECORD_REFRESH_SINCE = "8.15.0";

export function speaksRecordRefresh(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, SESSION_RECORD_REFRESH_SINCE);
}

/** Whether a computer knows the Infinitary rename's code names (`INFINITARY_NAMES_SINCE`). */
export function speaksInfinitaryNames(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, INFINITARY_NAMES_SINCE);
}

/**
 * The first contract whose home keeps a preview's project fonts
 * (`inf:work:typeface`, src/shared/work.ts; docs/card-authoring.md "Fonts by
 * reference") and serves them to its views (`inf:cards:typeface`). A computer
 * that runs work sends a card naming one only to a home on this contract or
 * later, and refuses it in words to an older one.
 */
export const CARD_TYPEFACES_SINCE = "8.9.0";

/** Whether a home keeps a preview's project fonts (`CARD_TYPEFACES_SINCE`). */
export function keepsCardTypefaces(homeVersion: string): boolean {
  return speaksSince(homeVersion, CARD_TYPEFACES_SINCE);
}

/**
 * The first contract whose home changes the words around a published story
 * (`open_change`'s optional `around`, docs/forge.md "Saved change stories").
 * An older home drops the field and would answer as if nothing was asked, so
 * a computer that runs work refuses it in words to that home instead.
 */
export const STORY_AROUND_SINCE = "10.1.0";

/** Whether a home changes the words around a published story (`STORY_AROUND_SINCE`). */
export function changesStoryAround(homeVersion: string): boolean {
  return speaksSince(homeVersion, STORY_AROUND_SINCE);
}

/**
 * The first contract whose home hears a background job's end as `client`
 * (`inf:work:job-exit`, src/shared/work.ts): a Claude client that ended
 * while the computer running it ran on took the task with it. A computer
 * says so only to a home it does not know is older, which reads the
 * request strictly; to that one it says the end without why.
 */
export const CLIENT_JOB_ENDS_SINCE = "9.2.0";

/** Whether a home hears a job's end as its Claude client's (`CLIENT_JOB_ENDS_SINCE`). */
export function hearsClientJobEnds(homeVersion: string): boolean {
  return speaksSince(homeVersion, CLIENT_JOB_ENDS_SINCE);
}

/**
 * The first contract whose work computer removes a closed task's temporary
 * folder on `inf:session:clean-temp`. An older computer is not reported as
 * cleaned; the home retries after it is updated.
 */
const TEMP_CLEANUP_SINCE = "7.1.0";

/** Whether a work computer removes a closed task's temporary folder. */
export function speaksTempCleanup(deviceVersion: string): boolean {
  return speaksSince(deviceVersion, TEMP_CLEANUP_SINCE);
}

export function speaksSince(deviceVersion: string, sinceVersion: string): boolean {
  const device = versionOf(deviceVersion);
  const since = versionOf(sinceVersion);
  if (!device || !since) return false;
  return (
    device.major > since.major || (device.major === since.major && device.minor >= since.minor)
  );
}

/**
 * Whether a computer that runs work may take new work from its home
 * (docs/helper.md): only on the home's own major, and only when it speaks
 * `PLACED_WORK_SINCE` or later, so it can hold the work it is sent. The home
 * sends it the work itself, so the version rule's wider window for a client
 * does not apply; a computer on another major takes no new work until it is
 * replaced with the home's version. A version that does not read as
 * `major.minor.patch` takes none.
 */
export function takesWork(deviceVersion: string, homeVersion: string = PROTOCOL_VERSION): boolean {
  return (
    majorOf(deviceVersion) === majorOf(homeVersion) && speaksSince(deviceVersion, PLACED_WORK_SINCE)
  );
}

function majorOf(version: string): number {
  return versionOf(version)?.major ?? Number.NaN;
}

function versionOf(version: string): { major: number; minor: number } | undefined {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : undefined;
}
