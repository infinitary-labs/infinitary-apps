import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type ForgeKind,
  hostOfAddress,
  isPublicForgeHost,
  type KnownForgeHost,
  kindByName,
} from "@shared/forge";
import {
  type ForgeBrowserSignIn,
  type ForgeKeySignIn,
  type ForgeKeySignInResult,
  type ForgeServerView,
  type ForgeSignInFlow,
  type ForgeSignInState,
  type ForgeStartProblem,
  type ForgesView,
  isForgeHostName,
} from "@shared/forges";

/**
 * The app's own sign-ins where projects live (git integration PR 1.2,
 * `docs/forge.md`): a sibling of the account vault, never a row in the
 * provider catalog and never visible to routing. One sign-in per host:
 *
 *   userData/forges/<host>/            0700
 *       sign-in.json                   0600 { token, scopes, login, createdAt,
 *                                             refreshToken?, expiresAt?, refreshExpiresAt?,
 *                                             kind?, gitUser? }
 *   userData/forges/health.log         0600 one dated line per change of health
 *
 * Two readers only: this file (for the forge's requests and the health
 * read) and the app's own git helper (`resources/git-askpass`), which git
 * runs when a project's host asks who is pushing. The sign-in never rides
 * an environment variable, an argument, a log line, a timeline event or a
 * card. Signing out deletes the host's directory; GitHub offers an OAuth
 * App with no secret no way to revoke a sign-in from the app, so the
 * person revokes it on GitHub's own page if they want it gone there too.
 *
 * Health follows the five-rule contract (`src/core/accounts/credentialHealth.ts`)
 * on the supervisor's tick: the host's answer to "who is this" is `ok`; its
 * refusal is `needs_reauth` only on proof - a sign-in with nothing to renew
 * it, a refused renewal, or a refusal that survived a real renewal; an
 * unreachable or rate-limited host is `unavailable` and retried; a store
 * the app cannot read is `unknown`.
 *
 * A short-lived sign-in (GitHub gives every OAuth App registered since
 * 2026-08-14 eight-hour sign-ins by default, `providers/github/oauth.ts`)
 * keeps its refresh token and renews itself: ahead of its end on the tick
 * and before a forge request, and once when the host refuses it. A refresh
 * token works once, so renewals run one at a time per host. The owner's
 * first sign-in died eight hours in because the app kept only the access
 * token (`docs/forge.md`).
 * Nothing here is ever required: with no sign-in there is nothing to check
 * and nothing to say.
 *
 * A key host - GitHub Enterprise, gitlab.com or a self-hosted GitLab
 * (`docs/forge.md`, "Hosts on your own server") -
 * keeps its sign-in in the same file under its own name, with the kind of
 * host it is and the user name git gives it, read by the same two readers.
 * Without an application registered there, the person makes a key on the
 * host's own page and Settings hands it here
 * once (`signInWithKey`): the host is asked who the key is before it is
 * kept, and that same read is its health. The hosts this service knows
 * (`knownHosts`) are the public key hosts, the ones with a sign-in on file,
 * and the ones the
 * person's projects live on (`projectHosts`), each with its kind; a kind
 * of server plugs in as one more `ForgeServer`. GitLab also offers browser
 * sign-in with a public Application ID registered on that host, kept with
 * the sign-in so the same renewal owner can refresh it after a restart.
 *
 * Every change of health, every completed sign-in and every sign-out is one
 * dated line in `health.log` (and the console): the states and what the
 * host answered - its HTTP status, or why it could not be asked - and never
 * the sign-in. So are the app's start and quit, once anyone has signed in
 * here: whether a sign-in is on file and since when. A packaged app's
 * console reaches no file, and a clean 401 once left no trace of when the
 * host began refusing (the owner's first sign-in, revoked on GitHub while
 * the app was closed; `docs/forge.md`).
 */

export type ForgeSignInRecord = {
  token: string;
  scopes: string[];
  login: string | null;
  createdAt: number;
  /** A short-lived sign-in's renewal: the refresh token, and when each runs out. */
  refreshToken?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
  /** A host on the person's own server: the kind of host it is ("github"). */
  kind?: ForgeKind;
  /** The user name git gives the host; the git helper says `x-access-token` without one. */
  gitUser?: string;
  /** Public application identifier for renewing a browser sign-in on this host. */
  applicationId?: string;
};

export const SIGN_IN_FILE = "sign-in.json";
export const HEALTH_LOG = "health.log";
/** The health log keeps its newest lines within this size. */
export const HEALTH_LOG_MAX_BYTES = 64 * 1024;
/** A short-lived sign-in renews this long before it runs out: ten of the tick's minutes. */
export const RENEW_LEAD_MS = 10 * 60_000;

