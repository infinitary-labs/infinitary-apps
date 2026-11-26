import type { CardAction } from "./cards";
import { HERE } from "./deviceNames";
import { type ComputerReach, type FoundTools, namesInWords } from "./devices";
import { forgePlace, kindByName } from "./forge";
import { changeRequestKind } from "./forgeKinds";
import { catalogEntry } from "./providers";
import type { RepoHost } from "./repos";
import type { ComputerSignIns, PlaceWords } from "./signIns";
import { signInsUnansweredInEnglish } from "./workSetupWords";

/**
 * Finishing a computer's setup (docs/devices.md, "Finishing its setup";
 * design skill `components/devices/FinishSetup`): the one host card the
 * home files when a computer that runs work joins, built from typed facts
 * alone - what the join found there, the sign-ins that computer last
 * reported, and the projects whose Runs on names it - one row per thing it
 * still needs, each with the button that opens the matching Settings step.
 * The host revises it as the facts change and takes it down by itself once
 * every row is done, or on Not now. Nothing here judges words.
 *
 * The same words serve the backstop for a computer that was set up later,
 * or signed out again: the feed line for a task that waits for a sign-in
 * there, and the GitHub card a project raises when it runs on a computer
 * with no GitHub sign-in (design skill `components/devices/SignInOnAMac`,
 * "GitHub on another device").
 */

/** Text as HTML text: the computer's own name and a project's name are the person's words. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export const GITHUB_HOST = "github.com";

/**
 * The host a project needs that computer's own sign-in for, when that
 * computer offers one from here (docs/forge.md, "A computer's own
 * sign-in"): a host it lists, such as github.com, or one of a kind of
 * server it signs in to by an address, such as GitLab or GitHub Enterprise.
 * Undefined for a project kept only here, on a plain Git host, or on a host
 * a computer too old to offer it would be tried for instead.
 */
export function computerForgeHost(
  forges: ComputerSignIns["forges"],
  host: RepoHost | undefined,
): string | undefined {
  if (!forges || !host?.name || !changeRequestKind(host.kind)) return undefined;
  const name = host.name;
  if (forges.hosts.some((entry) => entry.host === name)) return name;
  // github.com signs in with its own code; only another host is offered by its kind.
  if (name === GITHUB_HOST) return undefined;
  return forges.servers?.some((server) => server.kind === host.kind) ? name : undefined;
}

/** The person's word for a host a computer signs in to ("GitHub", "GitLab", "github.example.com"). */
export function computerForgeName(host: string): string {
  return forgePlace({ kind: kindByName(host) ?? "github", host }) ?? host;
}

/** The setup card: one per computer, raised again under the same id as its facts change. */
export function deviceSetupCardId(deviceId: string): string {
  return `card-device-setup-${deviceId}`;
}

/** The GitHub card for a computer that runs a project living there with no sign-in of its own. */
export function deviceForgeSignInCardId(host: string, deviceId: string): string {
  return `card-forge-${host}-${deviceId}`;
}

/**
 * The gate a task waits behind for its computer's own GitHub sign-in, as
 * the task record names it; lifted when that computer reports the sign-in.
 */
export function deviceForgeGateRef(host: string, deviceId: string): string {
  return `forge-sign-in:${host}@${deviceId}`;
}

export type DeviceSetupFacts = {
  deviceId: string;
  reach: ComputerReach;
  waitReason: string | null;
  signInsUnanswered?: boolean;
  /** How the home's words place the computer ("Mac mini", "Running as Builder"). */
  place: PlaceWords;
  /** What the join found there; absent for a computer whose join said nothing. */
  found?: FoundTools | undefined;
  /** What the computer last said of its own sign-ins; null before it said anything. */
  signIns: ComputerSignIns | null;
  /** The projects whose Runs on names it. */
  runs: readonly string[];
};

export type DeviceSetupRowId = "subscription" | "github" | "project";

export type DeviceSetupRow = {
  id: DeviceSetupRowId;
  need: string;
  done: boolean;
  /** Its state in words: what it has, or what the step is. */
  state: string;
};

/** The action ids the card's buttons declare; the host reads them only as resolutions. */
export const DEVICE_SETUP_ACTIONS = {
  subscription: "add-subscription",
  github: "sign-in-github",
  project: "choose-project",
  notNow: "not-now",
} as const;

function subscriptionNames(signIns: ComputerSignIns): string[] {
  return [
    ...new Set(
      signIns.accounts.map((account) => catalogEntry(account.providerId)?.name ?? account.label),
    ),
  ];
}

