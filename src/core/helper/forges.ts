import { join } from "node:path";
import { hostOfAddress, type KnownForgeHost } from "@shared/forge";
import {
  type ForgeBrowserSignIn,
  type ForgeCliSignInResult,
  type ForgeKeySignIn,
  type ForgeKeySignInResult,
  type ForgeSignInFlow,
  forgeStartProblemText,
} from "@shared/forges";
import type { ComputerForges, SignInStep } from "@shared/signIns";
import {
  type ForgeServer,
  type ForgeSignInEnding,
  type ForgeSignInProvider,
  ForgeSignInStore,
  ForgeSignIns,
  ForgeStartError,
  forgeFiledHosts,
  forgeKnownHosts,
  forgeSignInProviders,
  forgeSignInServers,
  type GitHubCli,
  githubCliFor,
} from "../forge";
import { configureGitSignIn } from "../hostEnv";

/**
 * A computer that runs work's own sign-in where projects live (docs/forge.md,
 * "A computer's own sign-in"; docs/helper.md, "Its own sign-ins"): the same
 * `ForgeSignIns` the home keeps its own in, over this computer's own store
 * under its data folder, which its git reads through the app's helper for
 * its clones and pushes. Nothing of the home's sign-in is here.
 *
 *   work/forges/<host>/sign-in.json    0700 / 0600, one per host
 *   work/forges/health.log             one dated line per change of health
 *
 * The host's device flow runs here - GitHub's, or GitLab's browser code
 * with an application the person registered there: its code to read goes to
 * the home, the captain enters it on the host's page there, and this
 * computer finishes the sign-in itself. A key for GitLab or GitHub
 * Enterprise is typed at the home and crosses once, to be kept here. Health and renewal run on this computer's own clock; the
 * home holds no store for it, so it can neither read nor renew one.
 */

/** How often its health is read, and a short-lived sign-in renewed ahead of its end: the home's own tick. */
const HEALTH_EVERY_MS = 60_000;

export type ComputerForgesOptions = {
  dataDir: string;
  /** Whether it runs from a packaged app: the endpoint overrides are read only off one. */
  packaged: boolean;
  /** The hosts' sign-ins; the app's own (`forgeSignInProviders`) unless a test stands in its own. */
  providers?: ForgeSignInProvider[];
  /** The kinds of server signed in to by an address; the app's own (`forgeSignInServers`) unless a test stands in its own. */
  servers?: ForgeServer[];
  /** This computer's own GitHub CLI; the one on its search path unless a test stands in its own. */
  cli?: GitHubCli;
  /** A sign-in made or gone, or a change of its health or of who the host says it is. */
  onChange: () => void;
  /** Starts the clock; tests read the health themselves. */
  clock?: boolean;
  log?: (line: string) => void;
  now?: () => number;
};

export type HeldForges = {
  /** What the home is told: each sign-in with its health as read here, and each host it offers. */
  view: () => ComputerForges;
  /**
   * Starts a host's device flow here. Resolves once its code is known, which
   * `step` gets as a notice; its end goes to `step` once. A flow already
   * running here ends first, cancelled.
   */
  start: (host: string, step: (step: SignInStep) => void) => Promise<void>;
  /**
   * Starts GitLab's browser code sign-in here with the public application
   * the person registered on that host; the same steps as `start`.
   */
  startBrowser: (input: ForgeBrowserSignIn, step: (step: SignInStep) => void) => Promise<void>;
  /**
   * Signs in to GitLab or GitHub Enterprise with a key made there, kept
   * here only once the host answers for it; the answer carries no key.
   */
  signInWithKey: (input: ForgeKeySignIn) => Promise<ForgeKeySignInResult>;
  /**
   * Signs a GitHub host in through this computer's own GitHub CLI: only the
   * way and the program's path are kept, never its token, and the answer
   * carries none (docs/forge.md, "GitHub CLI's sign-in").
   */
  signInWithCli: (host: string) => Promise<ForgeCliSignInResult>;
  /** Stops the flow running here, if any; its end goes to its `step` as cancelled. */
  cancel: () => void;
  /** Forgets a host's sign-in here: its folder is deleted. */
  signOut: (host: string) => void;
  /** Reads every sign-in's health now, renewing one that is ending. */
  checkHealth: () => Promise<void>;
  close: () => void;
};

/** Where this computer keeps its sign-ins where projects live. */
export function computerForgesDir(dataDir: string): string {
  return join(dataDir, "forges");
}

/** Whether this computer holds a sign-in where projects live, so it has one to keep renewed. */
export function holdsForgeSignIn(dataDir: string): boolean {
  return new ForgeSignInStore(computerForgesDir(dataDir)).hosts().length > 0;
}

/** The hosts this computer knows other than the code's, each with its kind, by the home's own rule (`forgeKnownHosts`). */
export function computerKnownHosts(dataDir: string, packaged = true): KnownForgeHost[] {
  return forgeKnownHosts({
    store: new ForgeSignInStore(computerForgesDir(dataDir)),
    providers: forgeSignInProviders({ packaged }),
    servers: forgeSignInServers({ packaged }),
  });
}

/**
 * Git that never prompts, and answers a host the app signs in to only with
 * this computer's own sign-in (`src/core/hostEnv.ts`): every child this
 * process starts - git, a crewmate's shell, Claude's client - carries the
 * app's helper pointed at this computer's store.
 */