/** The files: one 0700 directory per host, one 0600 file in it. */
export class ForgeSignInStore {
  constructor(readonly root: string) {}

  dirFor(host: string): string {
    if (!isForgeHostName(host)) throw new Error(`not a host name: ${host}`);
    return join(this.root, host);
  }

  /** The hosts with a directory, whatever state their file is in. */
  hosts(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isForgeHostName(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  /** The sign-in, nothing when there is none, `unreadable` when the file is there but broken. */
  read(host: string): ForgeSignInRecord | "unreadable" | undefined {
    const file = join(this.dirFor(host), SIGN_IN_FILE);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ForgeSignInRecord>;
      if (typeof parsed.token !== "string" || !parsed.token) return "unreadable";
      return {
        token: parsed.token,
        scopes: Array.isArray(parsed.scopes)
          ? parsed.scopes.filter((s) => typeof s === "string")
          : [],
        login: typeof parsed.login === "string" ? parsed.login : null,
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
        ...(typeof parsed.refreshToken === "string" && parsed.refreshToken
          ? { refreshToken: parsed.refreshToken }
          : {}),
        ...(typeof parsed.expiresAt === "number" ? { expiresAt: parsed.expiresAt } : {}),
        ...(typeof parsed.refreshExpiresAt === "number"
          ? { refreshExpiresAt: parsed.refreshExpiresAt }
          : {}),
        ...(typeof parsed.kind === "string" && parsed.kind ? { kind: parsed.kind } : {}),
        ...(typeof parsed.applicationId === "string" && parsed.applicationId
          ? { applicationId: parsed.applicationId }
          : {}),
        ...(typeof parsed.gitUser === "string" && parsed.gitUser
          ? { gitUser: parsed.gitUser }
          : {}),
      };
    } catch {
      return "unreadable";
    }
  }

  /** Write the one file, whole, never readable by anyone else even mid-write. */
  write(host: string, record: ForgeSignInRecord): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const dir = this.dirFor(host);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, SIGN_IN_FILE);
    const temp = `${file}.${process.pid}.tmp`;
    // One line: the git helper reads the token field with a line tool.
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temp, file);
  }

  remove(host: string): void {
    rmSync(this.dirFor(host), { recursive: true, force: true });
  }

  /**
   * One line of the health log, at the store's root beside every host's
   * directory - never inside one, so signing out keeps the history. Past
   * its size the log keeps its newest half, whole lines only.
   */
  appendHealth(line: string): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, HEALTH_LOG);
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
    if (statSync(file).size <= HEALTH_LOG_MAX_BYTES) return;
    const text = readFileSync(file);
    const tail = text.subarray(text.length - HEALTH_LOG_MAX_BYTES / 2);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, tail.subarray(tail.indexOf(10) + 1), { mode: 0o600 });
    renameSync(temp, file);
  }
}

/** What a host answers when asked who a sign-in is; `status` is its HTTP status, where it answered. */
export type ForgeWhoAmI =
  | { state: "ok"; login: string; status?: number; scopes?: string[] }
  | { state: "rejected"; status?: number }
  | { state: "unavailable"; reason: string; status?: number };

export type ForgeDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInS: number;
  intervalS: number;
};

/** A sign-in as the host hands it over; a short-lived one carries its lifetime and refresh token. */
export type ForgeIssued = {
  token: string;
  scopes: string[];
  refreshToken?: string;
  expiresInS?: number;
  refreshExpiresInS?: number;
};

export type ForgeDeviceResult =
  | ({ outcome: "signed-in" } & ForgeIssued)
  | { outcome: "expired" }
  | { outcome: "denied" }
  | { outcome: "cancelled" };

/**
 * One host's sign-in, as this service asks it (`providers/github/oauth.ts`):
 * a code the person enters on the host's page (`start`, `wait`), or, for a
 * host on the person's own server, a key the person makes there (`server`).
 */
export type ForgeSignInProvider = {
  host: string;
  name: string;
  /** A host on the person's own server: its kind and offered methods. */
  server?: ForgeServerView;
  applicationId?: string;
  start?: (signal?: AbortSignal) => Promise<ForgeDeviceCode>;
  wait?: (code: ForgeDeviceCode, signal: AbortSignal) => Promise<ForgeDeviceResult>;
  whoAmI: (token: string) => Promise<ForgeWhoAmI>;
  /** Renew a short-lived sign-in with its refresh token; a host without them has none. */
  renew?: (refreshToken: string) => Promise<ForgeRenewal>;
};

/**
 * A browser sign-in the host would not start, with the reason its answer
 * gave. The message names the status and OAuth error code only, never the
 * Application ID or the host's own text.
 */
export class ForgeStartError extends Error {
  constructor(
    readonly problem: ForgeStartProblem,
    detail: string,
  ) {
    super(`${problem}: ${detail}`);
    this.name = "ForgeStartError";
  }
}

