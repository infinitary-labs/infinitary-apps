import type { MachineLoginOutcome } from "@shared/accounts";
import { anotherUserHere, COMPUTER, HERE } from "@shared/deviceNames";
import { type LeftReason, PAIRING_LINK_TTL_MS, userDisplayName } from "@shared/devices";

/**
 * What a person reads in Terminal when this Mac, or another user on it,
 * joins and runs work for Firstmate (docs/helper.md). Written for someone
 * who has never opened a terminal, in the words of the design skill's
 * `components/devices/AddAMac` and `copy/Vocabulary.prompt.md`: the Mac
 * where Firstmate lives is named, never a host, and none of this is called
 * a helper.
 */

/** Where the home is, as the person knows it before it says its own name. */
export type HomePlace = {
  /** The home dialed from this Mac itself: running as another user here. */
  readonly thisMac: boolean;
  /** The address its link names, without the port. */
  readonly host: string;
  /**
   * The home reaches this computer through its own SSH connection
   * (docs/helper.md, "Through the home's SSH"): its link names the far end
   * of that connection, loopback, which says nothing to a person, so the
   * words name the Mac that set this one up instead.
   */
  readonly overSsh?: boolean;
};

/** A home that reaches this computer over its own SSH connection, before it said its name. */
const OVER_SSH = `the ${COMPUTER.one} that set this one up over SSH`;

/** The Mac where Firstmate lives, named from here. */
function there(place: HomePlace): string {
  if (place.thisMac) return HERE.this;
  return place.overSsh ? OVER_SSH : `the ${COMPUTER.one} at ${place.host}`;
}

const NOTHING_CHANGED = `Nothing changed on ${HERE.this}.`;
/** The same, where the words before already said where. */
const NOTHING_CHANGED_HERE = "Nothing changed.";

/** A Mac that runs its home's work may also control it, from Firstmate opened there. */
const OPEN_HERE = `Open Infinitary here any time to control it from ${HERE.this}, with no new link.`;

/**
 * Whether the work runs in the background now that it joined
 * (`./background.ts`): `running` now, `at-login` from the user's next login,
 * `failed` when it could not be set up, and `none` when nothing set it up.
 */
export type InBackground = "running" | "at-login" | "failed" | "none";

