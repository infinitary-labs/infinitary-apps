function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * What keeping a copy on another computer says (docs/devices.md, "Keeping
 * a copy on another computer"): the answers to the captain's clicks and the
 * copy's own lines at the top of each Ready to take over list, with whether
 * it reaches each other copy.
 */
export const STANDBY_WORDS = {
  notWork: (name: string) =>
    `${name} does not run work for your first mate, so it cannot keep a copy. Add it as a computer that runs work first.`,
  keeping: (name: string) =>
    `${name} keeps a copy of your first mate's record from now on. It takes one full copy, then each change.`,
  keepingSignIns: (signIns: readonly string[]) =>
    `It has no sign-in of its own for ${list(signIns)} yet: sign in there from its Ready to take over list.`,
  stopped: (name: string) =>
    `${name} keeps no copy from now on. Its copy is deleted there once it is in reach.`,
  notKept: (name: string) => `${name} keeps no copy of your first mate's record.`,
  copying: (name: string) => `${name} is still taking its full copy of your first mate's record.`,
  catchingUp: (name: string, behind: number) =>
    `${name}'s copy lacks ${behind === 1 ? "one change" : `${behind} changes`} and is catching up.`,
  away: (name: string) =>
    `${name} is out of reach, so its copy lacks what your first mate saved since. It catches up once it is back.`,
  needsUpdate: (name: string) =>
    `${name} runs an older Infinitary that cannot keep a copy. Update it there.`,
  inSync: (name: string) => `${name}'s copy is in sync with your first mate.`,
  noCopies: "This first mate cannot keep a copy on another computer.",
  // Whether this copy reaches each other copy (docs/devices.md, "Copies that reach each other").
  peerReaches: (name: string, other: string) => `${name} reaches the copy on ${other}.`,
  peerUnreached: (name: string, other: string, bothMacs: boolean) =>
    `${name} cannot reach the copy on ${other}.${bothMacs ? " macOS lets Infinitary on each of them use your local network only once someone there allows it." : ""}`,
  peerNoAddress: (name: string, other: string) =>
    `${name} has not heard where the copy on ${other} listens. It hears once ${other} is next in reach of your first mate.`,
  peerOlder: (other: string) =>
    `${other} runs an older Infinitary that other copies cannot reach. Update it there.`,
  peersOlder: (name: string) =>
    `${name} runs an older Infinitary that cannot reach the other copies. Update it there.`,
  secretsKept: (name: string) =>
    `${name} keeps your Secrets, sealed with its own lock. They work there if it takes over.`,
  secretsNone: (name: string) =>
    `${name} keeps none of your Secrets. Keep them there, then confirm once on ${name} itself.`,
  secretsAsking: (name: string) =>
    `Confirm on ${name} itself, as it asks you there, to keep your Secrets on it.`,
  secretsAway: (name: string) =>
    `${name} keeps none of your Secrets and is out of reach. Keep them there once it is back.`,
  secretsNeedsUpdate: (name: string) =>
    `${name} runs an older Infinitary that cannot keep your Secrets. Update it there.`,
  secretsCannot: (name: string) =>
    `${name} cannot keep your Secrets: it has no keychain or way to confirm you there.`,
  secretsRefused: (name: string) =>
    `${name} keeps none of your Secrets: it was not confirmed there.`,
  secretsUnopened:
    "Your Secrets are not open on this computer, so no computer that keeps a copy can take them now.",
  whichTitle: "Which Secrets should your first mate use here?",
  whichBody:
    "This computer kept Secrets of its own from before, and the copy your first mate started from holds the Secrets your earlier home kept. Both stay as they are until you choose. The set you do not choose is replaced on this computer and on the computers that keep a copy.",
  whichCopy: "Use the copy's Secrets",
  whichOwn: "Keep this computer's Secrets",
  signInsMissing: (name: string, signIns: readonly string[]) =>
    `${name} has no sign-in of its own for ${list(signIns)}. Sign in there from this window, so your first mate can work if it takes over.`,
  signInsThere: (name: string) =>
    `${name} has its own sign-in for every provider and host your first mate uses.`,
  signInsUnknown: (name: string) => `${name} has not said yet which sign-ins it has.`,
  // Two homes with one number (docs/devices.md, "Two homes with one number").
  noTwoHomes: "No other first mate answers with this one's number now.",
  keptHere: (other: string) =>
    `Your first mate stays here. The one on ${other} steps down and keeps a copy once it hears this one.`,
  keptOther: (other: string) =>
    `Your first mate continues on ${other}. This computer steps down and keeps a copy of it.`,
};

/**
 * What taking over says (docs/devices.md, "Taking over"): the work's answer
 * to the window's ask, which the window shows under the Take over button.
 */
export const TAKE_OVER_WORDS = {
  running: "Taking over from the copy here.",
  homeInReach: (name: string | null) =>
    `${name ?? "Your first mate's computer"} answers this computer again, so nothing is taken over.`,
  noCopy: "This computer keeps no whole copy of your first mate's record, so it cannot take over.",
  homeNeverTold:
    "Your first mate's computer never told this one what taking over needs. Update Infinitary there first.",
  notJoined: "This computer does not run work for your first mate, so it cannot take over.",
  started: (name: string) => `Your first mate runs here now, from the copy of ${name}'s record.`,
  startedNewer: (name: string, other: string) =>
    `Your first mate runs here now, from the copy of ${name}'s record, brought up to date from ${other}'s newer copy first.`,
  otherTookOver: (other: string) =>
    `${other} heard that another computer already took over, so nothing is taken over here.`,
  newerCannotGive: (other: string) =>
    `${other} keeps a newer copy, and its version cannot hand it over. Update Infinitary there, or take over there instead.`,
  newerMoved: (other: string) =>
    `${other}'s newer copy kept changing while it was brought in, so your first mate's computer may still be running. Nothing is taken over.`,
  failed: (why: string) => `This computer could not take over, and its copy is as it was. ${why}`,
  restarted:
    "Your first mate runs here now: taking over finished after this computer started again.",
  cutShort:
    "Taking over stopped when this computer started again, so it is undone and its copy is as it was. Take over again.",
};