/** The host's answer to a renewal: a new pair, a refusal (the proof), or no answer. */
export type ForgeRenewal =
  | ({ outcome: "renewed" } & ForgeIssued)
  | { outcome: "refused"; reason: string }
  | { outcome: "unavailable"; reason: string };

/** What a renewal came to here; `superseded` is a sign-out or a new sign-in while the host answered. */
type Renewal =
  | { outcome: "renewed" }
  | { outcome: "superseded" }
  | { outcome: "refused"; reason: string }
  | { outcome: "unavailable"; reason: string };

/** A change of one host's health, for the host's card and feed line. */
export type ForgeHealthChange = {
  host: string;
  name: string;
  from: ForgeSignInState | "none";
  to: ForgeSignInState | "none";
};

type Health = { state: ForgeSignInState; login: string | null };

/**
 * How one sign-in that showed its code ended, for whoever started it: a
 * computer that runs work telling its home (`src/core/helper/forges.ts`).
 * `denied` is the person saying no on the host's page; `cancelled` is a
 * Cancel, a sign-out, or a newer sign-in taking the screen.
 */
export type ForgeSignInEnding = "signed-in" | "expired" | "denied" | "cancelled" | "failed";

type Flight = {
  flow: ForgeSignInFlow;
  abort: AbortController;
  onEnd?: ((ending: ForgeSignInEnding) => void) | undefined;
};

/**
 * A kind of host the person runs on their own server, which signs in with
 * a key made there (`providers/github/oauth.ts` `createGitHubServer`): what
 * it is called, the user name git gives it, and one host's sign-in.
 */
export type ForgeServer = ForgeServerView & {
  kind: ForgeKind;
  gitUser: string;
  /** Public hosts of this kind that also sign in with a key, rather than a device code. */
  hosts?: readonly string[];
  signIn: (host: string, applicationId?: string) => ForgeSignInProvider;
};

export type ForgeSignInsOptions = {
  store: ForgeSignInStore;
  /** The hosts that offer a sign-in whatever the person has: github.com's code. */
  providers: ForgeSignInProvider[];
  /** The kinds of server a host can be added as by its address and a key: GitHub Enterprise. */
  servers?: ForgeServer[];
  /** The hosts on the person's own server their projects live on, with each one's kind. */
  projectHosts?: () => readonly KnownForgeHost[];
  /** A key sign-in was kept: that host's projects are its kind's projects now. */
  onSignedIn?: (known: KnownForgeHost) => void;
  /** How many of the person's projects live on a host, for the row's words. */
  projectsOn: (host: string) => number;
  /** The whole view, after every change. */
  push: (view: ForgesView) => void;
  onHealthChange?: (change: ForgeHealthChange) => void;
  /** A short-lived sign-in renewed itself: work a refusal held for it can go again. */
  onRenewed?: (host: string) => void;
  log?: (message: string) => void;
  now?: () => number;
};

export class ForgeSignIns {
  private readonly health = new Map<string, Health>();
  private flight: Flight | undefined;
  private starting: { host: string; abort: AbortController } | undefined;
  private ended: ForgesView["ended"] = null;
  private readonly checking = new Map<string, Promise<void>>();
  private readonly renewing = new Map<string, Promise<Renewal>>();
  private readonly onServers = new Map<string, ForgeSignInProvider>();

  constructor(private readonly options: ForgeSignInsOptions) {
    for (const host of this.signedInHosts()) {
      const record = options.store.read(host);
      this.health.set(host, {
        state: "unknown",
        login: record && record !== "unreadable" ? record.login : null,
      });
    }
  }

  view(): ForgesView {
    const signIns = this.signedInHosts().map((host) => {
      const record = this.options.store.read(host);
      const health = this.health.get(host);
      return {
        host,
        name: this.provider(host)?.name ?? host,
        login: health?.login ?? (record && record !== "unreadable" ? record.login : null),
        state: record === "unreadable" ? ("unknown" as const) : (health?.state ?? "unknown"),
        projects: this.options.projectsOn(host),
        since: record && record !== "unreadable" ? record.createdAt : 0,
        ...(record && record !== "unreadable" && record.applicationId
          ? { applicationId: record.applicationId }
          : {}),
        ...serverOf(this.provider(host)),
      };
    });
    return {
      signIns,
      hosts: [
        ...this.options.providers.map((provider) => ({
          host: provider.host,
          name: provider.name,
        })),
        ...this.knownHosts().flatMap(({ host }) => {
          const provider = this.provider(host);
          return provider ? [{ host, name: provider.name, ...serverOf(provider) }] : [];
        }),
      ],
      servers: (this.options.servers ?? []).map(({ kind, name, browser }) => ({
        kind,
        name,
        ...(browser ? { browser } : {}),
      })),
      flow: this.flight?.flow ?? null,
      ended: this.ended,
    };
  }