export const helperWords = {
  usage: [
    `Joins ${HERE.this}, or this user on it, to Infinitary on another ${COMPUTER.one} and runs its work.`,
    "",
    "  join <link>   join with the link in a command from Infinitary (asks you first)",
    "  run           stay in reach of Infinitary and take its work",
    "  status        say what this user has joined",
    "  version       say the version of Infinitary here",
  ],

  notALink: ["This is not a link to join Infinitary.", NOTHING_CHANGED],

  viewLink: [
    `This link is for the app on another ${COMPUTER.one}. Paste it into Infinitary there.`,
    NOTHING_CHANGED,
  ],

  alreadyJoined: (home: string) => [`This user already runs work for ${home}.`, NOTHING_CHANGED],

  busy: ["Infinitary is already running work as this user.", NOTHING_CHANGED_HERE],

  /** Linux with no screen and no Xvfb: the work mode has nowhere to draw its hidden windows. */
  needsDisplay: [
    `Infinitary needs Xvfb to run work on a ${COMPUTER.one} with no screen.`,
    "Install Xvfb with your system's software, then run this again.",
  ],

  unreachable: (place: HomePlace) =>
    place.thisMac
      ? [`Could not reach Infinitary on ${HERE.this}.`, "Open Infinitary, then run this again."]
      : place.overSsh
        ? [`Could not reach ${OVER_SSH}.`, NOTHING_CHANGED]
        : [
            `Could not reach the ${COMPUTER.one} at ${place.host}.`,
            `Both ${COMPUTER.many} need the same network, or the same private network.`,
          ],

  notThatMac: (place: HomePlace) => [
    place.overSsh
      ? `Something answered through the SSH connection, but not the ${COMPUTER.one} that made this link.`
      : `Something answered at ${place.host}, but not the ${COMPUTER.one} that made this link.`,
    "Nothing was sent to it.",
  ],

  /**
   * The question asked before anything is sent with the link. `platform` is
   * this computer's system, which says what another user here may read; a
   * Mac's unless the composer names another.
   */
  ask: (place: HomePlace, user: string, platform = "darwin") =>
    place.thisMac
      ? [
          `Infinitary on ${HERE.this} asks the user ${user} to run its work.`,
          `${userDisplayName(user)} only runs work and cannot control your first mate.`,
          anotherUserHere(platform).reads,
        ]
      : macAsk(there(place), user),

  prompt: "Type yes to agree: ",

  declined: [NOTHING_CHANGED],

  used: (place: HomePlace) => commandUsed(there(place)),

  expired: (place: HomePlace) => commandExpired(there(place)),

  closedLink: (place: HomePlace) => commandClosed(there(place)),

  /** The copy of Firstmate a command fetched could not be kept here. */
  notKept: [`Could not keep Infinitary on ${HERE.this}.`, NOTHING_CHANGED],

  sameUser: [
    `This is the user Infinitary already runs as. Log in as another user on ${HERE.this}, and run it there.`,
    NOTHING_CHANGED_HERE,
  ],

  refused: (place: HomePlace) => [
    `Infinitary on ${there(place)} did not let ${HERE.this} join.`,
    NOTHING_CHANGED,
  ],

  /**
   * Joined. A Mac that may also control its home (a grant of kind `mac`)
   * says it can, from Firstmate opened there (docs/view.md, "A Mac that
   * runs work").
   */
  joined: (
    place: HomePlace,
    home: string | null,
    user: string,
    background: InBackground,
    controls = false,
  ) => {
    if (place.thisMac)
      return [
        `Joined. ${userDisplayName(user)} runs work for Infinitary on ${HERE.this} now.`,
        ...userInBackground(user, background),
      ];
    const named = home ?? there(place);
    const open = controls ? [OPEN_HERE] : [];
    switch (background) {
      case "running":
        return [
          `Joined. ${HERE.This} runs work for ${named} now, whenever ${user} is logged in.`,
          ...open,
        ];
      case "at-login":
        return [
          `Joined. ${HERE.This} runs work for ${named} whenever ${user} is logged in, from the next time ${user} logs in.`,
          ...open,
        ];
      case "failed":
        return [
          `Joined. ${HERE.This} runs work for ${named} now.`,
          ...notInBackground(`on ${named}`),
          ...open,
        ];
      case "none":
        return [`Joined. ${HERE.This} runs work for ${named} now.`, ...open];
    }
  },

  /**
   * A new command from the home this user already runs work for found it
   * where it is now (docs/helper.md, "Finding the home again"): the same
   * computer on its list, with everything kept here.
   */
  foundAgain: (place: HomePlace, home: string | null, user: string, background: InBackground) => {
    if (place.thisMac)
      return [
        `Found Infinitary on ${HERE.this} again. ${userDisplayName(user)} runs its work as before.`,
        ...userInBackground(user, background),
      ];
    const found = place.overSsh
      ? `Found ${home ?? `the ${COMPUTER.one}`} again.`
      : `Found ${home ?? `the ${COMPUTER.one}`} at ${place.host}.`;
    switch (background) {
      case "running":
        return [`${found} ${HERE.This} runs its work as before, whenever ${user} is logged in.`];
      case "at-login":
        return [
          `${found} ${HERE.This} runs its work as before, from the next time ${user} logs in.`,
        ];
      case "failed":
        return [
          `${found} ${HERE.This} runs its work as before.`,
          ...notInBackground(`on ${home ?? there(place)}`),
        ];
      case "none":
        return [`${found} ${HERE.This} runs its work as before.`];
    }
  },

  /**
   * The home removed this computer while it was out of reach, and a new
   * command from it said so: what a removal takes away goes first, then the
   * command joins it anew.
   */
  removedEarlier: (place: HomePlace, name: string | null) => [
    place.thisMac
      ? `Infinitary on ${HERE.this} removed this user earlier.`
      : `${homeLabel(place, name)} removed ${HERE.this} earlier.`,
  ],

  /**
   * A link from another home while the one this user runs work for does not
   * answer (docs/helper.md, "Leaving a home that is gone"): the question asked
   * before it leaves that home as a removal would, keeping work that never
   * merged.
   */
  askLeave: (from: string) => [
    `This user runs work for ${from}, which does not answer.`,
    `Joining leaves it: Infinitary removes what it set up here for ${from}, with its sign-ins.`,
    `Work that never merged stays on ${HERE.this}.`,
  ],

  /** It left the home that does not answer, before it joins the new one. */
  leftHome: (from: string) => [`This user left ${from}.`],

  /**
   * The home it leaves, as `askLeave` and `leftHome` name it when the new
   * link comes from the same place: on this Mac, or at the same address.
   */
  earlierHome: (place: HomePlace) =>
    place.thisMac
      ? `an earlier Infinitary on ${HERE.this}`
      : `an earlier Infinitary at ${place.host}`,

  notJoined: ["This user has not joined Infinitary yet."],

  inReach: (place: HomePlace, name: string | null) => [`${homeLabel(place, name)} is in reach.`],

  outOfReach: (place: HomePlace, name: string | null) => [
    `${homeLabel(place, name)} is out of reach. ${self(place)} keeps trying.`,
  ],

  quit: (place: HomePlace, name: string | null) => [
    `Infinitary on ${place.thisMac ? HERE.this : (name ?? there(place))} quit. ${self(place)} keeps trying.`,
  ],

  noNewWork: (place: HomePlace, name: string | null) => [
    `${homeLabel(place, name)} has another version of Infinitary, so ${self(place).toLowerCase()} takes no new work.`,
    `It takes work again once it is updated from ${place.thisMac ? `Infinitary on ${HERE.this}` : homeLabel(place, name)}.`,
  ],

  /**
   * The home updated Firstmate here to its version (`./update.ts`): this run
   * ends, and the background starts it again, or the person does.
   */
  updated: (place: HomePlace, name: string | null, restarts: boolean) => [
    place.thisMac
      ? `Infinitary on ${HERE.this} updated this user to its version.`
      : `${homeLabel(place, name)} updated Infinitary on ${HERE.this} to its version.`,
    restarts ? "It starts again now." : "Start it again to run its work.",
  ],

  removed: (place: HomePlace, name: string | null) =>
    place.thisMac
      ? [`Infinitary on ${HERE.this} removed this user.`, "A new command from it joins it again."]
      : [
          `${homeLabel(place, name)} removed ${HERE.this}.`,
          `A new command from ${homeLabel(place, name)} joins it again.`,
        ],

  /**
   * What removing it took away here (`./cleanUp.ts`): everything Firstmate
   * set up, but a working copy holding work that never came home, and what
   * it could not remove yet, which it tries again unless a join that clears
   * the note follows (`triesAgain: false`); and with `claude`, what became of
   * this user's Claude login.
   */
  cleanedUp: (
    kept: readonly string[],
    unreadable: readonly string[] = [],
    unremoved: readonly string[] = [],
    options: { triesAgain?: boolean; claude?: MachineLoginOutcome | "later" } = {},
  ) => [
    ...(unremoved.length === 0
      ? ["Infinitary removed what it set up here, with its sign-ins."]
      : options.triesAgain === false
        ? [`Infinitary could not remove all it set up here, in ${unremoved.join(", ")}.`]
        : notFinished(unremoved)),
    ...(options.claude ? claudeLogin(options.claude) : []),
    ...(kept.some((dir) => !unreadable.includes(dir))
      ? [
          `Unmerged work it could not bring home stays here, in ${kept.filter((dir) => !unreadable.includes(dir)).join(", ")}.`,
        ]
      : []),
    ...unreadable.map(
      (dir) =>
        `Infinitary could not read the work history in ${dir}, so it kept that folder and the projects it needs here.`,
    ),
  ],

  /** What became of this user's Claude login as Firstmate let it go (`claudeLogin`). */
  claudeLogin: (outcome: MachineLoginOutcome | "later") => claudeLogin(outcome),

  status: (place: HomePlace, name: string | null, at: string, since: string, running: boolean) => [
    `This user runs work for ${place.thisMac ? `Infinitary on ${HERE.this}` : homeLabel(place, name)}, at ${at}, since ${since}.`,
    running ? "It is running now." : "It is not running now.",
  ],

  /**
   * A home removed it, or it left one; `unfinished` what that removal could
   * not remove yet, null once it finished; `claudeLater` when the Claude
   * login Firstmate made here waits for the work's own run.
   */
  left: (
    name: string,
    unfinished: readonly string[] | null = null,
    reason: LeftReason = "removed",
    claudeLater = false,
  ) => [
    reason === "left" ? `This user left ${name}.` : `${name} removed this user.`,
    "This user has not joined Infinitary since.",
    ...(unfinished && (unfinished.length > 0 || !claudeLater) ? notFinished(unfinished) : []),
    ...(claudeLater ? claudeLogin("later") : []),
  ],
};