/**
 * The card's rows, from the facts alone. A subscription row is done once
 * the computer reports any account there (the captain's pick: an allowance
 * that cannot be read there still counts). The GitHub row is done once it
 * reports a sign-in for GitHub, whatever its health. The project row is
 * last and optional in its words: a computer with no project runs nothing.
 */
export function deviceSetupRows(facts: DeviceSetupFacts): DeviceSetupRow[] {
  const signIns = facts.signIns;
  const subscriptions = signIns ? subscriptionNames(signIns) : [];
  const github = signIns?.forges?.signIns.find((entry) => entry.host === GITHUB_HOST);
  const { who } = facts.place;
  return [
    {
      id: "subscription",
      need: "A subscription of its own",
      done: subscriptions.length > 0,
      state:
        subscriptions.length > 0
          ? `signed in to ${namesInWords(subscriptions)}`
          : signIns?.providers.length || signIns?.custom?.length
            ? `Sign in under ${facts.place.label} in Settings → Intelligence.`
            : `Add a sign-in on ${who}.`,
    },
    {
      id: "github",
      need: "Its own GitHub sign-in, to clone and push",
      done: github !== undefined,
      state:
        github !== undefined
          ? `signed in${github.login ? ` as ${github.login}` : ""}`
          : signIns?.forges?.hosts.some((host) => host.host === GITHUB_HOST)
            ? `Needed for a project that lives on GitHub. Sign in under ${facts.place.label} in Settings → Integrations.`
            : `Needed for a project that lives on GitHub. ${who} does not offer GitHub sign-in here.`,
    },
    {
      id: "project",
      need: "A project that runs there",
      done: facts.runs.length > 0,
      state:
        facts.runs.length > 0
          ? `runs ${namesInWords(facts.runs)}`
          : `Optional: ${who} runs nothing until a project's Runs on names it, and that is fine.`,
    },
  ];
}

/** The card's title: "Finish setting up Mac mini", "Finish setting up Running as Builder". */
export function deviceSetupTitle(place: PlaceWords): string {
  return `Finish setting up ${place.label}`;
}

/** What the join found, as the card's first sentence. */
function foundSentence(facts: DeviceSetupFacts): string {
  const { place, found } = facts;
  const joined = place.who === place.label ? `${place.who} joined` : `${place.label} is set up`;
  if (!found) return `${joined}.`;
  if (found.git && found.claudeCode) return `${joined} with git and Claude Code.`;
  if (found.git) return `${joined} with git, and no Claude Code yet.`;
  if (found.claudeCode) return `${joined} with Claude Code, and no git yet.`;
  return `${joined} with no git or Claude Code yet.`;
}

/**
 * The card's body shows what the join found and why setup waits, or one
 * row per need once work connects and reports. Each row carries its id and
 * whether it is done, so a reader takes the fact, never the words.
 */
export function deviceSetupBody(facts: DeviceSetupFacts): string {
  if (facts.reach !== "in-reach") {
    const reason =
      facts.waitReason ??
      (facts.reach === "connecting"
        ? "Its work is connecting to this computer."
        : "It is not connected for work yet.");
    return `<p>${escapeHtml(foundSentence(facts))}</p><p data-setup-wait="work">${escapeHtml(reason)}</p><p class="inf-muted">You can set up its sign-ins here once its work connects.</p>`;
  }
  if (!facts.signIns) {
    const reason = facts.signInsUnanswered
      ? signInsUnansweredInEnglish(facts.place.who, HERE.this)
      : "Its work is connected. It has not reported its sign-ins yet.";
    return `<p>${escapeHtml(foundSentence(facts))}</p><p data-setup-wait="sign-ins">${escapeHtml(reason)}</p>`;
  }
  const rows = deviceSetupRows(facts);
  const items = rows
    .map(
      (row) =>
        `<li data-setup-row="${row.id}" data-done="${row.done}"><strong>${escapeHtml(row.need)}</strong> · ${row.done ? `<mark>${escapeHtml(row.state)}</mark>` : escapeHtml(row.state)}</li>`,
    )
    .join("");
  return `<p>${escapeHtml(foundSentence(facts))} It runs work once it has:</p><ul>${items}</ul><p class="inf-muted">Nothing from ${HERE.this}'s sign-ins goes there.</p>`;
}

/**
 * The card's buttons: one for each open row with a usable Settings step,
 * once work is in reach and has reported, plus Not now. The first setup button is the default. Every button
 * resolves the card; the host raises it again once a fact changes.
 */