  /** The person's word for a host that offers a sign-in, or nothing. */
  nameOf(host: string): string | undefined {
    return this.provider(host)?.name;
  }

  /**
   * The hosts on the person's own server this service knows, each with its
   * kind: every one with a key sign-in on file, and every one the person's
   * projects live on. A project's address on one of them is that kind's
   * project (`forgeOf`'s `known`), and a kind of server the app does not
   * offer here is not known.
   */
  knownHosts(): KnownForgeHost[] {
    const offered = new Set(this.options.providers.map((provider) => provider.host));
    const known = new Map<string, ForgeKind>();
    for (const server of this.options.servers ?? []) {
      for (const host of server.hosts ?? []) known.set(host, server.kind);
    }
    for (const host of this.options.store.hosts()) {
      if (offered.has(host)) continue;
      const record = this.options.store.read(host);
      // A sign-in on file that names no kind is GitHub's, the one kind that ever wrote one.
      const kind = (record && record !== "unreadable" ? record.kind : undefined) ?? "github";
      if (this.serverFor(kind)) known.set(host, kind);
    }
    for (const entry of this.options.projectHosts?.() ?? []) {
      if (offered.has(entry.host) || known.has(entry.host) || !isForgeHostName(entry.host))
        continue;
      if (isPublicForgeHost(entry.host) || !this.serverFor(entry.kind)) continue;
      known.set(entry.host, entry.kind);
    }
    return [...known]
      .map(([host, kind]) => ({ host, kind }))
      .sort((a, b) => a.host.localeCompare(b.host));
  }

  /**
   * The hosts git answers with the app's sign-in alone, every other
   * helper set aside (`hostEnv`): each host that offers the code, whatever
   * the person has, and each host on the person's own server with a sign-in
   * on file. One the app holds no sign-in for keeps the person's own
   * helpers, as it did before the app knew it.
   */
  gitHosts(): string[] {
    const servers = this.knownHosts()
      .map(({ host }) => host)
      .filter((host) => this.isSignedIn(host));
    return [
      ...new Set([
        ...this.options.providers.map((provider) => provider.host),
        ...(this.options.servers ?? []).flatMap((server) => server.hosts ?? []),
        ...servers,
      ]),
    ];
  }

  /** Whether a host has a sign-in on file (whatever its health). */
  isSignedIn(host: string): boolean {
    const record = this.options.store.read(host);
    return record !== undefined && record !== "unreadable";
  }

  /** Who the host last said the person is. */
  loginOf(host: string): string | null {
    return this.health.get(host)?.login ?? null;
  }

  stateOf(host: string): ForgeSignInState | undefined {
    return this.health.get(host)?.state;
  }

  /**
   * The app's sign-in for a host as one typed fact (git integration PR
   * 1.3, the Firstmate's context): undefined where the host offers no
   * sign-in here, null where it offers one and none is on file, else who
   * the host last said the person is and the sign-in's health. An
   * unreadable file is a sign-in in `unknown` health, never absent.
   */
  signInOn(
    host: string,
  ): { name: string; login: string | null; state: ForgeSignInState } | null | undefined {
    const name = this.nameOf(host);
    if (!name) return undefined;
    const record = this.options.store.read(host);
    if (record === undefined) return null;
    const health = this.health.get(host);
    return {
      name,
      login: health?.login ?? (record === "unreadable" ? null : record.login),
      state: record === "unreadable" ? "unknown" : (health?.state ?? "unknown"),
    };
  }

  /**
   * The sign-in a forge sends with a request. Read at call time, never kept
   * in memory; a short-lived one about to run out is renewed first.
   */
  async token(host: string): Promise<string | undefined> {
    const record = this.usable(host);
    if (!record || !this.expiring(record)) return record?.token;
    await this.renew(host, record);
    return this.usable(host)?.token;
  }