/**
 * What became of this user's Claude login as Firstmate let it go
 * (`./cleanUp.ts`): signed out when Firstmate made it from a pasted code,
 * kept when it did not, or signed out by the work's own run (`later`).
 */
function claudeLogin(outcome: MachineLoginOutcome | "later"): string[] {
  switch (outcome) {
    case "signed-out":
      return ["Infinitary signed this user out of the Claude login it made."];
    case "kept":
      return ["This user's own Claude login stays, since Infinitary did not make it."];
    case "not-signed-out":
      return [
        "Infinitary could not sign this user out of the Claude login it made.",
        "To end it, sign out in Claude Code.",
      ];
    case "later":
      return [
        "Infinitary signs this user out of the Claude login it made the next time it runs as this user.",
      ];
  }
}

/**
 * A removal that has not finished: what it could not remove yet, or nothing
 * known when its first try was cut off; the agent's next run tries again.
 */
function notFinished(paths: readonly string[]): string[] {
  return [
    paths.length > 0
      ? `Infinitary could not remove all it set up here yet, in ${paths.join(", ")}.`
      : "Infinitary has not finished removing what it set up here.",
    "It tries again the next time this user logs in.",
  ];
}

/** The question a command asks before it gets Firstmate onto another Mac, or joins with it. */
export function macAsk(home: string, user: string): string[] {
  return [
    `Infinitary on ${home} asks to add ${HERE.this}, as the user ${user}.`,
    "It runs only the projects you give it, with sign-ins of its own.",
  ];
}