export function configureComputerGit(options: {
  dataDir: string;
  askpass: string;
  packaged: boolean;
}): void {
  const dir = computerForgesDir(options.dataDir);
  const providers = forgeSignInProviders({ packaged: options.packaged });
  const servers = forgeSignInServers({ packaged: options.packaged });
  configureGitSignIn({
    askpass: options.askpass,
    signInDir: dir,
    // github.com, and every other host only once it is signed in to here,
    // read at each spawn: a host signed in to after the start is answered by
    // this computer's own sign-in alone from its next child on, and one with
    // no sign-in here keeps the computer's own git login, so a GitLab project
    // still clones there under a home too old to offer GitLab's sign-in.
    hosts: () => [
      ...new Set([
        ...providers.map((provider) => provider.host),
        ...forgeFiledHosts({ store: new ForgeSignInStore(dir), providers, servers }),
      ]),
    ],
  });
}

/** What an ended flow says at home, in the words this Mac's own row uses (design skill `components/projects/ForgeRow`). */
function endStep(ending: ForgeSignInEnding, name: string, why?: string): SignInStep {
  switch (ending) {
    case "signed-in":
      return { kind: "ended", outcome: "signed-in" };
    case "expired":
      return { kind: "ended", outcome: "failed", error: "The code expired." };
    case "failed":
      return {
        kind: "ended",
        outcome: "failed",
        error: why ?? `Could not reach ${name} - try again.`,
      };
    default:
      // The person said no on the host's page, or it was stopped: quiet.
      return { kind: "ended", outcome: "cancelled" };
  }
}

export function startComputerForges(options: ComputerForgesOptions): HeldForges {
  const log = options.log ?? (() => {});
  const providers = options.providers ?? forgeSignInProviders({ packaged: options.packaged });
  const servers = options.servers ?? forgeSignInServers({ packaged: options.packaged });
  let told = "";
  const view = (): ComputerForges => {
    const whole = signIns.view();
    const signedIn = new Set(whole.signIns.map((row) => row.host));
    return {
      signIns: whole.signIns.map(({ projects: _here, ...row }) => row),
      // A host of a kind of server gets a row once it is signed in to here;
      // until then its kind's chip offers it, so an older home, which knows
      // only the code, is never offered a host it would start a code for.
      hosts: whole.hosts.filter((host) => !host.server || signedIn.has(host.host)),
      ...(whole.servers?.length ? { servers: whole.servers } : {}),
      ...(whole.githubCli ? { githubCli: true } : {}),
    };
  };
  const signIns: ForgeSignIns = new ForgeSignIns({
    store: new ForgeSignInStore(computerForgesDir(options.dataDir)),
    providers,
    servers,
    cli: options.cli ?? githubCliFor({ packaged: options.packaged }),
    // No project lives here: the home keeps the record of them.
    projectsOn: () => 0,
    // A code on screen is a step of its own; the home hears the rows only when they change.
    push: () => {
      const now = JSON.stringify(view().signIns);
      if (now === told) return;
      told = now;
      options.onChange();
    },
    log,
    ...(options.now ? { now: options.now } : {}),
  });
  told = JSON.stringify(view().signIns);
  const nameOf = (host: string) => signIns.nameOf(host) ?? host;

  /**
   * One flow here: its code goes to `step` as a notice once known, and its
   * end once. A start the host refuses says why in the end's words.
   */
  const run = async (
    host: string,
    step: (step: SignInStep) => void,
    begin: (onEnd: (ending: ForgeSignInEnding) => void) => Promise<ForgeSignInFlow>,
  ): Promise<void> => {
    let ended = false;
    const end = (ending: ForgeSignInEnding, why?: string) => {
      if (ended) return;
      ended = true;
      step(endStep(ending, nameOf(host), why));
    };
    let flow: ForgeSignInFlow;
    try {
      flow = await begin(end);
    } catch (error) {
      log(
        `a sign-in to ${host} could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
      end(
        "failed",
        error instanceof ForgeStartError ? forgeStartProblemText(error.problem, host) : undefined,
      );
      return;
    }
    if (ended) return;
    step({
      kind: "notice",
      notice: {
        providerId: host,
        kind: "device_code",
        message: `Enter this code on ${nameOf(host)}.`,
        url: flow.verificationUri,
        userCode: flow.userCode,
      },
    });
  };

  let timer: NodeJS.Timeout | undefined;
  signIns.recordApp("start");
  if (options.clock !== false) {
    timer = setInterval(() => void signIns.checkHealth().catch(() => undefined), HEALTH_EVERY_MS);
    timer.unref();
    void signIns.checkHealth().catch(() => undefined);
  }

  return {
    view,
    start: (host, step) => {
      if (!signIns.nameOf(host)) throw new Error(`This computer offers no sign-in to ${host}.`);
      return run(host, step, (onEnd) => signIns.signIn(host, { onEnd }));
    },
    startBrowser: (input, step) => {
      const host = hostOfAddress(input.address) ?? input.address;
      return run(host, step, (onEnd) => signIns.signInWithBrowser(input, { onEnd }));
    },
    signInWithKey: (input) => signIns.signInWithKey(input),
    // A GitHub Enterprise host it is not signed in to yet is named by its
    // address; the service refuses one that is not GitHub's.
    signInWithCli: (host) => signIns.signInWithCli(`https://${host}`),
    cancel: () => signIns.cancel(),
    signOut: (host) => {
      if (!signIns.nameOf(host)) throw new Error(`This computer offers no sign-in to ${host}.`);
      signIns.signOut(host);
    },
    checkHealth: () => signIns.checkHealth(),
    close: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      signIns.cancel();
      signIns.recordApp("quit");
    },
  };
}