  /**
   * Start the device flow for a host: a code to enter on the host's page.
   * A flow already in flight is ended first, so there is only ever one
   * code on screen. Resolves once the code is known; the person's answer
   * arrives later as a push, and once to `onEnd` when it is given. A flow
   * that could not start throws and calls nothing.
   */
  async signIn(
    host: string,
    options: { onEnd?: (ending: ForgeSignInEnding) => void } = {},
  ): Promise<ForgeSignInFlow> {
    const provider = this.provider(host);
    if (!provider) throw new Error(`${host} offers no sign-in`);
    const { start, wait } = provider;
    if (!start || !wait) throw new Error(`${host} signs in with a key made there, not a code`);
    this.cancel();
    this.ended = null;
    const abort = new AbortController();
    const starting = { host, abort };
    this.starting = starting;
    let code: ForgeDeviceCode;
    try {
      code = await start(abort.signal);
    } catch (caught) {
      if (this.starting !== starting) throw new Error("Sign-in cancelled");
      this.starting = undefined;
      this.ended = {
        host,
        end: "failed",
        ...(caught instanceof ForgeStartError ? { problem: caught.problem } : {}),
      };
      this.log(`sign-in to ${host} could not start: ${messageOf(caught)}`);
      this.pushView();
      throw caught;
    }
    if (this.starting !== starting) throw new Error("Sign-in cancelled");
    this.starting = undefined;
    const flow: ForgeSignInFlow = {
      host,
      userCode: code.userCode,
      verificationUri: code.verificationUri,
      expiresAt: this.now() + code.expiresInS * 1000,
    };
    const flight: Flight = { flow, abort, onEnd: options.onEnd };
    this.flight = flight;
    this.pushView();
    void this.finish(provider, wait, code, flight);
    return flow;
  }

  /** Start the existing code flow using a public application registered on this host. */
  async signInWithBrowser(input: ForgeBrowserSignIn): Promise<ForgeSignInFlow> {
    const host = hostOfAddress(input.address);
    const server = this.serverFor(input.kind);
    if (
      !host ||
      !isForgeHostName(host) ||
      !server?.browser ||
      this.options.providers.some((provider) => provider.host === host) ||
      (isPublicForgeHost(host) && !server.hosts?.includes(host)) ||
      (kindByName(host) !== undefined && kindByName(host) !== server.kind) ||
      !/^[A-Za-z0-9_-]{20,256}$/.test(input.applicationId.trim())
    )
      throw new Error("Check the server address and Application ID");
    this.onServers.set(host, server.signIn(host, input.applicationId.trim()));
    return this.signIn(host);
  }

  /**
   * Sign in to a host on the person's own server with a key they made
   * there; `kind` is the kind of server they chose. The address may be the
   * host's name, a page on it, or a project's address there. The host is
   * asked who the key is first, and only a key it answers for is kept:
   * refused, unreachable, or an address that does not answer as that kind
   * of server does, the answer says which and nothing is written. The key
   * is never logged, and never handed back.
   */
  async signInWithKey(input: ForgeKeySignIn): Promise<ForgeKeySignInResult> {
    const host = hostOfAddress(input.address);
    if (!host || !isForgeHostName(host)) return { ok: false, problem: "address", host: null };
    if (this.options.providers.some((provider) => provider.host === host)) {
      return { ok: false, problem: "public-host", host };
    }
    const server = this.serverFor(input.kind);
    const named = kindByName(host);
    if (
      !server ||
      (isPublicForgeHost(host) && !server.hosts?.includes(host)) ||
      (named !== undefined && named !== server.kind)
    ) {
      return { ok: false, problem: "not-server", host };
    }
    const key = input.key.trim();
    if (!KEY.test(key)) return { ok: false, problem: "key", host };
    const provider = server.signIn(host);
    const reading = await whoAmI(provider, key);
    if (reading.state !== "ok") {
      const status = reading.status;
      const problem =
        reading.state === "rejected" || status === 403
          ? "refused"
          : status === undefined || status >= 500
            ? "unreachable"
            : "not-server";
      this.log(`sign-in to ${host} with a key was not kept: ${answerOf(reading)}`);
      return { ok: false, problem, host };
    }
    this.onServers.set(host, provider);
    if (this.flight?.flow.host === host || this.starting?.host === host) this.cancel();
    const before = this.health.get(host)?.state ?? "none";
    this.options.store.write(host, {
      token: key,
      scopes: reading.scopes ?? [],
      login: reading.login,
      createdAt: this.now(),
      kind: server.kind,
      gitUser: server.gitUser,
    });
    this.health.set(host, { state: "ok", login: reading.login });
    if (this.ended?.host === host) this.ended = null;
    this.record(host, before, "ok", `signed in with a key, ${answerOf(reading)}`);
    this.changed(host, before, "ok");
    this.options.onSignedIn?.({ host, kind: server.kind });
    this.pushView();
    return { ok: true, host };
  }

  /** The person's Cancel: the code stops being asked about. */
  cancel(): void {
    this.starting?.abort.abort();
    this.starting = undefined;
    const flight = this.flight;
    if (!flight) return;
    this.flight = undefined;
    flight.abort.abort();
    flight.onEnd?.("cancelled");
    this.pushView();
  }

  /** Forget a host's sign-in: its directory goes, and so does anything said about it. */
  signOut(host: string): void {
    if (this.flight?.flow.host === host || this.starting?.host === host) this.cancel();
    const before = this.health.get(host)?.state ?? "none";
    this.options.store.remove(host);
    this.onServers.delete(host);
    this.health.delete(host);
    this.ended = null;
    this.record(host, before, "none", "signed out");
    this.changed(host, before, "none");
    this.pushView();
  }