/**
 * The command for another computer, run on a system Firstmate does not run
 * on: it stops before anything (docs/devices.md, "Joining by a command").
 */
export function otherSystem(): string[] {
  return [
    `Infinitary does not run on ${HERE.this}'s system.`,
    "It runs on Macs, and on Linux computers with an x64 chip.",
    NOTHING_CHANGED,
  ];
}

/** The command on a Linux computer with no curl, which gets Firstmate from its home. */
export function needsCurl(home: string): string[] {
  return [
    `This command needs curl to get Infinitary from ${home}.`,
    "Install curl, then run it again.",
    NOTHING_CHANGED,
  ];
}

/**
 * The command on a Linux computer where the AppImage it gets would run
 * without Chromium's sandbox: it stops before anything, as adding that
 * computer by its address does (docs/devices.md, "Joining by a command").
 */
export function sandboxOff(): string[] {
  return [
    `Infinitary would run on ${HERE.this} without its sandbox: its system keeps apps from making one.`,
    "Install the Infinitary package for this system, then run this command again.",
    NOTHING_CHANGED,
  ];
}

/**
 * The command on a Linux computer whose installed Infinitary is not the
 * home's version (captain's pick on INF-1181, "stop and print the one line
 * that updates the package"): it stops before anything. `update` is the line
 * that updates an Ubuntu package, when there is one to name.
 */
export function otherVersion(home: string, version: string, update: string | null): string[] {
  return [
    `The Infinitary installed on ${HERE.this} is not version ${version}, which ${home} runs.`,
    ...(update
      ? ["Update it with this line, then run this command again:", update]
      : [`Update it to version ${version}, then run this command again.`]),
    NOTHING_CHANGED,
  ];
}

/**
 * The command on a Linux computer that lacks what the AppImage and its work
 * need: it stops before it asks (docs/devices.md, "Joining by a command").
 * `install` is the line that installs them with that computer's own
 * installer, or null with `names` alone when it has none the command knows.
 */
export function commandNeeds(home: string, names: string, install: string | null): string[] {
  return install
    ? [
        `Infinitary needs more on ${HERE.this} before it can run work for ${home}.`,
        "Install it with this line, then run this command again:",
        install,
        NOTHING_CHANGED,
      ]
    : [
        `Infinitary needs ${names} on ${HERE.this} before it can run work for ${home}.`,
        "Install them with its software app or package manager, then run this command again.",
        NOTHING_CHANGED,
      ];
}

/** The command on Ubuntu 24.04 or 26.04 with no Infinitary, for an account that may not install it. */
export function commandCannotInstall(): string[] {
  return [
    `Infinitary is not installed on ${HERE.this}, and this account cannot install software.`,
    "Use an account that can, or install the Infinitary package for this system, then run this command again.",
    NOTHING_CHANGED,
  ];
}

/** Before the command installs the Ubuntu package, which sudo may ask this account's password for. */
export const COMMAND_INSTALLING =
  "Installing Infinitary, which may ask for this account's password.";

/**
 * The install did not finish: a wrong password, a package that did not match,
 * or apt refused. `left` is what apt changed before it stopped: part of the
 * package, or only packages it needs.
 */
export function commandInstallFailed(left?: "part" | "needs"): string[] {
  if (!left) return [`Could not install Infinitary on ${HERE.this}.`, NOTHING_CHANGED];
  return left === "part"
    ? [
        `Could not finish installing Infinitary on ${HERE.this}.`,
        "Part of it stays installed, and this line removes it:",
        "sudo apt-get remove -y infinitary",
      ]
    : [
        `Could not finish installing Infinitary on ${HERE.this}.`,
        "Packages it needs that apt installed stay installed.",
      ];
}