export function deviceSetupActions(facts: DeviceSetupFacts): CardAction[] {
  const notNow: CardAction = {
    id: DEVICE_SETUP_ACTIONS.notNow,
    label: "Not now",
    variant: "ghost",
  };
  if (facts.reach !== "in-reach" || !facts.signIns) return [notNow];
  const actions: CardAction[] = [];
  for (const row of deviceSetupRows(facts)) {
    if (row.done) continue;
    switch (row.id) {
      case "subscription":
        if (facts.signIns.providers.length === 0 && !facts.signIns.custom?.length) break;
        actions.push({
          id: DEVICE_SETUP_ACTIONS.subscription,
          label: "Add a subscription",
          effect: { kind: "open", target: "subscriptions" },
        });
        break;
      case "github":
        if (!facts.signIns.forges?.hosts.some((host) => host.host === GITHUB_HOST)) break;
        actions.push({
          id: DEVICE_SETUP_ACTIONS.github,
          label: `Sign in to GitHub ${facts.place.where}`,
          effect: {
            kind: "open",
            target: "projects",
            forgeSignInOn: { deviceId: facts.deviceId, host: GITHUB_HOST },
          },
        });
        break;
      case "project":
        actions.push({
          id: DEVICE_SETUP_ACTIONS.project,
          label: "Choose a project",
          effect: { kind: "open", target: "projects" },
        });
        break;
    }
  }
  const [first] = actions;
  if (first) first.default = true;
  actions.push(notNow);
  return actions;
}

/** Whether every row is done, so the card comes down by itself. */
export function deviceSetupDone(facts: DeviceSetupFacts): boolean {
  return deviceSetupRows(facts).every((row) => row.done);
}

/** The feed's one line when the card comes down done. */
export function deviceSetupDoneLine(facts: Pick<DeviceSetupFacts, "place" | "runs">): string {
  return `${facts.place.label} is set up. It runs ${namesInWords([...facts.runs])} with its own sign-ins.`;
}

/**
 * The feed's line when a task waits for its computer to have a sign-in at
 * all (design skill `components/devices/RunsOn`); `subject` is who waits,
 * "website's next task" or the task by its title.
 */
export function noSignInsWaitLine(label: string, subject: string): string {
  return `${label} has no sign-ins yet. ${subject} waits until it has one.`;
}

/** Start now's refusal for the same wait. */
export function noSignInsStartRefusal(handle: string, who: string): string {
  return `${handle} waits for ${who}, which has no sign-ins yet. Sign it in to one in Settings → Intelligence.`;
}

/**
 * The feed's line when a task with no project waits for a computer that
 * runs an older Firstmate (docs/helper.md, "Runs on"); `subject` is who waits.
 */
export function updateWaitLine(label: string, subject: string): string {
  return `${label} needs an update to run ${subject}. Update it in Settings → Devices.`;
}

/** Start now's refusal for the same wait. */
export function updateStartRefusal(handle: string, who: string): string {
  return `${handle} waits for ${who} to be updated. Update it in Settings → Devices.`;
}

/** The feed's line when a task waits for its computer's own GitHub sign-in; `subject` is who waits. */
export function deviceForgeWaitLine(subject: string, who: string, name = "GitHub"): string {
  return `${subject} waits for ${who}'s own ${name} sign-in.`;
}

/** The gate's reason, which Start now's refusal reads back. */
export function deviceForgeGateReason(who: string, name = "GitHub"): string {
  return `waiting for ${who}'s own ${name} sign-in`;
}

/** The GitHub card's title: "Sign in to GitHub on Mac mini", "... as Builder". */
export function deviceForgeSignInTitle(where: string, name = "GitHub"): string {
  return `Sign in to ${name} ${where}`;
}

/**
 * The GitHub card's body (design skill `components/devices/SignInOnAMac`,
 * "GitHub on another device"): the project that runs there, what the
 * computer needs, and that nothing of this Mac's sign-in goes there.
 */
export function deviceForgeSignInBody(project: string, place: PlaceWords, name = "GitHub"): string {
  return `<p>${escapeHtml(project)} runs ${escapeHtml(place.where)} now. ${escapeHtml(place.who)} needs its own ${escapeHtml(name)} sign-in to clone it and push.</p><p>Its next task waits for it. ${HERE.This}'s ${escapeHtml(name)} sign-in is not sent there.</p>`;
}