  /**
   * The tick's health read, for every host with a sign-in: the host's own
   * answer to who the person is. Concurrent asks for one host share a read.
   */
  async checkHealth(): Promise<void> {
    await Promise.all(this.signedInHosts().map((host) => this.checkHost(host)));
  }

  /** Ask one host now, as the tick would (the integration's Check now). */
  checkNow(host: string): Promise<void> {
    return this.checkHost(host);
  }

  /**
   * A forge request the host refused as the sign-in (a 401): not proof on
   * its own - the health read asks the host again, and its answer is what
   * the row and the card follow.
   */
  rejected(host: string): void {
    void this.checkHost(host);
  }

  private checkHost(host: string): Promise<void> {
    const running = this.checking.get(host);
    if (running) return running;
    const check = this.readHealth(host).finally(() => this.checking.delete(host));
    this.checking.set(host, check);
    return check;
  }

  private async readHealth(host: string): Promise<void> {
    const provider = this.provider(host);
    const record = this.options.store.read(host);
    if (record === undefined) return;
    const before = this.health.get(host);
    let next: Health;
    let answer: string;
    if (record === "unreadable" || !provider) {
      next = { state: "unknown", login: before?.login ?? null };
      answer = "the sign-in file is unreadable";
    } else {
      let current = record;
      let renewal: Renewal | undefined;
      if (this.expiring(current)) {
        renewal = await this.renew(host, current);
        current = this.usable(host) ?? current;
      }
      let reading = await whoAmI(provider, current.token);
      // The host refused it: renew once, and ask again with the new one.
      if (reading.state === "rejected" && renewal?.outcome !== "renewed" && current.refreshToken) {
        renewal = await this.renew(host, current);
        if (renewal.outcome === "renewed" || renewal.outcome === "superseded") {
          current = this.usable(host) ?? current;
          reading = await whoAmI(provider, current.token);
        }
      }
      // Signed out while the read was in flight: nothing to record.
      const latest = this.usable(host);
      if (!latest) return;
      answer = `${answerOf(reading)}${renewalNote(renewal)}`;
      const login = before?.login ?? latest.login;
      if (reading.state === "ok") {
        next = { state: "ok", login: reading.login };
        if (reading.login !== latest.login) {
          this.options.store.write(host, { ...latest, login: reading.login });
        }
      } else if (reading.state === "rejected" && renewal?.outcome !== "unavailable") {
        next = { state: "needs_reauth", login };
      } else {
        next = { state: "unavailable", login };
      }
    }
    this.health.set(host, next);
    if (before?.state !== next.state) {
      this.record(host, before?.state ?? "unknown", next.state, answer);
    }
    if (before?.state !== next.state || before?.login !== next.login) {
      this.changed(host, before?.state ?? "unknown", next.state);
      this.pushView();
    }
  }

  private async finish(
    provider: ForgeSignInProvider,
    wait: NonNullable<ForgeSignInProvider["wait"]>,
    code: ForgeDeviceCode,
    flight: Flight,
  ): Promise<void> {
    let result: ForgeDeviceResult;
    try {
      result = await wait(code, flight.abort.signal);
    } catch (caught) {
      if (this.flight !== flight) return;
      this.flight = undefined;
      this.ended = { host: provider.host, end: "failed" };
      this.log(`sign-in to ${provider.host} failed: ${messageOf(caught)}`);
      flight.onEnd?.("failed");
      this.pushView();
      return;
    }
    if (this.flight !== flight) return;
    if (result.outcome === "expired") {
      this.flight = undefined;
      this.ended = { host: provider.host, end: "expired" };
      flight.onEnd?.("expired");
      this.pushView();
      return;
    }
    // The person said no on the host's page, or cancelled here: quiet.
    if (result.outcome !== "signed-in") {
      this.flight = undefined;
      flight.onEnd?.(result.outcome);
      this.pushView();
      return;
    }
    const issuedAt = this.now();
    const reading = await whoAmI(provider, result.token);
    // Cancellation, sign-out or a replacement while the health read answered wins.
    if (this.flight !== flight) return;
    this.flight = undefined;
    const server = provider.server ? this.serverFor(provider.server.kind) : undefined;
    const before = this.health.get(provider.host)?.state ?? "none";
    const lifetime = lifetimeOf(result, issuedAt);
    this.options.store.write(provider.host, {
      token: result.token,
      scopes: result.scopes,
      login: reading.state === "ok" ? reading.login : null,
      createdAt: this.now(),
      ...lifetime,
      ...(server ? { kind: server.kind, gitUser: server.gitUser } : {}),
      ...(provider.applicationId ? { applicationId: provider.applicationId } : {}),
    });
    const state: ForgeSignInState =
      reading.state === "ok" ? "ok" : reading.state === "rejected" ? "needs_reauth" : "unavailable";
    this.health.set(provider.host, {
      state,
      login: reading.state === "ok" ? reading.login : null,
    });
    this.record(
      provider.host,
      before,
      state,
      `signed in, ${answerOf(reading)}${lifetime.expiresAt ? `, short-lived until ${isoOf(lifetime.expiresAt)}` : ""}`,
    );
    this.changed(provider.host, before, state);
    if (server) this.options.onSignedIn?.({ host: provider.host, kind: server.kind });
    flight.onEnd?.("signed-in");
    this.pushView();
  }