/**
 * A join after the command installed the Ubuntu package it runs from: the
 * package stays whatever the join does, so its words never say nothing
 * changed, and a join that stops ends with `INSTALLED_STAYS`.
 */
export function afterInstall(lines: readonly string[]): string[] {
  return lines.filter((line) => line !== NOTHING_CHANGED && line !== NOTHING_CHANGED_HERE);
}

/** The last words of a join that stopped after the command installed the package it runs from. */
export const INSTALLED_STAYS = `Infinitary stays installed on ${HERE.this}.`;

/** That install turned on `user`'s linger, and the join then stopped: how to turn it off. */
export function lingerStays(user: string): string[] {
  return [
    `Programs ${user} runs now keep running after ${user} logs out.`,
    "To turn that off, an administrator runs this once:",
    `sudo loginctl disable-linger ${user}`,
  ];
}

/** The home has no Infinitary to send for this computer's system. */
export function commandNothingToSend(home: string): string[] {
  return [
    `${home} cannot send Infinitary for ${HERE.this}.`,
    "Install Infinitary here, then run this command again.",
    NOTHING_CHANGED,
  ];
}

/**
 * After a Linux computer joined by the command: its work stays on after
 * `user` logs out (systemd's linger), or the one line an administrator runs
 * to allow it (captain's pick on INF-1181, "keep it on by itself when
 * allowed, otherwise print the one sudo line").
 */
export function afterLogout(user: string, on: boolean): string[] {
  return on
    ? [`It keeps running after ${user} logs out.`]
    : [
        `To keep it running after ${user} logs out, an administrator runs this once:`,
        `sudo loginctl enable-linger ${user}`,
      ];
}

/**
 * The command's own download (docs/devices.md, "Joining by a command"):
 * what its count stands after, rewritten in place as it moves.
 */
export const COMMAND_DOWNLOADING = "Downloading Infinitary…";

/** The command could not download Firstmate, or what it downloaded did not match: it gets it from its home. */
export function commandDownloadFallback(home: string, mismatch: boolean): string {
  return mismatch
    ? `The download did not match, so getting Infinitary from ${home} instead.`
    : `Could not download Infinitary, so getting it from ${home} instead.`;
}

/** A command used already, named by where it came from. */
export function commandUsed(home: string): string[] {
  return [`That command was used already. Make a new one on ${home}.`, NOTHING_CHANGED];
}

/** A used-up command's words, with how long its link lasted: ten minutes, or longer for one that downloads. */
export function commandExpired(home: string, lastsMs: number = PAIRING_LINK_TTL_MS): string[] {
  return [
    `That command expired. It lasts ${minutesWords(lastsMs)}; make a new one on ${home}.`,
    NOTHING_CHANGED,
  ];
}

/** A link's lifetime as the words say it: "ten minutes", "thirty minutes". */
export function minutesWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${({ 10: "ten", 30: "thirty" } as Record<number, string>)[minutes] ?? minutes} minutes`;
}

export function commandClosed(home: string): string[] {
  return [`That command is no longer open. Make a new one on ${home}.`, NOTHING_CHANGED];
}

/** How another user on this Mac runs its work in the background, once it joined. */
function userInBackground(user: string, background: InBackground): string[] {
  const who = userDisplayName(user);
  switch (background) {
    case "running":
      return [`It runs whenever ${who} is logged in, even in the background. You can switch back.`];
    case "at-login":
      return [
        `It starts the next time ${who} logs in, and then runs whenever ${who} is logged in.`,
      ];
    case "failed":
      return notInBackground(`in Infinitary on ${HERE.this}`);
    case "none":
      return [];
  }
}

/** It joined, but nothing will start it at the next login. */
function notInBackground(where: string): string[] {
  return [
    "It could not set itself to start in the background.",
    `Remove it ${where}, then run a new command to try again.`,
  ];
}

/** The Mac where Firstmate lives, named once it has said its name. */
export function homeLabel(place: HomePlace, name: string | null): string {
  if (place.thisMac) return `Infinitary on ${HERE.this}`;
  if (name) return name;
  return place.overSsh
    ? `The ${COMPUTER.one} that set this one up over SSH`
    : `The ${COMPUTER.one} at ${place.host}`;
}

/** Who keeps trying: this Mac, or this user on the Mac where Firstmate lives. */
function self(place: HomePlace): string {
  return place.thisMac ? "This user" : HERE.This;
}