  /**
   * The app's start or quit in the health log, one line per host that
   * offers a sign-in, once anyone has signed in here (the store exists):
   * whether a sign-in is on file and since when, and its last health read -
   * never the sign-in. A sign-in that dies while the app is closed is then
   * bracketed by the quit that last saw it and the start after.
   */
  recordApp(moment: "start" | "quit"): void {
    if (!existsSync(this.options.store.root)) return;
    const servers = this.knownHosts()
      .map(({ host }) => host)
      .filter((host) => this.options.store.read(host) !== undefined);
    for (const host of [...this.options.providers.map((provider) => provider.host), ...servers]) {
      const record = this.options.store.read(host);
      const onFile =
        record === undefined
          ? "not signed in"
          : record === "unreadable"
            ? "the sign-in file is unreadable"
            : `signed in since ${isoOf(record.createdAt)}${record.expiresAt ? `, short-lived until ${isoOf(record.expiresAt)}` : ""}`;
      const state = this.health.get(host)?.state;
      const lastRead = state && state !== "unknown" ? `, last read ${state}` : "";
      this.write(`${isoOf(this.now())} ${host} app ${moment}: ${onFile}${lastRead}`);
    }
  }

  /**
   * Renew a short-lived sign-in with its refresh token, one renewal at a
   * time per host: a refresh token works once, so two racing would spend it
   * twice and the second would read as a refusal.
   */
  private renew(host: string, record: ForgeSignInRecord): Promise<Renewal> {
    const running = this.renewing.get(host);
    if (running) return running;
    const renewal = this.runRenewal(host, record).finally(() => this.renewing.delete(host));
    this.renewing.set(host, renewal);
    return renewal;
  }

  private async runRenewal(host: string, record: ForgeSignInRecord): Promise<Renewal> {
    // A new, unfinished registration may be cached for Retry; it never renews the saved sign-in.
    const provider =
      record.applicationId && record.kind
        ? this.serverFor(record.kind)?.signIn(host, record.applicationId)
        : this.provider(host);
    const refreshToken = record.refreshToken;
    if (!provider?.renew || !refreshToken) {
      return { outcome: "unavailable", reason: "nothing renews this sign-in" };
    }
    const answer = await provider
      .renew(refreshToken)
      .catch((caught): ForgeRenewal => ({ outcome: "unavailable", reason: messageOf(caught) }));
    // Signed out, or signed in afresh, while the host answered: the file is
    // no longer this sign-in's, and nothing here may overwrite it.
    const now = this.usable(host);
    if (!now || now.refreshToken !== refreshToken) return { outcome: "superseded" };
    const at = this.now();
    if (answer.outcome === "renewed") {
      const { refreshToken: _spent, expiresAt: _ended, refreshExpiresAt: _lapsed, ...kept } = now;
      const lifetime = lifetimeOf(answer, at);
      this.options.store.write(host, {
        ...kept,
        token: answer.token,
        scopes: answer.scopes.length > 0 ? answer.scopes : now.scopes,
        ...lifetime,
      });
      this.write(
        `${isoOf(at)} ${host} sign-in renewed${lifetime.expiresAt ? `, short-lived until ${isoOf(lifetime.expiresAt)}` : ""}`,
      );
      this.options.onRenewed?.(host);
      return { outcome: "renewed" };
    }
    if (answer.outcome === "refused") {
      // A refused refresh token never works again: keep the sign-in, drop it.
      const { refreshToken: _refused, refreshExpiresAt: _lapsed, ...kept } = now;
      this.options.store.write(host, kept);
    }
    this.write(`${isoOf(at)} ${host} sign-in renewal ${answer.outcome} (${answer.reason})`);
    return answer;
  }

  /** The sign-in on file, when there is a readable one. */
  private usable(host: string): ForgeSignInRecord | undefined {
    const record = this.options.store.read(host);
    return record && record !== "unreadable" ? record : undefined;
  }

  /** A short-lived sign-in inside its renewal lead, with a refresh token to renew it. */
  private expiring(record: ForgeSignInRecord): boolean {
    return (
      record.refreshToken !== undefined &&
      record.expiresAt !== undefined &&
      this.now() >= record.expiresAt - RENEW_LEAD_MS
    );
  }

  /** One dated line of the health log for a change of a host's health. */
  private record(
    host: string,
    from: ForgeSignInState | "none",
    to: ForgeSignInState | "none",
    answer: string,
  ): void {
    this.write(`${isoOf(this.now())} ${host} sign-in ${from} -> ${to} (${answer})`);
  }

  /** A log that cannot be written never stops a read, a sign-in or a quit. */
  private write(line: string): void {
    this.log(line);
    try {
      this.options.store.appendHealth(line);
    } catch (caught) {
      this.log(`could not write the health log: ${messageOf(caught)}`);
    }
  }

  private changed(
    host: string,
    from: ForgeSignInState | "none",
    to: ForgeSignInState | "none",
  ): void {
    if (from === to) return;
    this.options.onHealthChange?.({ host, name: this.provider(host)?.name ?? host, from, to });
  }

  private signedInHosts(): string[] {
    return this.options.store.hosts().filter((host) => this.options.store.read(host) !== undefined);
  }

  /**
   * The host's sign-in: one that offers a code, else the sign-in of a host
   * on the person's own server this service knows (`knownHosts`), or one a
   * kind of server by its name alone (a `.ghe.com` host), with a key.
   */
  private provider(host: string): ForgeSignInProvider | undefined {
    const offered = this.options.providers.find((provider) => provider.host === host);
    if (offered) return offered;
    if (!isForgeHostName(host)) return undefined;
    const made = this.onServers.get(host);
    if (made) return made;
    const kind = this.knownHosts().find((entry) => entry.host === host)?.kind ?? kindByName(host);
    const server = kind ? this.serverFor(kind) : undefined;
    if (!server) return undefined;
    const record = this.usable(host);
    const provider = server.signIn(host, record?.applicationId);
    this.onServers.set(host, provider);
    return provider;
  }

  private serverFor(kind: string): ForgeServer | undefined {
    return this.options.servers?.find((server) => server.kind === kind);
  }

  private pushView(): void {
    this.options.push(this.view());
  }

  private log(message: string): void {
    this.options.log?.(`[forge] ${message}`);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** A host on the person's own server, as a view says it: the kind of server, where there is one. */
function serverOf(provider: ForgeSignInProvider | undefined): { server?: ForgeServerView } {
  return provider?.server ? { server: provider.server } : {};
}

/** A key a host issues: letters, digits, underscores, dashes and dots, nothing else. */
const KEY = /^[A-Za-z0-9_.-]{20,1024}$/;

function whoAmI(provider: ForgeSignInProvider, token: string): Promise<ForgeWhoAmI> {
  return provider
    .whoAmI(token)
    .catch((caught): ForgeWhoAmI => ({ state: "unavailable", reason: messageOf(caught) }));
}

/** When a sign-in the host just issued runs out, from its lifetimes in seconds. */
function lifetimeOf(
  issued: Pick<ForgeIssued, "refreshToken" | "expiresInS" | "refreshExpiresInS">,
  at: number,
): Pick<ForgeSignInRecord, "refreshToken" | "expiresAt" | "refreshExpiresAt"> {
  return {
    ...(issued.refreshToken ? { refreshToken: issued.refreshToken } : {}),
    ...(issued.expiresInS !== undefined ? { expiresAt: at + issued.expiresInS * 1000 } : {}),
    ...(issued.refreshExpiresInS !== undefined
      ? { refreshExpiresAt: at + issued.refreshExpiresInS * 1000 }
      : {}),
  };
}

/** What a renewal during a health read came to, for the health log. */
function renewalNote(renewal: Renewal | undefined): string {
  if (!renewal || renewal.outcome === "superseded") return "";
  if (renewal.outcome === "renewed") return ", after a renewal";
  if (renewal.outcome === "refused") return `, the renewal was refused (${renewal.reason})`;
  return `, the renewal could not be asked (${renewal.reason})`;
}

/** What the host answered, for the health log: its HTTP status, or why it could not be asked. */
function answerOf(reading: ForgeWhoAmI): string {
  if (reading.state === "unavailable") {
    const { reason, status } = reading;
    return status === undefined || reason.startsWith(String(status))
      ? reason
      : `${status}, ${reason}`;
  }
  return reading.status === undefined ? "no status" : `answered ${reading.status}`;
}

/** A moment as the health log dates it; a stored time too far out to date is written as it is. */
function isoOf(ms: number): string {
  const at = new Date(ms);
  return Number.isNaN(at.getTime()) ? String(ms) : at.toISOString();
}

function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
